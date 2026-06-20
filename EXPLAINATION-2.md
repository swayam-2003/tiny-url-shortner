# Tiny URL Shortener — Complete Project Explanation

A plain-English walkthrough of **every part** of this project: what runs where, why it exists, and how a request flows from browser to database and back.

---

## Table of Contents

1. [What This Project Does](#1-what-this-project-does)
2. [The Big Picture (Architecture)](#2-the-big-picture-architecture)
3. [Docker Services — What Is api1, api2, and Everything Else?](#3-docker-services--what-is-api1-api2-and-everything-else)
4. [Request Flows (Step by Step)](#4-request-flows-step-by-step)
5. [Backend Deep Dive](#5-backend-deep-dive)
6. [Database Schema](#6-database-schema)
7. [Redis Caching](#7-redis-caching)
8. [Nginx Load Balancer](#8-nginx-load-balancer)
9. [Security Layers](#9-security-layers)
10. [Frontend (React)](#10-frontend-react)
11. [Analytics System](#11-analytics-system)
12. [Benchmarks & Load Testing](#12-benchmarks--load-testing)
13. [How to Run (Modes)](#13-how-to-run-modes)
14. [File Map — Every Folder Explained](#14-file-map--every-folder-explained)
15. [Interview Cheat Sheet](#15-interview-cheat-sheet)

---

## 1. What This Project Does

This is a **URL shortener** like bit.ly or TinyURL:

| User action | What happens |
|-------------|--------------|
| Paste `https://very-long-article.com/...` | System returns `http://localhost/abc12` |
| Click `http://localhost/abc12` | Browser gets **HTTP 301** redirect to the original long URL |
| View analytics | See click count, recent clicks, referrers |

**Tech stack:**

| Layer | Technology |
|-------|------------|
| Frontend | React + Vite |
| API | Node.js + Express + TypeScript |
| Database | PostgreSQL (source of truth) |
| Cache | Redis (speed layer) |
| Load balancer | Nginx |
| Containers | Docker Compose |

---

## 2. The Big Picture (Architecture)

```
┌─────────────┐
│   Browser   │
└──────┬──────┘
       │  http://localhost (port 80)
       ▼
┌─────────────────────────────────────────────────────────────┐
│                        NGINX (:80)                          │
│  • Routes /api/* and /{shortCode} → api1 or api2            │
│  • Routes / → React frontend                                │
│  • Rate limits, security headers, connection limits         │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
       ┌───────▼───────┐              ┌───────▼───────┐
       │    api1       │              │    api2       │
       │  Express :3001│              │  Express :3001│
       │  SERVER_ID=   │              │  SERVER_ID=   │
       │    api1       │              │    api2       │
       └───────┬───────┘              └───────┬───────┘
               │         same code,             │
               │         two containers         │
               └──────────────┬─────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────────┐
        │  Redis   │   │ Postgres │   │ Analytics    │
        │  cache   │   │  urls DB │   │ queue (RAM)  │
        └──────────┘   └──────────┘   └──────────────┘
```

**Key idea:** Nginx is the **front door**. Users never talk to api1/api2 directly in production mode — they hit Nginx on port 80, and Nginx picks which API container handles the request.

---

## 3. Docker Services — What Is api1, api2, and Everything Else?

Defined in `docker-compose.yml`. Services are grouped by **profile**.

### Always-on services (no profile)

| Service | Port | What it is |
|---------|------|------------|
| **redis** | 6379 | In-memory cache. Stores `shortCode → longUrl` mappings for fast redirects. Uses `allkeys-lru` eviction (256MB cap). |
| **postgres** | 5433→5432 | Permanent storage. All URLs, click counts, analytics rows live here. Port 5433 on host maps to 5432 inside Docker. |

### Full-stack profile (`--profile full`)

| Service | Port | What it is |
|---------|------|------------|
| **api1** | internal 3001 | First copy of the Express backend. `SERVER_ID=api1` — adds `X-Server-Id: api1` header so you can see which replica handled a request. |
| **api2** | internal 3001 | **Identical** second copy of the backend. Same code, same DB, same Redis. `SERVER_ID=api2`. Exists for **horizontal scaling** and **load balancing**. |
| **nginx** | 80 | Reverse proxy + load balancer. Distributes traffic between api1 and api2 using `least_conn` algorithm. |
| **frontend** | internal 5173 | React dev server (Vite). Nginx proxies browser requests for `/` to this container. |

### Why two APIs (api1 and api2)?

They are **not different applications**. They are **two replicas of the same API**:

- If api1 is busy, Nginx sends the next request to api2.
- Both read/write the **same** Postgres and **same** Redis — so a URL created on api1 is immediately visible on api2.
- Under load, you get ~2× API processing capacity.
- k6 tests confirmed **50/50 traffic split** between them.

**Local dev without Docker full profile:** You run a single API with `npm run dev` in `backend/` — that's equivalent to one api1, no Nginx.

---

## 4. Request Flows (Step by Step)

### Flow A — Shorten a URL (POST)

```
Browser → Nginx:80 → api1 or api2
  POST /api/v1/urls  { "longUrl": "https://example.com" }
```

1. **Nginx** applies `shorten` rate limit (5 req/s per IP).
2. **Express** middleware chain:
   - `requestIdMiddleware` → adds `X-Request-Id` (UUID for tracing)
   - `serverIdMiddleware` → adds `X-Server-Id` (api1 or api2)
   - `securityMiddleware` → blocks suspicious paths
   - `helmet` → security headers
   - `apiRateLimiter` → 100 req / 15 min on all `/api/v1/*`
   - `shortenRateLimiter` → 20 shorten req / min
3. **urlController.shortenUrl** → **urlService.shorten**
4. **urlService** logic:
   - Validate URL (format, SSRF block on private IPs)
   - Check if same long URL already exists → return existing short link (dedup)
   - Else: get next ID from Postgres counter → Base62 encode + 2 random chars → unique short code
   - Insert row into `urls` table
   - **Write to Redis** (`cacheRepository.set`) — warm the cache immediately
5. Response: `{ shortCode, shortUrl, longUrl, expiresAt }`

### Flow B — Redirect (GET) — THE HOT PATH

```
Browser → Nginx:80 → api1 or api2
  GET /abc12
```

This is the **most performance-critical** path (millions of clicks in production).

1. **Nginx** matches regex `^/[a-zA-Z0-9_-]{3,12}$` → redirect rate limit (100 req/s per IP).
2. **Express** `redirectRateLimiter` → 200 redirects / min per IP.
3. **redirectController** → **redirectService.resolve**
4. **Cache-aside pattern:**
   ```
   Redis GET url:abc12
     ├─ HIT  → return longUrl immediately (~7ms)
     ├─ MISS → query Postgres → SET Redis → return longUrl (~25-40ms)
     └─ BYPASS (Redis down) → query Postgres only, still works
   ```
5. Set headers: `X-Cache: HIT|MISS|BYPASS`, `X-Response-Time`
6. **Async:** `trackClick` enqueues analytics (does NOT block redirect)
7. **HTTP 301** redirect to long URL

### Flow C — Analytics (GET)

```
GET /api/v1/urls/abc12/analytics
```

1. Lookup URL in Postgres
2. Query `url_clicks` for last 7 days + recent clicks
3. Return totals, referrers, user agents

### Flow D — Health Check

```
GET /health
```

- Checks Postgres connection
- Returns 200 or 503
- No rate limit (Nginx passes through for LB probes)

### Flow E — Frontend page load

```
Browser → Nginx:80 → frontend:5173
  GET /
```

Nginx proxies to Vite dev server. React app loads, calls API via `VITE_API_URL` (set to `http://localhost` in Docker = through Nginx).

---

## 5. Backend Deep Dive

### Layered architecture

```
HTTP Request
    ↓
Controller   ← parses HTTP, sends response
    ↓
Service      ← business rules (validate, dedup, expire checks)
    ↓
Repository   ← talks to Postgres or Redis
    ↓
Database / Cache
```

This separation means you can change storage (e.g. add read replicas) without touching HTTP handlers.

### Entry point — `backend/src/index.ts`

Boot sequence:
1. Load env (`dotenv`)
2. Run SQL migrations automatically on startup
3. Check Redis is reachable
4. Start Express on `PORT` (default 3001)

Routes registered:
| Method | Path | Handler |
|--------|------|---------|
| GET | `/health` | healthController |
| POST | `/api/v1/urls` | shortenUrl |
| GET | `/api/v1/urls/:shortCode` | getUrlMetadata |
| GET | `/api/v1/urls/:shortCode/analytics` | getAnalytics |
| DELETE | `/api/v1/urls/:shortCode` | deactivateUrl |
| GET | `/api/v1/cache/stats` | redisStatsController |
| GET | `/:shortCode` | redirectHandler (301) |

### Short code generation

File: `backend/src/utils/shortCode.ts`

```
counterId = 12345  (from Postgres sequence)
base62(12345) = "3d7"
random suffix = "xK"
shortCode = "3d7xK"
```

- **Base62** uses `a-zA-Z0-9` — compact, URL-safe.
- **2 random chars** reduce collision risk if two requests get the same counter (retry up to 3 times).
- **Custom alias** optional — user picks `my-link` instead of generated code.

### URL validation & SSRF protection

File: `backend/src/utils/urlValidator.ts`

Blocks:
- Private IPs (`127.x`, `10.x`, `192.168.x`, `localhost`)
- Invalid formats
- Overly long URLs

This prevents attackers from using your shortener to probe internal networks.

### Error handling

File: `backend/src/middleware/errorHandler.ts`

All errors return consistent JSON:
```json
{ "error": true, "code": "NOT_FOUND", "message": "..." }
```

`AppError` class carries HTTP status + code. Unknown errors → 500 with logged stack trace (Pino logger).

---

## 6. Database Schema

File: `backend/migrations/001_init.sql`

### `urls` table (source of truth)

| Column | Purpose |
|--------|---------|
| `id` | Internal BIGINT primary key |
| `short_code` | Unique 3–12 char code (what users see in URL) |
| `long_url` | Original destination |
| `created_at` | When shortened |
| `expires_at` | Optional expiry (default ~5 years) |
| `is_active` | Soft delete flag |
| `click_count` | Denormalized counter (updated async) |

### `url_clicks` table (analytics detail)

| Column | Purpose |
|--------|---------|
| `url_id` | FK to urls |
| `clicked_at` | Timestamp |
| `ip_hash` | SHA-256 of IP (privacy — not raw IP) |
| `user_agent` | Browser/device info |
| `referer` | Where click came from |

### `_migrations` table

Tracks which `.sql` files have been applied. Migrations run automatically when API starts.

---

## 7. Redis Caching

### Strategy: Cache-Aside (Lazy Loading)

The app controls cache — Redis does not auto-populate.

```
READ:  App checks Redis first → on miss, read DB → write Redis → return
WRITE: App writes DB first → then SET Redis
DELETE: App deletes from Redis when URL deactivated
```

### Key format

```
url:{shortCode}  →  "https://long-url.com/..."
TTL: 86400 seconds (24 hours, configurable)
```

### Eviction policy

File: `redis/redis.conf`

- `maxmemory 256mb`
- `maxmemory-policy allkeys-lru` — when full, evict **least recently used** keys

### Graceful degradation

If Redis is down, `cacheRepository` returns `BYPASS` status. Redirects still work via Postgres — just slower. Response header `X-Cache: BYPASS` tells you Redis was skipped.

### Cache status headers

| Header | Meaning |
|--------|---------|
| `X-Cache: HIT` | Found in Redis |
| `X-Cache: MISS` | Not in Redis, loaded from DB, now cached |
| `X-Cache: BYPASS` | Redis unavailable |

---

## 8. Nginx Load Balancer

File: `nginx/nginx.conf`

### Upstream block

```nginx
upstream api_backend {
    least_conn;           # send to server with fewest active connections
    server api1:3001;
    server api2:3001;
    keepalive 32;         # reuse TCP connections
}
```

**`least_conn`** vs round-robin: better when requests have variable duration (DB misses slower than cache hits).

### Routing rules

| URL pattern | Goes to | Rate limit |
|-------------|---------|------------|
| `/health` | api_backend | none |
| `/api/v1/urls` (POST) | api_backend | 5 req/s (shorten) |
| `/api/*` | api_backend | 30 req/s |
| `/[shortCode]` regex | api_backend | 100 req/s |
| `/` (everything else) | frontend:5173 | — |

### Headers Nginx adds

| Header | Value |
|--------|-------|
| `X-Real-IP` | Client IP |
| `X-Forwarded-For` | Proxy chain |
| `X-Upstream-Addr` | Which api1/api2 handled it |

### Security at Nginx layer

- Blocks `.git`, `.env`, `wp-admin`, `.php` paths
- `client_max_body_size 16k`
- Connection limit: 20 per IP
- Security headers on all responses

---

## 9. Security Layers

Defense in depth — multiple independent layers:

| Layer | What | Where |
|-------|------|-------|
| Nginx rate limits | Per-IP req/s caps | `nginx.conf` |
| Nginx path blocks | Scanner/attack paths | `nginx.conf` |
| Express rate limits | Per-IP API + redirect caps | `rateLimiter.ts` |
| SSRF blocking | No private URL targets | `urlValidator.ts` |
| Helmet | HTTP security headers | `index.ts` |
| Request ID | Trace every request | `requestId.ts` |
| Body size limit | 16KB JSON max | `index.ts` |
| IP hashing | Analytics stores hash not raw IP | `hashIp.ts` |
| CORS | Restricted in production | `index.ts` |

### Rate limits (Express)

| Limiter | Window | Max | Applies to |
|---------|--------|-----|------------|
| `apiRateLimiter` | 15 min | 100 | All `/api/v1/*` |
| `shortenRateLimiter` | 1 min | 20 | POST `/api/v1/urls` |
| `redirectRateLimiter` | 1 min | 200 | GET `/:shortCode` |

---

## 10. Frontend (React)

Directory: `src/`

### Pages

| Route | File | Purpose |
|-------|------|---------|
| `/` | `ShortenPage.jsx` | Form to paste long URL, get short link |
| `/links` | `LinksPage.jsx` | History of links you created (localStorage) |
| `/analytics/:shortCode` | `AnalyticsPage.jsx` | Click stats for a link |

### API client

File: `src/services/api.js`

- `VITE_API_URL` points to backend (through Nginx in Docker: `http://localhost`)
- Methods: `shorten`, `getUrl`, `getAnalytics`, `deactivate`, `health`

### Link history

File: `src/hooks/useLinks.js`

Stores created links in **browser localStorage** — not server-side user accounts. This is a demo app without auth.

---

## 11. Analytics System

File: `backend/src/workers/analyticsWorker.ts`

**Problem:** Writing to Postgres on every redirect would slow the hot path.

**Solution:** In-memory queue + batch worker.

```
Redirect happens → enqueue click event (instant, non-blocking)
Every 1 second OR when queue hits 10 items → flush batch to Postgres
  • INSERT into url_clicks
  • INCREMENT urls.click_count
```

If flush fails, events are **re-queued** — no silent data loss.

Trade-off: click count may lag by ~1 second under load. Acceptable for analytics; redirect is never delayed.

---

## 12. Benchmarks & Load Testing

See **[BENCHMARKS.md](BENCHMARKS.md)** for full numbers.

| Test | VUs | Result |
|------|-----|--------|
| Stress | 1000 | 315K requests, 5,232 req/s peak, 0 crashes |
| Sustainable | 2 | 4.8 req/s, 0% errors, 98.6% cache hits, P95 49ms |
| Nginx LB | 10 | 50/50 api1/api2 split, P95 25ms |

Scripts in `benchmark/`:
- `k6-stress.js` — 1000 VU ramp
- `k6-redirect.js` — read-heavy under rate limits
- `k6-nginx.js` — load balancer distribution
- `k6-mixed.js` — write + read mix

---

## 13. How to Run (Modes)

### Mode 1 — Minimal (Redis + Postgres only)

```bash
docker compose up -d
cd backend && npm run dev    # single API on :3001
npm run dev                  # frontend on :5173
```

### Mode 2 — Full production-like stack

```bash
docker compose --profile full up -d --build
# Everything on http://localhost (Nginx :80)
```

### Mode 3 — Local API + Docker data stores

```bash
docker compose up -d           # just redis + postgres
npm run dev:all                # backend :3001 + frontend :5173
```

---

## 14. File Map — Every Folder Explained

```
tiny-url-shortner/
│
├── README.md              Main documentation
├── RUNBOOK.md             Step-by-step commands to run everything
├── BENCHMARKS.md          Load test results and how to reproduce
├── EXPLAINATION.md        Original system design doc
├── EXPLAINATION-2.md      This file — complete walkthrough
│
├── docker-compose.yml     Defines all containers and profiles
├── package.json           Root npm scripts (dev:all, benchmark:*)
├── .env                   Secrets (DATABASE_URL, etc.) — gitignored
│
├── backend/
│   ├── Dockerfile         How api1/api2 image is built
│   ├── migrations/        SQL schema files (001_init.sql)
│   └── src/
│       ├── index.ts           Express app entry + route registration
│       ├── config/
│       │   ├── env.ts         Loads dotenv
│       │   ├── database.ts    Postgres connection pool (pg)
│       │   ├── redis.ts       Redis client (ioredis)
│       │   └── logger.ts      Pino structured logging
│       ├── controllers/
│       │   ├── urlController.ts      POST/GET/DELETE /api/v1/urls
│       │   ├── redirectController.ts GET /:shortCode → 301
│       │   └── healthController.ts   GET /health, cache stats
│       ├── services/
│       │   ├── urlService.ts         Shorten, metadata, analytics, deactivate
│       │   └── redirectService.ts    Cache-aside resolve + click tracking
│       ├── repositories/
│       │   ├── urlRepository.ts      Postgres CRUD for urls + analytics
│       │   └── cacheRepository.ts    Redis get/set/invalidate
│       ├── routes/
│       │   └── v1Routes.ts           Mounts /api/v1 endpoints
│       ├── middleware/
│       │   ├── requestId.ts          X-Request-Id UUID
│       │   ├── serverId.ts           X-Server-Id (api1/api2)
│       │   ├── security.ts           Path blocks, URI length
│       │   ├── rateLimiter.ts        Express rate limits
│       │   ├── errorHandler.ts       Global error JSON responses
│       │   ├── asyncHandler.ts       Wraps async routes (no try/catch boilerplate)
│       │   └── validation.ts       Request body validation helpers
│       ├── workers/
│       │   └── analyticsWorker.ts  In-memory click queue + batch flush
│       ├── scripts/
│       │   ├── migrate.ts            Run SQL migrations
│       │   ├── benchmark-full.ts     Latency benchmark suite
│       │   └── benchmark-redis.ts    Redis HIT vs MISS vs BYPASS
│       └── utils/
│           ├── base62.ts             Number ↔ Base62 encoding
│           ├── shortCode.ts          Generate short codes from counter
│           ├── urlValidator.ts       URL format + SSRF checks
│           └── hashIp.ts             SHA-256 IP for analytics privacy
│
├── benchmark/
│   ├── k6-stress.js       1000+ VU stress test
│   ├── k6-redirect.js     Redirect load test
│   ├── k6-nginx.js        Load balancer distribution test
│   ├── k6-mixed.js        Mixed workload
│   └── results/           JSON output from k6 runs
│
├── nginx/
│   └── nginx.conf         LB, rate limits, routing, security headers
│
├── redis/
│   └── redis.conf         LRU policy, 256MB, persistence settings
│
├── src/                   React frontend
│   ├── App.jsx            Router setup
│   ├── pages/             Shorten, Links, Analytics pages
│   ├── components/        UI components (form, shell, result card)
│   ├── hooks/             useLinks (localStorage history)
│   └── services/api.js    HTTP client to backend
│
└── postman/
    └── TinyURL-Shortener.postman_collection.json
```

---

## 15. Interview Cheat Sheet

### "Why Redis if you have Postgres?"

Redirect is read-heavy (100:1 read vs write). Redis serves cache hits in ~7ms vs ~25-40ms DB query. At scale, that difference matters enormously.

### "Why two API containers?"

Horizontal scaling. Stateless Express apps behind Nginx share one DB and one Redis. `least_conn` distributes load. Proven 50/50 split in benchmarks.

### "What if Redis goes down?"

Cache-aside with graceful bypass. Redirects still work from Postgres. `X-Cache: BYPASS` header. System degrades, doesn't fail.

### "Why 301 not 302?"

301 = permanent redirect. Browsers and CDNs cache it. Fewer repeat hits to your server for popular links.

### "How do you prevent abuse?"

Two-layer rate limiting (Nginx + Express), SSRF blocks, connection limits, body size caps, IP hashing for privacy.

### "How do you generate unique short codes?"

Postgres `BIGSERIAL` counter → Base62 encode → 2 random suffix chars → unique index on `short_code` with retry on collision.

### "Why async analytics?"

Redirect must be fast. Click tracking goes to in-memory queue, flushed in batches every 1s. User gets 301 immediately; analytics catches up within a second.

---

*Last updated: June 2026*

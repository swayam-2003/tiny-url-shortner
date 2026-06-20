# TinyURL Shortener — Complete Runbook

Step-by-step tutorial to run every component: PostgreSQL, Redis, API, React UI, Nginx load balancer, and benchmarks.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 20+ | Frontend + backend dev |
| Docker Desktop | Latest | Redis, PostgreSQL, Nginx, k6 |
| Git | Any | Clone repo |

---

## 1. First-Time Setup

```bash
# Clone and enter project
git clone https://github.com/swayam-2003/tiny-url-shortner.git
cd tiny-url-shortner

# Copy environment file
cp .env.example .env
```

Edit `.env`:

```env
# Docker PostgreSQL (default — port 5433):
DATABASE_URL=postgresql://postgres:password@localhost:5433/shortner

# OR your local PostgreSQL (port 5432):
# DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/shortner

REDIS_URL=redis://localhost:6379
PORT=3001
BASE_URL=http://localhost:3001
VITE_API_URL=http://localhost:3001
```

Install dependencies:

```bash
npm install
cd backend && npm install && cd ..
```

---

## 2. Start Infrastructure (Redis + PostgreSQL)

```bash
docker compose up -d
```

Verify:

```bash
docker compose ps
```

Expected:

| Container | Port | Status |
|-----------|------|--------|
| `redis` | 6379 | healthy |
| `postgres` | 5433 | healthy |

Test connections:

```bash
# Redis
docker exec tiny-url-shortner-redis-1 redis-cli ping
# → PONG

# PostgreSQL
docker exec tiny-url-shortner-postgres-1 pg_isready -U postgres -d shortner
# → accepting connections
```

---

## 3. Mode A — Local Development (Recommended for coding)

Best for active development with hot-reload.

**Terminal 1 — Backend API:**
```bash
npm run dev:backend
```
→ `http://localhost:3001`

**Terminal 2 — React Frontend:**
```bash
npm run dev:frontend
```
→ `http://localhost:5173`

**Verify:**
```bash
curl http://localhost:3001/health
curl -X POST http://localhost:3001/api/v1/urls \
  -H "Content-Type: application/json" \
  -d "{\"longUrl\":\"https://google.com\"}"
```

Open `http://localhost:5173` in browser → shorten URLs from the UI.

---

## 4. Mode B — Full Production Stack (Nginx + 2 API Replicas)

Best for load balancer testing and production-like demos.

```bash
docker compose --profile full up -d --build
```

This starts:

| Service | Role | Access |
|---------|------|--------|
| `nginx` | Load balancer + reverse proxy | `http://localhost` (port 80) |
| `api1` | API replica 1 | internal only |
| `api2` | API replica 2 | internal only |
| `frontend` | React dev server | proxied via Nginx |
| `redis` | Cache | port 6379 |
| `postgres` | Database | port 5433 |

**Verify Nginx + load balancer:**
```bash
curl -I http://localhost/health
# Look for: X-Server-Id: api1 or api2
# Look for: X-Upstream-Addr: 172.x.x.x:3001
```

**Stop full stack:**
```bash
docker compose --profile full down
```

---

## 5. Component Reference

### Redis (Cache)

```bash
# Start/stop/restart
docker compose up -d redis
docker compose stop redis
docker compose start redis

# View cache keys
docker exec tiny-url-shortner-redis-1 redis-cli KEYS "url:*"

# Check memory policy
docker exec tiny-url-shortner-redis-1 redis-cli INFO memory
```

Policy: `cache-aside`, `allkeys-lru`, 256MB max, 24h TTL per key.
Config file: [`redis/redis.conf`](redis/redis.conf)

### PostgreSQL (Database)

```bash
# Connect via psql (Docker)
docker exec -it tiny-url-shortner-postgres-1 psql -U postgres -d shortner

# Useful queries
SELECT short_code, long_url, click_count FROM urls ORDER BY created_at DESC LIMIT 10;
SELECT COUNT(*) FROM url_clicks;
```

Migrations run automatically on API startup.
Schema: [`backend/migrations/001_init.sql`](backend/migrations/001_init.sql)

### Nginx (Load Balancer)

```bash
# Check nginx status
docker logs tiny-url-shortner-nginx-1 --tail 20

# Reload after config change
docker compose restart nginx
```

Config: [`nginx/nginx.conf`](nginx/nginx.conf)
- Algorithm: `least_conn`
- Rate limits: shorten 5/s · redirect 100/s · API 30/s
- Replicas: `api1:3001`, `api2:3001`

### API Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| `POST` | `/api/v1/urls` | Shorten URL |
| `GET` | `/api/v1/urls/:code` | Metadata |
| `GET` | `/api/v1/urls/:code/analytics` | Click stats |
| `DELETE` | `/api/v1/urls/:code` | Deactivate |
| `GET` | `/:code` | 301 redirect |
| `GET` | `/health` | Health check |
| `GET` | `/api/v1/cache/stats` | Redis policy info |

---

## 6. Running Benchmarks

See **[BENCHMARKS.md](BENCHMARKS.md)** for full details.

Quick commands:

```bash
# Internal Node.js benchmark (POST + GET + LB check)
npm run benchmark:full

# Via Nginx load balancer
$env:BENCHMARK_URL="http://localhost"; npm run benchmark:full   # PowerShell
BENCHMARK_URL=http://localhost npm run benchmark:full            # Bash

# k6 load tests (requires Docker)
npm run benchmark:k6              # 50 VUs redirect stress
npm run benchmark:k6:nginx        # Nginx LB distribution
npm run benchmark:k6:mixed        # 100:1 read/write ratio

# Redis BYPASS test
docker compose stop redis
npm run benchmark:redis-down
docker compose start redis
```

---

## 7. Troubleshooting

| Problem | Fix |
|---------|-----|
| `password authentication failed` | Fix `DATABASE_URL` in `.env` |
| `Redis connection refused` | `docker compose up -d redis` |
| `Nginx restarting` | Check `docker logs tiny-url-shortner-nginx-1` — regex in config must be quoted |
| `429 Too Many Requests` | Rate limit hit — wait 60s or reduce request rate |
| `port 80 already in use` | Stop other web servers or change nginx port in `docker-compose.yml` |
| Backend won't start | Ensure Postgres is healthy: `docker compose ps` |

---

## 8. Stopping Everything

```bash
# Stop infra only
docker compose down

# Stop full stack
docker compose --profile full down

# Stop and remove volumes (fresh DB)
docker compose down -v
```

---

## 9. Quick Reference Card

```bash
# MINIMAL (dev)
docker compose up -d && npm run dev:all

# FULL (production-like)
docker compose --profile full up -d --build

# BENCHMARK
npm run benchmark:full
npm run benchmark:k6:nginx

# HEALTH
curl http://localhost:3001/health
curl http://localhost/health          # via Nginx
```

---

*For architecture and system design concepts see [EXPLAINATION.md](EXPLAINATION.md). For API details see [README.md](README.md).*

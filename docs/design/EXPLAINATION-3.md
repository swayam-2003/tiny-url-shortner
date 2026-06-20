# TinyURL Shortener — HLD, LLD & Database Design (Interview Guide)

This document is written for system design interviews. It explains **what** I built, **how** I designed it, and **why** I made each decision — in narrative form, the way you would walk an interviewer through a whiteboard session. If you have read `EXPLAINATION.md` (concepts) or `EXPLAINATION-2.md` (file-by-file walkthrough), this document sits between them: it is the design story from requirements to implementation.

---

## How I Approached the Design

When I started this project, I treated it the way I would approach a real system design interview. I did not begin with technology choices. I began with constraints. A URL shortener sounds simple until you ask who uses it, how often links get clicked versus created, and what happens when a link goes viral. Industry estimates put the read-to-write ratio at roughly 100:1 — for every URL shortened, it might be clicked a hundred times. That single number shaped almost everything: caching strategy, database indexing, load balancing, and the decision to keep analytics off the redirect hot path.

I also asked what "production-grade" means for a portfolio project. It does not mean running Kubernetes with twelve microservices. It means the system demonstrates the patterns interviewers expect: horizontal scaling, cache-aside, rate limiting, graceful degradation, observability headers, and security controls that survive scrutiny. I chose a modular monolith — one deployable backend with clear internal layers — behind Nginx, with two stateless API replicas, PostgreSQL as source of truth, and Redis as an acceleration layer. This is the same shape Bitly or TinyURL would use at moderate scale, simplified to what one engineer can build and explain confidently.

---

## High-Level Design (HLD)

### Functional Requirements

The system must accept a long URL and return a short URL. When someone visits the short URL, the browser receives an HTTP redirect to the original destination. Users can optionally provide a custom alias instead of an auto-generated code. Links can expire after a configurable period and can be deactivated. The system tracks click analytics — total count, recent clicks, referrers, and user agents — without slowing down redirects.

### Non-Functional Requirements

Redirects must feel instant. I targeted single-digit millisecond latency on cache hits and sub-fifty-millisecond P95 under sustainable load, which I later validated with k6. The system must be highly available: Redis failure must not take down redirects. Short codes must not be predictable — an attacker should not enumerate `abc1`, `abc2`, `abc3` and discover every link in the database. The API must scale horizontally by adding replicas, which requires stateless application servers and shared external state in PostgreSQL and Redis. Finally, the system must resist abuse through layered rate limiting and SSRF protection at URL creation time.

### Capacity Estimation (Interview Math)

In an interview I would state assumptions explicitly. Suppose we handle 1,000 URL creations per second and 100,000 redirects per second at peak. Each shortened URL mapping is roughly 500 bytes in PostgreSQL (short code, long URL, metadata). At 1,000 writes per second for one year, that is about 31 billion URLs — unrealistic for a demo, but the math matters. 500 bytes × 31B ≈ 15 TB of raw data over a year at that write rate. In practice a portfolio system handles millions, not billions, of URLs. The important insight is that storage grows with writes, but read traffic dominates infrastructure cost. That is why I invested engineering effort in Redis and Nginx rather than in write-path optimization.

For redirect throughput, if each cache hit costs roughly 2–7 ms of server time, a single Node.js process can handle thousands of redirects per second on cache hits. At 100,000 redirects per second you would need either many replicas or an edge CDN caching 301 responses. My design supports scaling to multiple API replicas today and CDN offload tomorrow without architectural changes.

### HLD Architecture — The Four Layers

At the highest level, the system has four layers: client, edge, application, and data.

The **client layer** is a React single-page application built with Vite. It provides a form to shorten URLs, a page to view locally stored link history, and an analytics view. The frontend is deliberately thin — it does not generate short codes or manage caching. It calls a REST API and follows redirects like any other HTTP client. This separation matters in interviews because it shows the backend can serve mobile apps, browser extensions, or partner integrations without changing core logic.

The **edge layer** is Nginx. In production Docker mode, every request enters on port 80 through Nginx before reaching any application code. Nginx is not decorative. It is the first line of defense: per-IP rate limits, connection limits, blocking of scanner paths like `.env` and `wp-admin`, security headers on every response, and load balancing across API replicas using the `least_conn` algorithm. I chose `least_conn` over round-robin because redirect latency is bimodal — a Redis cache hit completes in milliseconds, while a cache miss requires a PostgreSQL round trip and takes longer. Sending the next request to the replica with fewer open connections avoids piling work onto a server already waiting on a slow database query.

The **application layer** consists of two identical Express servers written in TypeScript, labelled `api1` and `api2` in Docker Compose. They are the same codebase, the same Docker image, differing only in the `SERVER_ID` environment variable which surfaces as an `X-Server-Id` response header for debugging and load-test verification. Both replicas are stateless. They hold no URL mappings in memory between requests. Any replica can handle any request because all shared state lives in PostgreSQL and Redis. This is the property that makes horizontal scaling work: when redirect traffic doubles, you add `api3` and `api4` to the Nginx upstream block.

The **data layer** has two stores with fundamentally different roles. PostgreSQL is the source of truth — durable, queryable, ACID-compliant. Redis is ephemeral acceleration — fast reads, atomic counters, and LRU eviction when memory fills. They are not redundant copies of each other. PostgreSQL answers questions like "show me click counts grouped by day for the last week." Redis answers "given short code `aB3xK`, what is the long URL?" in under a millisecond.

### HLD — Request Routing Overview

There are two distinct hot paths, and I designed them differently on purpose.

The **write path** (`POST /api/v1/urls`) is infrequent and can tolerate slightly higher latency. A user submits a JSON body with a long URL. The request passes through Nginx's shorten rate limiter (five requests per second per IP), lands on whichever API replica has fewer connections, and flows through the controller-service-repository chain. The service validates the URL, generates or reuses a short code, inserts into PostgreSQL, warms Redis, and returns the short URL. This path touches both data stores synchronously, which is acceptable because writes are rare.

The **read path** (`GET /{shortCode}`) is the performance-critical path. A browser or HTTP client requests a short link. Nginx matches the path against a regex for valid short-code patterns and applies the redirect rate limiter (one hundred requests per second per IP). The API checks Redis first. On a hit, the long URL is returned immediately, a click event is enqueued asynchronously, and the server responds with HTTP 301. On a miss, PostgreSQL is queried, Redis is populated for next time, and the redirect proceeds. The user never waits for analytics to be written. That decoupling is a deliberate HLD decision: observability must not block the latency-critical path.

### HLD — Why Not Microservices?

Interviewers often ask this. I considered splitting into a "URL Creation Service" and a "Redirect Service" as separate deployables, which is what GeeksforGeeks and Hello Interview describe at scale. I stayed with a modular monolith because at this scale the operational cost of separate deploy pipelines, separate monitoring, and distributed transactions outweighs the benefit. Internally, `UrlService` and `RedirectService` are already separate modules with separate responsibilities. Nginx already routes traffic as if they were independent. Extracting them into separate processes later would require changing deployment, not rewriting business logic. That is the answer interviewers want: design for separation of concerns now, defer the network boundary until scale demands it.

---

## Database Design

### Why PostgreSQL and Not NoSQL?

This is one of the most common interview questions for URL shorteners. DynamoDB, Cassandra, and other wide-column stores excel at horizontal write scaling and can serve key-value lookups at massive throughput. I chose PostgreSQL for four concrete reasons.

First, URL creation requires strong uniqueness guarantees. A duplicate short code is a data corruption event — two different long URLs must never map to the same code. PostgreSQL enforces this with a unique constraint on `short_code` and returns error code `23505` on collision, which my application catches and retries. Achieving the same guarantee in an eventually consistent NoSQL store requires compare-and-swap logic or distributed locking, which adds complexity I did not need at this scale.

Second, analytics queries are relational. "Give me click counts grouped by day for the last seven days" is a `GROUP BY` with a date range filter. SQL handles this naturally. In Cassandra you would denormalize into a separate table partitioned by date, which is the right approach at billions of events, but premature for a system at millions.

Third, the access pattern for redirects is a single-point lookup by `short_code`, which is O(log n) with a B-tree index — effectively constant time for any realistic table size. I do not need NoSQL's write scalability when my bottleneck is reads, not writes.

Fourth, operational simplicity. One PostgreSQL instance (or a managed Neon/Supabase instance in production) with connection pooling is easier to reason about, back up, and migrate than a sharded cluster.

### Schema Design — The `urls` Table

The `urls` table is the core entity. Every shortened link is one row.

```sql
CREATE TABLE urls (
  id            BIGSERIAL PRIMARY KEY,
  short_code    VARCHAR(12) NOT NULL UNIQUE,
  long_url      TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  is_active     BOOLEAN DEFAULT TRUE,
  click_count   BIGINT DEFAULT 0
);
```

I used `BIGSERIAL` for `id` because URL shorteners eventually accumulate millions or billions of rows, and a 32-bit integer overflows at roughly 2.1 billion. `BIGSERIAL` gives me a 64-bit auto-incrementing primary key that serves double duty: it is the internal row identifier and the input to Base62 encoding for auto-generated short codes.

`short_code` is `VARCHAR(12)` because auto-generated codes are Base62-encoded counter values plus a two-character random suffix, and custom aliases are capped at twelve characters by validation. The `UNIQUE` constraint is non-negotiable — it is the database-level guarantee that no two rows share a code, regardless of application bugs or race conditions between API replicas.

`long_url` is `TEXT` rather than `VARCHAR(2048)` because PostgreSQL stores TEXT efficiently and I validate length at the application layer (maximum 2048 characters, matching common browser limits). Using TEXT avoids arbitrary database-level truncation surprises.

`expires_at` is nullable. A null value means the link never expires. The default expiry is approximately five years (1,825 days), configurable via `DEFAULT_EXPIRY_DAYS`. I made expiration optional because some use cases — personal bookmarks, marketing campaigns with known end dates — have different lifetimes.

`is_active` implements soft deletion. When a user deactivates a link, I set `is_active = FALSE` rather than deleting the row. This preserves analytics history in `url_clicks` (which references `urls.id` via foreign key) and allows future audit trails. On deactivation I also invalidate the Redis cache entry so deactivated links stop redirecting immediately even if a cached copy existed.

`click_count` is a denormalized counter. The authoritative click data lives in `url_clicks`, but maintaining a running total on the `urls` row avoids `SELECT COUNT(*)` on every analytics page load. The counter is updated asynchronously by the analytics worker, so it may lag by up to one second under load. That is an acceptable tradeoff for a dashboard metric.

### Schema Design — The `url_clicks` Table

```sql
CREATE TABLE url_clicks (
  id          BIGSERIAL PRIMARY KEY,
  url_id      BIGINT REFERENCES urls(id) ON DELETE CASCADE,
  clicked_at  TIMESTAMPTZ DEFAULT NOW(),
  ip_hash     VARCHAR(64),
  user_agent  TEXT,
  referer     TEXT
);
```

This table stores one row per click event. I separated it from `urls` because the cardinality is wildly different: one URL row might have thousands or millions of click rows. Mixing them would bloat the primary table and slow down redirect lookups.

`url_id` is a foreign key with `ON DELETE CASCADE`. If a URL row is ever hard-deleted, its click history goes with it. In practice I soft-delete, so cascade rarely fires, but the constraint enforces referential integrity.

`ip_hash` stores a SHA-256 hash of the client IP, not the raw IP. This is a privacy decision. Analytics need coarse geographic or uniqueness signals, not personally identifiable IP addresses stored in plaintext. In an interview I would mention GDPR and that hashing is one-way — you cannot recover the IP from the hash, but you can compare hashes for duplicate detection.

`user_agent` and `referer` are stored as-is because they are standard analytics dimensions and are not personally identifying on their own.

### Indexing Strategy

Indexes exist to match access patterns, and I designed three of them deliberately.

The index on `short_code` (`idx_urls_short_code`) is the most important index in the entire system. Every redirect executes `SELECT ... FROM urls WHERE short_code = $1`. Without this index, PostgreSQL performs a sequential scan — reading every row in the table — which degrades linearly as data grows. With the unique B-tree index, lookup is O(log n), which for a table with ten million rows means roughly twenty-three index hops. Effectively constant time.

The partial index on `expires_at WHERE is_active = TRUE` (`idx_urls_expires_at`) supports a background cleanup job that would query active, expired links for batch deactivation. A partial index is smaller and faster than a full index because it only includes rows where `is_active = TRUE`, excluding deactivated links that will never need expiration checks.

The composite index on `url_clicks(url_id, clicked_at DESC)` (`idx_clicks_url_id`) supports the analytics query "show me the ten most recent clicks for this URL" and the seven-day aggregation grouped by date. The `DESC` ordering on `clicked_at` lets PostgreSQL read recent clicks without a separate sort step.

I deliberately did not index `long_url`. The only query by long URL is deduplication during creation (`SELECT ... WHERE long_url = $1`), which is infrequent. Adding an index on a TEXT column would slow every insert for a query that runs once per URL creation. If deduplication became hot, I would add a hash column (`long_url_hash SHA256`) with an index on the hash, keeping the index narrow.

### ER Relationship (Narrative)

One URL has many clicks. That is a classic one-to-many relationship. The `urls` table is the parent; `url_clicks` is the child. I did not normalize click metadata into separate `user_agents` or `referers` dimension tables because at this scale the storage savings are negligible and the join cost on analytics queries is not worth it. At billions of clicks, I would consider pre-aggregated daily summary tables or a time-series store like TimescaleDB.

---

## Base62 Encoding — Why, How, and the Full Algorithm

This section is the one interviewers drill into most deeply on URL shortener problems. I will explain it the way I would on a whiteboard.

### The Problem Base62 Solves

I need a short, URL-safe string that uniquely identifies a row in the `urls` table. The string appears in every short link (`https://mysite.com/aB3xK`), so it must be compact, contain only characters that are safe in URLs without encoding, and — critically — not be guessable by attackers scanning sequential values.

There are three common approaches in system design literature: hashing, random generation, and counter-based encoding. I use counter-based encoding with a security suffix, and I will explain why I rejected the alternatives.

### Why Not Hash the Long URL?

The hash approach (MD5 or SHA-256 truncated to seven characters) maps a long URL to a fixed-length code deterministically. The same long URL always produces the same hash, which gives deduplication for free. Bitly uses a variant of this.

I rejected pure hashing for two reasons. First, collisions. If I truncate a SHA-256 hash to seven Base62 characters, I have 62^7 ≈ 3.5 trillion possible codes. By the birthday paradox, collision probability becomes non-trivial at roughly the square root of the code space — around 1.8 million URLs. That sounds large, but collision handling (detect, re-hash with a salt, retry) adds complexity. Second, predictability is not the main concern with hashes — but reversibility is not either, which is good. The real issue is that hash-based codes are not ordered, so you cannot estimate system volume from the code, but you also cannot use a simple counter for ID generation.

I do use deduplication separately: before generating a new code, I check if the long URL already exists and return the existing short code. This gives me the deduplication benefit of hashing without the collision math.

### Why Not Random Strings?

Generating a random six-character Base62 string gives 62^6 ≈ 56 billion possibilities. With random generation, every insert requires a collision check — `SELECT` to see if the code exists, retry if it does. At low volume this is fine. At thousands of inserts per second, the check-then-insert pattern creates race conditions between replicas unless you use database-level locking. Two API servers could generate the same random code simultaneously, both pass the existence check, and one insert fails on the unique constraint. I handle this with retry logic, but it is wasteful.

Random codes are also not ordered, which makes no difference functionally but means you cannot use the code itself as a cursor for pagination or sharding.

### Why Base62 Specifically?

Base62 uses the alphabet `0-9`, `a-z`, `A-Z` — sixty-two characters. It is the standard encoding for URL shorteners because every output character is URL-safe. No percent-encoding needed.

Compare with alternatives. Base64 uses `+` and `/`, which have special meaning in URLs and query strings. Hexadecimal (Base16) only uses `0-9` and `a-f`, producing strings twice as long for the same amount of information. Base36 (lowercase alphanumeric only) is case-insensitive-safe but loses the entropy per character that mixed case provides. Base62 is the sweet spot: maximum information density with full URL safety.

The information-theoretic argument: each Base62 character encodes log₂(62) ≈ 5.95 bits of information. Six characters encode roughly 36 bits. Seven characters encode roughly 42 bits. With seven Base62 characters I have 62^7 = 3,521,614,606,208 possible codes — over 3.5 trillion. At one thousand new URLs per second, that space lasts over a hundred years before exhaustion. In practice I append a two-character random suffix, which multiplies the space further and breaks sequential predictability.

### How Base62 Encoding Works — Step by Step

The encoding function takes a non-negative integer and repeatedly divides by sixty-two, using the remainder as an index into the alphabet. This is the same principle as converting decimal to binary, but with base sixty-two instead of base two.

Take counter value `125` as a concrete example.

```
125 ÷ 62 = 2 remainder 1   → character index 1 = '1'
2   ÷ 62 = 0 remainder 2   → character index 2 = '2'
```

Reading remainders bottom to top: `125` encodes to `"21"` in Base62.

A larger example: counter value `12345`.

```
12345 ÷ 62 = 199 remainder 7  → '7'
199   ÷ 62 = 3 remainder 13   → 'd'
3     ÷ 62 = 0 remainder 3    → '3'
```

Result: `"3d7"`. Three characters for a number that would be five digits in decimal.

The implementation in `backend/src/utils/base62.ts` does exactly this in a loop:

```typescript
while (n > 0) {
  result = BASE62_CHARS[n % 62] + result;
  n = Math.floor(n / 62);
}
```

Decoding (not needed in my system but interviewers ask) reverses the process: multiply each character's index by increasing powers of sixty-two and sum.

### The Counter — Where Uniqueness Comes From

The integer fed into Base62 comes from a monotonically increasing counter. I store this counter in Redis as key `url:counter` and increment it atomically with `INCR`. Redis `INCR` is atomic at the server level — even if `api1` and `api2` call `INCR` at the exact same microsecond, Redis serializes the operations and returns different values. This is why the counter lives in Redis rather than in application memory: a local counter on each replica would produce duplicates.

If Redis is unavailable, the `CounterRepository` falls back to PostgreSQL's `BIGSERIAL` sequence on the `urls.id` column via `nextval(pg_get_serial_sequence('urls', 'id'))`. PostgreSQL sequences are also atomic within a single database. The fallback path is slower (network round trip to Postgres versus sub-millisecond Redis), but it preserves correctness. This is graceful degradation applied to ID generation, the same principle I apply to caching.

### The Random Suffix — Why Encoding Alone Is Not Enough

If I used only Base62(counter), codes would be sequential and partially predictable. After seeing `3d7` and `3d8`, an attacker knows `3d9` probably exists. The counter-based approach without a suffix is how early TinyURL worked, and it was vulnerable to enumeration attacks.

I append two random Base62 characters to every auto-generated code. The function `randomBase62(2)` uses `crypto.getRandomValues` — cryptographically secure random bytes — to pick two characters from the alphabet. This adds 62² = 3,844 possibilities per counter value. The final code for counter `12345` might be `3d7xK` or `3d7Qm` or any of 3,844 variants.

An attacker who knows the counter is `12345` still cannot guess the full code without brute-forcing 3,844 possibilities. Combined with rate limiting (two hundred redirects per minute per IP at the Express layer, one hundred per second at Nginx), enumeration becomes impractical.

### Collision Handling

Even with a counter and random suffix, two paths can produce the same `short_code`: custom alias collision (user picks a taken alias) and the astronomically rare case of random suffix collision on the same counter. PostgreSQL's `UNIQUE` constraint on `short_code` is the final safety net. On insert failure with error code `23505` (unique violation), `UrlService.shorten()` retries up to three times with a new random suffix. Custom alias collisions return HTTP 409 immediately without retry, because retrying would produce a different alias — the user must pick a new one.

### Custom Aliases — A Separate Path

When a user provides a custom alias, the counter and Base62 encoding are bypassed entirely. The alias is validated against a regex (`^[a-zA-Z0-9_-]{3,12}$`), checked against a reserved-word list (`api`, `health`, `admin`, etc.), and inserted directly as the `short_code`. This is the Bitly "custom back-half" feature. The tradeoff is that custom aliases are user-chosen and therefore more likely to collide, which is why the reserved-word check exists — without it, a user could claim `/api` and break routing.

---

## Low-Level Design (LLD)

### Layered Architecture

Inside each API replica, I follow a strict four-layer architecture: controller, service, repository, and configuration/utilities. This is the LLD answer to "how is the code organized?"

**Controllers** are thin HTTP adapters. `UrlController` receives Express `Request` and `Response` objects, extracts parameters, calls the appropriate service method, and formats the JSON response. Controllers do not contain business rules. `RedirectController` is even thinner — it calls `redirectService.resolve()`, sets headers (`X-Cache`, `X-Response-Time`), fires async click tracking, and issues `res.redirect(301, longUrl)`.

**Services** contain business logic. `UrlService` knows how to shorten a URL: validate, deduplicate, generate code, insert, cache. `RedirectService` knows how to resolve a redirect: check cache, fall back to database, populate cache, return result. Services do not know about HTTP status codes directly — they throw `AppError` with a code like `NOT_FOUND` or `SSRF_BLOCKED`, and the error handler middleware translates those into HTTP responses. This means I can test `UrlService.shorten()` in a unit test without mocking Express.

**Repositories** talk to external stores. `UrlRepository` runs SQL against PostgreSQL. `CacheRepository` runs commands against Redis. `CounterRepository` manages the ID counter in Redis with Postgres fallback. Repositories do not contain business rules — they do not know what a "valid" URL is. They only know how to `findByShortCode`, `create`, `set`, `get`, and `invalidate`.

**Middleware** wraps the request pipeline. `requestIdMiddleware` assigns a UUID to every request and exposes it as `X-Request-Id`. `serverIdMiddleware` adds `X-Server-Id` from the `SERVER_ID` env var. `securityMiddleware` blocks oversized URIs and scanner paths. `rateLimiter` enforces per-endpoint Express rate limits. `errorHandler` catches all errors and returns consistent JSON error bodies. `asyncHandler` wraps async route handlers so promise rejections propagate to the error handler instead of crashing the process.

### LLD — Write Path in Detail

When `POST /api/v1/urls` arrives, the middleware chain runs first. Request ID is assigned. Server ID header is prepared. Security checks pass. The body is parsed as JSON with a sixteen-kilobyte limit. Pino logs the request with the request ID attached.

The route matches `router.post('/urls', shortenRateLimiter, shortenUrl)` inside `v1Routes.ts`. The shorten-specific rate limiter (twenty per minute) applies before the controller runs.

`UrlController.shortenUrl` extracts `longUrl`, optional `customAlias`, and optional `expiresInDays` from the body. It calls `urlService.shorten()`.

Inside `UrlService.shorten()`, the first step is `validateLongUrl()`. This checks the URL is non-empty, matches an HTTP/HTTPS regex, is under 2048 characters, does not use dangerous protocols (`javascript:`, `data:`, `file:`), and does not point to private IP ranges. The SSRF check uses a regex for `127.x`, `10.x`, `192.168.x`, `172.16-31.x`, and `localhost`. If any check fails, an `AppError` with code `SSRF_BLOCKED` or `INVALID_URL` is thrown and the error handler returns HTTP 400.

If a custom alias was provided, the alias path runs: validate format, check reserved words, check uniqueness with `urlRepository.findByShortCode()`, insert, cache, return. Done.

Otherwise the auto-generate path runs. First, deduplication: `urlRepository.findByLongUrl()` checks if this exact long URL already has an active short link. If yes, return the existing one without creating a new row.

If no duplicate exists, the generation loop begins. `counterRepository.nextId()` returns the next integer. `generateShortCode(counterId)` encodes it in Base62 and appends two random characters. `urlRepository.create()` inserts the row. If Postgres returns error `23505` (unique violation), the loop retries with a new random suffix, up to three attempts. On success, `cacheRepository.set()` warms Redis so the first redirect is a cache hit. The result is returned to the controller, which sends HTTP 201 with the short URL.

### LLD — Read Path in Detail

When `GET /aB3xK` arrives, the route `app.get('/:shortCode', redirectRateLimiter, redirectHandler)` matches. The redirect rate limiter (two hundred per minute per IP) applies.

`RedirectController` checks reserved paths (`api`, `health`, `favicon.ico`) and passes them to the 404 handler instead of treating them as short codes.

`redirectService.resolve('aB3xK')` begins timing with `performance.now()`. The short code is validated against the format regex. Then `cacheRepository.get('aB3xK')` checks Redis key `url:aB3xK`.

If Redis returns a value, the result is `{ longUrl, cacheStatus: 'HIT', latencyMs }`. If Redis returns null (key does not exist), the status is `MISS` and the service queries `urlRepository.findByShortCode()`. If the row does not exist, `AppError(404)` is thrown. If the row exists but `is_active` is false or `expires_at` is in the past, `AppError(410)` is thrown (Gone). On a valid row, `cacheRepository.set()` populates Redis, and the result is `{ longUrl, cacheStatus: 'MISS', latencyMs }`.

If Redis itself is down, `cacheRepository.get()` catches the error, logs a warning, and returns `{ value: null, status: 'BYPASS' }`. The service falls through to PostgreSQL. The redirect still works. The response header says `X-Cache: BYPASS`. This is the graceful degradation path I would demonstrate in an interview by stopping the Redis container and showing redirects still succeed.

Back in the controller, `redirectService.trackClick()` is called without `await`. It looks up the URL record and enqueues a click event to the analytics worker. The HTTP response is sent immediately: `301 Moved Permanently` with `Location` set to the long URL, plus `X-Cache` and `X-Response-Time` headers.

### LLD — Analytics Worker

The analytics worker is an in-process queue, not a separate service or message broker. I made this choice because extracting Kafka or RabbitMQ for a portfolio project adds operational complexity without demonstrating a new design principle — the principle is "decouple slow writes from the fast read path," and an in-memory queue proves that principle.

`AnalyticsQueue` holds an array of `ClickEvent` objects. `enqueue()` pushes events. A `setInterval` fires every one second to flush. Additionally, if the queue reaches ten items, an immediate flush triggers. Each flush takes up to ten events, marks the queue as processing (to prevent concurrent flushes), and runs `Promise.all` over the batch: insert into `url_clicks`, increment `urls.click_count`. If the batch fails, events are pushed back to the front of the queue.

The tradeoff is durability: if the API process crashes between enqueue and flush, those click events are lost. In production at scale, I would replace this with a persistent queue (Redis Streams, Kafka, SQS). For the design interview, I explain the principle and name what I would upgrade.

### LLD — Error Handling Contract

Every error in the system flows through a single `errorHandler` middleware. `AppError` is a typed error class with `statusCode`, `code` (machine-readable string like `NOT_FOUND`), and `message` (human-readable). The handler returns:

```json
{ "error": true, "code": "NOT_FOUND", "message": "Short link not found" }
```

Unknown errors return HTTP 500 with a generic message; the full stack trace is logged by Pino but never exposed to the client. This consistent contract means the React frontend can display meaningful error messages by reading `code`, and API consumers can branch on it programmatically.

---

## Caching Design Decisions

I chose cache-aside (lazy loading) over read-through or write-through because the application needs explicit control over cache lifecycle. In cache-aside, the application checks Redis, and on miss, reads Postgres and writes Redis itself. This means I can skip caching for deactivated URLs, set custom TTLs per key, and mark responses `BYPASS` when Redis is down — none of which a transparent read-through cache supports without additional configuration.

The TTL is twenty-four hours (`REDIS_TTL_SECONDS=86400`). After twenty-four hours, a cached key expires even if the URL is still active. The next redirect is a cache miss, queries Postgres, and re-warms Redis. I chose twenty-four hours as a balance: long enough that hot links stay in cache indefinitely (they are re-warmed on every miss), short enough that deactivated or expired links eventually fall out of cache even if invalidation was missed.

Redis memory is capped at 256 MB with `allkeys-lru` eviction. When memory fills, Redis evicts the least recently used keys across the entire keyspace. I chose `allkeys-lru` over `volatile-lru` because my counter key (`url:counter`) has no TTL. Under `volatile-lru`, that key would never be evicted, which could cause OOM errors if the cache grows unbounded. Under `allkeys-lru`, cold links are evicted under memory pressure while hot links stay resident because they are accessed frequently. This is exactly the access pattern a URL shortener exhibits: a small percentage of links receive the vast majority of clicks (power law distribution).

---

## Security Design Decisions

Security is layered, and I designed each layer to catch what the previous layer cannot.

Nginx is the outer shell. It blocks known attack paths (`.git`, `.env`, WordPress probes), limits connections per IP to twenty, caps request body size at sixteen kilobytes, and enforces per-endpoint rate limits before traffic reaches Node.js. Nginx rate limiting uses a leaky-bucket algorithm with burst allowances — for redirects, one hundred requests per second with a burst of fifty — which absorbs legitimate traffic spikes while blocking sustained floods.

Express is the second layer. Separate rate limiters per endpoint type reflect abuse economics: creating URLs is expensive for the system and attractive to spammers (twenty per minute), while redirects are the core product and must not be blocked for legitimate users (two hundred per minute). The general API limiter (one hundred per fifteen minutes) catches scraping of metadata and analytics endpoints.

Application-level security handles threats Nginx cannot see. SSRF validation inspects the URL content at creation time. IP hashing protects user privacy in analytics. Request IDs enable tracing a specific abuse pattern across logs. The `X-Cache` and `X-Server-Id` headers are not security features themselves, but they support incident investigation.

---

## Load Balancing and Horizontal Scaling Design

I designed the system so that scaling is a configuration change, not a code change. Adding a third API replica means adding one line to the Nginx upstream block and one service to Docker Compose. No code changes, no shared-nothing refactoring, no session migration.

The `least_conn` algorithm is significant. Round-robin alternates requests blindly: request one to api1, request two to api2, request three to api1. If request one is a cache miss taking forty milliseconds and request two is a cache hit taking two milliseconds, round-robin does not account for this. `least_conn` sends request three to whichever server has fewer in-flight connections, which naturally routes traffic away from a server bogged down with slow queries.

Statelessness is the prerequisite. If I had stored sessions in server memory, or cached URL mappings locally without Redis, adding replicas would cause cache inconsistency — a URL created on api1 would miss on api2's local cache. By centralizing all mutable state in PostgreSQL and Redis, every replica sees the same data.

---

## Tradeoffs I Would Defend in an Interview

**301 versus 302 redirect.** I chose 301 (permanent). Browsers cache it locally, which means repeat clicks from the same user may never hit my server — great for performance, bad for complete analytics. The alternative is 302 (temporary), which forces every click through the server. At Bitly scale, teams use 302 with CDN edge caching at a short TTL as a compromise. I would explain my choice and immediately name the tradeoff and the production upgrade path.

**Deduplication on create.** I check if the long URL already exists and return the existing short code. This costs an extra `SELECT` on every create but saves storage and gives users consistent links. Bitly does not deduplicate — each submission creates a new code. Both are valid; I chose deduplication because the read-heavy ratio makes an extra read on rare writes negligible.

**In-process analytics queue versus Kafka.** The queue proves the async decoupling principle without Kafka operational overhead. I would tell the interviewer: "The design principle is identical; the transport is simplified for this scale."

**PostgreSQL versus DynamoDB.** I chose Postgres for ACID uniqueness, analytics queries, and operational simplicity. I would acknowledge that at billions of URLs with write-heavy sharding requirements, DynamoDB with a composite key of `short_code` as partition key would be the scaling path, and the cache-aside pattern over DynamoDB is well-documented in AWS architecture blogs.

**Counter in Redis versus Snowflake IDs.** Twitter's Snowflake generates distributed unique IDs without a central counter — 64-bit IDs with timestamp, machine ID, and sequence components. I used a Redis counter because it is simpler, sufficient at this scale, and has a Postgres fallback. Snowflake is the answer if I remove the Redis dependency for ID generation entirely.

---

## Common Interview Questions — How I Would Answer

**"Walk me through what happens when a user clicks a short link."**
A browser sends GET to Nginx on port 80. Nginx matches the short-code regex, applies the redirect rate limiter, and proxies to the least-busy API replica. The API checks Redis for the mapping. On a hit, it gets the long URL in about two to seven milliseconds, enqueues a click event to the analytics worker without waiting, sets X-Cache HIT, and returns 301. The browser follows the redirect to the destination. Total user-perceived latency is redirect time plus destination load time.

**"What happens if Redis goes down?"**
Cache repository catches the connection error, logs a warning, returns BYPASS status. Redirect service queries PostgreSQL directly. Redirects continue working at database latency — twenty-five to forty milliseconds instead of two to seven. No 500 errors. When Redis recovers, the next redirect for each code is a miss, re-warms the cache, and hits resume. ID generation also falls back to Postgres sequences.

**"How do you generate unique short codes?"**
Redis INCR on a counter key gives me a monotonically increasing integer. I encode it in Base62 for a compact URL-safe string, append two cryptographically random characters so codes are not sequentially guessable, and insert into Postgres with a unique constraint. On the rare collision, I retry with a new random suffix. Custom aliases skip the counter entirely.

**"Why Base62 and not Base64?"**
Base64 includes plus and slash, which are reserved in URLs. Base62 uses only alphanumeric characters — uppercase, lowercase, and digits — and every character is safe in a URL path without percent-encoding.

**"How would you scale this to a billion URLs?"**
Shard PostgreSQL by short_code prefix or hash range. Add Redis Cluster for cache partitioning. Put CloudFront or another CDN in front to cache 301 responses for hot links at the edge. Replace the in-process analytics queue with Kafka and a dedicated consumer writing to a time-series store. The API replicas remain stateless — scaling them is still just adding instances.

**"How did you validate the design?"**
k6 load tests. At one thousand virtual users with no sleep between requests, the system handled 315,000 requests at 5,200 requests per second with zero crashes. Under sustainable load within rate limits, Redis cache hit rate exceeded ninety-eight percent and P95 redirect latency was under fifty milliseconds. Nginx load balancer test confirmed fifty-fifty distribution between api1 and api2.

---

## Summary — The Design in One Paragraph

I designed a URL shortener around the read-heavy traffic shape, using PostgreSQL as the durable source of truth, Redis as a cache-aside acceleration layer with LRU eviction, and Base62-encoded counter IDs with random suffixes for compact non-guessable codes. The application layer is a stateless modular monolith behind Nginx least-conn load balancing across two replicas, with dual-layer rate limiting and SSRF protection. Redirects return HTTP 301 on the hot path with async analytics decoupled via an in-process queue, and every component degrades gracefully — Redis failure bypasses cache, Postgres sequences replace Redis counters — so the system fails open on performance but never fails closed on correctness.

---

*Companion docs: [EXPLAINATION.md](EXPLAINATION.md) (concepts), [EXPLAINATION-2.md](EXPLAINATION-2.md) (file walkthrough), [BENCHMARKS.md](BENCHMARKS.md) (load test results), [RUNBOOK.md](RUNBOOK.md) (how to run)*

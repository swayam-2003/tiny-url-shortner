# TinyURL Shortener — Complete System Design Explanation

This document explains every system design concept used in this project, from fundamentals to advanced patterns. It assumes you already know the basics of system design (CAP, load balancing, caching, databases) and goes deep into **what** we built, **why** we built it that way, and **how** it maps to real-world engineering decisions.

---

## Table of Contents

1. [The Problem We Are Solving](#1-the-problem-we-are-solving)
2. [Architecture — Explained in Full](#2-architecture--explained-in-full)
3. [Concepts: Basic to Advanced](#3-concepts-basic-to-advanced)
4. [The Write Path (Shortening a URL)](#4-the-write-path-shortening-a-url)
5. [The Read Path (Redirect)](#5-the-read-path-redirect)
6. [Caching Deep Dive](#6-caching-deep-dive)
7. [Security Architecture](#7-security-architecture)
8. [Analytics and Async Processing](#8-analytics-and-async-processing)
9. [Error Handling and Resilience](#9-error-handling-and-resilience)
10. [Observability](#10-observability)
11. [Deployment and Infrastructure](#11-deployment-and-infrastructure)
12. [Tradeoffs and Alternatives](#12-tradeoffs-and-alternatives)
13. [Interview Questions and Counter-Questions](#13-interview-questions-and-counter-questions)

---

## 1. The Problem We Are Solving

A URL shortener takes a long URL like `https://www.geeksforgeeks.org/system-design-url-shortening-service/` and produces a compact alias like `http://localhost:3001/aB3xK9Zq`. When someone visits the short link, the system looks up the original URL and redirects the browser there. This sounds trivial, but at scale it becomes a classic distributed systems problem because the traffic shape is extremely asymmetric: for every one URL that gets created, there might be a hundred or a thousand redirects. Twitter's `t.co`, Bitly, and TinyURL all face the same core tension — writes are infrequent, reads are massive, and redirects must feel instant.

The functional requirements of our system are to shorten URLs, redirect them with HTTP 301, optionally accept custom aliases, expire links after a configurable period, track click analytics, and allow deactivation. The non-functional requirements are what make this an engineering problem rather than a weekend project: the system must be highly available, redirect in single-digit milliseconds for hot links, generate codes that cannot be guessed by attackers, survive Redis failures without crashing, and scale horizontally by adding more API servers behind a load balancer.

---

## 2. Architecture — Explained in Full

### The Big Picture

Our system follows a classic three-tier architecture extended with an edge layer and a cache tier. At the outermost edge, clients — browsers running the React UI, Postman for API testing, or any HTTP client following a short link — send requests into the system. In production mode, those requests first hit **Nginx**, which acts as both a reverse proxy and a load balancer. Nginx is not just routing traffic; it is the first security perimeter. It enforces per-IP rate limits, blocks known attack paths like `.env` and `wp-admin` probes, injects security headers, and distributes requests across multiple stateless API replicas using the `least_conn` algorithm, which sends each new request to the backend server with the fewest active connections rather than blindly alternating in round-robin fashion.

Behind Nginx sit two identical **Express API replicas** written in TypeScript. They are deliberately stateless — no session data, no in-memory URL mappings, no sticky sessions. Any replica can handle any request. This statelessness is what makes horizontal scaling possible: if redirect traffic doubles, you add `api3`, `api4`, and tell Nginx about them. The API layer does not contain business logic directly in route handlers. Instead it follows a **layered architecture**: controllers accept HTTP requests and translate them into service calls, services contain the business rules, and repositories talk to PostgreSQL and Redis. This separation means you can test URL shortening logic without spinning up an HTTP server, and you can swap PostgreSQL for another database by changing only the repository layer.

The **data layer** has two stores with different jobs. PostgreSQL is the source of truth — every short-code-to-long-URL mapping lives here permanently (or until expiration). Redis is an acceleration layer — it holds hot redirect mappings in memory so that the read path avoids hitting PostgreSQL on every click. Redis also holds a distributed counter (`url:counter`) used to generate unique numeric IDs. These two stores are not redundant; they are complementary. PostgreSQL provides durability and complex queries for analytics; Redis provides sub-millisecond reads for the redirect hot path.

The **analytics worker** is an in-process asynchronous queue that decouples click tracking from the redirect response. When a user clicks a short link, the API immediately returns a 301 redirect without waiting for the database write that records the click. The click event is enqueued and flushed to PostgreSQL in batches of ten every second. This is a simplified version of what large systems do with Kafka or RabbitMQ, but the design principle is identical: never let observability work block the latency-critical path.

### Request Flow Through the Layers

When a user submits a long URL through the React frontend, the browser sends a `POST /api/v1/urls` request. In full-stack Docker mode this passes through Nginx's shorten-specific rate limiter (five requests per second per IP), gets proxied to whichever API replica has fewer open connections, and lands in the `UrlController`. The controller validates the JSON body with Zod, calls `UrlService.shorten()`, which validates the URL for format and SSRF safety, obtains the next ID from the Redis counter, encodes it to Base62, appends a random two-character suffix, inserts the row into PostgreSQL, warms the Redis cache, and returns the short URL. The entire write path touches both PostgreSQL and Redis but is dominated by the database insert, which is acceptable because writes are rare.

When a user clicks a short link, the read path is entirely different in character. The browser sends `GET /aB3xK9Zq`. Nginx matches this against a regex for valid short-code patterns and applies the high-throughput redirect rate limiter (one hundred requests per second). The API replica receives the request, and `RedirectService.resolve()` checks Redis first. On a cache hit, the long URL is returned in roughly two milliseconds, the analytics worker enqueues a click event without blocking, and the API responds with `301 Moved Permanently` plus `X-Cache: HIT` and `X-Response-Time` headers. On a cache miss, PostgreSQL is queried, the result is written into Redis with a twenty-four-hour TTL, and the response carries `X-Cache: MISS`. If Redis is entirely down, the system does not crash — it falls through to PostgreSQL every time, marks the response `X-Cache: BYPASS`, and continues serving redirects. This graceful degradation is a deliberate resilience feature.

### Why This Shape, Not a Monolith or Full Microservices

We chose a **modular monolith** — one deployable backend with clear internal boundaries — rather than microservices because the read and write paths share the same database schema and deployment lifecycle, and the team's operational overhead does not justify separate deploy pipelines for a "Redirect Service" and a "Creation Service" at this scale. However, the internal separation between `UrlService` and `RedirectService` mirrors what Hello Interview and GeeksforGeeks describe as the read/write service split, meaning we could extract them into separate processes later without rewriting business logic. Nginx already routes traffic as if they were separate services, which is the first step toward that extraction.

---

## 3. Concepts: Basic to Advanced

### 3.1 Client-Server Model and REST API

The React frontend is a thick client that talks to a RESTful JSON API. REST is used because URL shortening is fundamentally a resource-oriented problem — URLs are resources identified by short codes, and standard HTTP verbs map naturally (`POST` to create, `GET` to read, `DELETE` to deactivate). We version the API under `/api/v1/` so that breaking changes can be introduced in `/api/v2/` without disrupting existing clients. The redirect endpoint deliberately lives outside `/api/v1/` at `/:shortCode` because it is not a JSON API — it is a browser-facing HTTP redirect that must be as short and fast as possible.

### 3.2 Read-Heavy Workload (100:1 Ratio)

URL shorteners are the canonical example of a **read-heavy** system. Industry estimates and GeeksforGeeks capacity planning assume a 100:1 read-to-write ratio — for every URL created, it gets clicked a hundred times on average. This ratio drives nearly every architectural decision: we invest heavily in caching and load balancing for reads, accept slightly higher latency on writes, and design the database schema with redirect lookups as the primary access pattern (indexed `short_code` column). If this were a write-heavy system like a logging pipeline, we would optimize for ingestion throughput instead and might choose Cassandra or Kafka.

### 3.3 Horizontal Scaling and Stateless Services

**Horizontal scaling** means adding more machines rather than upgrading one machine (vertical scaling). Our API servers are stateless — they store nothing between requests — so any instance can serve any request and we can add replicas freely. The constraint is that shared state must live in external stores (PostgreSQL, Redis), not in server memory. This is why clicking a link created on `api1` works when the redirect is handled by `api2`: both read from the same Redis and PostgreSQL. The moment you put session state in server RAM without sticky sessions, horizontal scaling breaks.

### 3.4 Load Balancing

**Load balancing** distributes incoming requests across multiple backend servers so no single server is overwhelmed. Nginx is our load balancer and reverse proxy — it terminates the client connection and opens a new connection to a backend. We use **least_conn** rather than round-robin because redirect requests have variable processing time (cache hit vs. miss), and least_conn avoids piling requests onto a server that is busy with slow database lookups. Nginx also configures `max_fails=3` and `fail_timeout=30s`, which means if an API replica fails three consecutive health checks, it is removed from the pool for thirty seconds — a basic form of **circuit breaking** at the infrastructure layer.

### 3.5 Reverse Proxy

A **reverse proxy** sits in front of backend servers and acts on their behalf. Clients only know about Nginx's address. This gives us a single entry point for SSL termination (in production you would add HTTPS here), centralized rate limiting, and the ability to route `/api/*` to the backend and `/` to the React dev server without the client knowing about the internal topology. Nginx also forwards `X-Real-IP` and `X-Forwarded-For` headers so the API can rate-limit and hash the actual client IP rather than seeing every request as coming from Nginx.

### 3.6 Database Selection: PostgreSQL

GeeksforGeeks discusses the SQL vs NoSQL tradeoff for URL shorteners at length. NoSQL stores like Cassandra and DynamoDB excel at horizontal write scaling and are eventually consistent by default, which suits write-heavy social feeds. We chose **PostgreSQL** because our scale tier is moderate, we need ACID guarantees on URL creation (no duplicate short codes), we run analytics queries with `GROUP BY` and date ranges, and the operational simplicity of a single relational database outweighs the theoretical write scalability of sharded NoSQL at our current volume. PostgreSQL also gives us `BIGSERIAL` for ID generation fallback, unique constraints for collision detection, and partial indexes for expiration queries.

The schema has two tables. The `urls` table stores the mapping with a unique index on `short_code` for O(log n) lookups and a partial index on `expires_at` for cleanup queries. The `url_clicks` table stores analytics events with a foreign key to `urls` and a composite index on `(url_id, clicked_at DESC)` for efficient per-link analytics queries. This is classic **relational modeling** — normalize the data, index the access patterns, use foreign keys for integrity.

### 3.7 Indexing

A **database index** is a data structure (typically B-tree in PostgreSQL) that speeds up lookups at the cost of write overhead and storage. We index `short_code` because every redirect does `WHERE short_code = $1`. Without this index, PostgreSQL would scan the entire table. We do not index `long_url` for redirects because we never look up by long URL during a redirect — only during deduplication on create. The partial index `WHERE is_active = TRUE` on `expires_at` is an optimization for a background cleanup job that would query only active, expired links.

### 3.8 ID Generation and Base62 Encoding

Generating unique short codes is the hardest part of a URL shortener at scale. We use a **counter-based approach**: a monotonically increasing integer guarantees uniqueness without collision checks on every insert. The counter lives in Redis (`INCR url:counter`) because Redis INCR is atomic — even with two API replicas calling it simultaneously, each gets a different number. If Redis is unavailable, we fall back to PostgreSQL's `BIGSERIAL` sequence, which is also atomic within a single database.

The integer is then encoded in **Base62** — the alphabet `0-9`, `a-z`, `A-Z` — which produces URL-safe strings without special characters. Base62 is preferred over Base64 because `+` and `/` have special meaning in URLs. Seven Base62 characters give 62^7 ≈ 3.5 trillion combinations, which GeeksforGeeks calculates is sufficient for decades at thousands of URLs per second. We then append **two random Base62 characters** as a security suffix. Without this suffix, codes would be sequential and predictable — an attacker could enumerate `1a`, `1b`, `1c` and discover every link in the system. The random suffix adds 62^2 = 3,844 possibilities per counter value, making enumeration impractical.

We also handle **hash collisions** (duplicate `short_code` inserts) by catching PostgreSQL error code `23505` (unique violation) and retrying up to three times with a new random suffix. Custom aliases bypass the counter entirely and are validated for format and reserved words.

### 3.9 URL Deduplication

When the same long URL is submitted twice, we return the existing short code rather than creating a duplicate row. This is optional in URL shorteners — Bitly creates a new code each time, TinyURL deduplicates. We deduplicate because it saves storage and gives users consistent links, at the cost of an extra `SELECT` on every create. For a write-heavy system this would be wrong; for our read-heavy profile the extra read on rare writes is negligible.

### 3.10 Caching — Cache-Aside Pattern

**Cache-aside** (also called lazy loading) means the application manages the cache, not the database. On a read, the app checks Redis first. On a hit, it returns immediately. On a miss, it reads PostgreSQL, writes the result to Redis, and returns. On a write (URL creation), the app writes to PostgreSQL and proactively warms Redis. On a delete (deactivation), the app soft-deletes in PostgreSQL and explicitly invalidates the Redis key. This differs from **read-through cache**, where the cache layer itself fetches from the database on a miss, and **write-through cache**, where every write goes to both cache and database synchronously. Cache-aside is the most common pattern for application-managed caches because it gives the application full control over what gets cached and when.

### 3.11 Redis Memory Policy — allkeys-lru

When Redis reaches its `maxmemory` limit (256 MB in our config), it must evict keys. The **allkeys-lru** policy evicts the least recently used keys across the entire keyspace, regardless of whether they have a TTL. This is appropriate for a redirect cache because every key has similar value — a popular link and an unpopular link both deserve cache space proportional to their access frequency. The alternative **volatile-lru** only evicts keys with a TTL set, which would be worse here because our counter key (`url:counter`) has no TTL and would never be evicted even if memory is full. LRU eviction combined with per-key TTL (24 hours via `SETEX`) gives us two independent expiration mechanisms: time-based expiry for stale entries and memory-pressure eviction for capacity management.

### 3.12 HTTP 301 vs 302 Redirect

This is one of the most consequential decisions in a URL shortener. **HTTP 301 Moved Permanently** tells the browser "this redirect will never change — cache it locally." After the first click, the browser may go directly to the destination without contacting our servers at all. This is excellent for performance and reduces our infrastructure costs, but it means we lose analytics on repeat clicks from the same browser. **HTTP 302 Found** is a temporary redirect — the browser always contacts our server, enabling full click tracking, but every click generates server load. We chose 301 because the project requirements prioritize redirect performance. In production at Bitly-scale, teams often use 302 with CDN edge caching at a short TTL (five to sixty minutes) as a compromise. Our `X-Cache` header and async analytics capture at least the first click per browser session.

### 3.13 Rate Limiting

**Rate limiting** protects the system from abuse — brute-force enumeration of short codes, spam URL creation, and DDoS-style traffic floods. We implement **dual-layer rate limiting**: Nginx enforces coarse per-IP limits at the edge (cheaper, blocks bad traffic before it reaches application code), and Express enforces finer-grained per-endpoint limits as a second defense. The shorten endpoint has the strictest limits (five per second at Nginx, twenty per minute at Express) because creating URLs is the most abuse-prone operation. Redirects have the loosest limits (one hundred per second) because blocking legitimate viral traffic would be catastrophic. Nginx uses a **leaky bucket** algorithm internally for `limit_req`, allowing burst traffic up to the `burst=N` parameter before rejecting with HTTP 429.

### 3.14 SSRF Prevention

**Server-Side Request Forgery (SSRF)** is an attack where a user submits a URL that points to an internal resource — `http://localhost:5432`, `http://192.168.1.1/admin` — and tricks the server into making requests to its own infrastructure. In a URL shortener this is especially dangerous because the server stores the URL and later redirects users to it, but the validation at creation time is the critical gate. We block URLs pointing to private IP ranges (`10.x`, `172.16-31.x`, `192.168.x`, `127.x`, `localhost`) and non-HTTP protocols (`javascript:`, `data:`, `file:`). This is a **business-logic security control** that no amount of Nginx configuration can replace.

### 3.15 Defense in Depth

**Defense in depth** means multiple independent security layers so that if one fails, others still protect the system. Our three layers are: Nginx (rate limits, connection limits, path blocking, security headers), Express middleware (Helmet headers, CORS restrictions, body size limits, application rate limits), and business logic (SSRF validation, reserved alias blocking, input schema validation with Zod). An attacker who bypasses Nginx rate limiting still hits Express rate limiting. An attacker who sends a syntactically valid request still gets blocked if the URL points to an internal network.

### 3.16 Async Processing and Eventual Consistency

Click analytics are **eventually consistent** — the `click_count` on a URL and the rows in `url_clicks` may lag behind the actual redirect by up to one second. This is intentional. The redirect path responds in milliseconds; the analytics path batches writes every second. Users viewing the analytics dashboard might see a click appear slightly after it happened. For a URL shortener this is acceptable. For a banking ledger it would not be. The **async worker pattern** here uses an in-memory queue with batch flushing, which is the simplest form of a message queue. At scale this would become Redis Streams, RabbitMQ, or Kafka with dedicated consumer workers.

### 3.17 Graceful Degradation

**Graceful degradation** means the system continues operating with reduced functionality when a component fails, rather than returning 500 errors to all users. When Redis is down, redirects still work via PostgreSQL (`X-Cache: BYPASS`). When Redis fails mid-request, the `withRedis()` wrapper catches the error and returns a bypass status rather than throwing. URL creation still works because the counter falls back to PostgreSQL sequences. The health endpoint reports `degraded` status when Redis is down but the database is up, giving operators visibility without triggering false-positive critical alerts.

### 3.18 Soft Delete

Deactivating a link uses **soft delete** — we set `is_active = FALSE` rather than `DELETE FROM urls`. This preserves analytics history, allows audit trails, and lets us return a meaningful `410 Gone` response rather than `404 Not Found`. The Redis cache key is explicitly invalidated on deactivation so a deactivated link does not continue redirecting from cache.

### 3.19 Repository and Service Layer Patterns

The **repository pattern** abstracts data access behind an interface so services do not contain SQL or Redis commands. `UrlRepository` knows about PostgreSQL; `CacheRepository` knows about Redis; `UrlService` knows about neither — it just calls `urlRepository.create()` and `cacheRepository.set()`. The **service layer** contains business rules: "if the same long URL already exists, return it," "if the alias is taken, throw 409," "if the link is expired, throw 410." Controllers are thin — they parse HTTP, call a service, and format the response. This is the same layered architecture taught in LLD interviews, and it maps directly to the class diagram in the README.

### 3.20 Connection Pooling

PostgreSQL connections are expensive to create — each requires a TCP handshake, authentication, and memory allocation on the database server. **Connection pooling** (via the `pg` library's `Pool`) maintains a set of reusable connections. Our pool allows up to twenty concurrent connections per API replica. With two replicas, that is forty connections to PostgreSQL, which is well within default limits. Without pooling, every redirect would open and close a connection, adding tens of milliseconds of overhead.

### 3.21 Migrations

Database schema changes are managed through **versioned SQL migrations** in `backend/migrations/`. A `_migrations` table tracks which files have been applied. Migrations run automatically on server startup inside a transaction — if the migration fails, it rolls back and the server does not start with a half-applied schema. This is basic **schema evolution** discipline that prevents the "works on my machine" database drift problem.

### 3.22 Containerization and Docker Compose

**Docker** packages each service (Redis, PostgreSQL, API, Nginx) with its dependencies into isolated containers. **Docker Compose** orchestrates them with a single `docker compose up` command, defines health checks so API containers wait for PostgreSQL to be ready, and uses named volumes for data persistence across container restarts. The `full` profile adds Nginx, two API replicas, and the frontend for a production-like local environment. This is not Kubernetes, but it demonstrates the same principles: immutable infrastructure, declarative configuration, and service dependency ordering.

### 3.23 CAP Theorem (Applied)

The **CAP theorem** states that a distributed system can provide at most two of Consistency, Availability, and Partition tolerance. Our URL mappings prioritize **consistency and partition tolerance** — PostgreSQL gives us strong consistency on writes, and if the network partitions, we would rather return an error than serve a wrong redirect. Redis caching relaxes consistency to **eventual consistency** — a newly created URL might not be in Redis for a few milliseconds until the cache warms, but the PostgreSQL row is immediately consistent. Analytics are explicitly eventual. This is the standard CAP positioning for a read-heavy cache-aside system.

### 3.24 ACID Properties

PostgreSQL provides **ACID** guarantees on URL creation. **Atomicity** means the insert either fully succeeds or fully fails — no half-written rows. **Consistency** means the unique constraint on `short_code` is always enforced. **Isolation** means two concurrent inserts with the same alias do not both succeed — one gets `23505` and retries. **Durability** means once the insert commits, a crash does not lose the mapping. Redis, by contrast, is not ACID — it trades durability for speed, which is why PostgreSQL is the source of truth.

### 3.25 What We Have Not Built (And When You Would)

At true billion-redirect-per-day scale, you would add **database sharding** by `short_code` hash range, a **CDN** (CloudFront/Cloudflare) to cache 301/302 responses at the edge, **Kafka** for analytics instead of an in-memory queue, **separate read replicas** of PostgreSQL, **Snowflake IDs** or a dedicated ID generation service instead of Redis INCR, and **multi-region deployment** with geo-DNS. Our architecture is designed so each of these can be added without rewriting the core service layer — the repository pattern, stateless API, and cache-aside model are the same patterns Bitly and TinyURL started with before they needed the advanced tier.

---

## 4. The Write Path (Shortening a URL)

When a `POST /api/v1/urls` request arrives, it passes through Nginx's shorten rate limiter and reaches the `UrlController`. Zod validates that `longUrl` is a non-empty string and that optional fields match their schemas. `UrlService.shorten()` then calls `validateLongUrl()`, which checks the URL format with a regex, rejects dangerous protocols, blocks private IP ranges (SSRF), and enforces the 2048-character limit from GeeksforGeeks capacity planning.

If the user provided a custom alias, we check that it matches the `[a-zA-Z0-9_-]{3,12}` pattern, is not a reserved word like `api` or `health`, and is not already taken in PostgreSQL. If it passes, we insert directly with that alias as the short code.

For auto-generated codes, we first check if the long URL already exists (deduplication). If it does and is still active, we return the existing mapping. Otherwise we call `counterRepository.nextId()` which atomically increments `url:counter` in Redis, encodes the result to Base62, appends two random characters, and attempts an insert. On unique constraint violation (astronomically rare with a counter but possible with race conditions), we retry up to three times. On success, we warm Redis with `SETEX url:{code} 86400 {longUrl}` so the first redirect is already a cache hit. The entire operation is dominated by one PostgreSQL insert and typically completes in tens of milliseconds.

---

## 5. The Read Path (Redirect)

The redirect is the performance-critical path. After Nginx routes `GET /aB3xK9Zq` to an API replica, `RedirectService.resolve()` validates the short code format, then calls `cacheRepository.get()`. This issues `GET url:aB3xK9Zq` against Redis. If a value is returned, we have a cache hit and the long URL is available in about two milliseconds. If Redis returns null, we query `SELECT long_url FROM urls WHERE short_code = $1`, check `is_active` and `expires_at`, write the result to Redis, and return with `X-Cache: MISS`. If Redis is unreachable, we skip it entirely and query PostgreSQL directly with `X-Cache: BYPASS`.

Regardless of cache status, `trackClick()` enqueues an analytics event without awaiting it. The HTTP response is `301 Moved Permanently` with a `Location` header pointing to the original URL. The `X-Response-Time` header tells operators exactly how long the server-side resolution took, which is what our benchmark script measures.

---

## 6. Caching Deep Dive

### Why Cache-Aside and Not Write-Through

Write-through caching writes to both cache and database on every write, guaranteeing the cache is always fresh but doubling write latency. For URL shortening, writes are rare and the cost of a stale cache entry is low (it expires in twenty-four hours anyway). Cache-aside lets us warm the cache proactively on create and invalidate on delete without paying write-through overhead on every analytics update or metadata read.

### TTL Strategy

Each cached redirect has a **TTL of 86400 seconds (24 hours)**. This is a common industry default cited by InterviewLoop and Hello Interview. The reasoning is that most clicks on a link happen within the first few days of creation, so twenty-four hours of caching covers the burst period. Links that go viral stay in cache because LRU keeps frequently accessed keys alive even after TTL would have expired — wait, no: `SETEX` hard-expires keys regardless of LRU. LRU only applies when memory is full. For viral links, the TTL refreshes on every cache miss, and frequent hits keep the key alive until TTL expires, at which point the next click re-populates it from PostgreSQL.

### Cache Invalidation

Cache invalidation is one of the two hard problems in computer science. We handle it in two places: explicit invalidation on deactivation (`DEL url:{code}`), and natural expiration via TTL. We do not invalidate on analytics updates because analytics do not change the redirect target. If we added an "edit destination URL" feature, we would need to invalidate the cache on update as well.

### Measuring Cache Effectiveness

The `npm run benchmark` script measures three scenarios. **HIT**: warm the cache, run fifty redirects, measure average/P50/P95 latency — typically around two milliseconds. **MISS**: create a brand-new code, measure the first redirect before Redis is populated — typically ten to thirty milliseconds depending on PostgreSQL load. **BYPASS**: stop Redis with `docker compose stop redis`, run fifty redirects, measure latency — similar to MISS but without cache writes. The `X-Cache` response header lets you verify which path was taken on any individual request without running the full benchmark.

---

## 7. Security Architecture

Security is implemented as three independent layers rather than a single firewall rule because no single control catches every attack vector.

The Nginx layer handles volumetric attacks and automated scanning. Rate limiting prevents a single IP from creating thousands of URLs or enumerating short codes. Connection limiting (`limit_conn 20`) prevents a single IP from holding open hundreds of connections. Path blocking returns 404 for `.git`, `.env`, `wp-admin`, and `.php` requests — these are automated scanner probes that hit virtually every public server and have no legitimate purpose in our application. Security headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`) protect browser users from clickjacking and MIME-type confusion attacks.

The Express middleware layer adds Helmet for additional HTTP security headers, CORS to restrict which origins can call the API in production, a 16 KB body size limit to prevent oversized payload attacks, and per-endpoint rate limits as a second line of defense behind Nginx. The `requestIdMiddleware` assigns a UUID to every request and returns it in `X-Request-Id`, which does not prevent attacks but is essential for incident response — you can trace a suspicious request through logs.

The business logic layer handles semantic attacks. SSRF validation prevents internal network probing via malicious URLs. Reserved alias blocking prevents users from claiming `/api` or `/health` as short codes, which would break routing. Protocol blocking prevents `javascript:` URLs that could execute code in older browsers. IP hashing in analytics (SHA-256 of the client IP) provides click tracking without storing personally identifiable information in plain text.

---

## 8. Analytics and Async Processing

Every redirect generates a click event containing the URL ID, hashed IP, user agent, and referer. Rather than inserting this into PostgreSQL synchronously — which would add five to twenty milliseconds to every redirect — the event is pushed into an in-memory queue. A background worker flushes the queue every second or when it reaches ten events, whichever comes first, batch-inserting into `url_clicks` and incrementing `click_count` on the `urls` table.

This design choice follows the **separation of concerns** principle from the Hello Interview Bitly breakdown: the read path (redirect) and the analytics path have different latency requirements and should not share the same execution thread. The tradeoff is that if the API process crashes, up to one second of click events in the queue are lost. In production you would persist the queue to Redis Streams or Kafka for durability. For this project, the tradeoff is acceptable because analytics are approximate by nature (remember the 301 browser caching issue) and losing a fraction of a second of events during a crash is tolerable.

---

## 9. Error Handling and Resilience

Every error in the API returns the same JSON envelope: `{ error: true, code: "...", message: "...", requestId: "..." }`. This consistency matters for client developers and for monitoring systems that alert on error codes rather than HTTP status alone.

Business errors use the `AppError` class with explicit HTTP status and machine-readable codes. `NOT_FOUND` (404) for missing short codes. `LINK_EXPIRED` and `LINK_INACTIVE` (410) for gone resources — we use 410 instead of 404 because the resource existed but is no longer available, which is semantically correct. `SSRF_BLOCKED` (400) for security violations. `RATE_LIMIT_EXCEEDED` (429) from both Nginx and Express.

Infrastructure errors are mapped separately. PostgreSQL connection failures (`ECONNREFUSED`, `57P01`) become `DATABASE_UNAVAILABLE` (503), telling clients to retry rather than treating it as a client error. Zod validation failures become `VALIDATION_ERROR` (400) with the specific field messages. Unhandled exceptions become `INTERNAL_ERROR` (500) with the message hidden from the client but logged with the `requestId` for debugging.

The `asyncHandler` wrapper ensures that rejected promises in async controllers reach the global error handler rather than crashing the process. Without this, a single unhandled rejection in an `async` Express route would leave the client hanging and potentially destabilize the Node.js process.

---

## 10. Observability

Observability is the ability to understand what a system is doing from the outside without reading source code. We implement three pillars in a basic form.

**Logging**: Pino structured JSON logs capture every HTTP request with method, URL, status code, response time, and `requestId`. Cache hits and misses are logged at debug level with the short code.

**Metrics via headers**: `X-Cache` (HIT/MISS/BYPASS), `X-Response-Time` (server-side latency), and `X-Request-Id` (correlation) are returned on every redirect. The benchmark script reads these headers to produce latency statistics.

**Health checks**: `GET /health` returns the status of PostgreSQL and Redis independently, reporting `healthy`, `degraded` (database up, Redis down), or `unhealthy` (database down). Nginx uses this for upstream health monitoring via `max_fails`. `GET /api/v1/cache/stats` exposes Redis memory usage and eviction policy for operators.

In production you would add Prometheus metrics, Grafana dashboards, and distributed tracing (Jaeger/Zipkin) using the `X-Request-Id` as the trace correlation ID.

---

## 11. Deployment and Infrastructure

The system supports three deployment modes. **Local development** runs the API and React dev server directly on the host with `npm run dev:all`, connecting to Dockerized Redis and PostgreSQL. This gives fast hot-reload for frontend and backend development. **Docker infrastructure** runs only Redis and PostgreSQL in containers while the API runs on the host — a common pattern when you want containerized data services but prefer native Node.js debugging. **Full stack** (`docker compose --profile full up`) runs Nginx, two API replicas, the frontend, Redis, and PostgreSQL entirely in containers, accessible through port 80.

Environment configuration uses `process.env` directly with a `.env` file loaded by dotenv. This is deliberately simple — no config abstraction layer — so operators can see exactly what variables the system reads. Secrets like `DATABASE_URL` passwords live in `.env` (gitignored), with `.env.example` documenting the required variables without real credentials.

---

## 12. Tradeoffs and Alternatives

### PostgreSQL vs Cassandra/DynamoDB

We chose PostgreSQL for ACID guarantees, complex analytics queries, and operational simplicity. At billions of URLs with write throughput exceeding single-node PostgreSQL capacity, you would shard by `short_code` hash range across multiple PostgreSQL instances or migrate to DynamoDB with `short_code` as the partition key. The repository pattern makes this migration possible without changing service logic.

### Redis INCR vs Snowflake IDs

Redis INCR is simple and fast but creates a single point of failure for ID generation. **Snowflake IDs** (timestamp + machine ID + sequence) generate unique IDs without coordination and are used by Twitter and Discord. They produce longer codes but eliminate the Redis dependency on the write path. We use Redis INCR because it is simpler and the fallback to PostgreSQL sequences covers the failure case.

### In-Memory Queue vs Kafka

The in-memory analytics queue is simple and sufficient for single-process deployments. **Kafka** would be necessary when analytics consumers run on separate machines, when you need replay capability, or when click volume exceeds what a single Node.js process can batch-write to PostgreSQL.

### 301 vs 302

We chose 301 for performance. If a product manager requires accurate click counts above all else, switch to 302. If infrastructure cost is the primary concern, keep 301 and accept approximate analytics. If both matter, use 302 with a CDN edge cache at a five-minute TTL.

### Monolith vs Microservices

The current modular monolith can be split into a Write Service (shorten, deactivate) and a Read Service (redirect) when independent scaling becomes necessary. Nginx already routes as if they were separate. The trigger for splitting would be redirect latency increasing despite adding API replicas — indicating the read path needs different optimization (more Redis memory, read replicas) than the write path.

---

## 13. Interview Questions and Counter-Questions

Below are questions an interviewer might ask about this project, with detailed answers, followed by **counter-questions** you can ask back to demonstrate depth.

---

### Q1: "Walk me through what happens when a user clicks a short link."

When a user clicks `http://localhost/aB3xK9Zq`, the browser sends an HTTP GET request. In production this hits Nginx first, which applies the redirect rate limiter (one hundred requests per second per IP with a burst of fifty), matches the path against the short-code regex, and proxies the request to whichever API replica has the fewest open connections. The API validates the short code format, then checks Redis for the key `url:aB3xK9Zq`. On a cache hit, the long URL is returned in about two milliseconds. On a miss, PostgreSQL is queried with an indexed lookup on `short_code`, the result is cached in Redis with a twenty-four-hour TTL, and the response is marked `X-Cache: MISS`. If Redis is down, PostgreSQL serves the request directly with `X-Cache: BYPASS`. In all cases, a click event is enqueued asynchronously and the API responds with HTTP 301 and a `Location` header pointing to the original URL. The browser follows the redirect. On subsequent clicks, the browser may use its cached 301 response and skip our servers entirely.

**Counter-question**: "How would you handle the case where the destination URL itself is down? Would you keep redirecting to a broken link, or add destination health checking?"

---

### Q2: "How do you generate short codes? Why not just use a hash of the long URL?"

We use a counter-based approach rather than hashing because hashes create two problems at scale. First, MD5 or SHA hashes are long and must be truncated, which increases collision probability — two different URLs can produce the same seven-character prefix. Handling collisions requires a database check on every insert anyway, defeating the purpose. Second, hashing the same URL always produces the same code, which is deduplication by construction but means you cannot give different users different short links for the same URL (a feature Bitly offers). Our approach atomically increments a Redis counter, encodes the integer in Base62 for compactness, and appends two random Base62 characters so codes are not sequentially enumerable. If two inserts collide on the rare chance of duplicate random suffixes, PostgreSQL's unique constraint catches it and we retry.

**Counter-question**: "What is the collision probability with a seven-character Base62 code, and at what scale would you need to move to eight characters?"

---

### Q3: "Why Redis? Why not just use PostgreSQL for everything?"

PostgreSQL is disk-backed and optimized for durability and complex queries, not sub-millisecond key-value lookups at millions of requests per second. A cached redirect in Redis completes in one to five milliseconds; the same lookup in PostgreSQL takes ten to thirty milliseconds even with an index, because it must traverse the buffer pool, B-tree, and potentially disk. At a hundred-to-one read ratio with thousands of redirects per second, that difference determines whether you need ten API servers or a hundred. Redis also provides atomic INCR for distributed ID generation, which PostgreSQL sequences can do but with higher latency per call. The tradeoff is operational complexity — you now run two data stores — and cache consistency management.

**Counter-question**: "How would you handle cache invalidation if we add the ability to edit a link's destination URL after creation?"

---

### Q4: "What happens when Redis goes down?"

The system does not crash. `cacheRepository.get()` wraps every Redis call in a try-catch. On failure, it returns `{ value: null, status: 'BYPASS' }` and the redirect service queries PostgreSQL directly. URL creation falls back to PostgreSQL `BIGSERIAL` for ID generation instead of Redis INCR. The health endpoint reports `degraded` status. Redirect latency increases from about two milliseconds to about ten to thirty milliseconds — still acceptable for most use cases. What we lose is protection against a PostgreSQL overload spike from uncached reads. In production, you would alert on `degraded` status and prioritize Redis recovery. You might also temporarily enable PostgreSQL read replicas to handle the increased read load.

**Counter-question**: "Would you implement a circuit breaker on the Redis client to avoid hammering a recovering Redis instance with reconnect attempts?"

---

### Q5: "Why 301 and not 302?"

HTTP 301 tells the browser this redirect is permanent and can be cached locally. After the first visit, the browser may never contact our servers again for that link. This reduces our infrastructure costs dramatically for repeat visitors and improves their experience with zero-latency redirects. The cost is analytics accuracy — we only reliably capture the first click per browser. HTTP 302 forces the browser to contact us every time, giving perfect analytics but multiplying server load by the repeat-visit rate. We chose 301 because performance and cost were prioritized. The industry compromise at CDN scale is 302 with edge caching at a short TTL.

**Counter-question**: "How would you estimate the percentage of clicks we lose to 301 browser caching, and would you A/B test 301 vs 302 for different link categories?"

---

### Q6: "How would you scale this to a billion URLs?"

The first bottleneck would be PostgreSQL write throughput on URL creation. I would shard the `urls` table by `short_code` hash range across multiple PostgreSQL instances, with a routing layer that directs reads and writes to the correct shard. For redirects, I would move Redis to a Redis Cluster with sixteen thousand hash slots distributed across multiple nodes. I would add a CDN (CloudFront) in front of Nginx to cache redirect responses at edge locations globally. Analytics would move from the in-memory queue to Kafka with dedicated consumer groups writing to a separate analytics database (ClickHouse or BigQuery) so click writes do not contend with redirect reads. ID generation would move from Redis INCR to Snowflake IDs to eliminate the coordination bottleneck entirely.

**Counter-question**: "How would you handle cross-shard queries, like an analytics dashboard that shows all links created by a user across shards?"

---

### Q7: "Explain your caching strategy and eviction policy."

We use cache-aside with Redis as the cache and PostgreSQL as the source of truth. The application explicitly reads from Redis, falls back to PostgreSQL on a miss, and writes to Redis after a miss. On URL creation, we proactively warm the cache. On deactivation, we explicitly delete the cache key. Redis is configured with `maxmemory 256mb` and `allkeys-lru` eviction, meaning when memory is full, the least recently used keys are evicted regardless of TTL. Each key also has an explicit twenty-four-hour TTL via `SETEX`. This gives us two eviction mechanisms: time-based for staleness and LRU for capacity. The `allkeys-lru` policy is chosen over `volatile-lru` because our counter key has no TTL and must remain evictable under memory pressure.

**Counter-question**: "What cache hit rate would you target in production, and how would you alert if it drops below threshold?"

---

### Q8: "How do you prevent abuse?"

We use defense in depth across three layers. Nginx blocks volumetric attacks with per-IP rate limits (five shorten/second, one hundred redirect/second), connection limits (twenty concurrent per IP), and scanner path blocking. Express adds a second rate-limit layer, Helmet security headers, and body size limits. Business logic prevents SSRF via private IP blocking, prevents alias squatting on reserved words, and validates all input with Zod schemas. For advanced abuse (malware distribution via short links), you would add a URL reputation scanning service on the write path and a reporting/blocklist mechanism.

**Counter-question**: "How would you distinguish between a legitimate viral link spike and a DDoS attack on a specific short code?"

---

### Q9: "What design patterns did you use?"

The backend uses the **Repository pattern** for data access (separate repositories for PostgreSQL and Redis), the **Service layer pattern** for business logic, the **Middleware chain pattern** for cross-cutting concerns (security, rate limiting, error handling, request ID), the **Cache-aside pattern** for read acceleration, the **Async worker / Producer-Consumer pattern** for analytics, the **Graceful degradation pattern** for Redis failures, and the **Soft delete pattern** for link deactivation. The `AppError` class implements a form of the **Exception hierarchy pattern** for typed error handling. `asyncHandler` is the **Wrapper pattern** for async error propagation in Express.

**Counter-question**: "Which pattern would you refactor first if the codebase needed to support multiple database backends simultaneously?"

---

### Q10: "What are the single points of failure in this system?"

PostgreSQL is the primary single point of failure — if it is down, both URL creation and redirects fail entirely. Redis failure is mitigated by graceful degradation. Nginx is a single instance in our Docker Compose setup; in production you would run multiple Nginx instances behind a cloud load balancer (AWS ALB, GCP LB). The in-memory analytics queue is a single-process failure point — a crash loses up to one second of events. The Redis counter is a single key — if it resets due to an unplanned flush, IDs restart from one but PostgreSQL unique constraints prevent duplicate codes. The most critical SPOF to address first in production is PostgreSQL, via streaming replication to a hot standby.

**Counter-question**: "What RPO and RTO would you target for PostgreSQL recovery, and how does that influence the choice between streaming replication and periodic snapshots?"

---

### Q11: "How did you measure that Redis actually helps?"

We built a benchmark script (`npm run benchmark`) that measures redirect latency across three cache states using the `X-Response-Time` and `X-Cache` headers returned by the API. For cache HIT, we warm Redis with one redirect, then run fifty redirects and measure average, P50, and P95 latency — typically around two milliseconds. For cache MISS, we create a brand-new short code and measure the first redirect before Redis is populated — typically ten to thirty milliseconds. For BYPASS, we stop the Redis container and run fifty redirects — latency is similar to MISS but without cache writes afterward. This gives concrete evidence that Redis provides a five to fifteen times latency improvement on the hot path.

**Counter-question**: "How would you automate this benchmark in CI/CD to catch performance regressions on every pull request?"

---

### Q12: "Why Nginx instead of a cloud load balancer?"

Nginx serves as both a reverse proxy and a load balancer in one process, with zero licensing cost and deep control over rate limiting, path routing, and security headers. A cloud load balancer (AWS ALB) provides managed high availability and SSL termination but offers less granular per-endpoint rate limiting. In our Docker Compose setup, Nginx demonstrates the architecture without cloud costs. In AWS production, the typical pattern is CloudFront (CDN) → ALB → Nginx (optional, for rate limiting) → API replicas. The Nginx configuration we wrote translates directly to that inner layer.

**Counter-question**: "At what traffic level would you remove Nginx and let the cloud load balancer route directly to API replicas?"

---

## Quick Reference: Concept Map

| Concept | Where in Project | Why |
|---------|-----------------|-----|
| Load balancing | `nginx/nginx.conf` — `least_conn` | Distribute traffic, avoid overloaded replicas |
| Reverse proxy | Nginx | Single entry point, SSL, rate limits |
| Cache-aside | `cacheRepository.ts` | Sub-ms redirects for hot links |
| allkeys-lru | `redis/redis.conf` | Evict cold keys when memory full |
| Base62 + random suffix | `utils/base62.ts`, `shortCode.ts` | Compact, non-enumerable codes |
| Counter ID generation | Redis `INCR url:counter` | Collision-free, atomic across replicas |
| 301 redirect | `redirectController.ts` | Performance; browser caches redirect |
| Async analytics | `analyticsWorker.ts` | Don't block redirect for DB writes |
| SSRF prevention | `urlValidator.ts` | Block internal network URLs |
| Rate limiting | Nginx + Express | Abuse prevention, dual layer |
| Graceful degradation | `cacheRepository.ts` BYPASS | Redis down ≠ system down |
| Soft delete | `is_active = FALSE` | Preserve history, return 410 |
| Repository pattern | `repositories/` | Isolate data access from business logic |
| Connection pooling | `pg.Pool` | Reuse DB connections |
| Request tracing | `X-Request-Id` | Debug and incident response |
| Health checks | `/health` endpoint | Orchestration and monitoring |
| Schema migrations | `migrations/001_init.sql` | Versioned, repeatable DB setup |
| Docker Compose | `docker-compose.yml` | Reproducible multi-service deployment |

---

*This document covers the full system design of the TinyURL Shortener project. For setup instructions see [README.md](README.md). For API testing see [postman/TinyURL-Shortener.postman_collection.json](postman/TinyURL-Shortener.postman_collection.json).*

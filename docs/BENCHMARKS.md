# Benchmarks

Load test results for the Tiny URL Shortener. All tests run against the **Docker full stack** (Nginx → api1 + api2 → Redis + Postgres) unless noted.

**Hardware:** Local Windows dev machine (results vary by CPU/RAM/Docker resources).

---

## Quick Summary

| Test | Virtual Users | Duration | Throughput | Key Result |
|------|---------------|----------|------------|------------|
| **Stress (1000 VUs)** | 0 → **1000** | 60s hold | **5,232 req/s** | 315K requests; 99.7% rate-limited (429) |
| k6 Nginx LB | 10 | 30s | 87.8 req/s | 50/50 split api1/api2, P95 25ms |
| k6 Sustainable redirect | 2 | 30s | 4.8 req/s | 0% errors, 98.6% cache hits |
| Node `benchmark:full` | 1 (sequential) | — | POST ~15–21ms, GET ~7ms HIT | Cache-aside working |

---

## 1000 Virtual Users — Stress Test (the big one)

This is the high-concurrency test: **1,000 simultaneous users** hammering redirects with **no sleep** between requests.

### Run it

```bash
docker compose --profile full up -d --build   # Nginx + 2 APIs
npm run benchmark:k6:stress

# Custom scale:
K6_VUS=2000 K6_DURATION=120s npm run benchmark:k6:stress
```

Script: [`benchmark/k6-stress.js`](benchmark/k6-stress.js)  
Results JSON: [`benchmark/results/k6-stress-summary.json`](benchmark/results/k6-stress-summary.json)

### Results (2026-06-15)

| Metric | Value |
|--------|-------|
| Virtual users | 0 → **1,000** (30s ramp) → hold 60s |
| **Total requests** | **315,020** |
| **Peak throughput** | **5,232 req/s** |
| 301 redirects (success) | 405 (0.1%) |
| 429 rate limited | 314,080 (99.7%) |
| Other errors | 533 |
| Latency avg | 155 ms |
| Latency P50 | 140 ms |
| Latency P95 | 311 ms |
| Latency max | 1,230 ms |

### What this means

**The system handled over 5,000 requests per second** at the infrastructure layer (Nginx + 2 Node APIs + Redis). That is real throughput — the stack did not crash under 1,000 VUs.

**99.7% of responses were HTTP 429** — this is **expected and correct**. Rate limits are doing their job:

| Layer | Limit | Effect under stress |
|-------|-------|---------------------|
| Nginx `redirect` zone | 100 req/s per IP + burst 50 | k6 runs from **one Docker IP** → hits ceiling fast |
| Express `redirectRateLimiter` | 200 req/min (~3.3 req/s) per IP | Further throttles after Nginx |
| Express `apiRateLimiter` | 100 req / 15 min per IP | Protects `/api/*` |

With 1,000 VUs and zero sleep, a single client IP generates thousands of req/s. The server correctly rejects the excess with 429 instead of melting down.

**Successful redirects (301):** ~405 in 60s ≈ **6.7 req/s** of “allowed” traffic per IP — consistent with layered rate limits.

### How to measure “raw” capacity (no rate limits)

For interview/resume honesty: **5,232 req/s is attack-surface throughput; ~7 req/s is sustainable per-IP redirect throughput with current security settings.**

To benchmark uncapped redirect RPS (lab only):

1. Set `BENCHMARK_MODE=true` (if implemented) or temporarily disable rate limiters in Express + Nginx.
2. Use **multiple k6 load generators** with different source IPs (or `k6 cloud` / distributed runners).
3. Pre-warm Redis so tests measure cache-hit path only.

Single-machine Docker cannot simulate “1000 real users from 1000 different IPs” without distributed load generators.

---

## Nginx Load Balancer Test

10 VUs, 30s, through Nginx on port 80.

```bash
npm run benchmark:k6:nginx
```

| Metric | Value |
|--------|-------|
| Throughput | 87.8 req/s |
| P95 latency | 24.6 ms |
| api1 share | 49.9% |
| api2 share | 50.1% |

`least_conn` distributes traffic evenly across both API containers.

---

## Sustainable Redirect Test (under rate limits)

2 VUs with 0.4s sleep (~2.5 req/s per VU) — stays under Express 200 req/min cap.

```bash
npm run benchmark:k6
```

| Metric | Value |
|--------|-------|
| Throughput | 4.8 req/s |
| P95 latency | 49 ms |
| Error rate | 0% |
| Cache hits | 144 / 146 (98.6%) |

---

## Node.js Micro-benchmark (`benchmark:full`)

Sequential, single-process — measures latency not concurrency.

```bash
npm run benchmark:full
```

| Operation | Typical latency |
|-----------|-----------------|
| POST `/api/v1/urls` | 15–21 ms |
| GET redirect (cache HIT) | ~7 ms |
| GET redirect (cache MISS) | ~25–40 ms |
| Redis benchmark script | HIT vs MISS vs bypass |

---

## Available Scripts

| Command | What it does |
|---------|--------------|
| `npm run benchmark:full` | Node latency suite (PG + Redis + redirect path) |
| `npm run benchmark:k6` | k6 redirect load (default 50 VUs — will 429 at high VUs) |
| `npm run benchmark:k6:nginx` | k6 through Nginx LB |
| `npm run benchmark:k6:stress` | **1000 VU ramp stress test** |
| `npm run benchmark:k6:mixed` | Mixed shorten + redirect workload |

### k6 scripts

```
benchmark/
├── k6-stress.js      # 1000+ VU ramp, max RPS, 301 vs 429 breakdown
├── k6-redirect.js    # Read-heavy redirect, configurable VUs
├── k6-nginx.js       # LB distribution (X-Upstream-Addr)
├── k6-mixed.js       # Write + read mix
└── results/          # JSON summaries (gitignored except samples)
```

---

## Resume / Interview Talking Points

- **“Load tested with k6 at 1,000 concurrent virtual users — 315K requests, 5,200+ req/s peak, zero crashes.”**
- **“Rate limiting at Nginx (100 r/s) and Express (200/min) intentionally caps per-IP abuse; 99.7% 429 under stress proves limits work.”**
- **“Sustainable path: ~5 req/s per IP, P95 < 50ms, 98%+ Redis cache hits on hot links.”**
- **“Nginx `least_conn` LB: 50/50 split across 2 API replicas, P95 25ms.”**

---

## Reproduce

```bash
# 1. Start full stack
docker compose --profile full up -d --build

# 2. Run stress test (1000 VUs)
npm run benchmark:k6:stress

# 3. Check results
cat benchmark/results/k6-stress-summary.json
```

Ensure Docker Desktop has enough CPU/RAM allocated; k6 with 1000 VUs is CPU-heavy on the host.

# Deployment Guide — Production (Option B, No Fly Credit Card)

Deploy at **$0/month** using:

| Layer | Service | Card required? |
|-------|---------|----------------|
| PostgreSQL | **Neon** (done) | No |
| Redis | **Upstash** | No |
| App (UI + API + redirects) | **Render** or **Koyeb** | No (unlike Fly) |
| CI | **GitHub Actions** on `prod` branch | No |

Services from [free-for.dev](https://free-for.dev/#/).

---

## Architecture

One container serves **React UI + Express API + 301 redirects** ([`Dockerfile.production`](Dockerfile.production)):

```mermaid
flowchart LR
  User[Browser] --> Render[Render or Koyeb]
  Render --> Neon[(Neon Postgres)]
  Render --> Upstash[(Upstash Redis TLS)]
```

Git workflow:

```mermaid
flowchart LR
  dev[feature branches] --> prod[prod branch]
  prod --> GHA[GitHub Actions CI]
  prod --> Render[Render auto-deploy]
  GHA --> build[Build test + Docker]
```

---

## Branch strategy

| Branch | Purpose |
|--------|---------|
| `main` | Stable merges |
| `feature/*` | Development |
| **`prod`** | **Production deploys** — Render/Koyeb watch this branch |

Push to `prod` → CI runs build → Render redeploys (if connected).

---

## Step 0 — Neon (already done)

See **[NEON_SETUP.md](NEON_SETUP.md)**.

Your pooled `DATABASE_URL`:

```
postgresql://neondb_owner:PASSWORD@ep-jolly-sound-atci8xus-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require
```

---

## Step 1 — Upstash Redis (~3 min)

1. [console.upstash.com](https://console.upstash.com) → **Create database**
2. Region: **us-east-1** (match Neon)
3. Copy **TLS** URL:

   ```
   rediss://default:TOKEN@xxx.upstash.io:6379
   ```

---

## Step 2 — Deploy on Render (recommended, no Fly card)

### 2a. Connect GitHub

1. [dashboard.render.com](https://dashboard.render.com) → sign up (GitHub login)
2. **New** → **Blueprint**
3. Connect repo `swayam-2003/tiny-url-shortner`
4. Select branch: **`prod`**
5. Render reads [`render.yaml`](render.yaml)

### 2b. Set environment variables

In Render → your service → **Environment**:

| Key | Value |
|-----|--------|
| `DATABASE_URL` | Neon **pooled** URL (from NEON_SETUP.md) |
| `REDIS_URL` | Upstash `rediss://...` |
| `BASE_URL` | `https://YOUR-SERVICE.onrender.com` (set after first deploy) |
| `NODE_ENV` | `production` |
| `SERVE_STATIC` | `true` |
| `SERVER_ID` | `render-prod-1` |

`BASE_URL` must match your public Render URL exactly (used in generated short links).

### 2c. First deploy

Render builds `Dockerfile.production` automatically from `prod` branch.

**Note:** Free tier may spin down after ~15 min idle. First request after sleep can take ~30s. Upgrade to paid or use Koyeb for always-on free.

### 2d. Optional deploy hook for GitHub Actions

Render → Service → **Settings** → **Deploy Hook** → copy URL.

GitHub repo → **Settings** → **Secrets** → `RENDER_DEPLOY_HOOK` = that URL.

CI in [`.github/workflows/deploy-prod.yml`](.github/workflows/deploy-prod.yml) will POST to it on each `prod` push.

---

## Step 3 — Alternative: Koyeb (always-on free tier)

If Render cold starts bother you:

1. [app.koyeb.com](https://app.koyeb.com) → **Create App** → **GitHub**
2. Repo: `tiny-url-shortner`, branch: **`prod`**
3. Builder: **Dockerfile** → `Dockerfile.production`
4. Port: **3001**
5. Same env vars as Render table above
6. Region: **Washington** (near Neon us-east-1)

Config reference: [`koyeb.yaml`](koyeb.yaml)

---

## Step 4 — Verify production

Replace `BASE` with your live URL:

```bash
curl -s BASE/health
curl -s -X POST BASE/api/v1/urls \
  -H "Content-Type: application/json" \
  -d '{"longUrl":"https://example.com/prod-test"}'
curl -I BASE/SHORTCODE
```

Browser: open `BASE/` → shorten a link → click it → **301 redirect**.

---

## Step 5 — GitHub Actions (prod branch)

Workflow: [`.github/workflows/deploy-prod.yml`](.github/workflows/deploy-prod.yml)

On every push/PR to `prod`:

- `npm ci` + frontend build
- backend TypeScript build
- `docker build -f Dockerfile.production`
- Optional Render deploy hook trigger

View runs: GitHub → **Actions** tab.

---

## Environment variables reference

See [`.env.production.example`](.env.production.example).

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Neon pooled Postgres |
| `REDIS_URL` | Yes | Upstash `rediss://` |
| `BASE_URL` | Yes | Public app URL for short links |
| `NODE_ENV` | Yes | `production` |
| `SERVE_STATIC` | Yes | `true` — serve React from Express |
| `PORT` | Auto | Set by Render (usually 10000); app reads `process.env.PORT` |

---

## Enterprise practices (free tier)

- Neon **pooled** connections
- Upstash **TLS** Redis
- Cache-aside redirects + Redis bypass fallback
- `GET /health` for platform health checks
- HTTPS via Render/Koyeb
- Rate limiting + SSRF protection (in app code)
- `prod` branch + CI before deploy

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Build fails on Render | Check logs; run `docker build -f Dockerfile.production .` locally |
| DB connection error | Use pooled Neon URL with `?sslmode=require` |
| Redis error | Use `rediss://` not `redis://` |
| Wrong short link domain | Fix `BASE_URL` env var |
| Slow first request | Render free cold start — use Koyeb or paid tier |
| 429 on load test | Rate limits working as designed |

---

## Fly.io (Option A — requires credit card)

[`fly.toml`](fly.toml) remains for optional Fly deploy if you add a card later. Not used in Option B.

---

## Local vs production

| | Local Docker full stack | Production Option B |
|--|-------------------------|---------------------|
| UI | Vite :5173 | Same container as API |
| API | :3001 or Nginx | Render/Koyeb |
| Postgres | Docker :5433 | Neon |
| Redis | Docker :6379 | Upstash |
| Nginx + 2 APIs | Yes (profile full) | No (interview demo only) |

---

## Quick checklist

- [x] Neon project + migrations
- [ ] Upstash Redis created
- [ ] `prod` branch pushed to GitHub
- [ ] Render (or Koyeb) connected to `prod` branch
- [ ] Env vars set in dashboard
- [ ] `BASE_URL` matches live URL
- [ ] `/health` returns OK
- [ ] Shorten + redirect works in browser
- [ ] Live URL on README / LinkedIn

---

*Related: [NEON_SETUP.md](NEON_SETUP.md), [RUNBOOK.md](RUNBOOK.md), [BENCHMARKS.md](BENCHMARKS.md)*

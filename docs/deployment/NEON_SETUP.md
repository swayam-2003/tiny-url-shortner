# Neon Setup — `tiny-url` Project

Neon is your **PostgreSQL** layer for production (Render).

---

## Project details

| Setting | Value |
|---------|--------|
| Project | `tiny-url` |
| Branch | `production` |
| Database | `neondb` or `shortner` |
| Region | US East 1 |
| Host (pooled) | `ep-jolly-sound-atci8xus-pooler.c-9.us-east-1.aws.neon.tech` |

---

## Connection string (production)

Use **Pooled connection** in Neon dashboard (Connection pooling **ON**):

```
postgresql://neondb_owner:YOUR_PASSWORD@ep-jolly-sound-atci8xus-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require
```

Host must include **`-pooler`**.

Set as `DATABASE_URL` in Render → Environment.

---

## Verify tables

Neon SQL Editor:

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
```

Expected: `urls`, `url_clicks`, `_migrations`

---

## Next step

[DEPLOY.md](DEPLOY.md) — Upstash + Render deploy from `prod` branch.

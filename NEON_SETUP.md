# Neon Setup — `tiny-url` Project (Option B Hosting)

Neon is your **PostgreSQL** layer. Redis and app hosting use **Upstash + Render/Koyeb** (no Fly.io credit card).

---

## Your Neon project

| Setting | Value |
|---------|--------|
| Project | `tiny-url` |
| Branch | `production` |
| Database | `neondb` |
| Role | `neondb_owner` |
| Region | US East 1 |

---

## Connection string for production

Use **Pooled connection** (Connection pooling ON in Neon dashboard):

```
postgresql://neondb_owner:YOUR_PASSWORD@ep-jolly-sound-atci8xus-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require
```

Host must include **`-pooler`**. Do not use the direct hostname on Render/Koyeb.

---

## Completed

- [x] Project and database created
- [x] Migration `001_init.sql` applied — tables `urls`, `url_clicks`, `_migrations`

Verify in Neon SQL Editor:

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
```

---

## Where to paste this URL

Set `DATABASE_URL` in your hosting dashboard:

| Platform | Location |
|----------|----------|
| **Render** | Dashboard → Service → Environment |
| **Koyeb** | App → Settings → Environment variables |

**Do not commit** this URL to git.

---

## Security

Rotate `neondb_owner` password if it was ever shared publicly (Neon → Settings → reset password).

---

## Next steps

1. [Upstash Redis](https://console.upstash.com) → copy `rediss://` URL  
2. Deploy from **`prod`** branch — see **[DEPLOY.md](DEPLOY.md)**

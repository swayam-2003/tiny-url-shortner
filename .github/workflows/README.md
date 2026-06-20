# GitHub Actions

| Workflow | File | Triggers | Purpose |
|----------|------|----------|---------|
| **CI** | [`ci.yml`](ci.yml) | Push/PR to `main`, `prod`, `feature/*` | Lint + build frontend & backend |
| **Production** | [`deploy-prod.yml`](deploy-prod.yml) | Push/PR to `prod` | Docker build + optional Render deploy hook |

## Branch strategy

| Branch | Purpose |
|--------|---------|
| `main` | Stable default branch |
| `prod` | Production deploys — Render watches this branch |
| `feature/*` | Development |

## Setup Render deploy hook (optional)

1. Render → your service → **Settings** → **Deploy Hook** → copy URL
2. GitHub repo → **Settings** → **Secrets and variables** → **Actions**
3. New secret: `RENDER_DEPLOY_HOOK` = deploy hook URL

On each push to `prod`, CI builds then POSTs to the hook (if secret is set). Render also auto-deploys via GitHub integration.

## Badges (for README)

```markdown
[![CI](https://github.com/swayam-2003/tiny-url-shortner/actions/workflows/ci.yml/badge.svg)](https://github.com/swayam-2003/tiny-url-shortner/actions/workflows/ci.yml)
[![Production](https://github.com/swayam-2003/tiny-url-shortner/actions/workflows/deploy-prod.yml/badge.svg)](https://github.com/swayam-2003/tiny-url-shortner/actions/workflows/deploy-prod.yml)
```

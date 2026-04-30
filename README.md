# 🌍 Friend Atlas

Map your friendships across the world.

A shareable map where you create an atlas, send friends a 6-letter code or
`/join/CODE` link, and they drop their pin on your map. No accounts, no logins,
no friction — every visitor is identified by a long-lived browser cookie.

Live: https://friendatlas.com

## Stack

- Node.js + Express (server/)
- Static frontend with Leaflet (public/index.html)
- PostgreSQL (atlases, friends, sessions)
- Sessions persisted via connect-pg-simple
- Docker for local dev, Render for deploy (see render.yaml)

## Local dev

```bash
cp .env.example .env       # set SESSION_SECRET to anything for local
docker-compose up --build  # spins up app + postgres
```

Open http://localhost:3000.

## Deploy to Render

The repo is wired up via `render.yaml`. Pushes to `main` auto-deploy.

If setting up a fresh Render service:

1. Render → New → Blueprint → connect GitHub repo
2. Render reads `render.yaml` and provisions: web service + free Postgres
3. Set `APP_URL` env var manually (used for OG share links + CORS):
   `APP_URL=https://friendatlas.com` (or your domain)
4. `SESSION_SECRET` and `DATABASE_URL` are auto-generated/wired

## Custom domain

In Render → friend-atlas → Settings → Custom Domains → add `friendatlas.com`
and `www.friendatlas.com`. Add the CNAME records Render gives you to your DNS
provider (Namecheap → Advanced DNS).

## Architecture notes

- Ownership of an atlas is tied to the `anon_session` cookie. Clearing cookies
  on the creator's browser orphans the atlas (the data is still in the DB but
  the rename/delete endpoints become unreachable). This is intentional for the
  zero-login UX — accept the tradeoff or add real auth.
- Pin attribution is the same model: pins are tied to the visitor's
  `anon_session` cookie, so they can edit/delete their own pin from the same
  browser.
- Rate limiting requires `app.set('trust proxy', 1)` in production because
  Render terminates TLS at a proxy that sets `X-Forwarded-For`.

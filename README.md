# 🌍 Friend Atlas

Map your friendships across the world.

A shareable, unlisted city-level map where you create an atlas, send friends a
view or contribution link, and they add the places they know. No accounts or
passwords are required; every visitor is identified by a long-lived browser
cookie.

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

For local QA without PostgreSQL or Docker:

```bash
USE_IN_MEMORY_DB=true NODE_ENV=test npm start
```

The in-memory mode uses the `pg-mem` development dependency and must not be
used for production data.

## Tests

```bash
npm run check
npm test
```

The integration test covers contribution-token enforcement, owner-only export,
lock/reopen behavior, invitation rotation, moderation, and atlas deletion.

## Privacy and owner configuration

- `OWNER_CONTACT` supplies the recovery/deletion contact shown in public copy.
- `JTERM_CONNECTION_GUIDANCE` controls the J-Term person-card guidance, such as
  `Find them in the J-Term group.`
- `JTERM_ADMIN_KEY` is a long random operator recovery secret. After setting it,
  open `/jterm#admin=YOUR_KEY` once in the organizer's browser. The fragment is
  cleared immediately, the browser becomes the J-Term atlas owner, and a
  **Manage atlas** link appears. Do not share or reuse this key.
- Atlas view links remain stable. New atlases use a separate long random
  contribution token carried in the URL fragment so it is not sent in HTTP
  request logs or referrer headers.
- Existing atlases remain backward-compatible until the owner rotates the
  contribution link.
- Atlas owners can lock/reopen contributions, rotate the contribution link,
  remove or correct entries, remove recommendations, export, and delete.

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
  owner endpoints become unreachable). Keep a configured owner contact and a
  secure operator recovery procedure until account-based recovery is added.
- Pin attribution is the same model: pins are tied to the visitor's
  `anon_session` cookie, so they can edit/delete their own pin from the same
  browser.
- Rate limiting requires `app.set('trust proxy', 1)` in production because
  Render terminates TLS at a proxy that sets `X-Forwarded-For`.

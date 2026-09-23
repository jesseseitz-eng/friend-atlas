# Friend Atlas

A shared, unlisted map of where your friends live, where they grew up, and the
places they would send you. Create an atlas, send one link, and friends add
their cities and favorite spots. No accounts or passwords: each browser is
identified by a long-lived random cookie.

Live: https://friendatlas.com

## Stack

- Node.js 22 + Express (`server/`)
- Static frontend (`public/`): `index.html` (home + atlas), `jterm.html` (CBS J-Term cohort page), shared JS in `public/js`, CSS in `public/css`
- Maps: MapLibre GL with OpenFreeMap vector tiles (free, no API key), restyled in `public/js/fa-map.js`
- City search: an offline GeoNames index (`server/data/places.json`, about 62k cities) served from `/api/places/search`
- PostgreSQL (atlases, friends, recommendations)
- Docker for local dev, Render for deploy (`render.yaml`)

## Local dev

```bash
cp .env.example .env
docker-compose up --build   # app + postgres at http://localhost:3000
```

Without Docker or Postgres:

```bash
USE_IN_MEMORY_DB=true NODE_ENV=test npm start
```

The in-memory mode uses the `pg-mem` dev dependency and must never hold real data.

## Tests

```bash
npm run check
npm test
```

## City data

`server/data/places.json` is generated from GeoNames (CC BY 4.0) by
`scripts/build-places.js`, which also writes `public/js/fa-countries.js` for
flags. Rebuild after editing the script:

```bash
npm run build:places
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (wired automatically on Render) |
| `APP_URL` | Public origin, used for share previews and CORS, e.g. `https://friendatlas.com` |
| `OWNER_CONTACT` | Contact shown on the privacy page and cohort pages for removal requests |
| `JTERM_CONNECTION_GUIDANCE` | J-Term "how to connect" note, e.g. `Find them in the J-Term group.` |
| `JTERM_ADMIN_KEY` | Long random secret. Open `/jterm#admin=YOUR_KEY` once to make that browser the J-Term owner |
| `STARTUP_NATION_OPEN` | Set to `true` to reopen the finished Startup Nation atlas to new entries |

## Privacy model

- Atlas view links (`/join/CODE`) are unlisted, not secret. Anyone with the link can view city-level entries.
- New atlases use a separate random contribution token carried in the URL fragment (`#invite=...`), so it never reaches server logs or referrers. The owner can rotate it, lock contributions, correct or remove entries, export, and delete.
- Owners can add their own places without the token.
- Contributors can remove their own entries from the browser that created them.
- Class pages (`/jterm`, `/join/*`, `/api/*`) send `X-Robots-Tag: noindex`.

## Deploy

Pushes to `main` auto-deploy on Render. For a fresh service: Render, then New, then Blueprint, then this repo. Set `APP_URL` and `OWNER_CONTACT` in the service's Environment tab. The custom domain `friendatlas.com` is configured under Settings, then Custom Domains.

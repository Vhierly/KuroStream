# KuroStream

KuroStream is an AnimePahe-powered anime streaming web app prototype with a static frontend, KuroStream Express backend, and AnimePahe proxy backend.

## Live Deployments

- Frontend: https://kuurostreaam.vercel.app
- Kuro backend: https://kurostream-backend.vercel.app
- AnimePahe API backend: https://animepahe-api-ashen.vercel.app

## Features

- Home, Explore, Detail, Watch, My List, and Login pages
- AnimePahe catalog modes:
  - Airing
  - Search
  - Queue
  - A-Z list
- AnimePahe poster cover enrichment so cards use anime poster art instead of episode screenshots
- Anime detail page with AnimePahe metadata:
  - synopsis
  - Japanese title
  - synonyms
  - aired date
  - duration
  - genres
  - studio/status/type/season
  - trailer link when available
  - recommendations when available
- Watch page with:
  - episode list
  - previous/next episode controls
  - SUB/DUB source filter
  - quality picker with resolution/fansub/size labels
  - downloads modal for AnimePahe download links when returned
  - auto-next toggle
  - continue-watching progress save
- My List + Continue Watching persistence via Dexie.js / IndexedDB
- Optional Supabase Auth login/register + cross-device sync
- Health/readiness/liveness endpoints for deployment checks
- Rate limiting, CORS controls, structured request logging

## Project Structure

- `backend/` — KuroStream Express API server, health checks, AnimePahe integration, Vercel backend config
- `api/[...route].js` — root Vercel serverless API/proxy shim
- `css/` — frontend styles
- `js/` — frontend scripts/components/API client
- `*.html` — frontend pages

## Main Backend Endpoints

- `GET /api/live` — liveness
- `GET /api/ready` — readiness / upstream dependency check
- `GET /api/health` — combined diagnostics
- `GET /api/home`
- `GET /api/catalog?mode=airing|search|queue|az&q=&tab=&page=&perPage=`
- `GET /api/anime/:id/detail?session=&title=`
- `GET /api/watch/:id?ep=&session=&title=`

## AnimePahe Proxy Endpoints Used

- `GET /api/airing?page=`
- `GET /api/search?q=&page=`
- `GET /api/anime?tab=`
- `GET /api/queue`
- `GET /api/:session`
- `GET /api/:session/releases?sort=&page=`
- `GET /api/play/:session?episodeId=&downloads=`

## Local Run

Run KuroStream backend:

```bash
cd backend
npm ci
npm run start
```

Default local URL:

```txt
http://127.0.0.1:8787
```

If using a separate AnimePahe proxy, set:

```bash
export ANIMEPAHE_PROXY_BASE="http://127.0.0.1:3030/api"
```

## Test

```bash
cd backend
npm run lint
npm test
```

## Vercel Deployment

Current production topology:

1. AnimePahe API backend deployed separately.
2. KuroStream backend deployed from `backend/`.
3. Frontend deployed from repo root and forwards `/api/*` to KuroStream backend using `KURO_BACKEND_BASE`.

Required frontend env:

```txt
KURO_BACKEND_BASE=https://kurostream-backend.vercel.app
```

Required Kuro backend env:

```txt
ANIMEPAHE_PROXY_BASE=https://animepahe-api-ashen.vercel.app/api
```

Optional envs:

```txt
SUPABASE_URL=
SUPABASE_ANON_KEY=
JIKAN_BASE=
JIKAN_CACHE_TTL_MS=
JIKAN_CACHE_MAX_SIZE=
```

## Security Notes

- Never commit Vercel tokens, GitHub tokens, or Supabase service role keys.
- Frontend should not hardcode secrets.
- Supabase config is read via `/api/config` or manually entered on `login.html`.
- Only public anon keys should be used client-side.

## Known Runtime Notes

- AnimePahe availability can depend on upstream network/Cloudflare behavior.
- Some episodes may return no playable stream; UI falls back to trailer/empty states.
- Download links appear only when AnimePahe proxy returns them for selected episode.

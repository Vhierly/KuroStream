# KuroStream

KuroStream is an anime streaming web app prototype with a Node.js backend.

## Features

- Home, Explore, Detail, Watch, and My List pages
- Jikan API integration for anime metadata
- AnimePahe proxy integration for stream source lookup
- Continue Watching + My List persistence via Dexie.js (IndexedDB)
- Health/readiness/liveness endpoints for deployment checks
- Rate limiting, CORS controls, structured request logging

## Project Structure

- `backend/` — Express API server, health checks, upstream adapters
- `css/` — styles
- `js/` — frontend scripts
- `*.html` — frontend pages

## Backend Endpoints

- `GET /api/live` — liveness
- `GET /api/ready` — readiness (upstream dependency check)
- `GET /api/health` — combined health diagnostics
- `GET /api/home`
- `GET /api/catalog`
- `GET /api/anime/:id/detail`
- `GET /api/watch/:id?ep=1`

Notes:
- `GET /api/home` returns `featured`, `trending`, and `latest`.
- Continue Watching and My List are client-side user state (Dexie), not API-seeded data.

## Local Run

```bash
cd backend
npm ci
npm run start
```

Default: `http://127.0.0.1:8787`

## Test

```bash
cd backend
npm run lint
npm test
```

## Deploy (Vercel Fullstack)

This repo is ready for full Vercel deployment:

- Frontend: static HTML/CSS/JS from project root
- API: serverless function at `api/[...route].js`

Required Vercel environment variable (choose one mode):

- `ANIMEPAHE_PROXY_BASE` (example: `https://your-proxy-domain/api`) for direct AnimePahe proxy mode
- `KURO_BACKEND_BASE` (example: `https://your-wsl-tunnel.trycloudflare.com`) to forward all `/api/*` traffic to your running WSL backend

Optional envs:

- `JIKAN_BASE`
- `JIKAN_CACHE_TTL_MS`
- `JIKAN_CACHE_MAX_SIZE`

## Legacy Render Files

Render artifacts are still present in `backend/` if you need fallback deploy there.

## Notes

This project is currently optimized as a deployable prototype and can be extended with stronger CI/release automation and full streaming provider runtime validation.

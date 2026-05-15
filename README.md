# KuroStream

KuroStream is an anime streaming web app prototype with a Node.js backend.

## Features

- Home, Explore, Detail, Watch, and My List pages
- Jikan API integration for anime metadata
- AnimePahe proxy integration for stream source lookup
- Continue Watching (local progress persistence)
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
- `GET /api/my-list`

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

## Deploy (Render)

Backend includes:

- `backend/render.yaml`
- `backend/Dockerfile`
- `backend/Procfile`

Set required env in Render:

- `ANIMEPAHE_PROXY_BASE`

## Notes

This project is currently optimized as a deployable prototype and can be extended with stronger CI/release automation and full streaming provider runtime validation.

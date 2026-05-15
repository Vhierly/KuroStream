import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const app = express();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const JIKAN_BASE = process.env.JIKAN_BASE || 'https://api.jikan.moe/v4';
const ANIMEPAHE_BASE = process.env.ANIMEPAHE_BASE || 'https://animepahe.ru/api';
const ANIMEPAHE_PROXY_BASE = process.env.ANIMEPAHE_PROXY_BASE || 'http://127.0.0.1:3030/api';
const JIKAN_CACHE_TTL_MS = Number(process.env.JIKAN_CACHE_TTL_MS || 120000);
const JIKAN_CACHE_MAX_SIZE = Math.max(20, Number(process.env.JIKAN_CACHE_MAX_SIZE || 300));

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const corsOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!corsOrigins.length) {
      return callback(null, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    }
    return callback(null, corsOrigins.includes(origin));
  }
};

const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  limit: Number(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

app.use(cors(corsOptions));
app.use(express.json());
app.disable('x-powered-by');
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = String(requestId);
  res.setHeader('X-Request-Id', req.requestId);

  const startedAt = Date.now();
  res.on('finish', () => {
    const log = {
      level: res.statusCode >= 500 ? 'error' : 'info',
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      ip: req.ip
    };
    console.log(JSON.stringify(log));
  });

  next();
});
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  next();
});
app.use('/api', apiLimiter);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const jikanCache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setJikanCache(key, data) {
  if (jikanCache.has(key)) {
    jikanCache.delete(key);
  }

  jikanCache.set(key, { time: Date.now(), data });

  while (jikanCache.size > JIKAN_CACHE_MAX_SIZE) {
    const oldestKey = jikanCache.keys().next().value;
    if (!oldestKey) break;
    jikanCache.delete(oldestKey);
  }
}

function getJikanCache(key, ttlMs = JIKAN_CACHE_TTL_MS) {
  const cached = jikanCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.time >= ttlMs) {
    jikanCache.delete(key);
    return null;
  }
  return cached.data;
}

function cleanupExpiredJikanCache() {
  const now = Date.now();
  for (const [key, value] of jikanCache.entries()) {
    if (now - value.time >= JIKAN_CACHE_TTL_MS) {
      jikanCache.delete(key);
    }
  }
}

function sendError(res, req, status, code, message, detail = null) {
  return res.status(status).json({
    error: {
      code,
      message,
      requestId: req.requestId,
      ...(detail ? { detail } : {})
    }
  });
}

function pickGenre(genres = []) {
  return genres?.[0]?.name || 'Unknown';
}

function mapStatus(statusRaw) {
  const value = String(statusRaw || '').toLowerCase();
  if (value.includes('finished') || value.includes('complete')) return 'completed';
  return 'ongoing';
}

function mapAnime(item) {
  return {
    id: item.mal_id,
    title: item.title,
    genre: pickGenre(item.genres),
    rating: Number(item.score || 0),
    year: item.year || (item.aired?.from ? new Date(item.aired.from).getFullYear() : null),
    eps: item.episodes || 0,
    status: mapStatus(item.status),
    image: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || null
  };
}

function normalizeEmbedUrl(urlRaw) {
  const url = String(urlRaw || '').trim();
  if (!url) return null;
  if (url.includes('youtube.com/watch?v=')) {
    const id = new URL(url).searchParams.get('v');
    return id ? `https://www.youtube.com/embed/${id}` : url;
  }
  if (url.includes('youtu.be/')) {
    const id = url.split('youtu.be/')[1]?.split(/[?&]/)[0];
    return id ? `https://www.youtube.com/embed/${id}` : url;
  }
  if (url.includes('youtube-nocookie.com/embed/')) {
    const id = url.split('/embed/')[1]?.split(/[?&]/)[0];
    return id ? `https://www.youtube.com/embed/${id}` : url;
  }
  return url;
}

function fallbackSearchEmbed(titleRaw) {
  const title = String(titleRaw || '').trim();
  if (!title) return null;
  const q = encodeURIComponent(`${title} official trailer anime`);
  return `https://www.youtube.com/embed?listType=search&list=${q}`;
}

async function jikanGet(url, params = {}, ttlMs = 120000) {
  const cacheKey = `${url}?${new URLSearchParams(params).toString()}`;
  const cached = getJikanCache(cacheKey, ttlMs);
  if (cached) return cached;

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(`${JIKAN_BASE}${url}`, {
        params,
        timeout: 15000,
        headers: { Accept: 'application/json' }
      });

      setJikanCache(cacheKey, res.data);
      return res.data;
    } catch (error) {
      lastError = error;
      const code = error?.response?.status;
      if (code === 429 && attempt < 3) {
        await sleep(700 * attempt);
        continue;
      }
      break;
    }
  }

  throw lastError;
}

async function checkUpstreamReadiness() {
  let jikanOk = false;
  let jikanError = null;
  let proxyOk = false;
  let proxyError = null;

  try {
    const top = await jikanGet('/top/anime', { limit: 1 }, 30_000);
    jikanOk = Array.isArray(top?.data);
  } catch (error) {
    jikanError = error?.message || String(error);
  }

  try {
    const check = await paheProxyGet('/airing', { page: 1 });
    proxyOk = Array.isArray(check?.data);
  } catch (error) {
    proxyError = error?.message || String(error);
  }

  return {
    ready: jikanOk && proxyOk,
    providers: {
      jikan: jikanOk,
      jikanError,
      animepaheProxy: proxyOk,
      animepaheProxyError: proxyError
    }
  };
}

app.get('/api/live', (_req, res) => {
  res.json({ ok: true, uptimeSec: Math.floor(process.uptime()) });
});

app.get('/api/ready', async (_req, res) => {
  const status = await checkUpstreamReadiness();
  if (!status.ready) {
    return res.status(503).json({ ok: false, ...status });
  }
  return res.json({ ok: true, ...status });
});

async function animepaheGet(params = {}) {
  try {
    const res = await axios.get(ANIMEPAHE_BASE, {
      params,
      timeout: 15000,
      httpsAgent: insecureAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*'
      }
    });

    if (typeof res.data === 'string') {
      throw new Error('AnimePahe returned non-JSON content (possible anti-bot block)');
    }

    return { ok: true, data: res.data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function paheProxyGet(pathname, params = {}) {
  const res = await axios.get(`${ANIMEPAHE_PROXY_BASE}${pathname}`, {
    params,
    timeout: 45000,
    headers: { Accept: 'application/json' }
  });
  return res.data;
}

app.get('/api/health', async (_req, res) => {
  const readiness = await checkUpstreamReadiness();
  const paheDirect = await animepaheGet({ m: 'release', page: 1 });

  const body = {
    ok: readiness.ready,
    live: true,
    ready: readiness.ready,
    providers: {
      ...readiness.providers,
      animepaheDirect: paheDirect.ok,
      animepaheDirectError: paheDirect.ok ? null : paheDirect.error
    },
    cache: {
      size: jikanCache.size,
      maxSize: JIKAN_CACHE_MAX_SIZE,
      ttlMs: JIKAN_CACHE_TTL_MS
    }
  };

  return res.status(readiness.ready ? 200 : 503).json(body);
});

app.get('/api/home', async (req, res) => {
  try {
    const [top, seasonNow] = await Promise.all([
      jikanGet('/top/anime', { limit: 12 }),
      jikanGet('/seasons/now', { limit: 12 })
    ]);

    const featuredSource = (seasonNow.data?.[0] || top.data?.[0]);
    const featured = {
      id: featuredSource?.mal_id || null,
      title: featuredSource?.title || 'Featured Anime',
      subtitle: featuredSource?.synopsis?.slice(0, 160) || 'No synopsis available.',
      genres: (featuredSource?.genres || []).slice(0, 3).map((g) => g.name),
      rating: Number(featuredSource?.score || 0),
      year: featuredSource?.year || new Date(featuredSource?.aired?.from || Date.now()).getFullYear(),
      image: featuredSource?.images?.jpg?.large_image_url || featuredSource?.images?.jpg?.image_url || null
    };

    const trending = (top.data || []).slice(0, 10).map(mapAnime);

    const latestEpisodes = (seasonNow.data || []).slice(0, 8).map((a, i) => ({
      id: a.mal_id,
      anime: a.title,
      image: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || null,
      epNum: Number(a.episodes || 1),
      ep: a.episodes ? `EP ${a.episodes}` : `EP ?`,
      time: `${i + 1}h ago`
    }));

    res.json({ featured, trending, latest: latestEpisodes });
  } catch (error) {
    console.error('GET /api/home failed:', error);
    sendError(res, req, 500, 'HOME_FETCH_FAILED', 'Failed to load home data', error?.message || String(error));
  }
});

app.get('/api/catalog', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const genre = String(req.query.genre || 'All').trim();
    const sort = String(req.query.sort || 'rating').trim();

    const source = q
      ? await jikanGet('/anime', { q, limit: 25, sfw: true })
      : await jikanGet('/top/anime', { limit: 25 });

    let rows = (source.data || []).map(mapAnime);

    if (genre && genre !== 'All') {
      rows = rows.filter((a) => a.genre.toLowerCase() === genre.toLowerCase());
    }

    if (sort === 'year') rows.sort((a, b) => (b.year || 0) - (a.year || 0));
    else rows.sort((a, b) => (b.rating || 0) - (a.rating || 0));

    res.json(rows);
  } catch (error) {
    sendError(res, req, 500, 'CATALOG_FETCH_FAILED', 'Failed to load catalog', error.message);
  }
});

app.get('/api/anime/:id/detail', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return sendError(res, req, 400, 'INVALID_ANIME_ID', 'Invalid anime id');
    }

    const [detail, episodes, charactersRes] = await Promise.all([
      jikanGet(`/anime/${id}/full`),
      jikanGet(`/anime/${id}/episodes`, { page: 1 }),
      jikanGet(`/anime/${id}/characters`).catch(() => ({ data: [] }))
    ]);

    const anime = mapAnime(detail.data);
    const synopsis = detail.data?.synopsis || 'No synopsis available.';

    const episodeList = (episodes.data || []).slice(0, 24).map((ep, idx) => ({
      num: idx + 1,
      title: ep.title || `Episode ${idx + 1}`,
      duration: '24 min'
    }));

    const cast = ((charactersRes?.data) || []).slice(0, 10).map((row) => ({
      character: row.character?.name || '-',
      role: row.role || '-',
      voiceActor: (row.voice_actors || [])[0]?.person?.name || '-',
      language: (row.voice_actors || [])[0]?.language || '-'
    }));

    res.json({
      anime,
      synopsis,
      episodes: episodeList,
      info: {
        studios: (detail.data?.studios || []).map((s) => s.name),
        source: detail.data?.source || '-',
        status: detail.data?.status || '-',
        type: detail.data?.type || '-',
        season: `${detail.data?.season || ''} ${detail.data?.year || ''}`.trim() || '-',
        trailerUrl: detail.data?.trailer?.url || null
      },
      cast
    });
  } catch (error) {
    sendError(res, req, 500, 'ANIME_DETAIL_FETCH_FAILED', 'Failed to load anime detail', error.message);
  }
});

app.get('/api/watch/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const ep = Number(req.query.ep || 1);
    if (!Number.isFinite(id) || id <= 0) {
      return sendError(res, req, 400, 'INVALID_ANIME_ID', 'Invalid anime id');
    }
    const safeEp = Number.isFinite(ep) && ep > 0 ? Math.floor(ep) : 1;

    const [detail, episodes, top] = await Promise.all([
      jikanGet(`/anime/${id}/full`),
      jikanGet(`/anime/${id}/episodes`, { page: 1 }),
      jikanGet('/top/anime', { limit: 10 })
    ]);

    const anime = mapAnime(detail.data);
    const episodeList = (episodes.data || []).slice(0, 24).map((item, idx) => ({
      num: idx + 1,
      title: item.title || `Episode ${idx + 1}`,
      duration: '24 min'
    }));

    let pahe = {
      available: false,
      note: 'No AnimePahe match',
      search: null,
      selectedAnime: null,
      releases: null,
      selectedEpisode: null,
      play: null
    };

    try {
      const search = await paheProxyGet('/search', { q: anime.title });
      const matches = Array.isArray(search?.data) ? search.data : [];
      const selectedAnime = matches.find((m) => Number(m.episodes || 0) > 0) || matches[0];

      if (selectedAnime?.session) {
        const releases = await paheProxyGet(`/${selectedAnime.session}/releases`, {
          sort: 'episode_asc',
          page: 1
        });

        const releaseRows = Array.isArray(releases?.data) ? releases.data : [];
        const selectedEpisode = releaseRows.find((r) => Number(r.episode) === safeEp) || releaseRows[0];

        let play = null;
        if (selectedEpisode?.session) {
          play = await paheProxyGet(`/play/${selectedAnime.session}`, {
            episodeId: selectedEpisode.session,
            downloads: false
          });
        }

        pahe = {
          available: Boolean(play?.sources?.length),
          note: play?.sources?.length ? 'AnimePahe stream sources ready' : 'AnimePahe found, but no stream source on selected episode',
          search,
          selectedAnime,
          releases,
          selectedEpisode,
          play
        };
      }
    } catch (error) {
      pahe = {
        ...pahe,
        note: `AnimePahe proxy error: ${error.message}`
      };
    }

    const trailerEmbed = normalizeEmbedUrl(detail.data?.trailer?.embed_url || detail.data?.trailer?.url)
      || fallbackSearchEmbed(anime.title);
    const paheSources = Array.isArray(pahe.play?.sources) ? pahe.play.sources : [];
    const streamSources = paheSources.filter((source) => source?.isDub !== true);

    if (paheSources.length > 0 && streamSources.length === 0) {
      pahe.note = 'Only English dub sources found; Japanese audio source unavailable for this episode';
    }

    if (!streamSources.length && trailerEmbed) {
      streamSources.push({
        url: null,
        isM3U8: false,
        filename: 'Trailer',
        embed: trailerEmbed,
        resolution: 'Trailer',
        isDub: false,
        fanSub: 'official'
      });
    }

    res.json({
      anime,
      currentEpisode: safeEp,
      episodes: episodeList,
      related: (top.data || []).slice(0, 6).map(mapAnime),
      streamProvider: {
        source: 'animepahe-api',
        available: pahe.available || Boolean(streamSources.length),
        note: pahe.available ? pahe.note : (trailerEmbed ? 'Fallback to official trailer embed' : pahe.note),
        selectedAnimeSession: pahe.selectedAnime?.session || null,
        selectedEpisodeSession: pahe.selectedEpisode?.session || null,
        sources: streamSources,
        downloads: pahe.play?.downloads || []
      }
    });
  } catch (error) {
    sendError(res, req, 500, 'WATCH_CONTEXT_FETCH_FAILED', 'Failed to load watch context', error.message);
  }
});

app.use(express.static(frontendRoot));
app.get('*', (_req, res) => res.sendFile(path.join(frontendRoot, 'home.html')));

const server = app.listen(PORT, HOST, () => {
  console.log(`KuroStream running on http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', event: 'shutdown_start', signal }));
  server.close(() => {
    console.log(JSON.stringify({ level: 'info', event: 'shutdown_complete' }));
    process.exit(0);
  });

  setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', event: 'shutdown_force_exit' }));
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

setInterval(cleanupExpiredJikanCache, 60_000).unref();

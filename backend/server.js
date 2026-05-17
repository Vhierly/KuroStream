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
const OTAKUDESU_API_BASE = process.env.OTAKUDESU_API_BASE || 'https://anoboy.be';
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

async function getAllAnimeEpisodes(animeId) {
  const all = [];
  let page = 1;
  const maxPages = 30;

  while (page <= maxPages) {
    const response = await jikanGet(`/anime/${animeId}/episodes`, { page });
    const rows = Array.isArray(response?.data) ? response.data : [];
    all.push(...rows);

    const hasNext = Boolean(response?.pagination?.has_next_page);
    if (!hasNext || rows.length === 0) break;
    page += 1;
  }

  return all.map((ep, idx) => ({
    num: Number(ep?.mal_id) > 0 ? Number(ep.mal_id) : idx + 1,
    title: ep?.title || `Episode ${idx + 1}`,
    duration: '24 min'
  }));
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

function normalizeTitle(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleTokens(value = '') {
  return normalizeTitle(value).split(/\s+/).filter((x) => x.length >= 3);
}

function scoreTitleMatch(targetTitle, candidateTitle) {
  const target = titleTokens(targetTitle);
  const candidate = titleTokens(candidateTitle);
  if (!target.length || !candidate.length) return 0;
  const hit = target.filter((token) => candidate.includes(token)).length;
  return hit / Math.max(target.length, 1);
}

async function otakudesuGet(pathname) {
  if (!OTAKUDESU_API_BASE) throw new Error('OTAKUDESU_API_BASE not configured');
  const res = await axios.get(`${OTAKUDESU_API_BASE}${pathname}`, {
    timeout: 25000,
    headers: { Accept: 'application/json' }
  });
  return res.data;
}

function isAnimeIndoV2Base() {
  return /\/api\/v2\/anime\/?$/i.test(String(OTAKUDESU_API_BASE || ''));
}

function isAnoboyBase() {
  return /anoboy\./i.test(String(OTAKUDESU_API_BASE || ''));
}

function getAnoboyBaseUrl() {
  const raw = String(OTAKUDESU_API_BASE || '').trim();
  if (!raw) return 'https://anoboy.be';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return `https://${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function parseAnimeIndoSlugPath(slug = '') {
  const raw = String(slug || '').trim();
  if (!raw) return null;
  const match = raw.match(/\/anime\/([^/]+)\/([^/]+)/i);
  if (!match) return null;
  return { animeCode: match[1], animeId: match[2] };
}

function parseAnimeIndoEpisodePath(episodeUrl = '') {
  const raw = String(episodeUrl || '').trim();
  const match = raw.match(/\/anime\/([^/]+)\/([^/]+)\/episode\/([^/?#]+)/i);
  if (!match) return null;
  return { animeCode: match[1], animeId: match[2], episodeId: match[3] };
}

async function resolveAnimeIndoV2Episode(titleInput, requestedEp = 1) {
  const titleCandidates = Array.from(new Set(
    (Array.isArray(titleInput) ? titleInput : [titleInput])
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean)
  ));

  const pools = ['/ongoing?page=1', '/completed?page=1', '/movie?page=1'];
  const rows = [];
  for (const p of pools) {
    const data = await otakudesuGet(p).catch(() => null);
    const arr = Array.isArray(data?.data) ? data.data : [];
    rows.push(...arr);
  }
  if (!rows.length) return { available: false, note: 'AnimeIndo V2: katalog kosong/upstream gagal.', sources: [] };

  const ranked = rows
    .map((item) => ({ ...item, _score: Math.max(...titleCandidates.map((t) => scoreTitleMatch(t, item?.title || ''))) }))
    .sort((a, b) => b._score - a._score);
  const selectedAnime = ranked.find((x) => x._score >= 0.30) || ranked[0];
  const parsed = parseAnimeIndoSlugPath(selectedAnime?.slug || '');
  if (!parsed) return { available: false, note: 'AnimeIndo V2: slug anime tidak valid.', sources: [] };

  const detail = await otakudesuGet(`/${parsed.animeCode}/${parsed.animeId}`).catch(() => null);
  const eps = Array.isArray(detail?.data?.episode_list) ? detail.data.episode_list : [];
  if (!eps.length) return { available: false, note: 'AnimeIndo V2: episode list kosong.', sources: [] };

  const selectedEp = eps.find((e) => extractEpisodeNumber(e?.epsTitle) == requestedEp) || eps[0];
  const episodeMeta = parseAnimeIndoEpisodePath(selectedEp?.episodeId || '');
  if (!episodeMeta) return { available: false, note: 'AnimeIndo V2: episode path tidak ditemukan.', sources: [] };

  const epRes = await otakudesuGet(`/${episodeMeta.animeCode}/${episodeMeta.animeId}/episode/${episodeMeta.episodeId}`).catch(() => null);
  const sourcesRaw = Array.isArray(epRes?.data?.episode_list) ? epRes.data.episode_list : [];
  const sources = sourcesRaw
    .map((s) => ({
      url: s?.source_video || null,
      embed: s?.source_video || null,
      isM3U8: String(s?.source_video || '').includes('.m3u8'),
      filename: `AnimeIndo ${s?.size || 'auto'}`,
      resolution: s?.size || 'auto',
      isDub: false,
      fanSub: 'indo',
      sourceLang: 'id'
    }))
    .filter((s) => /^https?:\/\//i.test(String(s.url || '')));

  if (sources.length) return { available: true, note: 'AnimeIndo V2 stream source ready', sources };

  const activeEpisodeUrl = (Array.isArray(epRes?.data?.list_episode)
    ? epRes.data.list_episode.find((row) => row?.active_eps)?.eps_slug
    : null) || selectedEp?.episodeId || null;
  const iframe = await extractOtakudesuIframe(activeEpisodeUrl || '');
  if (iframe) {
    return {
      available: true,
      note: 'AnimeIndo V2 iframe source ready',
      sources: [{
        url: iframe,
        embed: iframe,
        isM3U8: false,
        filename: 'AnimeIndo Indo (iframe)',
        resolution: 'auto',
        isDub: false,
        fanSub: 'indo',
        sourceLang: 'id'
      }]
    };
  }

  return { available: false, note: 'AnimeIndo V2: stream kosong pada episode ini.', sources: [] };
}

function extractEpisodeNumber(text = '') {
  const match = String(text || '').match(/(\d{1,4})\s*$/);
  return match ? Number(match[1]) : null;
}

function normalizeOtakudesuEpisodeId(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) return raw.replace(/^\/+|\/+$/g, '');
  const withoutQuery = raw.split('?')[0];
  const match = withoutQuery.match(/\/episode\/([^/]+)\/?$/i);
  return (match?.[1] || '').trim();
}

async function extractOtakudesuIframe(episodeUrl = '') {
  if (!/^https?:\/\//i.test(String(episodeUrl || ''))) return null;
  try {
    const res = await axios.get(episodeUrl, {
      timeout: 25000,
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    const html = String(res.data || '');
    const match = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    const src = (match?.[1] || '').trim();
    return /^https?:\/\//i.test(src) ? src : null;
  } catch {
    return null;
  }
}

async function anoboyGetHtml(pathname = '/') {
  const base = getAnoboyBaseUrl();
  const target = /^https?:\/\//i.test(pathname) ? pathname : `${base}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
  const response = await fetch(target, {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Referer: `${base}/`
    }
  });
  if (!response.ok) throw new Error(`Anoboy ${response.status}`);
  return String(await response.text());
}

function parseAnoboyEpisodeMeta(url = '') {
  const raw = String(url || '').trim();
  const match = raw.match(/\/([^/?#]+)\/?$/);
  const slug = (match?.[1] || '').toLowerCase();
  if (!slug.includes('episode-')) return null;
  const epMatch = slug.match(/episode-(\d{1,4})/);
  const ep = epMatch ? Number(epMatch[1]) : null;
  const title = slug
    .replace(/-episode-\d{1,4}.*/, '')
    .replace(/-subtitle-indonesia.*/, '')
    .replace(/-/g, ' ')
    .trim();
  if (!title) return null;
  return { title, ep };
}

async function resolveAnoboyEpisode(titleInput, requestedEp = 1) {
  const titleCandidates = Array.from(new Set(
    (Array.isArray(titleInput) ? titleInput : [titleInput])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
  ));

  const pages = ['/', '/page/2/', '/page/3/'];
  const links = new Set();
  for (const page of pages) {
    const html = await anoboyGetHtml(page).catch(() => '');
    const matches = html.match(/href=["'](https?:\/\/anoboy\.[^"']+)["']/gi) || [];
    for (const m of matches) {
      const u = m.replace(/^href=["']|["']$/gi, '').trim();
      if (/episode-\d{1,4}/i.test(u) && /subtitle-indonesia/i.test(u)) links.add(u);
    }
  }

  if (!links.size) {
    return { available: false, note: 'Anoboy: daftar episode kosong/upstream gagal.', sources: [] };
  }

  const ranked = Array.from(links)
    .map((url) => {
      const meta = parseAnoboyEpisodeMeta(url);
      const score = meta
        ? Math.max(...titleCandidates.map((candidate) => scoreTitleMatch(candidate, meta.title)))
        : 0;
      return { url, meta, _score: score };
    })
    .filter((x) => x.meta)
    .sort((a, b) => b._score - a._score);

  const sameEp = ranked.filter((x) => x.meta?.ep === Number(requestedEp));
  const pick = (sameEp.find((x) => x._score >= 0.25) || sameEp[0])
    || ranked.find((x) => x._score >= 0.30)
    || ranked[0];

  if (!pick?.url) {
    return { available: false, note: 'Anoboy: judul tidak ditemukan.', sources: [] };
  }

  const html = await anoboyGetHtml(pick.url).catch(() => '');
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  const iframe = (iframeMatch?.[1] || '').trim();

  if (!/^https?:\/\//i.test(iframe)) {
    return { available: false, note: 'Anoboy: iframe stream tidak ditemukan.', sources: [] };
  }

  return {
    available: true,
    note: 'Anoboy iframe source ready',
    sources: [{
      url: iframe,
      embed: iframe,
      isM3U8: false,
      filename: 'Anoboy Indo (iframe)',
      resolution: 'auto',
      isDub: false,
      fanSub: 'indo',
      sourceLang: 'id'
    }]
  };
}

async function resolveOtakudesuEpisode(titleInput, requestedEp = 1) {
  if (!OTAKUDESU_API_BASE) {
    return { available: false, note: 'Otakudesu API belum dikonfigurasi.', sources: [] };
  }
  return resolveAnoboyEpisode(titleInput, requestedEp);

  const titleCandidates = Array.from(new Set(
    (Array.isArray(titleInput) ? titleInput : [titleInput])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
  ));

  let best = null;
  let searchNetworkErrors = 0;
  for (const candidateTitle of titleCandidates) {
    const q = encodeURIComponent(candidateTitle);
    let search;
    try {
      search = await otakudesuGet(`/search/${q}`);
    } catch {
      searchNetworkErrors += 1;
      continue;
    }
    const rows = Array.isArray(search?.search_results) ? search.search_results : [];
    if (!rows.length) continue;

    const ranked = rows
      .map((item) => ({ ...item, _score: scoreTitleMatch(candidateTitle, item?.title || '') }))
      .sort((a, b) => b._score - a._score);

    const winner = ranked.find((item) => item._score >= 0.30) || ranked[0];
    if (winner?.id) {
      best = winner;
      break;
    }
  }

  if (!best?.id) {
    if (searchNetworkErrors >= Math.max(1, titleCandidates.length)) {
      return { available: false, note: 'Otakudesu upstream tidak bisa diakses.', sources: [] };
    }
    return { available: false, note: 'Otakudesu: judul tidak ditemukan.', sources: [] };
  }

  const detail = await otakudesuGet(`/anime/${best.id}`).catch(() => ({ episode_list: [] }));
  const episodes = Array.isArray(detail?.episode_list) ? detail.episode_list : [];
  if (!episodes.length) {
    return { available: false, note: 'Otakudesu: episode list kosong.', sources: [] };
  }

  const selected = episodes.find((row) => extractEpisodeNumber(row?.title) == requestedEp) || episodes[0];
  if (!selected?.id) {
    return { available: false, note: 'Otakudesu: id episode tidak ditemukan.', sources: [] };
  }

  const episodeId = normalizeOtakudesuEpisodeId(selected.id || selected.link || '');
  if (!episodeId) {
    return { available: false, note: 'Otakudesu: id episode tidak valid.', sources: [] };
  }

  const ep = await otakudesuGet(`/eps/${episodeId}/`).catch(() => ({}));
  const streamRaw = ep?.link_stream || ep?.streamLink || null;
  const stream = /^https?:\/\//i.test(String(streamRaw || '').trim()) ? String(streamRaw).trim() : null;

  if (stream) {
    return {
      available: true,
      note: 'Otakudesu stream source ready',
      sources: [{
        url: stream,
        embed: stream,
        isM3U8: String(stream).includes('.m3u8'),
        filename: 'Otakudesu Indo',
        resolution: 'auto',
        isDub: false,
        fanSub: 'indo',
        sourceLang: 'id'
      }]
    };
  }

  const iframe = await extractOtakudesuIframe(selected.link || selected.id || '');
  if (iframe) {
    return {
      available: true,
      note: 'Otakudesu iframe source ready',
      sources: [{
        url: iframe,
        embed: iframe,
        isM3U8: false,
        filename: 'Otakudesu Indo (iframe)',
        resolution: 'auto',
        isDub: false,
        fanSub: 'indo',
        sourceLang: 'id'
      }]
    };
  }

  return { available: false, note: 'Otakudesu: link stream dan iframe kosong.', sources: [] };
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

    const [detail, episodeList, charactersRes] = await Promise.all([
      jikanGet(`/anime/${id}/full`),
      getAllAnimeEpisodes(id),
      jikanGet(`/anime/${id}/characters`).catch(() => ({ data: [] }))
    ]);

    const anime = mapAnime(detail.data);
    const synopsis = detail.data?.synopsis || 'No synopsis available.';

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

    const [detail, episodeList, top] = await Promise.all([
      jikanGet(`/anime/${id}/full`),
      getAllAnimeEpisodes(id),
      jikanGet('/top/anime', { limit: 10 })
    ]);

    const anime = mapAnime(detail.data);

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
    const paheSubEngSources = paheSources
      .filter((source) => source?.isDub !== true)
      .map((source) => ({ ...source, fanSub: source?.fanSub || 'eng', sourceLang: 'en' }));

    if (paheSources.length > 0 && paheSubEngSources.length === 0) {
      pahe.note = 'Only English dub sources found; Japanese audio source unavailable for this episode';
    }

    const subIndoSourceId = 'disabled';
    const indo = { available: false, note: 'Sub INDO dinonaktifkan.', sources: [] };

    const streamSources = [...paheSubEngSources, ...(indo.sources || [])];

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

    const providerNotes = [
      `Sub ENG: ${pahe.note}`,
      `Sub INDO: ${indo.note}`
    ].filter(Boolean).join(' | ');

    res.json({
      anime,
      currentEpisode: safeEp,
      episodes: episodeList,
      related: (top.data || []).slice(0, 6).map(mapAnime),
      streamProvider: {
        source: `animepahe+${subIndoSourceId}`,
        available: Boolean(streamSources.length),
        note: streamSources.length ? providerNotes : (trailerEmbed ? `Fallback trailer. ${providerNotes}` : providerNotes),
        selectedAnimeSession: pahe.selectedAnime?.session || null,
        selectedEpisodeSession: pahe.selectedEpisode?.session || null,
        sources: streamSources,
        downloads: pahe.play?.downloads || [],
        providers: {
          subEng: { source: 'animepahe-api', available: paheSubEngSources.length > 0, count: paheSubEngSources.length, note: pahe.note, sources: paheSubEngSources },
          subIndo: { source: subIndoSourceId, available: indo.available, count: (indo.sources || []).length, note: indo.note, sources: (indo.sources || []) }
        }
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

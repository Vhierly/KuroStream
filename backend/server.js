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
const ANIMEPAHE_BASE = process.env.ANIMEPAHE_BASE || 'https://animepahe.ru/api';
const ANIMEPAHE_PROXY_BASE = process.env.ANIMEPAHE_PROXY_BASE || 'http://127.0.0.1:3030/api';
const OTAKUDESU_API_BASE = process.env.OTAKUDESU_API_BASE || 'https://anoboy.be';

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function checkUpstreamReadiness() {
  let proxyOk = false;
  let proxyError = null;

  try {
    const check = await paheProxyGet('/airing', { page: 1 });
    proxyOk = normalizeListPayload(check).length > 0;
  } catch (error) {
    proxyError = error?.message || String(error);
  }

  return {
    ready: proxyOk,
    providers: {
      paheanime: proxyOk,
      paheanimeError: proxyError
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
      provider: 'paheanime',
      size: 0,
      maxSize: 0,
      ttlMs: 0
    }
  };

  return res.status(readiness.ready ? 200 : 503).json(body);
});

const fallbackAnime = [
  { id: 21, session: 'one-piece', title: 'One Piece', genre: 'Adventure', rating: 8.72, year: 1999, eps: 1130, status: 'ongoing', image: 'https://cdn.myanimelist.net/images/anime/1244/138851l.jpg' },
  { id: 52991, session: 'sousou-no-frieren', title: 'Sousou no Frieren', genre: 'Adventure', rating: 9.29, year: 2023, eps: 28, status: 'completed', image: 'https://cdn.myanimelist.net/images/anime/1015/138006l.jpg' },
  { id: 5114, session: 'fullmetal-alchemist-brotherhood', title: 'Fullmetal Alchemist: Brotherhood', genre: 'Action', rating: 9.10, year: 2009, eps: 64, status: 'completed', image: 'https://cdn.myanimelist.net/images/anime/1208/94745l.jpg' },
  { id: 9253, session: 'steins-gate', title: 'Steins;Gate', genre: 'Drama', rating: 9.07, year: 2011, eps: 24, status: 'completed', image: 'https://cdn.myanimelist.net/images/anime/1935/127974l.jpg' },
  { id: 11061, session: 'hunter-x-hunter-2011', title: 'Hunter x Hunter (2011)', genre: 'Action', rating: 9.03, year: 2011, eps: 148, status: 'completed', image: 'https://cdn.myanimelist.net/images/anime/1337/99013l.jpg' },
  { id: 16498, session: 'shingeki-no-kyojin', title: 'Shingeki no Kyojin', genre: 'Action', rating: 8.55, year: 2013, eps: 25, status: 'completed', image: 'https://cdn.myanimelist.net/images/anime/10/47347l.jpg' },
  { id: 30276, session: 'one-punch-man', title: 'One Punch Man', genre: 'Action', rating: 8.48, year: 2015, eps: 12, status: 'completed', image: 'https://cdn.myanimelist.net/images/anime/12/76049l.jpg' },
  { id: 31964, session: 'boku-no-hero-academia', title: 'Boku no Hero Academia', genre: 'Action', rating: 7.85, year: 2016, eps: 13, status: 'ongoing', image: 'https://cdn.myanimelist.net/images/anime/10/78745l.jpg' },
  { id: 40748, session: 'jujutsu-kaisen', title: 'Jujutsu Kaisen', genre: 'Action', rating: 8.60, year: 2020, eps: 47, status: 'completed', image: 'https://cdn.myanimelist.net/images/anime/1171/109222l.jpg' },
  { id: 38000, session: 'kimetsu-no-yaiba', title: 'Kimetsu no Yaiba', genre: 'Action', rating: 8.45, year: 2019, eps: 63, status: 'ongoing', image: 'https://cdn.myanimelist.net/images/anime/1286/99889l.jpg' },
  { id: 33352, session: 'violet-evergarden', title: 'Violet Evergarden', genre: 'Drama', rating: 8.67, year: 2018, eps: 13, status: 'completed', image: 'https://cdn.myanimelist.net/images/anime/1795/95088l.jpg' },
  { id: 20583, session: 'haikyuu', title: 'Haikyuu!!', genre: 'Sports', rating: 8.44, year: 2014, eps: 85, status: 'completed', image: 'https://cdn.myanimelist.net/images/anime/7/76014l.jpg' }
];

function hashId(value = '') {
  const hex = crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

function firstImage(item = {}) {
  return item.poster || item.image || item.cover || item.snapshot || item.thumbnail || item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || null;
}

function mapPaheAnime(item = {}, idx = 0) {
  const title = item.title || item.name || item.anime_title || `Anime ${idx + 1}`;
  const episodeCount = Number(item.episodes || item.episode || item.latestEpisode || item.latest_episode || item.totalEpisodes || 0);
  const session = item.session || item.id || item.slug || item.animeSession || normalizeTitle(title).replace(/\s+/g, '-');
  return {
    id: Number(item.anime_id || item.mal_id || item.anilist_id || item.numericId || item.id || 0) || hashId(session || title),
    session,
    title,
    genre: item.genre || item.type || 'Anime',
    rating: Number(item.score || item.rating || 0),
    year: Number(item.year || item.releaseYear || 0) || null,
    eps: episodeCount,
    status: mapStatus(item.status || (episodeCount ? 'ongoing' : 'ongoing')),
    image: firstImage(item)
  };
}

function mapPaheDetail(payload = {}, fallback = {}) {
  const title = payload.title || fallback.title || 'Anime';
  const ids = payload.ids || {};
  return {
    id: Number(ids.animepahe_id || ids.mal || fallback.id || 0) || hashId(payload.session || title),
    session: payload.session || fallback.session || null,
    title,
    genre: Array.isArray(payload.genre) ? payload.genre.join(', ') : (payload.genre || payload.type || fallback.genre || 'Anime'),
    rating: Number(payload.score || fallback.rating || 0),
    year: Number(payload.year || String(payload.season || payload.aired || '').match(/\b(19|20)\d{2}\b/)?.[0] || fallback.year || 0) || null,
    eps: Number(payload.episodes || fallback.eps || 0),
    status: mapStatus(payload.status || fallback.status || 'ongoing'),
    image: firstImage(payload) || fallback.image || null,
    synopsis: payload.synopsis || null,
    info: payload
  };
}

function mapPaheRelatedRows(rows = []) {
  return normalizeListPayload(rows).map((row, idx) => mapPaheAnime({
    ...row,
    id: row.id || row.anime_id || row.ids?.animepahe_id || hashId(row.session || row.title || idx),
    image: firstImage(row) || row.poster
  }, idx)).filter((row) => row.title);
}

async function resolvePaheAnime(id, query = {}) {
  const title = String(query.title || '').trim();
  const session = String(query.session || '').trim();
  const base = fallbackAnime.find((a) => a.id === id) || null;
  if (title) {
    const found = await findPaheAnimeByTitle(title).catch(() => null);
    if (found?.session) {
      const detail = await paheProxyGet(`/${found.session}`).catch(() => null);
      if (detail?.title) return mapPaheDetail({ ...detail, session: found.session }, found);
      return found;
    }
  }
  if (session) {
    const detail = await paheProxyGet(`/${session}`).catch(() => null);
    if (detail?.title) return mapPaheDetail({ ...detail, session }, base || {});
  }
  if (base) {
    const found = await findPaheAnimeByTitle(base.title).catch(() => null);
    return found || base;
  }
  return null;
}

const posterCache = new Map();
async function findAnimePosterByTitle(title) {
  const key = normalizeTitle(title);
  if (!key) return null;
  if (posterCache.has(key)) return posterCache.get(key);
  const found = await findPaheAnimeByTitle(title).catch(() => null);
  const poster = found?.image || null;
  posterCache.set(key, poster);
  if (posterCache.size > 300) posterCache.delete(posterCache.keys().next().value);
  return poster;
}

async function enrichPosters(rows = []) {
  const limited = rows.slice(0, 12);
  await Promise.all(limited.map(async (row) => {
    const poster = await findAnimePosterByTitle(row.title);
    if (poster) row.image = poster;
  }));
  return rows;
}

function normalizeListPayload(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'results', 'anime', 'items', 'list']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

async function getPaheList(kind = 'airing', params = {}) {
  const paths = kind === 'search'
    ? ['/search']
    : kind === 'releases'
      ? ['/releases', '/release', '/airing']
      : ['/airing', '/release', '/releases'];

  for (const pathname of paths) {
    try {
      const data = await paheProxyGet(pathname, { page: 1, ...params });
      const rows = normalizeListPayload(data).map(mapPaheAnime).filter((x) => x.title);
      if (rows.length) return rows;
    } catch (_error) {}
  }
  return [];
}

async function findPaheAnimeByTitle(title) {
  const rows = await getPaheList('search', { q: title });
  if (!rows.length) return null;
  const ranked = rows
    .map((row) => ({ ...row, _score: scoreTitleMatch(title, row.title) }))
    .sort((a, b) => b._score - a._score);
  return ranked[0];
}

function buildPaheEpisodes(anime, releaseRows = []) {
  const rows = normalizeListPayload(releaseRows);
  if (rows.length) {
    return rows.map((row, idx) => ({
      num: Number(row.episode || row.ep || row.number || idx + 1),
      title: row.title || row.name || `Episode ${Number(row.episode || idx + 1)}`,
      duration: row.duration || '24 min',
      session: row.session || row.id || null
    })).sort((a, b) => a.num - b.num);
  }
  const total = Math.max(1, Math.min(Number(anime?.eps || 12), 1200));
  return Array.from({ length: total }, (_row, idx) => ({ num: idx + 1, title: `Episode ${idx + 1}`, duration: '24 min' }));
}

function buildHomePayload(paheRows = []) {
  const rows = paheRows.length ? paheRows : fallbackAnime;
  const ongoing = rows.filter((a) => a.status === 'ongoing' || Number(a.eps || 0) > 0);
  const featured = {
    ...(ongoing[0] || rows[0]),
    subtitle: 'Powered by Paheanime / AnimePahe data. Watch latest anime releases and ongoing episodes.'
  };
  const latest = (ongoing.length ? ongoing : rows).slice(0, 8).map((a, i) => ({
    id: a.id,
    anime: a.title,
    image: a.image,
    epNum: Number(a.eps || 0) || null,
    ep: Number(a.eps || 0) ? `EP ${a.eps}` : 'EP TBA',
    status: a.status,
    time: `${i + 1}h ago`
  }));
  return { featured, trending: rows.slice(0, 10), latest };
}

app.get('/api/home', async (_req, res) => {
  const rows = await enrichPosters(await getPaheList('airing'));
  res.json(buildHomePayload(rows));
});

app.get('/api/catalog', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const genre = String(req.query.genre || 'All').trim();
  const sort = String(req.query.sort || 'rating').trim();
  const mode = String(req.query.mode || (q ? 'search' : 'airing')).trim();
  const tab = String(req.query.tab || 'all').trim();
  const page = Math.max(1, Math.floor(Number(req.query.page || 1) || 1));
  const perPage = Math.min(30, Math.max(5, Math.floor(Number(req.query.perPage || 10) || 10)));

  let payload = null;
  let rows = [];
  try {
    const params = { page, perPage };
    let pathname = '/airing';
    if (mode === 'search' || q) {
      pathname = '/search';
      params.q = q || 'anime';
    } else if (mode === 'queue') {
      pathname = '/queue';
    } else if (mode === 'az') {
      pathname = '/anime';
      if (tab && tab !== 'all') params.tab = tab;
    }
    payload = await paheProxyGet(pathname, params);
    rows = normalizeListPayload(payload).map(mapPaheAnime).filter((x) => x.title);
  } catch (_error) {}

  if (!rows.length) {
    rows = fallbackAnime;
  }

  if (q && mode !== 'search') rows = rows.filter((a) => normalizeTitle(a.title).includes(normalizeTitle(q)) || scoreTitleMatch(q, a.title) > 0.25);
  if (genre && genre !== 'All') rows = rows.filter((a) => a.genre.toLowerCase() === genre.toLowerCase());
  if (sort === 'year') rows.sort((a, b) => (b.year || 0) - (a.year || 0));
  else if (sort === 'title') rows.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'episodes') rows.sort((a, b) => (b.eps || 0) - (a.eps || 0));
  else rows.sort((a, b) => (b.rating || 0) - (a.rating || 0));

  const pageInfo = payload?.paginationInfo || payload?.pagination || payload || {};
  const apiCurrentPage = Number(pageInfo.current_page || pageInfo.currentPage || pageInfo.page || page) || page;
  const apiTotalPages = Number(pageInfo.last_page || pageInfo.lastPage || pageInfo.total_pages || pageInfo.totalPages || 0);
  const apiTotalItems = Number(pageInfo.total || pageInfo.totalItems || 0);
  const localTotalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const totalPages = apiTotalPages || localTotalPages;
  const totalItems = apiTotalItems || (apiTotalPages ? apiTotalPages * perPage : rows.length);
  const items = await enrichPosters(apiTotalPages ? rows : rows.slice((page - 1) * perPage, page * perPage));

  res.json({
    items,
    pagination: {
      page: apiCurrentPage,
      perPage,
      totalItems,
      totalPages,
      hasNextPage: apiCurrentPage < totalPages,
      hasPrevPage: apiCurrentPage > 1
    }
  });
});

app.get('/api/anime/:id/detail', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return sendError(res, req, 400, 'INVALID_ANIME_ID', 'Invalid anime id');
  const anime = await resolvePaheAnime(id, req.query);
  if (!anime) return sendError(res, req, 404, 'ANIME_NOT_FOUND', 'Anime not found');
  let releases = [];
  if (anime.session) {
    releases = await paheProxyGet(`/${anime.session}/releases`, { sort: 'episode_asc', page: 1 }).catch(() => []);
  }
  const episodes = buildPaheEpisodes(anime, releases);
  res.json({
    anime,
    synopsis: anime.synopsis || `${anime.title} details loaded from Paheanime / AnimePahe.`,
    episodes,
    info: {
      studios: Array.isArray(anime.info?.studio) ? anime.info.studio : (anime.info?.studio ? [anime.info.studio] : ['Paheanime / AnimePahe']),
      source: 'Paheanime API',
      status: anime.status,
      type: anime.info?.type || anime.genre || 'Anime',
      season: anime.info?.season || (anime.year ? String(anime.year) : '-'),
      trailerUrl: anime.info?.preview || null
    },
    extra: {
      japanese: anime.info?.japanese || null,
      synonym: anime.info?.synonym || null,
      aired: anime.info?.aired || null,
      duration: anime.info?.duration || null,
      genres: anime.info?.genre || [],
      themes: anime.info?.themes || [],
      demographic: anime.info?.demographic || [],
      externalLinks: anime.info?.external_links || [],
      relations: anime.info?.relations || []
    },
    recommendations: mapPaheRelatedRows(anime.info?.recommendations || []),
    cast: []
  });
});

app.get('/api/watch/:id', async (req, res) => {
  const id = Number(req.params.id);
  const ep = Number(req.query.ep || 1);
  if (!Number.isFinite(id) || id <= 0) return sendError(res, req, 400, 'INVALID_ANIME_ID', 'Invalid anime id');
  const safeEp = Number.isFinite(ep) && ep > 0 ? Math.floor(ep) : 1;
  const anime = await resolvePaheAnime(id, req.query);
  if (!anime) return sendError(res, req, 404, 'ANIME_NOT_FOUND', 'Anime not found');
  let releasePayload = [];
  if (anime.session) releasePayload = await paheProxyGet(`/${anime.session}/releases`, { sort: 'episode_asc', page: 1 }).catch(() => []);
  const episodes = buildPaheEpisodes(anime, releasePayload);
  const selectedEpisode = episodes.find((row) => Number(row.num) === safeEp) || episodes[0];
  let play = null;
  if (anime.session && selectedEpisode?.session) {
    play = await paheProxyGet(`/play/${anime.session}`, { episodeId: selectedEpisode.session, downloads: false }).catch(() => null);
  }
  const paheSources = normalizeListPayload(play?.sources || play).filter(Boolean);
  const streamSources = paheSources
    .map((source) => ({ ...source, fanSub: source?.fanSub || source?.fansub || 'eng', sourceLang: source?.isDub ? 'dub' : 'sub' }));
  const trailerEmbed = fallbackSearchEmbed(anime.title);
  if (!streamSources.length) {
    streamSources.push({ url: null, isM3U8: false, filename: 'Trailer', embed: trailerEmbed, resolution: 'Trailer', isDub: false, fanSub: 'official' });
  }
  res.json({
    anime,
    currentEpisode: safeEp,
    episodes,
    related: mapPaheRelatedRows(anime.info?.recommendations || []).slice(0, 6).concat(fallbackAnime.filter((item) => item.id !== anime.id)).slice(0, 6),
    streamProvider: {
      source: 'paheanime',
      available: Boolean(streamSources.length),
      note: paheSources.length ? 'Paheanime stream sources ready' : 'Using official trailer fallback because Paheanime stream source is unavailable.',
      selectedAnimeSession: anime.session || null,
      selectedEpisodeSession: selectedEpisode?.session || null,
      sources: streamSources,
      downloads: play?.downloads || [],
      trailer: { embed: trailerEmbed },
      providers: {
        subEng: { source: 'paheanime', available: true, count: streamSources.length, note: 'Paheanime source', sources: streamSources },
        subIndo: { source: 'disabled', available: false, count: 0, note: 'Indonesian subtitles are not enabled.', sources: [] }
      }
    }
  });
});

app.use(express.static(frontendRoot));
app.get('*', (_req, res) => res.sendFile(path.join(frontendRoot, 'home.html')));

let server = null;
if (!process.env.VERCEL) {
  server = app.listen(PORT, HOST, () => {
    console.log(`KuroStream running on http://${HOST}:${PORT}`);
  });
}

export default app;

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


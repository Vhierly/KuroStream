const JIKAN_BASE = process.env.JIKAN_BASE || 'https://api.jikan.moe/v4';
const ANIMEPAHE_PROXY_BASE = process.env.ANIMEPAHE_PROXY_BASE || '';
const OTAKUDESU_API_BASE = process.env.OTAKUDESU_API_BASE || 'https://anoboy.be';
const KURO_BACKEND_BASE = process.env.KURO_BACKEND_BASE || '';
const JIKAN_CACHE_TTL_MS = Number(process.env.JIKAN_CACHE_TTL_MS || 120000);
const JIKAN_CACHE_MAX_SIZE = Math.max(20, Number(process.env.JIKAN_CACHE_MAX_SIZE || 300));
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const jikanCache = global.__kuroJikanCache || new Map();
global.__kuroJikanCache = jikanCache;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setCache(key, data) {
  if (jikanCache.has(key)) jikanCache.delete(key);
  jikanCache.set(key, { time: Date.now(), data });
  while (jikanCache.size > JIKAN_CACHE_MAX_SIZE) {
    const oldestKey = jikanCache.keys().next().value;
    if (!oldestKey) break;
    jikanCache.delete(oldestKey);
  }
}

function getCache(key, ttlMs = JIKAN_CACHE_TTL_MS) {
  const cached = jikanCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.time >= ttlMs) {
    jikanCache.delete(key);
    return null;
  }
  return cached.data;
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function pickGenre(genres = []) {
  return genres?.[0]?.name || 'Unknown';
}

function mapStatus(statusRaw) {
  const value = String(statusRaw || '').toLowerCase();
  if (value.includes('finished') || value.includes('complete')) return 'completed';
  return 'ongoing';
}

function mapAnime(item = {}) {
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



async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

async function supabaseAuth(pathname, { method = 'GET', token = '', body = null } = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('SUPABASE_ENV_NOT_SET');
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: token ? `Bearer ${token}` : `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json'
  };
  const response = await fetch(`${SUPABASE_URL}/auth/v1${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text || '' }; }
  if (!response.ok) {
    const err = new Error(data?.msg || data?.message || `SUPABASE_AUTH_${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function supabaseRest(pathname, { method = 'GET', token, body = null, query = '' } = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('SUPABASE_ENV_NOT_SET');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}${query}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = [];
  try { data = text ? JSON.parse(text) : []; } catch { data = []; }
  if (!response.ok) {
    const err = new Error(data?.message || `SUPABASE_REST_${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

function getBearer(req) {
  const header = req.headers?.authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

function normalizeEmbedUrl(urlRaw) {
  const url = String(urlRaw || '').trim();
  if (!url) return null;
  if (url.includes('youtube.com/watch?v=')) {
    const parsed = new URL(url);
    const id = parsed.searchParams.get('v');
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

async function jikanGet(url, params = {}, ttlMs = JIKAN_CACHE_TTL_MS) {
  const cacheKey = `${url}?${new URLSearchParams(params).toString()}`;
  const cached = getCache(cacheKey, ttlMs);
  if (cached) return cached;

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const u = new URL(`${JIKAN_BASE}${url}`);
      Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
      const response = await fetch(u.toString(), {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        const err = new Error(`Jikan ${response.status}`);
        err.code = response.status;
        throw err;
      }
      const data = await response.json();
      setCache(cacheKey, data);
      return data;
    } catch (error) {
      lastError = error;
      if (error?.code === 429 && attempt < 3) {
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

async function paheProxyGet(pathname, params = {}) {
  if (!ANIMEPAHE_PROXY_BASE) throw new Error('ANIMEPAHE_PROXY_BASE not configured');
  const u = new URL(`${ANIMEPAHE_PROXY_BASE}${pathname}`);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  const response = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`AnimePahe proxy ${response.status}`);
  return response.json();
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
  const u = new URL(`${OTAKUDESU_API_BASE}${pathname}`);
  const response = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Otakudesu API ${response.status}`);
  return response.json();
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
    const response = await fetch(episodeUrl, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) return null;
    const html = String(await response.text());
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

async function checkReadiness() {
  let jikanOk = false;
  let jikanError = null;
  let proxyOk = false;
  let proxyError = null;

  try {
    const top = await jikanGet('/top/anime', { limit: 1 }, 30000);
    jikanOk = Array.isArray(top?.data);
  } catch (e) {
    jikanError = e?.message || String(e);
  }

  if (KURO_BACKEND_BASE) {
    try {
      const u = new URL('/api/live', KURO_BACKEND_BASE.endsWith('/') ? KURO_BACKEND_BASE : `${KURO_BACKEND_BASE}/`);
      const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
      proxyOk = r.ok;
      if (!r.ok) proxyError = `Kuro backend ${r.status}`;
    } catch (e) {
      proxyError = e?.message || String(e);
    }
  } else {
    try {
      const check = await paheProxyGet('/airing', { page: 1 });
      proxyOk = Array.isArray(check?.data);
    } catch (e) {
      proxyError = e?.message || String(e);
    }
  }

  return {
    ready: jikanOk && proxyOk,
    providers: {
      jikan: jikanOk,
      jikanError,
      animepaheProxy: proxyOk,
      animepaheProxyError: proxyError,
      kuroBackendProxyMode: Boolean(KURO_BACKEND_BASE)
    }
  };
}

module.exports = async (req, res) => {
  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const path = urlObj.pathname.replace(/^\/api/, '');

    if (KURO_BACKEND_BASE) {
      const base = KURO_BACKEND_BASE.endsWith('/') ? KURO_BACKEND_BASE.slice(0, -1) : KURO_BACKEND_BASE;
      const upstream = `${base}/api${path}${urlObj.search || ''}`;
      const response = await fetch(upstream, { headers: { Accept: 'application/json' } });
      const raw = await response.text();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch (_e) {
        body = { error: { code: 'UPSTREAM_NON_JSON', message: raw.slice(0, 500) } };
      }
      return json(res, response.status, body);
    }

    if (path === '/auth/register' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = String(body?.email || '').trim();
      const password = String(body?.password || '');
      if (!email || !password) return json(res, 400, { error: { code: 'INVALID_INPUT', message: 'Email and password are required' } });
      const data = await supabaseAuth('/signup', { method: 'POST', body: { email, password } });
      return json(res, 200, { ok: true, user: data.user || null, session: data.session || null });
    }

    if (path === '/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = String(body?.email || '').trim();
      const password = String(body?.password || '');
      if (!email || !password) return json(res, 400, { error: { code: 'INVALID_INPUT', message: 'Email and password are required' } });
      const data = await supabaseAuth('/token?grant_type=password', { method: 'POST', body: { email, password } });
      return json(res, 200, {
        access_token: data.access_token || '',
        refresh_token: data.refresh_token || '',
        expires_in: data.expires_in || 0,
        token_type: data.token_type || 'bearer',
        user: data.user || null
      });
    }

    if (path === '/auth/user' && req.method === 'GET') {
      const token = getBearer(req);
      if (!token) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing token' } });
      const data = await supabaseAuth('/user', { method: 'GET', token });
      return json(res, 200, { user: data || null });
    }

    if (path === '/auth/logout' && req.method === 'POST') {
      const token = getBearer(req);
      if (!token) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing token' } });
      await supabaseAuth('/logout', { method: 'POST', token });
      return json(res, 200, { ok: true });
    }

    if (path === '/user/my-list' && req.method === 'GET') {
      const token = getBearer(req);
      if (!token) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing token' } });
      const rows = await supabaseRest('my_list', { method: 'GET', token, query: '?select=payload&order=updated_at.desc&limit=60' });
      return json(res, 200, { rows: (rows || []).map((r) => r.payload).filter(Boolean) });
    }

    if (path === '/user/continue-watching' && req.method === 'GET') {
      const token = getBearer(req);
      if (!token) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing token' } });
      const rows = await supabaseRest('continue_watching', { method: 'GET', token, query: '?select=payload&order=updated_at.desc&limit=24' });
      return json(res, 200, { rows: (rows || []).map((r) => r.payload).filter(Boolean) });
    }

    if (path === '/user/my-list' && req.method === 'POST') {
      const token = getBearer(req);
      if (!token) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing token' } });
      const body = await readJsonBody(req);
      const payload = Array.isArray(body?.rows) ? body.rows : [];
      const user = await supabaseAuth('/user', { method: 'GET', token });
      const rows = payload.map((x) => ({ user_id: user.id, anime_id: Number(x.id), payload: x, updated_at: new Date(Number(x.updatedAt || Date.now())).toISOString() }))
        .filter((x) => Number.isFinite(x.anime_id) && x.anime_id > 0)
        .slice(0, 60);
      if (rows.length) await supabaseRest('my_list', { method: 'POST', token, query: '?on_conflict=user_id,anime_id', body: rows });
      return json(res, 200, { ok: true });
    }

    if (path === '/user/continue-watching' && req.method === 'POST') {
      const token = getBearer(req);
      if (!token) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing token' } });
      const body = await readJsonBody(req);
      const payload = Array.isArray(body?.rows) ? body.rows : [];
      const user = await supabaseAuth('/user', { method: 'GET', token });
      const rows = payload.map((x) => ({ user_id: user.id, anime_id: Number(x.id), payload: x, updated_at: new Date(Number(x.updatedAt || Date.now())).toISOString() }))
        .filter((x) => Number.isFinite(x.anime_id) && x.anime_id > 0)
        .slice(0, 24);
      if (rows.length) await supabaseRest('continue_watching', { method: 'POST', token, query: '?on_conflict=user_id,anime_id', body: rows });
      return json(res, 200, { ok: true });
    }

    if (path === '/live') {
      return json(res, 200, { ok: true, uptimeSec: Math.floor(process.uptime()) });
    }

    if (path === '/ready') {
      const status = await checkReadiness();
      return json(res, status.ready ? 200 : 503, { ok: status.ready, ...status });
    }

    if (path === '/health') {
      const readiness = await checkReadiness();
      return json(res, readiness.ready ? 200 : 503, {
        ok: readiness.ready,
        live: true,
        ready: readiness.ready,
        providers: readiness.providers,
        cache: {
          size: jikanCache.size,
          maxSize: JIKAN_CACHE_MAX_SIZE,
          ttlMs: JIKAN_CACHE_TTL_MS
        }
      });
    }

    if (path === '/home') {
      const [top, seasonNow] = await Promise.all([
        jikanGet('/top/anime', { limit: 12 }),
        jikanGet('/seasons/now', { limit: 12 })
      ]);

      const featuredSource = seasonNow.data?.[0] || top.data?.[0];
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
      const latest = (seasonNow.data || []).slice(0, 8).map((a, i) => ({
        id: a.mal_id,
        anime: a.title,
        image: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || null,
        epNum: Number(a.episodes || 1),
        ep: a.episodes ? `EP ${a.episodes}` : 'EP ?',
        time: `${i + 1}h ago`
      }));
      return json(res, 200, { featured, trending, latest });
    }

    if (path === '/catalog') {
      const q = String(urlObj.searchParams.get('q') || '').trim();
      const genre = String(urlObj.searchParams.get('genre') || 'All').trim();
      const sort = String(urlObj.searchParams.get('sort') || 'rating').trim();

      const source = q
        ? await jikanGet('/anime', { q, limit: 25, sfw: true })
        : await jikanGet('/top/anime', { limit: 25 });

      let rows = (source.data || []).map(mapAnime);
      if (genre && genre !== 'All') {
        rows = rows.filter((a) => a.genre.toLowerCase() === genre.toLowerCase());
      }
      if (sort === 'year') rows.sort((a, b) => (b.year || 0) - (a.year || 0));
      else rows.sort((a, b) => (b.rating || 0) - (a.rating || 0));

      return json(res, 200, rows);
    }

    const detailMatch = path.match(/^\/anime\/(\d+)\/detail$/);
    if (detailMatch) {
      const id = Number(detailMatch[1]);
      if (!Number.isFinite(id) || id <= 0) return json(res, 400, { error: { code: 'INVALID_ANIME_ID', message: 'Invalid anime id' } });

      const [detail, episodeList, charactersRes] = await Promise.all([
        jikanGet(`/anime/${id}/full`),
        getAllAnimeEpisodes(id),
        jikanGet(`/anime/${id}/characters`).catch(() => ({ data: [] }))
      ]);

      const anime = mapAnime(detail.data);
      const synopsis = detail.data?.synopsis || 'No synopsis available.';
      const cast = (charactersRes?.data || []).slice(0, 10).map((row) => ({
        character: row.character?.name || '-',
        role: row.role || '-',
        voiceActor: (row.voice_actors || [])[0]?.person?.name || '-',
        language: (row.voice_actors || [])[0]?.language || '-'
      }));

      return json(res, 200, {
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
    }

    const watchMatch = path.match(/^\/watch\/(\d+)$/);
    if (watchMatch) {
      const id = Number(watchMatch[1]);
      const ep = Number(urlObj.searchParams.get('ep') || 1);
      if (!Number.isFinite(id) || id <= 0) return json(res, 400, { error: { code: 'INVALID_ANIME_ID', message: 'Invalid anime id' } });
      const safeEp = Number.isFinite(ep) && ep > 0 ? Math.floor(ep) : 1;

      const [detail, episodeList, top] = await Promise.all([
        jikanGet(`/anime/${id}/full`),
        getAllAnimeEpisodes(id),
        jikanGet('/top/anime', { limit: 10 })
      ]);

      const anime = mapAnime(detail.data);

      let paheSubEngSources = [];
      let paheNote = 'No AnimePahe match';
      const proxyConfigured = Boolean(ANIMEPAHE_PROXY_BASE);

      try {
        const search = await paheProxyGet('/search', { q: anime.title });
        const matches = Array.isArray(search?.data) ? search.data : [];
        const selectedAnime = matches.find((m) => Number(m.episodes || 0) > 0) || matches[0];

        if (selectedAnime?.session) {
          const releases = await paheProxyGet(`/${selectedAnime.session}/releases`, { sort: 'episode_asc', page: 1 });
          const releaseRows = Array.isArray(releases?.data) ? releases.data : [];
          const selectedEpisode = releaseRows.find((r) => Number(r.episode) === safeEp) || releaseRows[0];

          if (selectedEpisode?.session) {
            const play = await paheProxyGet(`/play/${selectedAnime.session}`, {
              episodeId: selectedEpisode.session,
              downloads: false
            });
            const paheSources = Array.isArray(play?.sources) ? play.sources : [];
            paheSubEngSources = paheSources
              .filter((source) => source?.isDub !== true)
              .map((source) => ({ ...source, fanSub: source?.fanSub || 'eng', sourceLang: 'en' }));
            paheNote = paheSubEngSources.length
              ? 'AnimePahe stream sources ready'
              : 'Only English dub sources found; Japanese audio source unavailable for this episode';
          }
        }
      } catch (e) {
        paheNote = `AnimePahe proxy error: ${e?.message || String(e)}`;
      }

      const subIndoSourceId = 'disabled';
      const indo = { available: false, note: 'Sub INDO dinonaktifkan.', sources: [] };

      if (!proxyConfigured) {
        paheNote = 'AnimePahe proxy is not configured. Set ANIMEPAHE_PROXY_BASE or KURO_BACKEND_BASE in Vercel to enable sub ENG source.';
      }

      const streamSources = [...paheSubEngSources, ...(indo.sources || [])];
      const trailerEmbed = normalizeEmbedUrl(detail.data?.trailer?.embed_url || detail.data?.trailer?.url)
        || fallbackSearchEmbed(anime.title);
      const note = [`Sub ENG: ${paheNote}`, `Sub INDO: ${indo.note}`].join(' | ');

      return json(res, 200, {
        anime,
        currentEpisode: safeEp,
        episodes: episodeList,
        related: (top.data || []).slice(0, 6).map(mapAnime),
        streamProvider: {
          source: `animepahe+${subIndoSourceId}`,
          available: Boolean(streamSources.length),
          note,
          sources: streamSources,
          trailer: trailerEmbed ? {
            embed: trailerEmbed,
            title: 'Official trailer'
          } : null,
          downloads: [],
          providers: {
            subEng: { source: 'animepahe-api', available: paheSubEngSources.length > 0, count: paheSubEngSources.length, note: paheNote, sources: paheSubEngSources },
            subIndo: { source: subIndoSourceId, available: indo.available, count: (indo.sources || []).length, note: indo.note, sources: (indo.sources || []) }
          }
        }
      });
    }

    return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
  } catch (error) {
    return json(res, 500, {
      error: {
        code: 'INTERNAL_ERROR',
        message: error?.message || 'Internal server error'
      }
    });
  }
};

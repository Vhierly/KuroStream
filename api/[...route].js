const JIKAN_BASE = process.env.JIKAN_BASE || 'https://api.jikan.moe/v4';
const ANIMEPAHE_PROXY_BASE = process.env.ANIMEPAHE_PROXY_BASE || '';
const JIKAN_CACHE_TTL_MS = Number(process.env.JIKAN_CACHE_TTL_MS || 120000);
const JIKAN_CACHE_MAX_SIZE = Math.max(20, Number(process.env.JIKAN_CACHE_MAX_SIZE || 300));

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
  return url;
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

async function paheProxyGet(pathname, params = {}) {
  if (!ANIMEPAHE_PROXY_BASE) throw new Error('ANIMEPAHE_PROXY_BASE not configured');
  const u = new URL(`${ANIMEPAHE_PROXY_BASE}${pathname}`);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  const response = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`AnimePahe proxy ${response.status}`);
  return response.json();
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

  try {
    const check = await paheProxyGet('/airing', { page: 1 });
    proxyOk = Array.isArray(check?.data);
  } catch (e) {
    proxyError = e?.message || String(e);
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

module.exports = async (req, res) => {
  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const path = urlObj.pathname.replace(/^\/api/, '');

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
      const continueWatching = trending.slice(0, 4).map((a, i) => ({
        id: a.id,
        title: a.title,
        image: a.image || null,
        ep: Math.max(1, Math.floor((a.eps || 12) * 0.6)),
        progress: 35 + i * 15
      }));

      return json(res, 200, { featured, trending, latest, continueWatching });
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

      let streamSources = [];
      let note = 'No AnimePahe match';

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
            streamSources = paheSources.filter((source) => source?.isDub !== true);
            note = streamSources.length
              ? 'AnimePahe stream sources ready'
              : 'Only English dub sources found; Japanese audio source unavailable for this episode';
          }
        }
      } catch (e) {
        note = `AnimePahe proxy error: ${e?.message || String(e)}`;
      }

      const trailerEmbed = normalizeEmbedUrl(detail.data?.trailer?.embed_url || detail.data?.trailer?.url);
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

      return json(res, 200, {
        anime,
        currentEpisode: safeEp,
        episodes: episodeList,
        related: (top.data || []).slice(0, 6).map(mapAnime),
        streamProvider: {
          source: 'animepahe-api',
          available: Boolean(streamSources.length),
          note,
          sources: streamSources,
          downloads: []
        }
      });
    }

    if (path === '/my-list') {
      const top = await jikanGet('/top/anime', { limit: 12 });
      const rows = (top.data || []).slice(0, 8).map(mapAnime);
      return json(res, 200, rows);
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

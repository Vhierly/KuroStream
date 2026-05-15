window.ApiClient = (() => {
  const API_BASE = (window.KURO_API_BASE || `${window.location.origin}`) + '/api';

  async function request(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API ${response.status}: ${text.slice(0, 300)}`);
    }

    return response.json();
  }

  async function getHome() {
    return request('/home');
  }

  async function getCatalog(params = {}) {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.genre) query.set('genre', params.genre);
    if (params.sort) query.set('sort', params.sort);
    return request(`/catalog?${query.toString()}`);
  }

  async function getAnimeDetail(id = 1) {
    return request(`/anime/${id}/detail`);
  }

  async function getWatchContext(id = 1, ep = 1) {
    return request(`/watch/${id}?ep=${ep}`);
  }

  return { getHome, getCatalog, getAnimeDetail, getWatchContext };
})();

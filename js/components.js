window.UI = (() => {
  const el = (sel) => document.querySelector(sel);

  const saveMyList = (items) => localStorage.setItem('kuro_my_list', JSON.stringify(items || []));
  const loadMyList = () => {
    try {
      return JSON.parse(localStorage.getItem('kuro_my_list') || '[]');
    } catch {
      return [];
    }
  };

  const isSaved = (id) => loadMyList().some((item) => Number(item.id) === Number(id));
  const toggleMyList = (anime) => {
    const rows = loadMyList();
    const idx = rows.findIndex((item) => Number(item.id) === Number(anime.id));
    if (idx >= 0) {
      rows.splice(idx, 1);
      saveMyList(rows);
      return false;
    }
    rows.unshift(anime);
    saveMyList(rows.slice(0, 60));
    return true;
  };

  const CONTINUE_KEY = 'kuro_continue';

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const loadContinueWatching = () => {
    try {
      const rows = JSON.parse(localStorage.getItem(CONTINUE_KEY) || '[]');
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };

  const saveContinueWatching = (rows) => {
    localStorage.setItem(CONTINUE_KEY, JSON.stringify((rows || []).slice(0, 24)));
  };

  const updateContinueWatching = (entry) => {
    if (!entry || !entry.id) return;
    const rows = loadContinueWatching();
    const idx = rows.findIndex((x) => Number(x.id) === Number(entry.id));
    const merged = {
      ...(idx >= 0 ? rows[idx] : {}),
      ...entry,
      updatedAt: Date.now()
    };
    if (idx >= 0) rows.splice(idx, 1);
    rows.unshift(merged);
    saveContinueWatching(rows);
  };

  const safeBgUrl = (url) => String(url || '').replace(/'/g, '%27');

  const posterBlock = (a) => {
    if (a.image) {
      return `<div class="poster poster-image" style="background-image:url('${safeBgUrl(a.image)}')"></div>`;
    }
    return `<div class="poster">${escapeHtml(a.genre)} • ${escapeHtml(a.year || '-')}</div>`;
  };

  const card = (a) => `
    <article class="card card-link" data-id="${a.id}">
      ${posterBlock(a)}
      <div class="card-body">
        <div class="title">${escapeHtml(a.title)}</div>
        <div class="meta"><span>⭐ ${escapeHtml(a.rating || '-')}</span><span>${escapeHtml(a.eps || 0)} eps</span><span class="badge">${escapeHtml(a.status || '-')}</span></div>
      </div>
    </article>`;

  const attachCardNavigation = (rootSelector) => {
    document.querySelectorAll(`${rootSelector} .card-link`).forEach((node) => {
      node.onclick = () => {
        const id = node.dataset.id;
        location.href = `detail.html?id=${id}`;
      };
    });
  };

  const pager = (page, total) => {
    let html = '';
    for (let i = 1; i <= total; i++) html += `<button class="btn ghost ${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`;
    return `<div class="pagination">${html}</div>`;
  };

  const openModal = (title, content) => {
    const wrap = el('#modal');
    if (!wrap) return;
    wrap.innerHTML = `<div class="modal"><h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(content)}</p><div class="row" style="margin-top:12px"><button class="btn primary" id="modal-ok">OK</button></div></div>`;
    wrap.classList.add('show');
    el('#modal-ok').onclick = () => wrap.classList.remove('show');
  };

  return {
    el,
    card,
    pager,
    openModal,
    attachCardNavigation,
    loadMyList,
    saveMyList,
    isSaved,
    toggleMyList,
    loadContinueWatching,
    saveContinueWatching,
    updateContinueWatching,
    escapeHtml
  };
})();
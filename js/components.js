window.UI = (() => {
  const el = (sel) => document.querySelector(sel);

  const LEGACY_MY_LIST_KEY = 'kuro_my_list';
  const LEGACY_CONTINUE_KEY = 'kuro_continue';
  const LEGACY_AUTONEXT_KEY = 'autonext';

  const db = new Dexie('kurostream_db');
  db.version(1).stores({
    myList: 'id, title, status, updatedAt',
    continueWatching: 'id, updatedAt',
    settings: 'key'
  });

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  let initPromise = null;

  const parseJsonSafe = (raw, fallback) => {
    try {
      const parsed = JSON.parse(raw || '');
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  };

  const initStorage = async () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await db.open();

      const migrated = await db.settings.get('legacyMigratedV1');
      if (migrated?.value) return;

      const legacyMyList = parseJsonSafe(localStorage.getItem(LEGACY_MY_LIST_KEY), []);
      const legacyContinue = parseJsonSafe(localStorage.getItem(LEGACY_CONTINUE_KEY), []);
      const legacyAutoNext = localStorage.getItem(LEGACY_AUTONEXT_KEY);

      await db.transaction('rw', db.myList, db.continueWatching, db.settings, async () => {
        if (Array.isArray(legacyMyList) && legacyMyList.length) {
          const now = Date.now();
          const rows = legacyMyList
            .filter((x) => Number.isFinite(Number(x?.id)) && Number(x.id) > 0)
            .slice(0, 60)
            .map((x, idx) => ({ ...x, id: Number(x.id), updatedAt: now - idx }));
          if (rows.length) await db.myList.bulkPut(rows);
        }

        if (Array.isArray(legacyContinue) && legacyContinue.length) {
          const now = Date.now();
          const rows = legacyContinue
            .filter((x) => Number.isFinite(Number(x?.id)) && Number(x.id) > 0)
            .slice(0, 24)
            .map((x, idx) => ({
              ...x,
              id: Number(x.id),
              ep: Number(x.ep || 1),
              progress: Number(x.progress || 0),
              updatedAt: x.updatedAt || (now - idx)
            }));
          if (rows.length) await db.continueWatching.bulkPut(rows);
        }

        if (legacyAutoNext === '1' || legacyAutoNext === '0') {
          await db.settings.put({ key: 'autonext', value: legacyAutoNext });
        }

        await db.settings.put({ key: 'legacyMigratedV1', value: '1' });
      });

      localStorage.removeItem(LEGACY_MY_LIST_KEY);
      localStorage.removeItem(LEGACY_CONTINUE_KEY);
      localStorage.removeItem(LEGACY_AUTONEXT_KEY);
    })();

    return initPromise;
  };

  const saveMyList = async (items) => {
    await initStorage();
    const list = Array.isArray(items) ? items : [];
    await db.transaction('rw', db.myList, async () => {
      await db.myList.clear();
      const now = Date.now();
      const rows = list
        .filter((x) => Number.isFinite(Number(x?.id)) && Number(x.id) > 0)
        .slice(0, 60)
        .map((x, idx) => ({ ...x, id: Number(x.id), updatedAt: now - idx }));
      if (rows.length) await db.myList.bulkPut(rows);
    });
  };

  const loadMyList = async () => {
    await initStorage();
    return db.myList.orderBy('updatedAt').reverse().toArray();
  };

  const isSaved = async (id) => {
    await initStorage();
    const row = await db.myList.get(Number(id));
    return Boolean(row);
  };

  const toggleMyList = async (anime) => {
    await initStorage();
    const id = Number(anime?.id);
    if (!Number.isFinite(id) || id <= 0) return false;

    const exists = await db.myList.get(id);
    if (exists) {
      await db.myList.delete(id);
      return false;
    }

    const rows = await db.myList.toArray();
    if (rows.length >= 60) {
      rows.sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
      await db.myList.delete(rows[0].id);
    }

    await db.myList.put({ ...anime, id, updatedAt: Date.now() });
    return true;
  };

  const loadContinueWatching = async () => {
    await initStorage();
    return db.continueWatching.orderBy('updatedAt').reverse().limit(24).toArray();
  };

  const saveContinueWatching = async (rows) => {
    await initStorage();
    const list = Array.isArray(rows) ? rows : [];
    await db.transaction('rw', db.continueWatching, async () => {
      await db.continueWatching.clear();
      const now = Date.now();
      const payload = list
        .filter((x) => Number.isFinite(Number(x?.id)) && Number(x.id) > 0)
        .slice(0, 24)
        .map((x, idx) => ({
          ...x,
          id: Number(x.id),
          ep: Number(x.ep || 1),
          progress: Number(x.progress || 0),
          updatedAt: x.updatedAt || (now - idx)
        }));
      if (payload.length) await db.continueWatching.bulkPut(payload);
    });
  };

  const updateContinueWatching = async (entry) => {
    await initStorage();
    if (!entry || !entry.id) return;
    const id = Number(entry.id);
    const prev = await db.continueWatching.get(id);
    await db.continueWatching.put({
      ...(prev || {}),
      ...entry,
      id,
      ep: Number(entry.ep || prev?.ep || 1),
      progress: Number(entry.progress || 0),
      updatedAt: Date.now()
    });
  };

  const getSetting = async (key, fallback = null) => {
    await initStorage();
    const row = await db.settings.get(String(key));
    return row?.value ?? fallback;
  };

  const setSetting = async (key, value) => {
    await initStorage();
    await db.settings.put({ key: String(key), value: String(value) });
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
    getSetting,
    setSetting,
    escapeHtml
  };
})();
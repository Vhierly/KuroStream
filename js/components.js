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

  const maybeSyncToCloud = async () => {
    if (!window.Auth?.syncCurrentUserData) return;
    try { await window.Auth.syncCurrentUserData(); } catch (_e) {}
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
    await maybeSyncToCloud();
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
      await maybeSyncToCloud();
      return false;
    }

    const rows = await db.myList.toArray();
    if (rows.length >= 60) {
      rows.sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
      await db.myList.delete(rows[0].id);
    }

    await db.myList.put({ ...anime, id, updatedAt: Date.now() });
    await maybeSyncToCloud();
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
    await maybeSyncToCloud();
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
    await maybeSyncToCloud();
  };

  const replaceLocalData = async ({ myList = [], continueWatching = [] }) => {
    await initStorage();
    await db.transaction('rw', db.myList, db.continueWatching, async () => {
      await db.myList.clear();
      await db.continueWatching.clear();
      if (Array.isArray(myList) && myList.length) {
        await db.myList.bulkPut(myList.slice(0, 60).map((x) => ({ ...x, id: Number(x.id), updatedAt: Number(x.updatedAt || Date.now()) })));
      }
      if (Array.isArray(continueWatching) && continueWatching.length) {
        await db.continueWatching.bulkPut(continueWatching.slice(0, 24).map((x) => ({ ...x, id: Number(x.id), updatedAt: Number(x.updatedAt || Date.now()), ep: Number(x.ep || 1), progress: Number(x.progress || 0) })));
      }
    });
  };

  const exportLocalData = async () => {
    await initStorage();
    return {
      myList: await db.myList.orderBy('updatedAt').reverse().toArray(),
      continueWatching: await db.continueWatching.orderBy('updatedAt').reverse().limit(24).toArray()
    };
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

  const episodeLabel = (value, status = '') => {
    const count = Number(value || 0);
    if (count > 0) return `${count} eps`;
    return String(status).toLowerCase() === 'ongoing' ? 'Ongoing' : 'TBA';
  };

  const card = (a) => `
    <article class="card card-link" data-id="${a.id}" data-session="${escapeHtml(a.session || '')}" data-title="${escapeHtml(a.title || '')}">
      ${posterBlock(a)}
      <div class="card-body">
        <div class="title">${escapeHtml(a.title)}</div>
        <div class="meta">${Number(a.rating) > 0 ? `<span>⭐ ${escapeHtml(a.rating)}</span>` : ''}<span>${escapeHtml(episodeLabel(a.eps, a.status))}</span><span class="badge">${escapeHtml(a.status || '-')}</span></div>
      </div>
    </article>`;

  const attachCardNavigation = (rootSelector) => {
    document.querySelectorAll(`${rootSelector} .card-link`).forEach((node) => {
      node.onclick = () => {
        const id = node.dataset.id;
        const session = node.dataset.session || '';
        const title = node.dataset.title || '';
        const query = new URLSearchParams({ id });
        if (session) query.set('session', session);
        if (title) query.set('title', title);
        location.href = `detail.html?${query.toString()}`;
      };
    });
  };

  const pager = (page, total) => {
    const current = Math.max(1, Number(page || 1));
    const max = Math.max(1, Number(total || 1));
    const pages = new Set([1, max, current, current - 1, current + 1]);
    if (current <= 3) [2, 3, 4].forEach((n) => pages.add(n));
    if (current >= max - 2) [max - 3, max - 2, max - 1].forEach((n) => pages.add(n));
    const nums = [...pages].filter((n) => n >= 1 && n <= max).sort((a, b) => a - b);
    let last = 0;
    const parts = [];
    if (current > 1) parts.push(`<button class="btn ghost" data-page="${current - 1}">‹ Prev</button>`);
    nums.forEach((n) => {
      if (n - last > 1) parts.push('<span class="pager-gap">…</span>');
      parts.push(`<button class="btn ghost ${n === current ? 'active' : ''}" data-page="${n}">${n}</button>`);
      last = n;
    });
    if (current < max) parts.push(`<button class="btn ghost" data-page="${current + 1}">Next ›</button>`);
    return `<div class="pagination">${parts.join('')}</div>`;
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
    exportLocalData,
    replaceLocalData,
    getSetting,
    setSetting,
    escapeHtml
  };
})();

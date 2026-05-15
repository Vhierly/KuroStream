window.Auth = (() => {
  const CFG_URL_KEY = 'kuro_supabase_url';
  const CFG_ANON_KEY = 'kuro_supabase_anon_key';

  let client = null;
  let currentUser = null;
  let syncing = false;

  const getConfig = () => ({
    url: localStorage.getItem(CFG_URL_KEY) || '',
    anonKey: localStorage.getItem(CFG_ANON_KEY) || ''
  });

  const setConfig = (url, anonKey) => {
    localStorage.setItem(CFG_URL_KEY, String(url || '').trim());
    localStorage.setItem(CFG_ANON_KEY, String(anonKey || '').trim());
    client = null;
  };

  const loadConfigFromServer = async () => {
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) return null;
      const json = await response.json();
      if (!json?.supabaseUrl || !json?.supabaseAnonKey) return null;
      setConfig(json.supabaseUrl, json.supabaseAnonKey);
      return json;
    } catch {
      return null;
    }
  };

  const hasConfig = () => {
    const cfg = getConfig();
    return Boolean(cfg.url && cfg.anonKey);
  };

  const ensureClient = async () => {
    if (client) return client;
    if (!window.supabase?.createClient) throw new Error('Supabase SDK belum ter-load.');

    let cfg = getConfig();
    if (!cfg.url || !cfg.anonKey) {
      await loadConfigFromServer();
      cfg = getConfig();
    }

    if (!cfg.url || !cfg.anonKey) throw new Error('Supabase belum dikonfigurasi. Isi di login page atau set ENV di Vercel.');
    client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return client;
  };

  const getUser = async () => {
    try {
      const c = await ensureClient();
      const { data, error } = await c.auth.getUser();
      if (error) return null;
      currentUser = data?.user || null;
      return currentUser;
    } catch {
      return null;
    }
  };

  const syncCurrentUserData = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const c = await ensureClient();
      const user = await getUser();
      if (!user) return;
      const local = await UI.exportLocalData();

      const localRows = local.myList.map((x) => ({ user_id: user.id, anime_id: Number(x.id), payload: x, updated_at: new Date(Number(x.updatedAt || Date.now())).toISOString() }));
      const localContinueRows = local.continueWatching.map((x) => ({ user_id: user.id, anime_id: Number(x.id), payload: x, updated_at: new Date(Number(x.updatedAt || Date.now())).toISOString() }));

      if (localRows.length) await c.from('my_list').upsert(localRows, { onConflict: 'user_id,anime_id' });
      if (localContinueRows.length) await c.from('continue_watching').upsert(localContinueRows, { onConflict: 'user_id,anime_id' });

      const [cloudListRes, cloudContinueRes] = await Promise.all([
        c.from('my_list').select('payload').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(60),
        c.from('continue_watching').select('payload').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(24)
      ]);

      const cloudList = (cloudListRes.data || []).map((r) => r.payload).filter(Boolean);
      const cloudContinue = (cloudContinueRes.data || []).map((r) => r.payload).filter(Boolean);
      await UI.replaceLocalData({ myList: cloudList, continueWatching: cloudContinue });
    } finally {
      syncing = false;
    }
  };

  const signUp = async (email, password) => {
    const c = await ensureClient();
    const { error } = await c.auth.signUp({ email, password });
    if (error) throw error;
  };

  const signIn = async (email, password) => {
    const c = await ensureClient();
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await syncCurrentUserData();
  };

  const signOut = async () => {
    const c = await ensureClient();
    await c.auth.signOut();
    currentUser = null;
  };

  const initAuthBadge = async () => {
    const node = document.querySelector('#auth-badge');
    if (!node) return;
    const user = await getUser();
    if (user) {
      node.textContent = user.email || 'Account';
      node.setAttribute('href', 'user.html');
    } else {
      node.textContent = 'Login';
      node.setAttribute('href', 'login.html');
    }
  };

  return { getConfig, setConfig, loadConfigFromServer, hasConfig, ensureClient, getUser, syncCurrentUserData, signUp, signIn, signOut, initAuthBadge };
})();

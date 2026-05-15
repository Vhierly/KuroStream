window.Auth = (() => {
  const TOKEN_KEY = 'kuro_auth_access_token';
  const REFRESH_KEY = 'kuro_auth_refresh_token';
  const USER_KEY = 'kuro_auth_user';

  let currentUser = null;
  let syncing = false;

  const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
  const setSession = ({ access_token = '', refresh_token = '', user = null } = {}) => {
    if (access_token) localStorage.setItem(TOKEN_KEY, access_token);
    if (refresh_token) localStorage.setItem(REFRESH_KEY, refresh_token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  };

  const clearSession = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    currentUser = null;
  };

  const api = async (path, { method = 'GET', body = null, auth = false } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      const token = getToken();
      if (!token) throw new Error('Not logged in');
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = json?.error?.message || json?.message || 'Request failed';
      throw new Error(message);
    }
    return json;
  };

  const getUser = async () => {
    const token = getToken();
    if (!token) return null;

    try {
      const json = await api('/auth/user', { auth: true });
      currentUser = json.user || null;
      if (currentUser) localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
      return currentUser;
    } catch {
      const fallback = localStorage.getItem(USER_KEY);
      if (fallback) {
        try {
          currentUser = JSON.parse(fallback);
          return currentUser;
        } catch {
          return null;
        }
      }
      return null;
    }
  };

  const syncCurrentUserData = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const user = await getUser();
      if (!user) return;

      const local = await UI.exportLocalData();
      await api('/user/my-list', { method: 'POST', auth: true, body: { rows: local.myList || [] } });
      await api('/user/continue-watching', { method: 'POST', auth: true, body: { rows: local.continueWatching || [] } });

      const [cloudList, cloudContinue] = await Promise.all([
        api('/user/my-list', { auth: true }),
        api('/user/continue-watching', { auth: true })
      ]);

      await UI.replaceLocalData({
        myList: cloudList.rows || [],
        continueWatching: cloudContinue.rows || []
      });
    } finally {
      syncing = false;
    }
  };

  const signUp = async (email, password) => {
    await api('/auth/register', { method: 'POST', body: { email, password } });
  };

  const signIn = async (email, password) => {
    const json = await api('/auth/login', { method: 'POST', body: { email, password } });
    setSession(json);
    currentUser = json.user || null;
    await syncCurrentUserData();
  };

  const signOut = async () => {
    try {
      if (getToken()) await api('/auth/logout', { method: 'POST', auth: true });
    } catch (_e) {
      // ignore
    }
    clearSession();
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

  return { getUser, syncCurrentUserData, signUp, signIn, signOut, initAuthBadge };
})();

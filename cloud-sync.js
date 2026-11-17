/* Sincronización opcional con Supabase. Solo utiliza la clave pública anon/publishable.
   No introducir nunca una service_role key en una extensión o página web. */
(() => {
  const CONFIG_KEY = 'littleFocusCloudConfigV1';
  const SESSION_KEY = 'littleFocusCloudSessionV1';
  const STATE_KEY = 'littleFocusAppStateV2';
  const DEFAULTS = { url: '', anonKey: '' };
  let timer = null;
  let syncing = false;
  let queuedState = null;

  function config() {
    try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')) }; }
    catch { return DEFAULTS; }
  }
  function session() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (value?.expires_at && value.expires_at * 1000 < Date.now()) { localStorage.removeItem(SESSION_KEY); return null; }
      return value;
    } catch { return null; }
  }
  function saveSession(value) { localStorage.setItem(SESSION_KEY, JSON.stringify(value)); }
  function validConfig(c) { return /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(c.url) && !!c.anonKey; }
  async function request(path, options = {}, token) {
    const c = config();
    if (!validConfig(c)) throw new Error('Configura primero la URL y la clave pública de Supabase.');
    const headers = { apikey: c.anonKey, 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(c.url.replace(/\/$/, '') + path, { ...options, headers });
    const body = await response.text();
    let data = null; try { data = body ? JSON.parse(body) : null; } catch {}
    if (!response.ok) throw new Error(data?.msg || data?.message || data?.hint || data?.error_description || `Error ${response.status}: ${body.slice(0,180)}`);
    return data;
  }
  function persistLocal(state) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch {}
  }
  async function fetchCloudState(token) {
    const rows = await request('/rest/v1/littlefocus_states?select=state,updated_at&limit=1', {}, token);
    return rows?.[0] || null;
  }
  async function uploadState(state, token) {
    const user = session()?.user;
    if (!user?.id) throw new Error('No se ha encontrado la cuenta conectada.');
    await request('/rest/v1/littlefocus_states?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: user.id, state, updated_at: new Date().toISOString() })
    }, token);
  }
  async function syncNow(state) {
    const s = session();
    if (!s?.access_token || syncing) return;
    syncing = true;
    try { await uploadState(state || JSON.parse(localStorage.getItem(STATE_KEY) || '{}'), s.access_token); }
    catch (error) { console.warn('[Little Focus cloud]', error.message); }
    finally { syncing = false; if (queuedState) { const next = queuedState; queuedState = null; schedule(next); } }
  }
  async function signIn(email, password, create = false) {
    const endpoint = create ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
    const data = await request(endpoint, { method: 'POST', body: JSON.stringify({ email, password }) });
    if (!data?.access_token) throw new Error(create ? 'Cuenta creada. Si Supabase exige confirmar el correo, confirma el mensaje y vuelve a iniciar sesión.' : 'No se ha recibido una sesión válida.');
    data.expires_at = Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600);
    saveSession(data);
    return data;
  }
  async function connect(email, password, create = false) {
    const data = await signIn(email, password, create);
    const cloud = await fetchCloudState(data.access_token);
    const local = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    if (cloud?.state && typeof cloud.state === 'object') {
      const localTime = Number(local._cloudUpdatedAt || 0);
      const cloudTime = Date.parse(cloud.updated_at || '') || 0;
      if (cloudTime > localTime || !localTime) { persistLocal(cloud.state); return { restored: true }; }
      await uploadState(local, data.access_token);
      return { restored: false };
    }
    await uploadState(local, data.access_token);
    return { restored: false };
  }
  async function signOut() {
    const s = session();
    if (s?.access_token) { try { await request('/auth/v1/logout', { method: 'POST' }, s.access_token); } catch {} }
    localStorage.removeItem(SESSION_KEY);
  }
  function schedule(state) {
    if (!session()?.access_token) return;
    queuedState = state;
    clearTimeout(timer);
    timer = setTimeout(() => { const next = queuedState; queuedState = null; syncNow(next); }, 1100);
  }
  async function reconcile() {
    const s = session();
    if (!s?.access_token || !validConfig(config())) return { changed: false };
    try {
      const cloud = await fetchCloudState(s.access_token);
      const local = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
      if (!cloud?.state) { await uploadState(local, s.access_token); return { changed: false }; }
      const localTime = Number(local._cloudUpdatedAt || 0);
      const cloudTime = Date.parse(cloud.updated_at || '') || 0;
      if (cloudTime > localTime || !localTime) { persistLocal(cloud.state); return { changed: true }; }
      await uploadState(local, s.access_token);
    } catch (error) { console.warn('[Little Focus cloud]', error.message); }
    return { changed: false };
  }
  function saveConfig(url, anonKey) {
    const clean = { url: String(url || '').trim().replace(/\/$/, ''), anonKey: String(anonKey || '').trim() };
    if (!validConfig(clean)) throw new Error('La URL debe ser https://TU-PROYECTO.supabase.co y debes introducir la clave pública anon/publishable.');
    localStorage.setItem(CONFIG_KEY, JSON.stringify(clean));
  }
  window.LittleFocusCloud = {
    config, session, saveConfig, connect, signOut, schedule, reconcile,
    get connected() { return !!session()?.access_token; },
    get configured() { return validConfig(config()); }
  };
})();

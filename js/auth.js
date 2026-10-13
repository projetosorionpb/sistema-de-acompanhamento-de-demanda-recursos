// ── Auth somente-Supabase (sem logins demo, sem contas locais) ──
// Requer js/config.js preenchido (SUPABASE_URL + SUPABASE_ANON_KEY).
// Papéis vêm de `profiles.role`. Contas são criadas no Dashboard do Supabase:
//   Authentication → Users → Add user (marque Auto Confirm)
//   Table Editor → profiles → role = 'admin' | 'usuario'
// A sessão é guardada pelo supabase-js (token de login, não é dado do app).

function isSupabaseMode() {
  try {
    return !!(typeof window !== 'undefined' && window.SAD_CONFIG &&
      window.SAD_CONFIG.SUPABASE_URL && window.SAD_CONFIG.SUPABASE_ANON_KEY &&
      window.supabase && window.supabase.createClient);
  } catch (e) { return false; }
}

var _supaClient = null;
function supa() {
  if (_supaClient) return _supaClient;
  _supaClient = window.supabase.createClient(
    window.SAD_CONFIG.SUPABASE_URL,
    window.SAD_CONFIG.SUPABASE_ANON_KEY
  );
  return _supaClient;
}

// Cache de perfis (mantém getUsers/isAdminEmail síncronos para o app.js)
var _profilesCache = null;
var _roleByEmail = {};

async function refreshProfilesCache() {
  if (!isSupabaseMode()) return null;
  try {
    var res = await supa().from('profiles').select('email,role,name,created_at').order('email');
    if (res.error) throw res.error;
    _profilesCache = (res.data || []).map(function (r) {
      return {
        email: String(r.email || '').toLowerCase(),
        role: r.role === 'admin' ? 'admin' : 'usuario',
        name: r.name || String(r.email || '').split('@')[0],
        createdAt: r.created_at || ''
      };
    });
    _profilesCache.forEach(function (u) { _roleByEmail[String(u.email).toLowerCase()] = u.role; });
    return _profilesCache;
  } catch (e) {
    return null;
  }
}

// Lista de usuários (síncrona, do cache de profiles).
function getUsers() {
  return _profilesCache || [];
}

// Criação/exclusão/papel: pelo Dashboard do Supabase (não pelo app).
function createUser() {
  return { error: 'Crie a conta em Supabase → Authentication → Users (Auto Confirm) e ajuste profiles.role no Table Editor.' };
}
function deleteUser() {
  return { error: 'Exclua a conta em Supabase → Authentication → Users (o profile sai junto).' };
}
function setUserRole() {
  return { error: 'Troque o papel em Supabase → Table Editor → profiles → role.' };
}

async function getSession() {
  if (!isSupabaseMode()) return null;
  try {
    var res = await supa().auth.getSession();
    var user = res && res.data && res.data.session && res.data.session.user;
    if (!user || !user.email) return null;
    var em = String(user.email).toLowerCase();
    var role = _roleByEmail[em];
    if (!role) {
      try {
        var pr = await supa().from('profiles').select('role').eq('id', user.id).single();
        if (pr && pr.data && pr.data.role) role = pr.data.role;
      } catch (e) {}
      if (!role) role = 'usuario';
      _roleByEmail[em] = role;
    }
    return { email: user.email, role: role, name: em.split('@')[0], supabase: true, id: user.id };
  } catch (e) {
    return null;
  }
}

async function getCurrentUserEmail() {
  var s = await getSession();
  return s && s.email ? String(s.email).toLowerCase() : null;
}

async function isCurrentUserAdmin() {
  var email = await getCurrentUserEmail();
  return isAdminEmail(email);
}

function isAdminEmail(email) {
  if (!email) return false;
  var em = String(email).toLowerCase();
  if (_roleByEmail[em]) return _roleByEmail[em] === 'admin';
  if (_profilesCache) {
    for (var i = 0; i < _profilesCache.length; i++) {
      if (String(_profilesCache[i].email).toLowerCase() === em) return _profilesCache[i].role === 'admin';
    }
  }
  return false;
}

function getUserRole(email) {
  if (!email) return 'usuario';
  var em = String(email).toLowerCase();
  if (_roleByEmail[em]) return _roleByEmail[em];
  if (_profilesCache) {
    for (var i = 0; i < _profilesCache.length; i++) {
      if (String(_profilesCache[i].email).toLowerCase() === em) return _profilesCache[i].role;
    }
  }
  return 'usuario';
}

async function signIn(email, password) {
  email = String(email || '').trim().toLowerCase();
  if (!isSupabaseMode()) {
    return { data: null, error: { message: 'Supabase não configurado. Preencha js/config.js (URL + anon key).' } };
  }
  try {
    var res = await supa().auth.signInWithPassword({ email: email, password: password });
    if (res.error) throw res.error;
    var user = res.data && res.data.user;
    var role = 'usuario';
    try {
      var pr = await supa().from('profiles').select('role').eq('id', user.id).single();
      if (pr && pr.data && pr.data.role) role = pr.data.role;
    } catch (e) {}
    _roleByEmail[String(user.email).toLowerCase()] = role;
    try { await refreshProfilesCache(); } catch (e2) {}
    return { data: { session: { email: user.email, role: role, name: String(user.email).split('@')[0] } }, error: null };
  } catch (err) {
    var msg = (err && err.message) || 'E-mail ou senha incorretos.';
    if (/email not confirmed/i.test(msg)) msg = 'E-mail não confirmado. Ative Auto Confirm no usuário (Authentication → Users).';
    if (/invalid api key|jwt|apikey/i.test(msg)) msg = 'Chave/URL do Supabase inválida. Confira js/config.js com Project Settings → API.';
    if (/invalid login credentials/i.test(msg)) msg = 'E-mail ou senha incorretos.';
    return { data: null, error: { message: msg } };
  }
}

async function signOut() {
  try { if (isSupabaseMode()) await supa().auth.signOut(); } catch (e) {}
  window.location.href = 'login.html';
}

async function requireAuth() {
  var s = await getSession();
  if (!s) { window.location.href = 'login.html'; return null; }
  try { await refreshProfilesCache(); } catch (e) {}
  s.role = getUserRole(s.email);
  return s;
}

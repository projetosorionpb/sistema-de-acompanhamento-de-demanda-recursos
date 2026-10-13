// ── Auth híbrida: Supabase (nuvem) com fallback local ──
// Modo local (antes): contas em `sad_users_v1` (por navegador).
// Seed local:
//   admin   → admin@sistema / admin123
//   usuário → equipe@sistema / equipe123
// Modo Supabase (quando SAD_CONFIG preenchido + supabase-js carregado):
//   login via supabase.auth.signInWithPassword + role de `profiles.role`.
//   Usuários demo locais continuam funcionando como fallback.
var ADMIN_EMAILS = ['admin@sistema', 'valdecinunesaf@gmail.com'];
var SAD_USERS_KEY = 'sad_users_v1';

function _seedUsers() {
  return [
    { email: 'admin@sistema', pass: 'admin123', role: 'admin', name: 'Admin', createdAt: new Date().toISOString() },
    { email: 'equipe@sistema', pass: 'equipe123', role: 'usuario', name: 'Equipe', createdAt: new Date().toISOString() },
  ];
}

function getLocalUsers() {
  try {
    var raw = localStorage.getItem(SAD_USERS_KEY);
    if (!raw) {
      var seed = _seedUsers();
      try { localStorage.setItem(SAD_USERS_KEY, JSON.stringify(seed)); } catch (e) {}
      return seed;
    }
    var u = JSON.parse(raw);
    if (!Array.isArray(u) || !u.length) return _seedUsers();
    return u;
  } catch (e) { return _seedUsers(); }
}

function _saveUsers(users) {
  try { localStorage.setItem(SAD_USERS_KEY, JSON.stringify(users)); return true; }
  catch (e) { return false; }
}

function _normEmail(e) { return String(e || '').trim().toLowerCase(); }

function _findLocalUser(email) {
  var em = _normEmail(email);
  var users = getLocalUsers();
  for (var i = 0; i < users.length; i++) {
    if (_normEmail(users[i].email) === em) return users[i];
  }
  return null;
}

// ── Supabase mode ──
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

// Cache de perfis (para manter getUsers/isAdminEmail síncronos no app.js)
var _profilesCache = null;
var _roleByEmail = {};

async function refreshProfilesCache() {
  if (!isSupabaseMode()) return null;
  try {
    var client = supa();
    var res = await client.from('profiles').select('email,role,name,created_at').order('email');
    if (res.error) throw res.error;
    var rows = res.data || [];
    _profilesCache = rows.map(function (r) {
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

function isAdminEmailLocal(email) {
  if (!email) return false;
  var em = String(email).toLowerCase();
  var admins = ADMIN_EMAILS.map(function (e) { return String(e).toLowerCase(); });
  if (admins.indexOf(em) !== -1) return true;
  var u = _findLocalUser(em);
  return !!(u && u.role === 'admin');
}

// Lista de usuários (síncrona, como o app.js espera).
// Online autenticado: retorna profiles do Supabase. Senão: local.
function getUsers() {
  if (!isSupabaseMode()) return getLocalUsers();
  if (_profilesCache && _profilesCache.length) return _profilesCache;
  try { refreshProfilesCache(); } catch (e) {}
  return getLocalUsers();
}

function createUser(email, password, role) {
  // Online com Supabase carregado: gerenciar pelo Dashboard (anon não cria users).
  if (isSupabaseMode() && _profilesCache) {
    return { error: 'Com Supabase, crie em Authentication → Users (Auto Confirm) e ajuste profiles.role no Table Editor.' };
  }
  email = _normEmail(email);
  if (!email || email.indexOf('@') === -1) return { error: 'E-mail inválido.' };
  if (!password || String(password).length < 6) return { error: 'Senha deve ter ao menos 6 caracteres.' };
  role = (role === 'admin') ? 'admin' : 'usuario';
  if (_findLocalUser(email)) return { error: 'Esse e-mail já existe.' };
  var users = getLocalUsers();
  users.push({ email: email, pass: String(password), role: role, name: email.split('@')[0], createdAt: new Date().toISOString() });
  if (!_saveUsers(users)) return { error: 'Não salvou (quota do navegador).' };
  return { data: { email: email, role: role }, error: null };
}

function deleteUser(email) {
  if (isSupabaseMode() && _profilesCache) {
    return { error: 'Com Supabase, exclua em Authentication → Users (o profile sai junto).' };
  }
  email = _normEmail(email);
  var users = getLocalUsers();
  var me = _getSession();
  if (me && _normEmail(me.email) === email) return { error: 'Você não pode excluir a própria conta logada.' };
  var out = users.filter(function (u) { return _normEmail(u.email) !== email; });
  if (out.length === users.length) return { error: 'Usuário não encontrado.' };
  var hasAdmin = out.some(function (u) { return u.role === 'admin'; });
  if (!hasAdmin) return { error: 'Não pode ficar sem nenhum admin.' };
  if (!_saveUsers(out)) return { error: 'Não salvou.' };
  return { data: true, error: null };
}

function setUserRole(email, role) {
  if (isSupabaseMode() && _profilesCache) {
    return { error: 'Com Supabase, troque profiles.role no Table Editor.' };
  }
  email = _normEmail(email);
  role = (role === 'admin') ? 'admin' : 'usuario';
  var users = getLocalUsers();
  var found = false;
  for (var i = 0; i < users.length; i++) {
    if (_normEmail(users[i].email) === email) { users[i].role = role; found = true; }
  }
  if (!found) return { error: 'Usuário não encontrado.' };
  var hasAdmin = users.some(function (u) { return u.role === 'admin'; });
  if (!hasAdmin) return { error: 'Precisa de ao menos 1 admin.' };
  if (!_saveUsers(users)) return { error: 'Não salvou.' };
  return { data: true, error: null };
}

function _getSession() {
  try { return JSON.parse(localStorage.getItem('sad-session') || 'null'); }
  catch (e) { return null; }
}

async function getSession() {
  if (isSupabaseMode()) {
    try {
      var client = supa();
      var res = await client.auth.getSession();
      var user = res && res.data && res.data.session && res.data.session.user;
      if (user && user.email) {
        var em = String(user.email).toLowerCase();
        var role = _roleByEmail[em];
        if (!role) {
          try {
            var pr = await client.from('profiles').select('role').eq('id', user.id).single();
            if (pr && pr.data && pr.data.role) role = pr.data.role;
          } catch (e) {}
          if (!role) role = isAdminEmailLocal(em) ? 'admin' : 'usuario';
          if (ADMIN_EMAILS.map(function (e) { return String(e).toLowerCase(); }).indexOf(em) !== -1) role = 'admin';
          _roleByEmail[em] = role;
        }
        return { email: user.email, role: role, name: em.split('@')[0], supabase: true, id: user.id };
      }
    } catch (e) {}
    return _getSession();
  }
  return _getSession();
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
  if (ADMIN_EMAILS.map(function (e) { return String(e).toLowerCase(); }).indexOf(em) !== -1) return true;
  if (_roleByEmail[em]) return _roleByEmail[em] === 'admin';
  if (_profilesCache) {
    for (var i = 0; i < _profilesCache.length; i++) {
      if (String(_profilesCache[i].email).toLowerCase() === em) return _profilesCache[i].role === 'admin';
    }
  }
  return isAdminEmailLocal(email);
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
  var u = _findLocalUser(em);
  if (u) return u.role;
  return isAdminEmail(em) ? 'admin' : 'usuario';
}

function _signInLocal(email, password) {
  email = _normEmail(email);
  var u = _findLocalUser(email);
  if (!u || u.pass !== String(password || '')) {
    return { data: null, error: { message: 'E-mail ou senha incorretos.' } };
  }
  var sess = { email: u.email, role: u.role, name: u.name || u.email, ts: Date.now() };
  try { localStorage.setItem('sad-session', JSON.stringify(sess)); } catch (e) {}
  return { data: { session: sess }, error: null };
}

async function signIn(email, password) {
  email = _normEmail(email);
  if (isSupabaseMode()) {
    try {
      var client = supa();
      var res = await client.auth.signInWithPassword({ email: email, password: password });
      if (res.error) throw res.error;
      var user = res.data && res.data.user;
      var role = 'usuario';
      try {
        var pr = await client.from('profiles').select('role').eq('id', user.id).single();
        if (pr && pr.data && pr.data.role) role = pr.data.role;
      } catch (e) {}
      if (ADMIN_EMAILS.map(function (e) { return String(e).toLowerCase(); }).indexOf(String(user.email).toLowerCase()) !== -1) role = 'admin';
      _roleByEmail[String(user.email).toLowerCase()] = role;
      try { await refreshProfilesCache(); } catch (e2) {}
      return { data: { session: { email: user.email, role: role, name: String(user.email).split('@')[0] } }, error: null };
    } catch (sErr) {
      // Fallback: demo locais (admin@sistema) continuam valendo online.
      var loc = _signInLocal(email, password);
      if (!loc.error) return loc;
      var msg = (sErr && sErr.message) || 'E-mail ou senha incorretos.';
      if (/email not confirmed/i.test(msg)) msg = 'E-mail não confirmado no Supabase. Ative Auto Confirm no usuário.';
      if (/invalid api key|jwt/i.test(msg)) msg = 'Chave/URL do Supabase inválida. Confira js/config.js com Project Settings → API.';
      return { data: null, error: { message: msg } };
    }
  }
  return _signInLocal(email, password);
}

async function signOut() {
  if (isSupabaseMode()) {
    try { await supa().auth.signOut(); } catch (e) {}
  }
  try { localStorage.removeItem('sad-session'); } catch (e) {}
  window.location.href = 'login.html';
}

async function requireAuth() {
  var s = await getSession();
  if (!s) { window.location.href = 'login.html'; return null; }
  if (isSupabaseMode()) {
    try { await refreshProfilesCache(); } catch (e) {}
  }
  // revalida perfil
  s.role = getUserRole(s.email);
  return s;
}

// ── Auth local multiusuário (plugável no Supabase depois) ──
// Modo local: contas ficam em `sad_users_v1` (por navegador).
// Admin cria até quantos precisar (10 usuários + 6 admins sem problema).
// Seed inicial:
//   admin   → admin@sistema / admin123   (pode importar, aprova quarentena)
//   usuário → equipe@sistema / equipe123 (só caixa principal)
var ADMIN_EMAILS = ['admin@sistema', 'valdecinunesaf@gmail.com'];
var SAD_USERS_KEY = 'sad_users_v1';

function _seedUsers() {
  return [
    { email: 'admin@sistema', pass: 'admin123', role: 'admin', name: 'Admin', createdAt: new Date().toISOString() },
    { email: 'equipe@sistema', pass: 'equipe123', role: 'usuario', name: 'Equipe', createdAt: new Date().toISOString() },
  ];
}

function getUsers() {
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

function _findUser(email) {
  var em = _normEmail(email);
  var users = getUsers();
  for (var i = 0; i < users.length; i++) {
    if (_normEmail(users[i].email) === em) return users[i];
  }
  return null;
}

function createUser(email, password, role) {
  email = _normEmail(email);
  if (!email || email.indexOf('@') === -1) return { error: 'E-mail inválido.' };
  if (!password || String(password).length < 6) return { error: 'Senha deve ter ao menos 6 caracteres.' };
  role = (role === 'admin') ? 'admin' : 'usuario';
  if (_findUser(email)) return { error: 'Esse e-mail já existe.' };
  var users = getUsers();
  users.push({ email: email, pass: String(password), role: role, name: email.split('@')[0], createdAt: new Date().toISOString() });
  if (!_saveUsers(users)) return { error: 'Não salvou (quota do navegador).' };
  return { data: { email: email, role: role }, error: null };
}

function deleteUser(email) {
  email = _normEmail(email);
  var users = getUsers();
  var me = _getSession();
  if (me && _normEmail(me.email) === email) return { error: 'Você não pode excluir a própria conta logada.' };
  var out = users.filter(function (u) { return _normEmail(u.email) !== email; });
  if (out.length === users.length) return { error: 'Usuário não encontrado.' };
  // nunca deixar zero admin
  var hasAdmin = out.some(function (u) { return u.role === 'admin'; });
  if (!hasAdmin) return { error: 'Não pode ficar sem nenhum admin.' };
  if (!_saveUsers(out)) return { error: 'Não salvou.' };
  return { data: true, error: null };
}

function setUserRole(email, role) {
  email = _normEmail(email);
  role = (role === 'admin') ? 'admin' : 'usuario';
  var users = getUsers();
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

async function getSession() { return _getSession(); }

async function getCurrentUserEmail() {
  var s = _getSession();
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
  var u = _findUser(em);
  return !!(u && u.role === 'admin');
}

function getUserRole(email) {
  var u = _findUser(email);
  if (u) return u.role;
  return isAdminEmail(email) ? 'admin' : 'usuario';
}

async function signIn(email, password) {
  email = _normEmail(email);
  var u = _findUser(email);
  if (!u || u.pass !== String(password || '')) {
    return { data: null, error: { message: 'E-mail ou senha incorretos.' } };
  }
  var sess = { email: u.email, role: u.role, name: u.name || u.email, ts: Date.now() };
  try { localStorage.setItem('sad-session', JSON.stringify(sess)); } catch (e) {}
  return { data: { session: sess }, error: null };
}

async function signOut() {
  try { localStorage.removeItem('sad-session'); } catch (e) {}
  window.location.href = 'login.html';
}

async function requireAuth() {
  var s = await getSession();
  if (!s) { window.location.href = 'login.html'; return null; }
  // revalida perfil (admin pode ter trocado o papel)
  s.role = getUserRole(s.email);
  return s;
}

// ── Auth demo local (plugável no Supabase depois) ──
// Usuários demo:
//   admin   → admin@sistema / admin123   (pode importar, aprovar quarentena)
//   usuário → equipe@sistema / equipe123 (só caixa principal)
var ADMIN_EMAILS = ['admin@sistema', 'valdecinunesaf@gmail.com'];
var DEMO_USERS = [
  { email: 'admin@sistema', pass: 'admin123', role: 'admin', name: 'Admin' },
  { email: 'equipe@sistema', pass: 'equipe123', role: 'usuario', name: 'Equipe' },
];

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
  if (!email) return false;
  return ADMIN_EMAILS.map(function (e) { return String(e).toLowerCase(); }).indexOf(email) !== -1;
}

function isAdminEmail(email) {
  if (!email) return false;
  return ADMIN_EMAILS.map(function (e) { return String(e).toLowerCase(); })
    .indexOf(String(email).toLowerCase()) !== -1;
}

async function signIn(email, password) {
  email = String(email || '').trim().toLowerCase();
  var u = DEMO_USERS.find(function (x) { return x.email === email && x.pass === password; });
  if (!u) return { data: null, error: { message: 'E-mail ou senha incorretos.' } };
  var sess = { email: u.email, role: u.role, name: u.name, ts: Date.now() };
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
  return s;
}

const crypto = require('crypto');
const db = require('./supabase');
const config = require('./config');

// Sessions carry a keyed tag of the password hash, so changing or resetting the password logs out every
// other device. (The cookie is signed but readable, hence a keyed hash rather than part of the hash itself.)
const passwordTag = (passwordHash) => crypto.createHmac('sha256', config.sessionSecret).update(String(passwordHash)).digest('base64url').slice(0, 16);

// Call wherever someone logs in, or changes their password and should stay logged in on this device.
function logIn(req, user) {
  req.session.userId = user.id;
  req.session.pw = passwordTag(user.password_hash);
}

async function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.me = null;
  const id = req.session && req.session.userId;
  if (!id) return next();

  const { data: row } = await db.from('users').select('id,email,role,password_hash,sellers(*)').eq('id', id).maybeSingle();
  const tag = row && passwordTag(row.password_hash);
  // Sessions from before the tag existed adopt it now, so the change didn't log everyone out.
  if (row && !req.session.pw) req.session.pw = tag;
  if (!row || req.session.pw !== tag) {
    // Logged out (account gone, or the password changed elsewhere). The cart and form token stay.
    delete req.session.userId;
    delete req.session.pw;
    return next();
  }
  const { sellers, password_hash, ...user } = row;
  req.user = user;
  res.locals.user = user;
  if (user.role === 'seller') {
    const me = (Array.isArray(sellers) ? sellers[0] : sellers) || null;
    req.seller = me;
    res.locals.me = me;
  }
  next();
}

function requireSeller(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role === 'admin') return res.redirect('/admin');
  if (!req.seller) return res.status(403).render('error', { title: 'No seller profile', message: 'This account has no seller profile.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role !== 'admin') return res.status(404).render('404', { title: 'Page not found' });
  next();
}

module.exports = { logIn, loadUser, requireSeller, requireAdmin };

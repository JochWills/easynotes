const db = require('./supabase');

async function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.me = null;
  const id = req.session && req.session.userId;
  if (!id) return next();

  const { data: row } = await db.from('users').select('id,email,role,sellers(*)').eq('id', id).maybeSingle();
  if (!row) {
    req.session = null;
    return next();
  }
  const { sellers, ...user } = row;
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

module.exports = { loadUser, requireSeller, requireAdmin };

const db = require('./supabase');

async function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.me = null;
  const id = req.session && req.session.userId;
  if (!id) return next();

  const { data: user } = await db.from('users').select('id,email,role').eq('id', id).maybeSingle();
  if (!user) {
    req.session = null;
    return next();
  }
  req.user = user;
  res.locals.user = user;
  if (user.role === 'seller') {
    const { data: me } = await db.from('sellers').select('*').eq('user_id', user.id).maybeSingle();
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

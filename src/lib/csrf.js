const crypto = require('crypto');

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  next();
}

function verifyCsrf(req, res, next) {
  const token = req.body && req.body._csrf;
  const expected = req.session && req.session.csrf;
  const valid =
    typeof token === 'string' &&
    typeof expected === 'string' &&
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!valid) {
    return res.status(403).render('error', {
      title: 'Form expired',
      message: 'This form expired before it was sent. Go back, refresh the page and try again.',
    });
  }
  next();
}

module.exports = { csrf, verifyCsrf };

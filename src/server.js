const config = require('./lib/config');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieSession = require('cookie-session');
const helpers = require('./lib/helpers');
const { loadUser } = require('./lib/auth');
const { csrf, verifyCsrf } = require('./lib/csrf');
const education = require('./lib/education');

const app = express();
app.set('trust proxy', 1); // Render terminates TLS in front of the app
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

const supabaseOrigin = new URL(config.supabaseUrl).origin;
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'style-src-attr': ["'unsafe-inline'"],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:', supabaseOrigin], // blob: previews a picture before it's uploaded
        'connect-src': ["'self'"],
        // Form posts redirect to Paystack checkout and to signed Supabase download links
        'form-action': ["'self'", 'https://checkout.paystack.com', supabaseOrigin],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': config.isProd ? [] : null,
      },
    },
  })
);
app.use(compression());
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.isProd ? '1d' : 0,
    setHeaders: (res, file) => {
      if (file.endsWith('speculation-rules.json')) res.type('application/speculationrules+json');
    },
  })
);

app.get('/healthz', (req, res) => res.send('ok'));

// Webhooks need the raw body for signature checks, so they mount before body parsing and sessions.
app.use('/webhooks', require('./routes/webhooks'));

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(
  cookieSession({
    name: 'en_session',
    keys: [config.sessionSecret],
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 14 * 24 * 60 * 60 * 1000,
  })
);
app.use(csrf);
app.use((req, res, next) => {
  // Pages loaded ahead of a click (hover prerender) leave the one-off message for the page actually shown.
  if (/prefetch/i.test(req.get('sec-purpose') || '')) {
    res.locals.flash = null;
  } else {
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
  }
  // Chrome/Edge load same-site pages on hover so clicks feel instant (rules in public/speculation-rules.json).
  res.set('Speculation-Rules', '"/speculation-rules.json"');
  res.locals.currentPath = req.path;
  res.locals.feePercent = config.platformFeePercent;
  res.locals.minPrice = config.minPrice;
  res.locals.maxPrice = config.maxPrice;
  res.locals.supportEmail = config.supportEmail;
  res.locals.maxDownloads = config.maxDownloads;
  res.locals.baseUrl = config.baseUrl;
  res.locals.emailEnabled = Boolean(config.resendApiKey);
  res.locals.cartIds = Array.isArray(req.session.cart) ? req.session.cart : [];
  Object.assign(res.locals, helpers);
  res.locals.edu = { when: education.when, results: education.results, isOverdue: education.isOverdue, honoursLabel: education.honoursLabel }; // education wording for views
  next();
});
app.use(loadUser);

// Every urlencoded POST must carry the CSRF token. Multipart routes verify after multer parses the body.
app.use((req, res, next) => {
  if (req.method !== 'POST' || req.is('multipart/form-data')) return next();
  if (req.path === '/logout') return next(); // checks its own way (routes/auth.js)
  return verifyCsrf(req, res, next);
});

app.use(require('./routes/public'));
app.use(require('./routes/auth'));
app.use(require('./routes/checkout'));
app.use('/seller', require('./routes/seller'));
app.use('/admin', require('./routes/admin'));
app.use(require('./routes/storefront'));

app.use((req, res) => res.status(404).render('404', { title: 'Page not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).render('error', {
    title: 'Something went wrong',
    message: `The page didn't load because of an error on our side. Try again in a minute, or email ${config.supportEmail} if it keeps happening.`,
  });
});

app.listen(config.port, () => console.log(`EasyNotes running on ${config.baseUrl} (port ${config.port})`));
require('./lib/jobs').start();

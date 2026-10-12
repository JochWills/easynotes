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
const notify = require('./lib/notify');

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
        'script-src': ["'self'", 'https://js.paystack.co', 'https://cloud.umami.is'], // Paystack's pop-up checkout, Umami visitor stats
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // inline: Paystack's pop-up styles itself
        'style-src-attr': ["'unsafe-inline'"],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:', supabaseOrigin], // blob: previews a picture before it's uploaded
        // Umami's script sends visits to gateway.umami.is; without it every visit was blocked and nothing was counted
        'connect-src': ["'self'", 'https://*.paystack.co', 'https://*.paystack.com', 'https://cloud.umami.is', 'https://gateway.umami.is', 'https://api-gateway.umami.dev'],
        'frame-src': ['https://checkout.paystack.com', 'https://*.paystack.co', 'https://*.paystack.com'],
        // Form posts redirect to Paystack checkout and to signed Supabase download links
        'form-action': ["'self'", 'https://checkout.paystack.com', supabaseOrigin],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': config.isProd ? [] : null,
      },
    },
    // Send the Referer only within the site: "back to where you were" redirects need it, other sites never see our URLs.
    referrerPolicy: { policy: 'same-origin' },
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

// Domain verification files (e.g. Apple Pay through Paystack). The main static handler skips dot-folders.
app.use('/.well-known', express.static(path.join(__dirname, '..', 'public', '.well-known')));

app.get('/healthz', (req, res) => res.send('ok'));
app.use(require('./routes/og')); // link-preview images: no session needed

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
  res.locals.feeCoversProcessing = config.feeBearer === 'account'; // EasyNotes pays Paystack's fee out of its share
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
app.use(notify.dots); // red dots for sellers on the menu items and dashboard tabs with unseen news
// Logged-in pages are never kept by the browser, so Back after logging out can't show them again.
app.use((req, res, next) => {
  if (req.user) res.set('Cache-Control', 'private, no-store');
  next();
});

// Visitor stats (Umami): anonymous, no cookies. Left off for logged-in sellers and admins (their own clicks would
// skew the numbers) and for private pages. Query strings are never sent, so download links and tokens stay private.
const NO_STATS = /^\/(seller|admin|library|download|reset|confirm-email|forgot|login|signup)(\/|$)/;
app.use((req, res, next) => {
  res.locals.statsId = config.umamiWebsiteId && !req.user && !NO_STATS.test(req.path) ? config.umamiWebsiteId : null;
  res.locals.statsDomain = new URL(config.baseUrl).hostname;
  next();
});

// Every POST must carry the CSRF token. The upload routes below verify it themselves after multer parses
// the body; a multipart post anywhere else has no parsed body, so it fails here instead of skipping the check.
const UPLOAD_ROUTES = /^\/seller\/(profile|verification|verification\/education|notes|notes\/[0-9a-f-]{36})$/i;
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (req.is('multipart/form-data') && UPLOAD_ROUTES.test(req.path)) return next();
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

// Bring the database up to date (supabase/schema.sql) before taking visitors. If that fails the site still
// starts: everything new in the schema is optional until it's there.
require('./lib/migrate')
  .migrate()
  .then((result) => console.log('[schema]', result))
  .catch((err) => console.error('[schema] not applied, the site runs without the latest database changes:', err.message))
  .finally(() => {
    app.listen(config.port, () => console.log(`EasyNotes running on ${config.baseUrl} (port ${config.port})`));
    require('./lib/jobs').start();
  });

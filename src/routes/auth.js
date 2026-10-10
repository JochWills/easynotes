const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../lib/supabase');
const flash = require('../lib/flash');
const { slugify, str } = require('../lib/helpers');
const { RESERVED_SLUGS } = require('../lib/constants');
const emails = require('../lib/emails');

const profanity = require('../lib/profanity');
const config = require('../lib/config');
const { verifyCsrf } = require('../lib/csrf');
const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 12); // compared when the email doesn't exist

const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : null);

async function uniqueSlug(base) {
  let slug = slugify(base).slice(0, 40);
  for (let i = 0; i < 5; i++) {
    const { data } = await db.from('sellers').select('id').eq('slug', slug).maybeSingle();
    if (!data && slug.length >= 3 && !RESERVED_SLUGS.has(slug)) return slug;
    slug = `${slugify(base).slice(0, 34)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/seller');
  res.render('signup', { title: 'Create a seller account', values: {}, errors: {} });
});

router.post('/signup', limiter, async (req, res) => {
  const sameName = req.body.same_name === 'on';
  const full_name = str(req.body.full_name, 80);
  const values = {
    full_name,
    same_name: sameName,
    display_name: sameName ? full_name : str(req.body.display_name, 80),
    email: str(req.body.email, 200).toLowerCase(),
  };
  const password = String(req.body.password || '');
  const errors = {};
  if (full_name.length < 2) errors.full_name = 'Enter your full name.';
  if (!sameName && values.display_name.length < 2) errors.display_name = 'Enter the name students will see on your storefront.';
  if (!EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (Buffer.byteLength(password) > 72) errors.password = 'Use 72 characters or fewer.'; // bcrypt ignores anything longer
  if (req.body.accept !== 'on') errors.accept = 'You need to accept the seller terms to continue.';
  profanity.checkFields(values, ['full_name', 'display_name'], errors);
  if (sameName && errors.display_name) delete errors.display_name; // already reported on the full name

  if (!errors.email) {
    const { data: existing } = await db.from('users').select('id').eq('email', values.email).maybeSingle();
    if (existing) errors.email = 'An account with this email already exists. Log in instead.';
  }
  if (Object.keys(errors).length) return res.status(400).render('signup', { title: 'Create a seller account', values, errors });

  const password_hash = await bcrypt.hash(password, 12);
  const { data: user, error } = await db.from('users').insert({ email: values.email, password_hash, role: 'seller' }).select().single();
  if (error) throw error;

  const slug = await uniqueSlug(values.display_name);
  const { error: sErr } = await db.from('sellers').insert({ user_id: user.id, full_name, display_name: values.display_name, slug });
  if (sErr) {
    await db.from('users').delete().eq('id', user.id);
    throw sErr;
  }

  req.session.userId = user.id;
  flash(req, 'ok', 'Account created. Next step: verify your degree.');
  res.redirect('/seller');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/seller');
  res.render('login', { title: 'Log in', email: '', error: null, next: safeNext(req.query.next) || '' });
});

router.post('/login', limiter, async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = String(req.body.password || '');
  const next = safeNext(req.body.next);
  const { data: user } = await db.from('users').select('id,role,password_hash').eq('email', email).maybeSingle();
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).render('login', { title: 'Log in', email, error: 'That email and password don’t match an account.', next: next || '' });
  }
  req.session.userId = user.id;
  res.redirect(next || (user.role === 'admin' ? '/admin' : '/seller'));
});

/* ---------- Confirming a new login email (Settings) ---------- */

router.get('/confirm-email', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const t = emails.readEmailChangeToken(req.query.t);
  const fail = (msg) => res.status(400).render('error', { title: 'Link not valid', message: msg });
  if (!t) return fail(`This link has expired or isn’t valid. Request a new one from Settings (links work for ${emails.EMAIL_CHANGE_HOURS} hours).`);
  const { data: user } = await db.from('users').select('id,email,sellers(full_name,display_name)').eq('id', t.u).maybeSingle();
  if (!user) return fail('This account no longer exists.');
  if (user.email === t.to) {
    flash(req, 'ok', `You already log in with ${t.to}.`);
    return res.redirect(req.user ? '/seller/settings' : '/login');
  }
  if (user.email !== t.from) return fail('Your login email has changed since this link was sent. Request a new one from Settings.');
  const { data: taken } = await db.from('users').select('id').eq('email', t.to).maybeSingle();
  if (taken) return fail('Another account now uses this email, so we couldn’t switch to it.');
  const { error } = await db.from('users').update({ email: t.to }).eq('id', user.id);
  if (error) throw error;
  const s = Array.isArray(user.sellers) ? user.sellers[0] : user.sellers;
  emails.sendEmailChangedNotice(t.from, t.to, s && (s.full_name || s.display_name)).catch((err) => console.error('[auth] email-changed notice not sent', err.message));
  flash(req, 'ok', `Done. You now log in with ${t.to}.`);
  res.redirect(req.user && req.user.id === user.id ? '/seller/settings' : '/login');
});

/* ---------- Password reset ---------- */

router.get('/forgot', (req, res) => {
  res.render('forgot', { title: 'Reset your password', email: str(req.query.email, 200), sent: false });
});

// Same answer whether or not the account exists, so this can't be used to find out who has one.
router.post('/forgot', limiter, async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).render('forgot', { title: 'Reset your password', email, sent: false, error: 'Enter the email you log in with.' });
  const { data: user } = await db.from('users').select('id,email,password_hash').eq('email', email).maybeSingle();
  if (user) {
    try {
      await emails.sendPasswordReset(user);
    } catch (err) {
      console.error('[auth] reset email not sent', err.message);
    }
  }
  res.render('forgot', { title: 'Check your email', email, sent: true });
});

router.get('/reset', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const user = await emails.readResetToken(req.query.t);
  res.render('reset', { title: 'Choose a new password', token: user ? str(req.query.t, 1000) : null, errors: {} });
});

router.post('/reset', limiter, async (req, res) => {
  const token = str(req.body.t, 1000);
  const user = await emails.readResetToken(token);
  if (!user) return res.status(400).render('reset', { title: 'Choose a new password', token: null, errors: {} });

  const password = String(req.body.password || '');
  const errors = {};
  const min = user.role === 'admin' ? 10 : 8;
  if (password.length < min) errors.password = `Use at least ${min} characters.`;
  else if (Buffer.byteLength(password) > 72) errors.password = 'Use 72 characters or fewer.';
  else if (password !== String(req.body.confirm || '')) errors.confirm = 'The two passwords don’t match.';
  if (Object.keys(errors).length) return res.status(400).render('reset', { title: 'Choose a new password', token, errors });

  const { error } = await db.from('users').update({ password_hash: await bcrypt.hash(password, 12) }).eq('id', user.id);
  if (error) throw error;
  req.session.userId = user.id;
  flash(req, 'ok', 'Password changed. You’re logged in.');
  res.redirect(user.role === 'admin' ? '/admin' : '/seller');
});

// Logging out shouldn't fail because the page was old (another tab already logged out, or Back after
// logging in again changed the form token). So a stale token is fine as long as the browser says the
// click came from this site; a form on another site still can't log people out.
function logOut(req, res) {
  for (const key of Object.keys(req.session)) delete req.session[key];
  flash(req, 'ok', 'You’re logged out.');
  // Throw away pages loaded ahead while logged in (logged-in pages are never cached: see server.js).
  res.set('Clear-Site-Data', '"prefetchCache", "prerenderCache"'); // not "cache": Chrome can take ages clearing it
  res.set('Cache-Control', 'no-store');
  res.redirect(303, '/');
}

router.post('/logout', (req, res) => {
  const site = req.get('sec-fetch-site');
  const origin = req.get('origin');
  const sameSite = site ? site === 'same-origin' : origin ? origin === new URL(config.baseUrl).origin : false;
  if (!req.user || sameSite) return logOut(req, res);
  return verifyCsrf(req, res, () => logOut(req, res));
});

module.exports = router;

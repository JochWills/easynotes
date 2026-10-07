const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../lib/supabase');
const flash = require('../lib/flash');
const { slugify, str } = require('../lib/helpers');
const { RESERVED_SLUGS } = require('../lib/constants');
const emails = require('../lib/emails');

const profanity = require('../lib/profanity');
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
  const values = {
    display_name: str(req.body.display_name, 80),
    email: str(req.body.email, 200).toLowerCase(),
  };
  const password = String(req.body.password || '');
  const errors = {};
  if (values.display_name.length < 2) errors.display_name = 'Enter the name students will see on your storefront.';
  if (!EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address.';
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (Buffer.byteLength(password) > 72) errors.password = 'Use 72 characters or fewer.'; // bcrypt ignores anything longer
  if (req.body.accept !== 'on') errors.accept = 'You need to accept the seller terms to continue.';
  profanity.checkFields(values, ['display_name'], errors);

  if (!errors.email) {
    const { data: existing } = await db.from('users').select('id').eq('email', values.email).maybeSingle();
    if (existing) errors.email = 'An account with this email already exists. Log in instead.';
  }
  if (Object.keys(errors).length) return res.status(400).render('signup', { title: 'Create a seller account', values, errors });

  const password_hash = await bcrypt.hash(password, 12);
  const { data: user, error } = await db.from('users').insert({ email: values.email, password_hash, role: 'seller' }).select().single();
  if (error) throw error;

  const slug = await uniqueSlug(values.display_name);
  const { error: sErr } = await db.from('sellers').insert({ user_id: user.id, display_name: values.display_name, slug });
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

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

module.exports = router;

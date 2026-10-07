const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../lib/config');
const db = require('../lib/supabase');
const storage = require('../lib/storage');
const flash = require('../lib/flash');
const events = require('../lib/events');
const health = require('../lib/health');
const { requireAdmin } = require('../lib/auth');
const { isUuid, str } = require('../lib/helpers');
const emails = require('../lib/emails');

const router = express.Router();
router.use(requireAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanSearch = (q) => String(q || '').replace(/["%,()*\\:]/g, ' ').trim().slice(0, 80);
const backTo = (req, fallback) => (typeof req.body.back === 'string' && /^\/admin(\/|$)/.test(req.body.back) ? req.body.back : fallback);

// The Verifications tab shows how many sellers are waiting, on every admin page.
router.use(async (req, res, next) => {
  const { count } = await db.from('sellers').select('id', { count: 'exact', head: true }).eq('verification_status', 'pending');
  res.locals.pendingCount = count || 0;
  next();
});

/* ---------- Overview ---------- */

router.get('/', async (req, res) => {
  const [{ data: totals }, { data: recent }, { count: sellerCount }, { count: noteCount }, { count: noPayouts }, activity] = await Promise.all([
    db.rpc('platform_totals'),
    db.from('orders').select('reference,email,amount_cents,platform_fee_cents,status,created_at,notes(title)').order('created_at', { ascending: false }).limit(8),
    db.from('sellers').select('id', { count: 'exact', head: true }).eq('verification_status', 'approved'),
    db.from('notes').select('id', { count: 'exact', head: true }).eq('status', 'published'),
    db.from('sellers').select('id', { count: 'exact', head: true }).eq('verification_status', 'approved').is('paystack_subaccount_code', null),
    events.recent({ limit: 12 }),
  ]);
  const t = (totals && totals[0]) || { sales: 0, gross: 0, fees: 0 };
  res.render('admin/index', {
    title: 'Admin',
    tab: 'overview',
    totals: { sales: Number(t.sales), gross: Number(t.gross), fees: Number(t.fees) },
    recent: recent || [],
    sellerCount: sellerCount || 0,
    noteCount: noteCount || 0,
    noPayouts: noPayouts || 0,
    activity,
  });
});

/* ---------- Verifications ---------- */

router.get('/verifications', async (req, res) => {
  const [{ data: pending }, decided] = await Promise.all([
    db.from('sellers').select('id,display_name,degree,university,graduation_year,degree_doc_path,id_doc_path,submitted_at,verification_note,users(email)').eq('verification_status', 'pending').order('submitted_at'),
    events.recent({ limit: 15, kinds: ['seller.approved', 'seller.rejected', 'seller.revoked'] }),
  ]);
  const queue = await Promise.all(
    (pending || []).map(async (s) => ({
      ...s,
      degreeUrl: s.degree_doc_path ? await storage.signedUrl('verification', s.degree_doc_path, 600).catch(() => null) : null,
      idUrl: s.id_doc_path ? await storage.signedUrl('verification', s.id_doc_path, 600).catch(() => null) : null,
    }))
  );
  res.render('admin/verifications', { title: 'Verifications', tab: 'verifications', queue, decided });
});

/* ---------- Sellers ---------- */

const STATUSES = ['pending', 'approved', 'rejected', 'unsubmitted'];

router.get('/sellers', async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const q = cleanSearch(req.query.q);
  let query = db.from('sellers').select('id,display_name,slug,degree,university,verification_status,paystack_subaccount_code,created_at,users(email)').order('created_at', { ascending: false }).limit(200);
  if (status) query = query.eq('verification_status', status);
  if (q.includes('@')) {
    const { data: users } = await db.from('users').select('id').ilike('email', `%${q}%`).limit(50);
    query = query.in('user_id', (users || []).map((u) => u.id));
  } else if (q) {
    query = query.or(`display_name.ilike."%${q}%",slug.ilike."%${q}%"`);
  }
  const { data: sellers } = await query;
  res.render('admin/sellers', { title: 'Sellers', tab: 'sellers', sellers: sellers || [], status, statuses: STATUSES, q });
});

router.get('/sellers/:id', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const { data: s } = await db.from('sellers').select('*, users(email,created_at)').eq('id', req.params.id).maybeSingle();
  if (!s) return next();
  const [{ data: notes }, { data: sales }, docs] = await Promise.all([
    db.from('notes').select('id,title,slug,status,price_cents,sales_count').eq('seller_id', s.id).order('created_at', { ascending: false }),
    db.rpc('seller_totals', { p_seller_id: s.id }),
    Promise.all([
      s.degree_doc_path ? storage.signedUrl('verification', s.degree_doc_path, 600).catch(() => null) : null,
      s.id_doc_path ? storage.signedUrl('verification', s.id_doc_path, 600).catch(() => null) : null,
    ]),
  ]);
  const totals = (sales && sales[0]) || { sales: 0, earnings: 0 };
  res.render('admin/seller', { title: s.display_name, tab: 'sellers', s, notes: notes || [], totals, degreeUrl: docs[0], idUrl: docs[1] });
});

router.post('/sellers/:id/verification', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const back = backTo(req, `/admin/sellers/${req.params.id}`);
  const decision = req.body.decision;
  const note = str(req.body.note, 500) || null;
  const { data: s } = await db.from('sellers').select('display_name,verification_status').eq('id', req.params.id).maybeSingle();
  if (!s) return next();

  if (decision === 'approve') {
    await db.from('sellers').update({ verification_status: 'approved', verification_note: null, verified_at: new Date().toISOString() }).eq('id', req.params.id);
    flash(req, 'ok', `${s.display_name} approved. Their published notes are visible once payouts are set up.`);
    events.log('seller.approved', { seller_id: req.params.id, name: s.display_name }, req.user.email);
  } else if (decision === 'reject') {
    if (!note) {
      flash(req, 'error', 'Add a reason so the seller knows what to fix.');
      return res.redirect(back);
    }
    await db.from('sellers').update({ verification_status: 'rejected', verification_note: note, verified_at: null }).eq('id', req.params.id);
    const revoked = s.verification_status === 'approved';
    flash(req, 'ok', `${s.display_name} ${revoked ? 'revoked' : 'rejected'}. All their notes are hidden from students.`);
    events.log(revoked ? 'seller.revoked' : 'seller.rejected', { seller_id: req.params.id, name: s.display_name, reason: note }, req.user.email);
  } else {
    return res.redirect(back);
  }
  emails.sendVerificationDecision(req.params.id).catch((err) => console.error('[admin] decision email not sent', err.message));
  res.redirect(back);
});

/* ---------- Notes ---------- */

router.get('/notes', async (req, res) => {
  const q = cleanSearch(req.query.q);
  let query = db.from('notes').select('id,title,slug,status,price_cents,sales_count,university,created_at,sellers(id,display_name)').order('created_at', { ascending: false }).limit(200);
  if (q) query = query.or(`title.ilike."%${q}%",module_code.ilike."%${q}%"`);
  const { data: notes } = await query;
  res.render('admin/notes', { title: 'Notes', tab: 'notes', notes: notes || [], q });
});

router.post('/notes/:id/status', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const map = { remove: 'removed', unpublish: 'unpublished', restore: 'unpublished' };
  const status = map[req.body.action];
  if (status) {
    const { data: n } = await db.from('notes').update({ status }).eq('id', req.params.id).select('title').maybeSingle();
    flash(req, 'ok', req.body.action === 'remove' ? 'Notes removed. The seller can’t republish them.' : 'Notes updated.');
    events.log(`note.${req.body.action === 'remove' ? 'removed' : req.body.action === 'restore' ? 'restored' : 'hidden'}`, { note_id: req.params.id, title: n?.title }, req.user.email);
  }
  res.redirect(req.get('referer')?.includes('/admin/') ? req.get('referer') : '/admin/notes');
});

/* ---------- Orders ---------- */

router.get('/orders', async (req, res) => {
  const status = ['paid', 'pending', 'failed', 'all'].includes(req.query.status) ? req.query.status : 'paid';
  const search = str(req.query.reference, 200);
  let q = db.from('orders').select('reference,email,buyer_name,amount_cents,platform_fee_cents,seller_earnings_cents,status,download_count,created_at,paid_at,notes(title),sellers(display_name)').order('created_at', { ascending: false }).limit(200);
  if (search.includes('@')) q = q.eq('email', search.toLowerCase());
  else if (/^EN[A-Z0-9-]+$/i.test(search)) q = q.or(`reference.eq.${search.toUpperCase()},payment_ref.eq.${search.toUpperCase()}`);
  else if (search) q = q.ilike('buyer_name', `%${search.replace(/[%_\\]/g, '')}%`);
  else if (status !== 'all') q = q.eq('status', status);
  const { data: orders } = await q;
  res.render('admin/orders', { title: 'Orders', tab: 'orders', orders: orders || [], status, reference: search });
});

router.post('/orders/:reference/reset-downloads', async (req, res) => {
  const reference = str(req.params.reference, 40).toUpperCase();
  await db.from('orders').update({ download_count: 0 }).eq('reference', reference);
  flash(req, 'ok', `Download limit reset for ${reference}.`);
  events.log('order.downloads_reset', { reference }, req.user.email);
  res.redirect(`/admin/orders?reference=${encodeURIComponent(reference)}`);
});

/* ---------- Money ---------- */

router.get('/money', async (req, res) => {
  const [{ data: orders }, { data: noPayouts }] = await Promise.all([
    db.from('orders').select('amount_cents,platform_fee_cents,seller_earnings_cents,paid_at,seller_id,sellers(display_name,slug)').eq('status', 'paid').order('paid_at', { ascending: false }).limit(10000),
    db.from('sellers').select('id,display_name,verified_at,users(email)').eq('verification_status', 'approved').is('paystack_subaccount_code', null).order('verified_at'),
  ]);
  const paid = orders || [];

  // Last 12 months, newest first, including months with no sales.
  const months = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }), sales: 0, gross: 0, fees: 0, payouts: 0 });
  }
  const byMonth = Object.fromEntries(months.map((m) => [m.key, m]));
  const bySeller = {};
  const all = { sales: 0, gross: 0, fees: 0, payouts: 0 };
  for (const o of paid) {
    for (const bucket of [byMonth[String(o.paid_at).slice(0, 7)], all]) {
      if (!bucket) continue;
      bucket.sales += 1;
      bucket.gross += o.amount_cents;
      bucket.fees += o.platform_fee_cents;
      bucket.payouts += o.seller_earnings_cents;
    }
    const s = (bySeller[o.seller_id] ||= { id: o.seller_id, name: o.sellers?.display_name || 'Unknown', sales: 0, gross: 0, fees: 0, payouts: 0, last: o.paid_at });
    s.sales += 1;
    s.gross += o.amount_cents;
    s.fees += o.platform_fee_cents;
    s.payouts += o.seller_earnings_cents;
  }
  res.render('admin/money', {
    title: 'Money',
    tab: 'money',
    all,
    months,
    sellers: Object.values(bySeller).sort((a, b) => b.gross - a.gross),
    noPayouts: noPayouts || [],
    capped: paid.length >= 10000,
    feeBearerText: config.feeBearer === 'account' ? 'paid by EasyNotes out of its share' : 'deducted from the seller’s share',
  });
});

/* ---------- Health ---------- */

router.get('/health', async (req, res) => {
  const checks = await health.runAll(req.get('host'));
  res.set('Cache-Control', 'no-store');
  res.render('admin/health', { title: 'Health', tab: 'health', checks, app: health.appInfo() });
});

router.post('/health/test-email', async (req, res) => {
  try {
    const sent = await emails.sendTestEmail(req.user.email);
    flash(req, sent ? 'ok' : 'error', sent ? `Test email sent to ${req.user.email}. Check your inbox (and spam).` : 'RESEND_API_KEY isn’t set, so nothing was sent.');
    if (sent) events.log('email.test', { to: req.user.email }, req.user.email);
  } catch (err) {
    flash(req, 'error', `Resend refused the email: ${err.message.slice(0, 200)}`);
  }
  res.redirect('/admin/health');
});

/* ---------- Settings & admins ---------- */

router.get('/settings', async (req, res) => {
  const { data: admins } = await db.from('users').select('id,email,created_at').eq('role', 'admin').order('created_at');
  res.render('admin/settings', {
    title: 'Settings',
    tab: 'settings',
    admins: admins || [],
    settings: [
      ['Site address', config.baseUrl, 'BASE_URL'],
      ['EasyNotes fee', `${config.platformFeePercent}% of each sale`, 'PLATFORM_FEE_PERCENT'],
      ['Paystack fee paid by', config.feeBearer === 'account' ? 'EasyNotes (from its fee)' : 'The seller', 'PAYSTACK_FEE_BEARER'],
      ['Downloads per purchase', String(config.maxDownloads), 'MAX_DOWNLOADS'],
      ['Emails sent from', config.resendApiKey ? config.mailFrom : 'Not set up (no RESEND_API_KEY)', 'MAIL_FROM'],
      ['Support address', config.supportEmail, 'SUPPORT_EMAIL'],
      ['Paystack mode', config.paystackSecret.startsWith('sk_live_') ? 'Live' : config.paystackSecret.startsWith('sk_test_') ? 'Test' : 'No key', 'PAYSTACK_SECRET_KEY'],
    ],
  });
});

router.post('/admins', async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    flash(req, 'error', 'Enter a valid email address.');
    return res.redirect('/admin/settings');
  }
  const { data: existing } = await db.from('users').select('id,role').eq('email', email).maybeSingle();
  if (existing) {
    flash(req, 'error', existing.role === 'admin' ? `${email} is already an admin.` : `${email} has a seller account. Use a different email for admin access.`);
    return res.redirect('/admin/settings');
  }
  const password_hash = await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 12);
  const { data: user, error } = await db.from('users').insert({ email, password_hash, role: 'admin' }).select('id,email,password_hash').single();
  if (error) throw error;
  events.log('admin.added', { email }, req.user.email);
  try {
    const sent = await emails.sendAdminInvite(user, req.user.email);
    flash(req, 'ok', sent ? `${email} added. We’ve emailed them a link to choose a password.` : `${email} added, but emails aren’t set up. They can use “Forgot your password?” once they are.`);
  } catch (err) {
    console.error('[admin] invite not sent', err.message);
    flash(req, 'ok', `${email} added, but the invite email failed. They can use “Forgot your password?” on the login page.`);
  }
  res.redirect('/admin/settings');
});

router.post('/admins/:id/remove', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  if (req.params.id === req.user.id) {
    flash(req, 'error', 'You can’t remove yourself. Ask another admin to do it.');
    return res.redirect('/admin/settings');
  }
  const { count } = await db.from('users').select('id', { count: 'exact', head: true }).eq('role', 'admin');
  if ((count || 0) <= 1) {
    flash(req, 'error', 'There must always be at least one admin.');
    return res.redirect('/admin/settings');
  }
  const { data: gone } = await db.from('users').delete().eq('id', req.params.id).eq('role', 'admin').select('email').maybeSingle();
  if (gone) {
    flash(req, 'ok', `${gone.email} is no longer an admin.`);
    events.log('admin.removed', { email: gone.email }, req.user.email);
  }
  res.redirect('/admin/settings');
});

module.exports = router;

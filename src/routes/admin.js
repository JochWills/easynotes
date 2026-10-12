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
const education = require('../lib/education');
const notify = require('../lib/notify');
const paystack = require('../lib/paystack');

const router = express.Router();
router.use(requireAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const cleanSearch = (q) => String(q || '').replace(/["%,()*\\:]/g, ' ').trim().slice(0, 80);
const backTo = (req, fallback) => (typeof req.body.back === 'string' && /^\/admin(\/|$)/.test(req.body.back) ? req.body.back : fallback);
// The admin page the button was on (from the Referer), or the fallback.
const backToReferer = (req, fallback) => {
  try {
    const u = new URL(req.get('referer'));
    return u.host === req.get('host') && /^\/admin(\/|$)/.test(u.pathname) ? u.pathname + u.search : fallback;
  } catch {
    return fallback;
  }
};

// Reports, automatic upload flags and payments that didn't match an order stay open until an admin marks them resolved.
const REPORT_KINDS = ['note.reported', 'note.flagged', 'payment.unmatched', 'payment.mismatch'];
// All of them, however old: an unresolved report must never drop off the list.
async function openReports() {
  const [items, resolved] = await Promise.all([
    events.all({ kinds: REPORT_KINDS }),
    events.all({ kinds: ['report.resolved'], columns: 'id,detail' }),
  ]);
  if (items === null) return null;
  const done = new Set((resolved || []).map((e) => String(e.detail?.report_id)));
  return items.filter((e) => !done.has(String(e.id)));
}

// Education added or finished by sellers who are already verified (first verifications are reviewed with the seller).
function pendingUpdates({ head = false } = {}) {
  const q = db
    .from('qualifications')
    .select(head ? 'id, sellers!inner(verification_status)' : '*, sellers!inner(id,display_name,full_name,verification_status,users(email))', head ? { count: 'exact', head: true } : undefined)
    .eq('review_status', 'pending')
    .eq('sellers.verification_status', 'approved');
  return head ? q : q.order('submitted_at');
}
const docLinks = async (q) => ({
  ...q,
  docUrl: q.doc_path ? await storage.signedUrl('verification', q.doc_path, 600).catch(() => null) : null,
  recordUrl: q.record_path ? await storage.signedUrl('verification', q.record_path, 600).catch(() => null) : null,
});

// The Verifications and Reports tabs show how many things are waiting, on every admin page.
router.use(async (req, res, next) => {
  const [{ count }, { count: updates }, open] = await Promise.all([
    db.from('sellers').select('id', { count: 'exact', head: true }).eq('verification_status', 'pending'),
    pendingUpdates({ head: true }),
    openReports(),
  ]);
  res.locals.pendingSellers = count || 0;
  res.locals.pendingUpdates = updates || 0;
  res.locals.pendingCount = (count || 0) + (updates || 0);
  res.locals.reportCount = open ? open.length : 0;
  next();
});

/* ---------- Reports ---------- */

router.get('/reports', async (req, res) => {
  const open = await openReports();
  const ids = [...new Set((open || []).map((e) => e.detail?.note_id).filter(isUuid))];
  const { data: notes } = ids.length
    ? await db.from('notes').select('id,title,slug,status,sellers(id,display_name)').in('id', ids)
    : { data: [] };
  const byId = Object.fromEntries((notes || []).map((n) => [n.id, n]));
  res.render('admin/reports', { title: 'Reports', tab: 'reports', items: open, notesById: byId, reasons: emails.REPORT_REASONS });
});

// Admins can open any note's PDF (to check reports), through a short-lived signed link.
router.get('/notes/:id/file', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const { data: n } = await db.from('notes').select('file_path').eq('id', req.params.id).maybeSingle();
  if (!n) return next();
  res.set('Cache-Control', 'no-store');
  res.redirect(await storage.signedUrl('notes', n.file_path, 120));
});

router.post('/reports/:id/resolve', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isInteger(id) && id > 0) {
    const { data: item } = await db.from('events').select('id,kind,detail').eq('id', id).maybeSingle();
    if (item && REPORT_KINDS.includes(item.kind)) {
      await events.log('report.resolved', { report_id: item.id, kind: item.kind, title: item.detail?.title || item.detail?.reference }, req.user.email);
      flash(req, 'ok', 'Marked as resolved.');
    }
  }
  res.redirect('/admin/reports');
});

/* ---------- Overview ---------- */

// Sellers whose new bank account still needs Verify clicking in Paystack (it holds their first payout till then).
// They stay on the list, and the seller sees "being verified", until an admin ticks them off.
async function payoutChecks() {
  const { data } = await db.from('sellers').select('id,display_name,full_name,business_name,bank_name,account_number_last4,paystack_subaccount_code,payout_check_since').not('payout_check_since', 'is', null).not('paystack_subaccount_code', 'is', null).order('payout_check_since').limit(100);
  return data || [];
}

router.get('/', async (req, res) => {
  const [{ data: totals }, { data: recent }, { count: sellerCount }, { count: noteCount }, { count: noPayouts }, activity, toVerify] = await Promise.all([
    db.rpc('platform_totals'),
    db.from('orders').select('reference,email,amount_cents,platform_fee_cents,status,created_at,notes(title)').order('created_at', { ascending: false }).limit(8),
    db.from('sellers').select('id', { count: 'exact', head: true }).eq('verification_status', 'approved'),
    db.from('notes').select('id', { count: 'exact', head: true }).eq('status', 'published'),
    db.from('sellers').select('id', { count: 'exact', head: true }).eq('verification_status', 'approved').is('paystack_subaccount_code', null),
    events.recent({ limit: 12 }),
    payoutChecks(),
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
    toVerify: toVerify.length,
    activity,
  });
});

/* ---------- Verifications ---------- */

router.get('/verifications', async (req, res) => {
  const [{ data: pending }, { data: updates }, decided] = await Promise.all([
    db.from('sellers').select('id,display_name,full_name,id_doc_path,submitted_at,verification_note,users(email),qualifications(*)').eq('verification_status', 'pending').order('submitted_at'),
    pendingUpdates(),
    events.recent({ limit: 15, kinds: ['seller.approved', 'seller.rejected', 'seller.revoked', 'qualification.approved', 'qualification.rejected'] }),
  ]);
  const queue = await Promise.all(
    (pending || []).map(async (s) => ({
      ...s,
      quals: await Promise.all(education.sortQuals((s.qualifications || []).filter((q) => q.review_status === 'pending')).map(docLinks)),
      idUrl: s.id_doc_path ? await storage.signedUrl('verification', s.id_doc_path, 600).catch(() => null) : null,
    }))
  );
  // For "I've finished this": what the update replaces
  const replacedIds = (updates || []).map((q) => q.replaces_id).filter(Boolean);
  const { data: replaced } = replacedIds.length ? await db.from('qualifications').select('*').in('id', replacedIds) : { data: [] };
  const replacedById = Object.fromEntries((replaced || []).map((q) => [q.id, q]));
  const changes = await Promise.all(
    (updates || []).map(async (q) => {
      const replaced = replacedById[q.replaces_id] || null;
      return { ...(await docLinks(q)), replaced, diff: replaced ? education.changes(replaced, q) : [], sameDocs: !!replaced && replaced.doc_path === q.doc_path };
    })
  );
  res.render('admin/verifications', { title: 'Verifications', tab: 'verifications', queue, changes, decided });
});

// Approve or reject one qualification from an already verified seller.
router.post('/qualifications/:id/review', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const back = backTo(req, '/admin/verifications');
  const note = str(req.body.note, 500) || null;
  const { data: q } = await db.from('qualifications').select('id,seller_id,name,replaces_id,review_status,sellers(display_name)').eq('id', req.params.id).maybeSingle();
  if (!q || q.review_status !== 'pending') return res.redirect(back);
  const who = q.sellers?.display_name || 'the seller';
  if (req.body.decision === 'approve') {
    await db.from('qualifications').update({ review_status: 'approved', review_note: null, reviewed_at: new Date().toISOString() }).eq('id', q.id);
    if (q.replaces_id) await db.from('qualifications').update({ review_status: 'superseded' }).eq('id', q.replaces_id).eq('seller_id', q.seller_id);
    await education.refreshHeadline(q.seller_id);
    events.log('qualification.approved', { seller_id: q.seller_id, qualification_id: q.id, name: q.name, seller: who }, req.user.email);
    notify.add(q.seller_id, { kind: 'education', title: `${q.name} is verified`, body: 'It now shows on your storefront.', link: '/seller/verification' });
    flash(req, 'ok', `${q.name} approved for ${who}. It now shows on their storefront.`);
  } else if (req.body.decision === 'reject') {
    if (!note) {
      flash(req, 'error', 'Add a reason so the seller knows what to fix.');
      return res.redirect(back);
    }
    await db.from('qualifications').update({ review_status: 'rejected', review_note: note, reviewed_at: new Date().toISOString() }).eq('id', q.id);
    events.log('qualification.rejected', { seller_id: q.seller_id, qualification_id: q.id, name: q.name, seller: who, reason: note }, req.user.email);
    notify.add(q.seller_id, { kind: 'education', title: `${q.name} wasn’t approved`, body: note, link: '/seller/verification' });
    flash(req, 'ok', `${q.name} not approved. ${who} can see why and send it again.`);
  } else return res.redirect(back);
  emails.sendQualificationDecision(q.id).catch((err) => console.error('[admin] education email not sent', err.message));
  res.redirect(back);
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
  const [{ data: notes }, { data: sales }, docs, quals] = await Promise.all([
    db.from('notes').select('id,title,slug,status,price_cents,sales_count').eq('seller_id', s.id).order('created_at', { ascending: false }),
    db.rpc('seller_totals', { p_seller_id: s.id }),
    Promise.all([
      s.degree_doc_path ? storage.signedUrl('verification', s.degree_doc_path, 600).catch(() => null) : null,
      s.id_doc_path ? storage.signedUrl('verification', s.id_doc_path, 600).catch(() => null) : null,
    ]),
    education.forSeller(s.id).then((list) => Promise.all(list.map(docLinks))),
  ]);
  const { data: sellerReviews } = await db.from('reviews').select('*').eq('seller_id', s.id).order('created_at', { ascending: false }).limit(100);
  const totals = (sales && sales[0]) || { sales: 0, earnings: 0 };
  res.render('admin/seller', { title: s.display_name, tab: 'sellers', s, notes: notes || [], totals, degreeUrl: docs[0], idUrl: docs[1], quals, reviews: sellerReviews || [], jobsIdDays: require('../lib/jobs').ID_KEEP_DAYS });
});

router.post('/sellers/:id/verification', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const back = backTo(req, `/admin/sellers/${req.params.id}`);
  const decision = req.body.decision;
  const note = str(req.body.note, 500) || null;
  const { data: s } = await db.from('sellers').select('display_name,verification_status,paystack_subaccount_code').eq('id', req.params.id).maybeSingle();
  if (!s) return next();

  // Only a waiting submission can be decided; an approved seller can only be revoked
  const allowed = s.verification_status === 'pending' ? ['approve', 'reject'] : s.verification_status === 'approved' ? ['reject'] : [];
  if (!allowed.includes(decision)) {
    flash(req, 'error', 'This seller has already been decided.');
    return res.redirect(back);
  }

  if (decision === 'approve') {
    const now = new Date().toISOString();
    await db.from('sellers').update({ verification_status: 'approved', verification_note: null, verified_at: now }).eq('id', req.params.id);
    await db.from('qualifications').update({ review_status: 'approved', review_note: null, reviewed_at: now }).eq('seller_id', req.params.id).eq('review_status', 'pending');
    await education.refreshHeadline(req.params.id);
    flash(req, 'ok', `${s.display_name} approved. Their published notes are visible once payouts are set up.`);
    events.log('seller.approved', { seller_id: req.params.id, name: s.display_name }, req.user.email);
    notify.add(req.params.id, s.paystack_subaccount_code
      ? { kind: 'verification', title: 'You’re verified', body: 'Your published notes are now live for students.', link: '/seller' }
      : { kind: 'verification', title: 'You’re verified', body: 'One step left: add your payout details so your notes can go on sale.', link: '/seller/payouts' });
  } else if (decision === 'reject') {
    if (!note) {
      flash(req, 'error', 'Add a reason so the seller knows what to fix.');
      return res.redirect(back);
    }
    await db.from('sellers').update({ verification_status: 'rejected', verification_note: note, verified_at: null }).eq('id', req.params.id);
    await db.from('qualifications').update({ review_status: 'rejected', review_note: note, reviewed_at: new Date().toISOString() }).eq('seller_id', req.params.id).eq('review_status', 'pending');
    const revoked = s.verification_status === 'approved';
    flash(req, 'ok', revoked ? `${s.display_name} revoked. All their notes are hidden from students.` : `${s.display_name} not approved. They can see your reason and send their documents again.`);
    events.log(revoked ? 'seller.revoked' : 'seller.rejected', { seller_id: req.params.id, name: s.display_name, reason: note }, req.user.email);
    notify.add(req.params.id, { kind: 'verification', title: revoked ? 'Your verification was withdrawn' : 'We couldn’t verify your documents', body: note, link: '/seller/verification' });
  } else {
    return res.redirect(back);
  }
  emails.sendVerificationDecision(req.params.id).catch((err) => console.error('[admin] decision email not sent', err.message));
  res.redirect(back);
});

// Hide a review that breaks the rules (or show it again).
router.post('/reviews/:id/status', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const status = req.body.status === 'hidden' ? 'hidden' : 'published';
  const { data: r } = await db.from('reviews').update({ status }).eq('id', req.params.id).select('seller_id,rating,reviewer_name').maybeSingle();
  if (!r) return next();
  events.log(status === 'hidden' ? 'review.hidden' : 'review.shown', { seller_id: r.seller_id, rating: r.rating, by: r.reviewer_name }, req.user.email);
  flash(req, 'ok', status === 'hidden' ? 'Review hidden from the storefront.' : 'Review shown again.');
  res.redirect(backTo(req, `/admin/sellers/${r.seller_id}`));
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
  const status = Object.hasOwn(map, String(req.body.action)) ? map[req.body.action] : null;
  if (status) {
    // Notes the seller deleted stay deleted: changing them would put them back in the seller's list.
    const { data: n } = await db.from('notes').update({ status }).eq('id', req.params.id).neq('status', 'deleted').select('title,seller_id').maybeSingle();
    if (!n) {
      flash(req, 'error', 'The seller deleted these notes, so they can’t be changed. Past buyers can still download them.');
      return res.redirect(backToReferer(req, '/admin/notes'));
    }
    flash(req, 'ok', req.body.action === 'remove' ? 'Notes removed. The seller can’t republish them.' : 'Notes updated.');
    events.log(`note.${req.body.action === 'remove' ? 'removed' : req.body.action === 'restore' ? 'restored' : 'hidden'}`, { note_id: req.params.id, title: n?.title }, req.user.email);
    const support = `Email ${config.supportEmail} if you think this is a mistake.`;
    notify.add(n.seller_id, {
      remove: { kind: 'note', title: `EasyNotes removed “${n.title}”`, body: `It’s hidden from students and can’t be published again. ${support}`, link: '/seller/notes' },
      unpublish: { kind: 'note', title: `EasyNotes hid “${n.title}” from students`, body: `Past buyers can still download it. ${support}`, link: '/seller/notes' },
      restore: { kind: 'note', title: `“${n.title}” can be published again`, body: 'Publish it from your notes when you’re ready.', link: '/seller/notes' },
    }[req.body.action]);
  }
  res.redirect(backToReferer(req, '/admin/notes'));
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
  const { data: done } = await db.from('orders').update({ download_count: 0 }).eq('reference', reference).eq('status', 'paid').select('reference');
  if (!done || !done.length) {
    flash(req, 'error', `No paid order with the reference ${reference}.`);
    return res.redirect(`/admin/orders?reference=${encodeURIComponent(reference)}`);
  }
  flash(req, 'ok', `Download limit reset for ${reference}.`);
  events.log('order.downloads_reset', { reference }, req.user.email);
  res.redirect(`/admin/orders?reference=${encodeURIComponent(reference)}`);
});

/* ---------- Money ---------- */

// "2026-10" for a sale, by the South African calendar (a sale at 00:30 on 1 November is November's)
const saMonth = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }).slice(0, 7);

// Every paid order (Supabase sends at most 1000 rows a request, so it's fetched in pages)
async function allPaidOrders() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('orders').select('amount_cents,platform_fee_cents,seller_earnings_cents,paid_at,seller_id,sellers(display_name,slug)').eq('status', 'paid').order('paid_at', { ascending: false }).order('id').range(from, from + 999);
    if (error) throw error; // a partial list would show totals that are quietly too low
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// A new bank account, after checking it in Paystack: "I've verified it" takes the seller off the list.
// "Deny" (say the account isn't in the seller's name) removes the bank details and switches the Paystack
// subaccount off, so nothing is paid into it; their notes are hidden until they add new details.
router.post('/sellers/:id/payout-review', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const back = backTo(req, '/admin/money#verify-payouts');
  const { data: s } = await db.from('sellers').select('id,display_name,full_name,bank_name,account_number_last4,paystack_subaccount_code,payout_check_since,users(email)').eq('id', req.params.id).maybeSingle();
  if (!s || !s.payout_check_since || !s.paystack_subaccount_code) return res.redirect(back);
  if (req.body.decision === 'approve') {
    await db.from('sellers').update({ payout_check_since: null }).eq('id', s.id);
    events.log('seller.payout_checked', { seller_id: s.id, seller: s.display_name }, req.user.email);
    notify.add(s.id, { kind: 'payouts', title: 'Your payout account is verified', body: `Your share of each sale will be paid into ${s.bank_name} ••••${s.account_number_last4}.`, link: '/seller/payouts' });
    flash(req, 'ok', `${s.display_name} marked as verified in Paystack.`);
  } else if (req.body.decision === 'deny') {
    const note = str(req.body.note, 500);
    if (!note) {
      flash(req, 'error', 'Add a reason so the seller knows what to fix.');
      return res.redirect(back);
    }
    try {
      await paystack.updateSubaccount(s.paystack_subaccount_code, { active: false });
    } catch (err) {
      console.error('[admin] subaccount not switched off', err.message, err.paystack);
      flash(req, 'error', `Paystack didn’t switch the account off (${err.message}), so nothing was changed. Try again.`);
      return res.redirect(back);
    }
    const { error } = await db.from('sellers').update({
      paystack_subaccount_code: null, business_name: null, bank_code: null, bank_name: null, account_number_last4: null,
      payout_check_since: null, payout_rejected_note: note,
    }).eq('id', s.id);
    if (error) throw error;
    events.log('seller.payout_denied', { seller_id: s.id, seller: s.display_name, bank: s.bank_name, last4: s.account_number_last4, subaccount: s.paystack_subaccount_code, reason: note }, req.user.email);
    notify.add(s.id, { kind: 'payouts', title: 'Your bank details weren’t accepted', body: note, link: '/seller/payouts' });
    if (s.users) emails.sendPayoutDenied(s.users.email, s.full_name || s.display_name, s.bank_name, s.account_number_last4, note).catch((err) => console.error('[admin] payout email not sent', err.message));
    flash(req, 'ok', `${s.display_name}’s bank details removed. Their notes are hidden until they add new ones; they can see your reason.`);
  }
  res.redirect(back);
});

router.get('/money', async (req, res) => {
  const [paid, { data: noPayouts }, toVerify] = await Promise.all([
    allPaidOrders(),
    db.from('sellers').select('id,display_name,verified_at,users(email)').eq('verification_status', 'approved').is('paystack_subaccount_code', null).order('verified_at'),
    payoutChecks(),
  ]);

  // Last 12 months (South African time), newest first, including months with no sales.
  const months = [];
  const [year, month] = saMonth(new Date()).split('-').map(Number);
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    months.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }), sales: 0, gross: 0, fees: 0, payouts: 0 });
  }
  const byMonth = Object.fromEntries(months.map((m) => [m.key, m]));
  const bySeller = {};
  const all = { sales: 0, gross: 0, fees: 0, payouts: 0 };
  for (const o of paid) {
    for (const bucket of [byMonth[saMonth(o.paid_at)], all]) {
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
    toVerify,
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

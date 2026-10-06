const express = require('express');
const db = require('../lib/supabase');
const storage = require('../lib/storage');
const flash = require('../lib/flash');
const { requireAdmin } = require('../lib/auth');
const { isUuid, str } = require('../lib/helpers');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
  const [{ data: totals }, { data: pending }, { data: recent }, { count: sellerCount }, { count: noteCount }] = await Promise.all([
    db.rpc('platform_totals'),
    db.from('sellers').select('id,display_name,degree,university,submitted_at').eq('verification_status', 'pending').order('submitted_at'),
    db.from('orders').select('reference,email,amount_cents,platform_fee_cents,status,created_at,notes(title)').order('created_at', { ascending: false }).limit(10),
    db.from('sellers').select('id', { count: 'exact', head: true }).eq('verification_status', 'approved'),
    db.from('notes').select('id', { count: 'exact', head: true }).eq('status', 'published'),
  ]);
  const t = (totals && totals[0]) || { sales: 0, gross: 0, fees: 0 };
  res.render('admin/index', {
    title: 'Admin',
    tab: 'overview',
    totals: { sales: Number(t.sales), gross: Number(t.gross), fees: Number(t.fees) },
    pending: pending || [],
    recent: recent || [],
    sellerCount: sellerCount || 0,
    noteCount: noteCount || 0,
  });
});

const STATUSES = ['pending', 'approved', 'rejected', 'unsubmitted'];

router.get('/sellers', async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  let q = db.from('sellers').select('id,display_name,slug,degree,university,verification_status,paystack_subaccount_code,created_at,users(email)').order('created_at', { ascending: false }).limit(200);
  if (status) q = q.eq('verification_status', status);
  const { data: sellers } = await q;
  res.render('admin/sellers', { title: 'Sellers', tab: 'sellers', sellers: sellers || [], status, statuses: STATUSES });
});

router.get('/sellers/:id', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const { data: s } = await db.from('sellers').select('*, users(email,created_at)').eq('id', req.params.id).maybeSingle();
  if (!s) return next();
  const [{ data: notes }, docs] = await Promise.all([
    db.from('notes').select('id,title,slug,status,price_cents,sales_count').eq('seller_id', s.id).order('created_at', { ascending: false }),
    Promise.all([
      s.degree_doc_path ? storage.signedUrl('verification', s.degree_doc_path, 600) : null,
      s.id_doc_path ? storage.signedUrl('verification', s.id_doc_path, 600) : null,
    ]),
  ]);
  res.render('admin/seller', { title: s.display_name, tab: 'sellers', s, notes: notes || [], degreeUrl: docs[0], idUrl: docs[1] });
});

router.post('/sellers/:id/verification', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const decision = req.body.decision;
  const note = str(req.body.note, 500) || null;
  if (decision === 'approve') {
    await db.from('sellers').update({ verification_status: 'approved', verification_note: null, verified_at: new Date().toISOString() }).eq('id', req.params.id);
    flash(req, 'ok', 'Seller approved. Their published notes are now visible (once payouts are set up).');
  } else if (decision === 'reject') {
    if (!note) {
      flash(req, 'error', 'Add a reason so the seller knows what to fix.');
      return res.redirect(`/admin/sellers/${req.params.id}`);
    }
    await db.from('sellers').update({ verification_status: 'rejected', verification_note: note, verified_at: null }).eq('id', req.params.id);
    flash(req, 'ok', 'Seller rejected. All their notes are hidden from students.');
  }
  res.redirect(`/admin/sellers/${req.params.id}`);
});

router.get('/notes', async (req, res) => {
  const q = String(req.query.q || '').replace(/["%,()*\\:]/g, ' ').trim().slice(0, 80);
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
    await db.from('notes').update({ status }).eq('id', req.params.id);
    flash(req, 'ok', req.body.action === 'remove' ? 'Notes removed. The seller can’t republish them.' : 'Notes updated.');
  }
  res.redirect(req.get('referer')?.includes('/admin/') ? req.get('referer') : '/admin/notes');
});

router.get('/orders', async (req, res) => {
  const status = ['paid', 'pending', 'failed'].includes(req.query.status) ? req.query.status : 'paid';
  const reference = str(req.query.reference, 40).toUpperCase();
  let q = db.from('orders').select('reference,email,amount_cents,platform_fee_cents,seller_earnings_cents,status,download_count,created_at,paid_at,notes(title),sellers(display_name)').order('created_at', { ascending: false }).limit(200);
  if (reference) q = q.eq('reference', reference);
  else q = q.eq('status', status);
  const { data: orders } = await q;
  res.render('admin/orders', { title: 'Orders', tab: 'orders', orders: orders || [], status, reference });
});

router.post('/orders/:reference/reset-downloads', async (req, res) => {
  const reference = str(req.params.reference, 40).toUpperCase();
  await db.from('orders').update({ download_count: 0 }).eq('reference', reference);
  flash(req, 'ok', `Download limit reset for ${reference}.`);
  res.redirect(`/admin/orders?reference=${encodeURIComponent(reference)}`);
});

module.exports = router;

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../lib/config');
const db = require('../lib/supabase');
const paystack = require('../lib/paystack');
const storage = require('../lib/storage');
const { markPaid } = require('../lib/orders');
const { isPublic } = require('../lib/queries');
const { isUuid, feeFor, fileName, noteUrl, str } = require('../lib/helpers');
const flash = require('../lib/flash');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const checkoutLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const downloadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: 'draft-7', legacyHeaders: false });

const newReference = () => `EN${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

router.post('/checkout/:noteId', checkoutLimiter, async (req, res, next) => {
  if (!isUuid(req.params.noteId)) return next();
  const { data: note } = await db
    .from('notes')
    .select('id,title,slug,price_cents,status,seller_id,sellers(verification_status,paystack_subaccount_code)')
    .eq('id', req.params.noteId)
    .maybeSingle();
  if (!note || !isPublic(note)) return next();

  const email = str(req.body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    flash(req, 'error', 'Enter a valid email address. You’ll need it to download your notes.');
    return res.redirect(noteUrl(note) + '#buy');
  }
  if (req.body.accept !== 'on') {
    flash(req, 'error', 'Tick the box to confirm you understand all sales are final.');
    return res.redirect(noteUrl(note) + '#buy');
  }

  const reference = newReference();
  const fee = feeFor(note.price_cents);
  const { error } = await db.from('orders').insert({
    reference,
    note_id: note.id,
    seller_id: note.seller_id,
    email,
    amount_cents: note.price_cents,
    platform_fee_cents: fee,
    seller_earnings_cents: note.price_cents - fee,
  });
  if (error) throw error;

  try {
    const tx = await paystack.initialize({
      email,
      amount: note.price_cents,
      currency: 'ZAR',
      reference,
      callback_url: `${config.baseUrl}/checkout/callback`,
      subaccount: note.sellers.paystack_subaccount_code,
      transaction_charge: fee, // EasyNotes' cut, in cents
      bearer: config.feeBearer,
      metadata: {
        note_id: note.id,
        custom_fields: [{ display_name: 'Notes', variable_name: 'notes', value: note.title }],
      },
    });
    res.redirect(303, tx.authorization_url);
  } catch (err) {
    console.error('[checkout] paystack initialize failed', err.message, err.paystack);
    await db.from('orders').update({ status: 'failed' }).eq('reference', reference);
    flash(req, 'error', 'We couldn’t start the payment. Try again in a moment.');
    res.redirect(noteUrl(note) + '#buy');
  }
});

router.get('/checkout/callback', async (req, res) => {
  const reference = str(req.query.reference || req.query.trxref, 40).toUpperCase();
  if (!reference) return res.redirect('/');

  let order = null;
  try {
    const tx = await paystack.verify(reference);
    order = await markPaid(reference, tx);
  } catch (err) {
    console.error('[checkout] verify failed', err.message);
  }
  if (!order) {
    const { data } = await db.from('orders').select('*').eq('reference', reference).maybeSingle();
    order = data;
  }
  if (!order) return res.status(404).render('404', { title: 'Payment not found' });

  const { data: note } = await db.from('notes').select('id,title,slug,page_count').eq('id', order.note_id).single();
  res.set('Cache-Control', 'no-store');
  res.render('checkout-complete', { title: order.status === 'paid' ? 'Your notes are ready' : 'Payment not completed', order, note });
});

router.get('/download', (req, res) => {
  res.render('download', {
    title: 'Download your notes',
    email: str(req.query.email, 200),
    reference: str(req.query.reference, 40),
    error: null,
  });
});

router.post('/download', downloadLimiter, async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const reference = str(req.body.reference, 40).toUpperCase();
  const fail = (msg) => res.status(400).render('download', { title: 'Download your notes', email, reference, error: msg });

  if (!email || !reference) return fail('Enter the email you paid with and your payment reference.');

  const { data: order } = await db
    .from('orders')
    .select('id,email,status,download_count,notes(title,file_path)')
    .eq('reference', reference)
    .maybeSingle();
  if (!order || order.email !== email) {
    return fail('We couldn’t find a purchase with that email and reference. Check both against your Paystack receipt.');
  }

  if (order.status !== 'paid') {
    // The webhook may not have arrived yet: ask Paystack directly.
    let paid = null;
    try {
      paid = await markPaid(reference, await paystack.verify(reference));
    } catch {}
    if (!paid) return fail('This payment hasn’t gone through, so there’s nothing to download yet.');
  }

  if (order.download_count >= config.maxDownloads) {
    return fail(`This purchase has reached its limit of ${config.maxDownloads} downloads. Email ${config.supportEmail} with your reference if you need another copy.`);
  }

  const url = await storage.signedUrl('notes', order.notes.file_path, 60, fileName(order.notes.title));
  await db
    .from('orders')
    .update({ download_count: order.download_count + 1, last_download_at: new Date().toISOString() })
    .eq('id', order.id);
  res.set('Cache-Control', 'no-store');
  res.redirect(303, url);
});

module.exports = router;

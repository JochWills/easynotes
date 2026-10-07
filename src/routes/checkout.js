const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../lib/config');
const db = require('../lib/supabase');
const paystack = require('../lib/paystack');
const storage = require('../lib/storage');
const cart = require('../lib/cart');
const { markPaid, ordersFor } = require('../lib/orders');
const emails = require('../lib/emails');
const { isPublic, publicNotes } = require('../lib/queries');
const { isUuid, feeFor, fileName, noteUrl, str } = require('../lib/helpers');
const flash = require('../lib/flash');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const checkoutLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const downloadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: 'draft-7', legacyHeaders: false });
const linkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });

const newReference = () => `EN${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const backTo = (req, fallback) => {
  const ref = req.get('referer');
  try {
    const u = ref && new URL(ref);
    return u && u.host === req.get('host') ? u.pathname + u.search : fallback;
  } catch {
    return fallback;
  }
};

const ORDER_NOTE = 'id,title,slug,price_cents,status,seller_id,sellers(verification_status,paystack_subaccount_code)';

// Creates one order per note under a shared Paystack reference, then sends the buyer to Paystack.
// One seller: the seller's subaccount gets the payment minus EasyNotes' fee.
// Several sellers: a multi-split pays each seller their share and EasyNotes keeps the rest.
async function startCheckout(req, res, notes, back) {
  const email = str(req.body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    flash(req, 'error', 'Enter a valid email address. You’ll need it to download your notes.');
    return res.redirect(back);
  }
  if (req.body.accept !== 'on') {
    flash(req, 'error', 'Tick the box to confirm you understand all sales are final.');
    return res.redirect(back);
  }

  // Sellers can't buy their own notes: not while logged in, and not by paying with their account email.
  const sellerIds = [...new Set(notes.map((n) => n.seller_id))];
  const { data: owners, error: ownersErr } = await db.from('sellers').select('id,users(email)').in('id', sellerIds);
  if (ownersErr) throw ownersErr;
  const ownEmail = (owners || []).some((o) => (o.users?.email || '').toLowerCase() === email);
  if (ownEmail || (req.seller && sellerIds.includes(req.seller.id))) {
    flash(req, 'error', notes.length === 1 ? 'You can’t buy your own notes.' : 'Your cart has notes you’re selling. Remove them, then check out.');
    return res.redirect(back);
  }

  const paymentRef = newReference();
  const rows = notes.map((n, i) => {
    const fee = feeFor(n.price_cents);
    return {
      reference: notes.length === 1 ? paymentRef : `${paymentRef}-${i + 1}`,
      payment_ref: paymentRef,
      note_id: n.id,
      seller_id: n.seller_id,
      email,
      amount_cents: n.price_cents,
      platform_fee_cents: fee,
      seller_earnings_cents: n.price_cents - fee,
    };
  });
  const { error } = await db.from('orders').insert(rows);
  if (error) throw error;

  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  const sellers = {};
  for (const [i, r] of rows.entries()) {
    const s = (sellers[r.seller_id] ||= { subaccount: notes[i].sellers.paystack_subaccount_code, share: 0, fee: 0 });
    s.share += r.seller_earnings_cents;
    s.fee += r.platform_fee_cents;
  }
  const parties = Object.values(sellers);
  const split =
    parties.length === 1
      ? { subaccount: parties[0].subaccount, transaction_charge: parties[0].fee, bearer: config.feeBearer }
      : {
          split: {
            type: 'flat',
            // "account": EasyNotes pays Paystack's fee from its share. Otherwise everyone pays it in proportion.
            bearer_type: config.feeBearer === 'account' ? 'account' : 'all-proportional',
            subaccounts: parties.map((p) => ({ subaccount: p.subaccount, share: p.share })),
          },
        };

  try {
    const tx = await paystack.initialize({
      email,
      amount: total,
      currency: 'ZAR',
      reference: paymentRef,
      callback_url: `${config.baseUrl}/checkout/callback`,
      ...split,
      metadata: {
        note_ids: notes.map((n) => n.id),
        custom_fields: [{ display_name: 'Notes', variable_name: 'notes', value: notes.map((n) => n.title).join('; ').slice(0, 250) }],
      },
    });
    res.redirect(303, tx.authorization_url);
  } catch (err) {
    console.error('[checkout] paystack initialize failed', err.message, err.paystack);
    await db.from('orders').update({ status: 'failed' }).eq('payment_ref', paymentRef);
    flash(req, 'error', 'We couldn’t start the payment. Try again in a moment.');
    res.redirect(back);
  }
}

// Buy one set of notes straight from its page.
router.post('/checkout/:noteId', checkoutLimiter, async (req, res, next) => {
  if (!isUuid(req.params.noteId)) return next();
  const { data: note } = await db.from('notes').select(ORDER_NOTE).eq('id', req.params.noteId).maybeSingle();
  if (!note || !isPublic(note)) return next();
  return startCheckout(req, res, [note], noteUrl(note) + '#buy');
});

/* ---------- Cart ---------- */

router.get('/cart', async (req, res) => {
  const { notes, dropped } = await cart.load(req);
  res.set('Cache-Control', 'no-store');
  res.render('cart', {
    title: 'Your cart',
    notes,
    dropped,
    total: notes.reduce((s, n) => s + n.price_cents, 0),
  });
});

// The slide-in cart panel fetches its contents from here whenever it opens.
router.get('/cart/panel', async (req, res) => {
  const { notes, dropped } = await cart.load(req);
  res.set('Cache-Control', 'no-store');
  res.render('partials/cart-panel', {
    notes,
    dropped,
    total: notes.reduce((s, n) => s + n.price_cents, 0),
  });
});

router.post('/cart/add/:noteId', async (req, res, next) => {
  if (!isUuid(req.params.noteId)) return next();
  const { data } = await publicNotes('id,title,seller_id,sellers!inner(verification_status,paystack_subaccount_code)').eq('id', req.params.noteId).maybeSingle();
  if (!data) return next();
  const result = req.seller && req.seller.id === data.seller_id ? 'own' : cart.add(req, data.id);
  // The add-to-cart buttons on note cards ask for JSON so the page doesn't reload.
  if (req.get('accept') === 'application/json') {
    return res.json({ result, count: cart.ids(req).length, max: cart.MAX_ITEMS });
  }
  if (result === 'own') flash(req, 'error', 'You can’t buy your own notes.');
  else if (result === 'full') flash(req, 'error', `Your cart is full (${cart.MAX_ITEMS} sets of notes). Check out, then start a new cart.`);
  else flash(req, 'ok', result === 'already' ? 'That’s already in your cart.' : 'Added to your cart.');
  res.redirect(303, backTo(req, '/cart'));
});

router.post('/cart/remove/:noteId', (req, res, next) => {
  if (!isUuid(req.params.noteId)) return next();
  cart.remove(req, req.params.noteId);
  if (req.get('accept') === 'application/json') return res.json({ count: cart.ids(req).length });
  flash(req, 'ok', 'Removed from your cart.');
  res.redirect(303, '/cart');
});

router.post('/checkout', checkoutLimiter, async (req, res) => {
  const { notes, dropped } = await cart.load(req);
  if (dropped) {
    flash(req, 'error', 'Some notes in your cart are no longer available, so we removed them. Check the total and try again.');
    return res.redirect('/cart');
  }
  if (!notes.length) return res.redirect('/cart');
  const { data: fresh } = await db.from('notes').select(ORDER_NOTE).in('id', notes.map((n) => n.id));
  const byId = Object.fromEntries((fresh || []).map((n) => [n.id, n]));
  const ordered = notes.map((n) => byId[n.id]).filter((n) => n && isPublic(n));
  if (ordered.length !== notes.length) return res.redirect('/cart');
  return startCheckout(req, res, ordered, '/cart');
});

/* ---------- After paying ---------- */

const withNotes = async (orders) => {
  const { data: notes } = await db.from('notes').select('id,title,slug,page_count').in('id', orders.map((o) => o.note_id));
  const byId = Object.fromEntries((notes || []).map((n) => [n.id, n]));
  return orders.map((o) => ({ ...o, notes: byId[o.note_id] || { title: 'Notes', slug: '' } }));
};

router.get('/checkout/callback', async (req, res) => {
  const paymentRef = str(req.query.reference || req.query.trxref, 40).toUpperCase();
  if (!paymentRef) return res.redirect('/');

  let orders = null;
  try {
    orders = await markPaid(paymentRef, await paystack.verify(paymentRef));
  } catch (err) {
    console.error('[checkout] verify failed', err.message);
  }
  if (!orders) orders = await ordersFor(paymentRef);
  if (!orders.length) return res.status(404).render('404', { title: 'Payment not found' });

  const status = orders.every((o) => o.status === 'paid') ? 'paid' : orders.some((o) => o.status === 'failed') ? 'failed' : 'pending';
  if (status === 'paid') {
    // Bought: empty the cart of anything just paid for.
    const bought = new Set(orders.map((o) => o.note_id));
    req.session.cart = cart.ids(req).filter((id) => !bought.has(id));
  }
  res.set('Cache-Control', 'no-store');
  res.render('checkout-complete', {
    title: status === 'paid' ? 'Your notes are ready' : 'Payment not completed',
    status,
    paymentRef,
    email: orders[0].email,
    orders: await withNotes(orders),
    total: orders.reduce((s, o) => s + o.amount_cents, 0),
  });
});

/* ---------- Downloads ---------- */

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
  if (!/^EN[A-Z0-9]+(-\d+)?$/.test(reference)) return fail('That doesn’t look like an EasyNotes reference. It starts with EN, like EN8K2Q4F1A2B3C.');

  // The reference on the receipt covers the whole payment; each note in it also has its own (…-1, …-2).
  const { data: found } = await db
    .from('orders')
    .select('id,reference,payment_ref,email,status,download_count,paid_at,notes(title,file_path)')
    .or(`reference.eq.${reference},payment_ref.eq.${reference}`);
  const mine = (found || []).filter((o) => o.email === email);
  if (!mine.length) {
    return fail('We couldn’t find a purchase with that email and reference. Check both against your receipt.');
  }

  if (mine.some((o) => o.status !== 'paid')) {
    // The webhook may not have arrived yet: ask Paystack directly.
    let paid = null;
    try {
      paid = await markPaid(mine[0].payment_ref, await paystack.verify(mine[0].payment_ref));
    } catch {}
    if (!paid) return fail('This payment hasn’t gone through, so there’s nothing to download yet.');
    mine.forEach((o) => (o.status = 'paid'));
  }

  // Several notes under one reference: show them all, each with its own download button.
  if (mine.length > 1) {
    res.set('Cache-Control', 'no-store');
    return res.render('library', { title: 'Your notes', email, expires: null, orders: mine.sort((a, b) => a.reference.localeCompare(b.reference)), linkDays: emails.LIBRARY_DAYS });
  }

  const order = mine[0];
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

// Emailed link: lists every paid purchase for one email, each downloadable through POST /download.
router.get('/library', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const link = emails.readLibraryToken(req.query.t);
  if (!link) return res.render('library', { title: 'Link expired', orders: null, linkDays: emails.LIBRARY_DAYS });

  const { data: orders, error } = await db
    .from('orders')
    .select('reference,email,paid_at,download_count,notes(title,page_count)')
    .eq('email', link.email)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false });
  if (error) throw error;
  res.render('library', { title: 'Your notes', email: link.email, expires: link.expires, orders, linkDays: emails.LIBRARY_DAYS });
});

// "Email me my notes": always gives the same answer so it can't be used to check who has bought what.
router.post('/download/link', linkLimiter, async (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    flash(req, 'error', 'Enter the email address you paid with.');
    return res.redirect('/download#email-link');
  }
  const { count } = await db.from('orders').select('id', { count: 'exact', head: true }).eq('email', email).eq('status', 'paid');
  if (count) {
    try {
      await emails.sendLibraryLink(email);
    } catch (err) {
      console.error('[download] link email not sent', err.message);
    }
  }
  flash(req, 'ok', `If ${email} has bought notes on EasyNotes, a download link is on its way. Check your spam folder if it doesn’t arrive in a few minutes.`);
  res.redirect('/download');
});

module.exports = router;

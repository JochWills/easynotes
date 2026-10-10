const db = require('./supabase');
const events = require('./events');
const { sendPurchaseEmail, sendSaleEmails } = require('./emails');

// Every order bought in one payment shares payment_ref (the Paystack reference).
async function ordersFor(paymentRef) {
  const { data, error } = await db.from('orders').select('*').eq('payment_ref', paymentRef).order('reference');
  if (error) throw error;
  return data || [];
}

// A payment problem for an admin (Admin > Reports). The callback and webhook both see it, so it's logged once.
async function logProblem(kind, detail) {
  const { data: seen } = await db.from('events').select('id').eq('kind', kind).eq('detail->>reference', detail.reference).limit(1);
  if (!seen || !seen.length) await events.log(kind, detail, 'paystack');
}

// Idempotent: safe to call from both the browser callback and the webhook.
// Returns the orders once paid, otherwise null.
async function markPaid(paymentRef, tx) {
  const orders = await ordersFor(paymentRef);
  if (!orders.length) {
    // Paid, but the orders are gone (e.g. deleted with the note before a slow payment came through): flag it for an admin.
    if (tx && tx.status === 'success' && /^EN[A-Z0-9]+$/.test(paymentRef)) {
      await logProblem('payment.unmatched', { reference: paymentRef, amount_cents: Number(tx.amount) || 0, email: tx.customer?.email || null });
    }
    return null;
  }
  if (orders.every((o) => o.status === 'paid')) return orders;

  const total = orders.reduce((sum, o) => sum + o.amount_cents, 0);
  const ok = tx && tx.status === 'success' && tx.currency === 'ZAR' && Number(tx.amount) === total;
  if (!ok) {
    if (tx && tx.status === 'success') {
      await logProblem('payment.mismatch', { reference: paymentRef, paid_cents: Number(tx.amount) || 0, currency: tx.currency, expected_cents: total });
    }
    if (tx && tx.status === 'failed') {
      await db.from('orders').update({ status: 'failed' }).eq('payment_ref', paymentRef).eq('status', 'pending');
    }
    return null;
  }

  const { data: updated, error } = await db
    .from('orders')
    .update({ status: 'paid', paid_at: new Date().toISOString(), paystack_transaction_id: String(tx.id ?? '') })
    .eq('payment_ref', paymentRef)
    .in('status', ['pending', 'failed']) // a failed attempt can be retried and paid under the same reference
    .select();
  if (error) throw error;

  if (updated && updated.length) {
    for (const o of updated) {
      const { error: rpcErr } = await db.rpc('increment_note_sales', { p_note_id: o.note_id });
      if (rpcErr) console.error('[orders] sales count not incremented', rpcErr.message);
    }
    // Only the call that flips the orders to paid sends the emails (buyer's download link, seller's sale notice), so the callback and webhook don't both send them.
    sendPurchaseEmail(updated).catch((err) => console.error('[orders] purchase email not sent', err.message));
    sendSaleEmails(updated).catch((err) => console.error('[orders] sale email not sent', err.message));
  }
  return ordersFor(paymentRef);
}

module.exports = { markPaid, ordersFor };

const db = require('./supabase');
const { sendPurchaseEmail, sendSaleEmails } = require('./emails');

// Every order bought in one payment shares payment_ref (the Paystack reference).
async function ordersFor(paymentRef) {
  const { data, error } = await db.from('orders').select('*').eq('payment_ref', paymentRef).order('reference');
  if (error) throw error;
  return data || [];
}

// Idempotent: safe to call from both the browser callback and the webhook.
// Returns the orders once paid, otherwise null.
async function markPaid(paymentRef, tx) {
  const orders = await ordersFor(paymentRef);
  if (!orders.length) return null;
  if (orders.every((o) => o.status === 'paid')) return orders;

  const total = orders.reduce((sum, o) => sum + o.amount_cents, 0);
  const ok = tx && tx.status === 'success' && tx.currency === 'ZAR' && Number(tx.amount) === total;
  if (!ok) {
    if (tx && tx.status === 'failed') {
      await db.from('orders').update({ status: 'failed' }).eq('payment_ref', paymentRef).eq('status', 'pending');
    }
    return null;
  }

  const { data: updated, error } = await db
    .from('orders')
    .update({ status: 'paid', paid_at: new Date().toISOString(), paystack_transaction_id: String(tx.id ?? '') })
    .eq('payment_ref', paymentRef)
    .eq('status', 'pending')
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

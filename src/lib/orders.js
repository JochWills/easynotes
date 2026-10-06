const db = require('./supabase');

// Idempotent: safe to call from both the browser callback and the webhook.
async function markPaid(reference, tx) {
  const { data: order, error } = await db.from('orders').select('*').eq('reference', reference).maybeSingle();
  if (error) throw error;
  if (!order) return null;
  if (order.status === 'paid') return order;

  const ok = tx && tx.status === 'success' && tx.currency === 'ZAR' && Number(tx.amount) === order.amount_cents;
  if (!ok) {
    if (tx && tx.status === 'failed') {
      await db.from('orders').update({ status: 'failed' }).eq('id', order.id).eq('status', 'pending');
    }
    return null;
  }

  const { data: updated, error: upErr } = await db
    .from('orders')
    .update({ status: 'paid', paid_at: new Date().toISOString(), paystack_transaction_id: String(tx.id ?? '') })
    .eq('id', order.id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (upErr) throw upErr;

  if (updated) {
    const { error: rpcErr } = await db.rpc('increment_note_sales', { p_note_id: order.note_id });
    if (rpcErr) console.error('[orders] sales count not incremented', rpcErr.message);
    return updated;
  }
  return { ...order, status: 'paid' };
}

module.exports = { markPaid };

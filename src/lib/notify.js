// Notifications for sellers: a red dot in the account menu and a list at /seller/notifications.
// Best-effort like the activity log: a notification that can't be saved (say the table hasn't been created
// yet, see supabase/schema.sql) never breaks the action it's about.
const db = require('./supabase');
const { rand } = require('./helpers');

async function add(sellerId, { kind, title, body = null, link = null }) {
  if (!sellerId) return;
  try {
    const { error } = await db.from('notifications').insert({ seller_id: sellerId, kind, title, body, link });
    if (error) console.error('[notify] not saved', kind, error.message);
  } catch (err) {
    console.error('[notify] not saved', kind, err.message);
  }
}

// How many the seller hasn't seen (0 if the table is missing).
async function unreadCount(sellerId) {
  const { count, error } = await db.from('notifications').select('id', { count: 'exact', head: true }).eq('seller_id', sellerId).is('read_at', null);
  return error ? 0 : count || 0;
}

// One notification per seller per payment (a cart can hold notes from several sellers).
async function sales(orders) {
  const bySeller = new Map();
  for (const o of orders) bySeller.set(o.seller_id, [...(bySeller.get(o.seller_id) || []), o]);
  const { data: notes } = await db.from('notes').select('id,title').in('id', orders.map((o) => o.note_id));
  const title = (id) => (notes || []).find((n) => n.id === id)?.title || 'Your notes';
  for (const [sellerId, list] of bySeller) {
    const earned = list.reduce((sum, o) => sum + (o.seller_earnings_cents || 0), 0);
    await add(sellerId, {
      kind: 'sale',
      title: list.length > 1 ? `You sold ${list.length} sets of notes` : 'You made a sale',
      body: `${list.map((o) => title(o.note_id)).join(', ')} · you earn ${rand(earned)}`,
      link: '/seller',
    });
  }
}

module.exports = { add, unreadCount, sales };

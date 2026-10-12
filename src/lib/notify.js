// Notifications for sellers: a red dot on the avatar, and on the menu and dashboard tab where the news is
// (a sale on the dashboard, a hidden note on Notes, ...). Opening that tab marks its notifications as seen.
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

// The dashboard tab each notification points to (the tab names in views/partials/seller-nav.ejs)
const TABS = { '/seller': 'overview', '/seller/notes': 'notes', '/seller/payouts': 'payouts', '/seller/verification': 'verification' };
const tabOf = (n) => (n.kind === 'review' ? 'storefront' : TABS[String(n.link || '').split('#')[0]] || 'overview');

// Middleware: sets res.locals.unreadTabs for the menu and the dashboard tabs. Opening a tab clears its dot
// (but not when the page is only being loaded ahead of a click).
async function dots(req, res, next) {
  res.locals.unreadTabs = {};
  if (!req.seller) return next();
  const path = req.path.replace(/\/+$/, '').toLowerCase() || '/';
  const looking = req.method === 'GET' && !/prefetch|prerender/i.test(req.get('sec-purpose') || '');
  const seeing = !looking ? null : Object.hasOwn(TABS, path) ? TABS[path] : path === '/' + String(req.seller.slug || '').toLowerCase() ? 'storefront' : null;
  res.locals.unreadTabs = await unreadTabs(req.seller.id, seeing);
  next();
}

// Which tabs have news the seller hasn't seen, as { notes: 1, ... } ({} if the table is missing).
// Being on a tab (`seeing`) marks its notifications as seen first, so its dot is gone on that page.
async function unreadTabs(sellerId, seeing) {
  const { data, error } = await db.from('notifications').select('id,kind,link').eq('seller_id', sellerId).is('read_at', null).limit(500);
  if (error || !data) return {};
  const seen = seeing ? data.filter((n) => tabOf(n) === seeing).map((n) => n.id) : [];
  if (seen.length) {
    const { error: markErr } = await db.from('notifications').update({ read_at: new Date().toISOString() }).in('id', seen).eq('seller_id', sellerId);
    if (markErr) console.error('[notify] not marked seen', markErr.message);
  }
  const tabs = {};
  for (const n of data) if (!seen.includes(n.id)) tabs[tabOf(n)] = (tabs[tabOf(n)] || 0) + 1;
  return tabs;
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

module.exports = { add, unreadTabs, dots, sales };

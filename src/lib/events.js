const db = require('./supabase');

// Activity log shown in the admin dashboard. Logging is best-effort: it never breaks the
// action being logged (for example if the events table hasn't been created yet).
async function log(kind, detail = {}, actor = null) {
  try {
    const { error } = await db.from('events').insert({ kind, detail, actor });
    if (error) console.error('[events] not logged', kind, error.message);
  } catch (err) {
    console.error('[events] not logged', kind, err.message);
  }
}

// Returns null if the table is missing, so pages can say so instead of failing.
async function recent({ limit = 20, kinds } = {}) {
  let q = db.from('events').select('*').order('created_at', { ascending: false }).limit(limit);
  if (kinds) q = q.in('kind', kinds);
  const { data, error } = await q;
  return error ? null : data;
}

// One page of the log, newest first: `before` is the id of the last item on the previous page.
// skip leaves out kinds (Paystack's webhook receipts, say); sellerId narrows it to things about one seller. Returns null if the table is missing.
async function page({ limit = 50, before, kinds, skip, sellerId } = {}) {
  let q = db.from('events').select('*').order('id', { ascending: false }).limit(limit);
  if (before) q = q.lt('id', before);
  if (kinds) q = q.in('kind', kinds);
  if (skip) q = q.not('kind', 'in', `(${skip.join(',')})`);
  if (sellerId) q = q.eq('detail->>seller_id', sellerId);
  const { data, error } = await q;
  return error ? null : data;
}

// Every event of these kinds, newest first, however many there are (Supabase sends at most 1000 rows a request).
// Returns null if the table is missing.
async function all({ kinds, columns = '*' }) {
  const out = [];
  for (let before = null; ; ) {
    let q = db.from('events').select(columns).in('kind', kinds).order('id', { ascending: false }).limit(1000);
    if (before !== null) q = q.lt('id', before);
    const { data, error } = await q;
    if (error && !out.length) return null;
    if (error) throw error; // part-way: a partial list would quietly leave things out
    out.push(...data);
    if (data.length < 1000) return out;
    before = data[data.length - 1].id;
  }
}

module.exports = { log, recent, page, all };

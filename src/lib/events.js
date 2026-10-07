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

module.exports = { log, recent };

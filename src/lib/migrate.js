// Keeps the database up to date: when the site starts and supabase/schema.sql has changed since it was last
// applied, it runs the file (all of it, in one go, so nothing is ever half done). The file only adds what's
// missing, so running it again is safe. Needs DATABASE_URL (Supabase > Connect > Session pooler); without it
// nothing happens and schema.sql can still be pasted into the SQL Editor by hand.
// Also: `npm run migrate` to run it now from your computer or Render's Shell.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', '..', 'supabase', 'schema.sql');

async function migrate({ force = false } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) return 'skipped (no DATABASE_URL)';
  const { Client } = require('pg');
  const sql = fs.readFileSync(FILE, 'utf8');
  const hash = crypto.createHash('sha256').update(sql).digest('hex');

  // Supabase's certificate is signed by its own authority, which Node doesn't know, so it isn't checked.
  // The connection is still encrypted.
  const client = new Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await client.connect();
  try {
    await client.query('create table if not exists schema_runs (hash text primary key, ran_at timestamptz not null default now())');
    await client.query('alter table schema_runs enable row level security');
    if (!force) {
      const { rowCount } = await client.query('select 1 from schema_runs where hash = $1', [hash]);
      if (rowCount) return 'up to date';
    }
    await client.query('begin');
    try {
      await client.query('select pg_advisory_xact_lock(7302215)'); // two copies of the site starting at once take turns
      await client.query(sql);
      await client.query('insert into schema_runs (hash) values ($1) on conflict (hash) do update set ran_at = now()', [hash]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    }
    return 'applied';
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { migrate };

if (require.main === module) {
  require('dotenv').config();
  migrate({ force: process.argv.includes('--force') })
    .then((result) => console.log('[schema]', result))
    .catch((err) => {
      console.error('[schema] failed:', err.message);
      process.exit(1);
    });
}

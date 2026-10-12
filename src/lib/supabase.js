const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

// Every call gives up after a while, so a stalled connection shows an error page instead of a page that
// loads forever. File uploads and downloads (up to 50 MB) get longer.
const QUERY_MS = 15000;
const STORAGE_MS = 120000;
// The time-out is reported as an abort: the client retries other failures (3 times, with pauses), which
// would turn one stalled call into a minute-long wait.
async function fetchWithTimeout(url, init = {}) {
  const limit = AbortSignal.timeout(String(url).includes('/storage/v1/') ? STORAGE_MS : QUERY_MS);
  try {
    return await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, limit]) : limit });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new DOMException('Supabase didn’t answer in time', 'AbortError');
    throw err;
  }
}

// Server-only client. The service role key bypasses RLS: never send it to the browser.
module.exports = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: fetchWithTimeout },
});

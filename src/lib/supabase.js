const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

// Server-only client. The service role key bypasses RLS: never send it to the browser.
module.exports = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

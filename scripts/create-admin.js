// Usage: npm run create-admin -- you@example.com "a-strong-password"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/lib/supabase');

(async () => {
  const [email, password] = process.argv.slice(2);
  if (!email || !password || password.length < 10) {
    console.error('Usage: npm run create-admin -- email "password (10+ characters)"');
    process.exit(1);
  }
  const password_hash = await bcrypt.hash(password, 12);
  const { error } = await db
    .from('users')
    .upsert({ email: email.toLowerCase(), password_hash, role: 'admin' }, { onConflict: 'email' });
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(`Admin ready: ${email.toLowerCase()}`);
})();

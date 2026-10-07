// Usage: npm run create-admin -- you@example.com ["a-strong-password"]
// Leave the password out to set a random one, then use "Forgot your password?" on the site to choose your own.
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../src/lib/supabase');

(async () => {
  const [email, given] = process.argv.slice(2);
  const password = given || crypto.randomBytes(24).toString('base64url');
  if (!email || password.length < 10) {
    console.error('Usage: npm run create-admin -- email ["password (10+ characters)"]');
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
  if (!given) console.log('A random password was set. Use “Forgot your password?” on the login page to choose your own.');
})();

// Signed, expiring tokens for emailed links. Each purpose gets its own key, so a token
// made for one kind of link can't be used as another.
const crypto = require('crypto');
const config = require('./config');

const keyFor = (purpose) => crypto.createHmac('sha256', config.sessionSecret).update(purpose).digest();
const sign = (purpose, payload) => crypto.createHmac('sha256', keyFor(purpose)).update(payload).digest('base64url');

function make(purpose, data, ttlMs) {
  const payload = Buffer.from(JSON.stringify({ ...data, x: Date.now() + ttlMs })).toString('base64url');
  return `${payload}.${sign(purpose, payload)}`;
}

// Returns the data (plus `expires`) for a valid, unexpired token, otherwise null.
function read(purpose, token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(purpose, payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { x, ...data } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!(x > Date.now())) return null;
    return { ...data, expires: new Date(x) };
  } catch {
    return null;
  }
}

module.exports = { make, read };

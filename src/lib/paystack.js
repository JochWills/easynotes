const crypto = require('crypto');
const config = require('./config');

const BASE = 'https://api.paystack.co';

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${config.paystackSecret}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) {
    const err = new Error(json.message || `Paystack request failed (${res.status})`);
    err.paystack = json;
    throw err;
  }
  return json.data;
}

let bankCache = null;
let bankCacheAt = 0;
async function listBanks() {
  if (bankCache && Date.now() - bankCacheAt < 6 * 60 * 60 * 1000) return bankCache;
  const data = await call('GET', '/bank?country=south%20africa&currency=ZAR&perPage=100');
  const seen = new Set();
  bankCache = data
    .filter((b) => b.active !== false && !b.is_deleted)
    .map((b) => ({ name: b.name, code: b.code }))
    .filter((b) => (seen.has(b.code) ? false : seen.add(b.code)))
    .sort((a, b) => a.name.localeCompare(b.name));
  bankCacheAt = Date.now();
  return bankCache;
}

const createSubaccount = (payload) => call('POST', '/subaccount', payload);
const updateSubaccount = (code, payload) => call('PUT', `/subaccount/${encodeURIComponent(code)}`, payload);
const initialize = (payload) => call('POST', '/transaction/initialize', payload);
const verify = (reference) => call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

function validSignature(rawBody, signature) {
  if (!signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha512', config.paystackSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { listBanks, createSubaccount, updateSubaccount, initialize, verify, validSignature };

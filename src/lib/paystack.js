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

// Settlements are Paystack's payouts. The list is filtered by the subaccount's numeric id, so look it up once.
const subaccountIds = new Map();
async function subaccountId(code) {
  if (!subaccountIds.has(code)) {
    const sub = await call('GET', `/subaccount/${encodeURIComponent(code)}`);
    subaccountIds.set(code, sub.id);
  }
  return subaccountIds.get(code);
}

const settlementCache = new Map(); // short cache so reloading the page doesn't hit Paystack every time
async function listSettlements(code) {
  const hit = settlementCache.get(code);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.list;
  const id = await subaccountId(code);
  const data = await call('GET', `/settlement?subaccount=${encodeURIComponent(id)}&perPage=100`);
  const list = (Array.isArray(data) ? data : []).map((s) => ({
    id: s.id,
    status: String(s.status || '').toLowerCase(),
    amount: Number(s.effective_amount ?? s.total_amount ?? s.total_processed ?? 0),
    fees: Number(s.total_fees || 0),
    date: s.settlement_date || s.settled_at || s.settledAt || s.createdAt || s.created_at || null,
  }));
  settlementCache.set(code, { at: Date.now(), list });
  return list;
}

function validSignature(rawBody, signature) {
  if (!signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha512', config.paystackSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { listBanks, createSubaccount, updateSubaccount, initialize, verify, listSettlements, validSignature };

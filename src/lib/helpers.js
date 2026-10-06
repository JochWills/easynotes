const config = require('./config');

const rand = (cents) => 'R' + (Number(cents || 0) / 100).toFixed(2).replace(/\.00$/, '');

const date = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'EN';

const slugify = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'notes';

const fileName = (title) => `${slugify(title)}.pdf`;
const noteUrl = (n) => `/note/${n.id}/${n.slug}`;
const storeUrl = (s) => `/${s.slug}`;

const maskEmail = (email = '') => {
  const [user, domain] = email.split('@');
  if (!domain) return email;
  return `${user.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, user.length - 2)))}@${domain}`;
};

const qs = (params) =>
  '?' +
  Object.entries(params)
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));

const str = (v, max) => String(v ?? '').trim().slice(0, max);

const feeFor = (priceCents) => Math.round((priceCents * config.platformFeePercent) / 100);

module.exports = { rand, date, initials, slugify, fileName, noteUrl, storeUrl, maskEmail, qs, isUuid, str, feeFor };

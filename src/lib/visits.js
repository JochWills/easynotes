// Visitor stats for Admin > Visitors: page views, where visitors came from, and how many add to cart, start
// checking out and pay. Anonymous and cookie-free: a visitor is a keyed hash of their IP address and browser that
// changes every day, so nobody can be followed from one day to the next and no IP address is stored.
// Rows are written in small batches; if the site_visits table isn't there yet, nothing is recorded.
const crypto = require('crypto');
const db = require('./supabase');
const config = require('./config');

const FLUSH_MS = 15 * 1000;
const FLUSH_AT = 100;
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|headless|lighthouse|curl|wget|python|axios|node-fetch|go-http/i;

// "2026-10-17" in South Africa
const saDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

const visitorId = (req) =>
  crypto.createHmac('sha256', config.sessionSecret).update(`visit:${saDay()}:${req.ip}:${req.get('user-agent') || ''}`).digest('base64url').slice(0, 16);

const deviceOf = (ua) => (/iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'phone' : 'computer');

// Where a visit came from, from the page that linked here (or ?utm_source=). null: from this site.
const SOURCES = [
  [/com\.google\.android\.gm|mail\.google\.com$/, 'Gmail'], // before Google
  [/(^|\.)google\./, 'Google'], [/(^|\.)bing\.com$/, 'Bing'], [/duckduckgo\.com$/, 'DuckDuckGo'], [/(^|\.)yahoo\./, 'Yahoo'],
  [/(^|\.)instagram\.com$|^ig$/, 'Instagram'], [/(^|\.)facebook\.com$|(^|\.)fb\.(com|me)$|^fb$/, 'Facebook'],
  [/^t\.co$|(^|\.)twitter\.com$|(^|\.)x\.com$/, 'X (Twitter)'], [/tiktok\.com$/, 'TikTok'], [/linkedin\.com$|^lnkd\.in$/, 'LinkedIn'],
  [/whatsapp/, 'WhatsApp'], [/youtube\.com$|^youtu\.be$/, 'YouTube'], [/reddit\.com$/, 'Reddit'], [/telegram|^t\.me$/, 'Telegram'],
  [/chatgpt\.com$|openai\.com$/, 'ChatGPT'], [/perplexity\.ai$/, 'Perplexity'],
];
function sourceOf(referrer, utm) {
  // ?utm_source=: a plain app name becomes its usual label; anything more specific ("whatsapp-ucc-group") is kept as written
  const name = String(utm || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (name) {
    const simple = name.toLowerCase();
    const known = /^[a-z]+$/.test(simple) && SOURCES.find(([re]) => re.test(simple) || re.test(simple + '.com'));
    return known ? known[1] : name;
  }
  let host;
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!host || host === new URL(config.baseUrl).hostname.replace(/^www\./, '')) return null;
  const known = SOURCES.find(([re]) => re.test(host));
  return known ? known[1] : host.slice(0, 80);
}

const NOTE_PATH = /^\/note\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/|$)/i;

let queue = [];
let timer = null;
let missingTable = false;

async function flush() {
  timer = null;
  if (!queue.length) return;
  const rows = queue;
  queue = [];
  const { error } = await db.from('site_visits').insert(rows);
  if (error && !missingTable) {
    missingTable = /site_visits/.test(error.message || '');
    console.error('[visits] not recorded', error.message);
  }
}

function add(row) {
  if (missingTable) return;
  queue.push(row);
  if (queue.length >= FLUSH_AT) flush().catch(() => {});
  else if (!timer) timer = setTimeout(() => flush().catch(() => {}), FLUSH_MS).unref();
}

// Visitors only: not bots, not sellers or admins looking at their own site.
const counts = (req) => !req.user && !BOTS.test(req.get('user-agent') || '');

// A step towards buying: 'cart_add', 'checkout' or 'paid'.
function record(req, kind, noteId = null) {
  if (!counts(req)) return;
  add({ day: saDay(), visitor: visitorId(req), kind, note_id: noteId, device: deviceOf(req.get('user-agent') || '') });
}

// A page view, sent by the page itself once it's actually shown (public/js/app.js), so pages loaded ahead on hover
// only count if they're opened.
function pageView(req) {
  if (!counts(req)) return;
  const path = String(req.body.p || '').slice(0, 200);
  if (!path.startsWith('/')) return;
  const m = NOTE_PATH.exec(path);
  add({
    day: saDay(),
    visitor: visitorId(req),
    kind: 'view',
    path: m ? `/note/${m[1].toLowerCase()}` : path,
    note_id: m ? m[1].toLowerCase() : null,
    source: sourceOf(String(req.body.r || '').slice(0, 500), req.body.s),
    device: deviceOf(req.get('user-agent') || ''),
  });
}

// Write what's waiting before the server stops (Render sends SIGTERM on a deploy).
process.once('SIGTERM', () => {
  flush().catch(() => {}).finally(() => process.exit(0));
});

module.exports = { record, pageView, sourceOf, deviceOf, saDay, flush };

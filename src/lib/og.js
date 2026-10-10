// Link-preview images (1200×630) shown when a page is shared on WhatsApp, Instagram, LinkedIn, X and so on.
// Drawn on the server with the same fonts and colours as the site.
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const W = 1200;
const H = 630;
const C = { ink: '#0E1A3A', soft: '#3B4766', muted: '#5F6B85', blue: '#1E5BD8', blueSoft: '#E6EEFC', page: '#F6F8FC', rule: '#E4E9F2', yellow: '#FFE27A', ok: '#14804A' };

const fontDir = path.join(__dirname, '..', '..', 'assets', 'fonts');
GlobalFonts.registerFromPath(path.join(fontDir, 'plus-jakarta-sans-latin-800-normal.woff2'), 'OG Display');
GlobalFonts.registerFromPath(path.join(fontDir, 'plus-jakarta-sans-latin-700-normal.woff2'), 'OG Display Bold');
GlobalFonts.registerFromPath(path.join(fontDir, 'inter-latin-500-normal.woff2'), 'OG Body');
GlobalFonts.registerFromPath(path.join(fontDir, 'inter-latin-600-normal.woff2'), 'OG Body Bold');
const F = {
  display: (px) => `${px}px "OG Display"`,
  displayBold: (px) => `${px}px "OG Display Bold"`,
  body: (px) => `${px}px "OG Body"`,
  bodyBold: (px) => `${px}px "OG Body Bold"`,
};

// Splits text into at most maxLines lines that fit maxWidth, ending in … if it had to cut.
function wrap(ctx, text, maxWidth, maxLines) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(next).width <= maxWidth) { line = next; continue; }
    if (line) lines.push(line);
    line = words[i];
    if (lines.length === maxLines) { line = ''; break; }
  }
  if (line) lines.push(line);
  const cut = lines.length > maxLines || lines.join(' ').split(/\s+/).length < words.length;
  const out = lines.slice(0, maxLines);
  if (cut && out.length) {
    let last = out[out.length - 1];
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    out[out.length - 1] = last.replace(/[\s,.:;–-]+$/, '') + '…';
  }
  // A single word wider than the box is shrunk to fit with …
  return out.map((l) => {
    let s = l;
    while (ctx.measureText(s).width > maxWidth && s.length > 1) s = s.slice(0, -2) + '…';
    return s;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// The EasyNotes logo: the favicon's page icon plus the wordmark.
function logo(ctx, x, y, size = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size * 1.5, size * 1.5);
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = C.ink;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(5, 2); ctx.lineTo(21, 2); ctx.lineTo(28, 9); ctx.lineTo(28, 30); ctx.lineTo(5, 30); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(21, 2); ctx.lineTo(21, 9); ctx.lineTo(28, 9); ctx.stroke();
  ctx.fillStyle = C.yellow; roundRect(ctx, 8.5, 13, 15, 6, 1); ctx.fill();
  ctx.beginPath(); ctx.moveTo(9, 16); ctx.lineTo(23, 16); ctx.moveTo(9, 23.5); ctx.lineTo(19, 23.5); ctx.stroke();
  ctx.restore();
  ctx.font = F.display(38 * size);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = C.ink;
  const wx = x + 58 * size;
  const wy = y + 25 * size;
  ctx.fillText('Easy', wx, wy);
  ctx.fillStyle = C.blue;
  ctx.fillText('Notes', wx + ctx.measureText('Easy').width, wy);
  ctx.textBaseline = 'alphabetic';
}

function tick(ctx, cx, cy, r) {
  ctx.fillStyle = C.ok;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = r * 0.28; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(cx - r * 0.42, cy + r * 0.02); ctx.lineTo(cx - r * 0.1, cy + r * 0.34); ctx.lineTo(cx + r * 0.45, cy - r * 0.3); ctx.stroke();
}

function star(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

function pill(ctx, text, x, y, { font, bg, fg, padX = 18, h = 44 }) {
  ctx.font = font;
  const w = ctx.measureText(text).width + padX * 2;
  ctx.fillStyle = bg; roundRect(ctx, x, y, w, h, h / 2); ctx.fill();
  ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.fillText(text, x + padX, y + h / 2 + 1); ctx.textBaseline = 'alphabetic';
  return w;
}

function base() {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.page; ctx.fillRect(0, 0, W, H);
  // soft blue glow in the corner, like the site's hero
  const g = ctx.createRadialGradient(W, 0, 0, W, 0, 700);
  g.addColorStop(0, 'rgba(30,91,216,0.16)'); g.addColorStop(1, 'rgba(30,91,216,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.blue; ctx.fillRect(0, H - 12, W, 12);
  return { canvas, ctx };
}

async function tryImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

const png = (canvas) => canvas.encode('png');

/* ---------- A note ---------- */

// note: { title, module_code, price, sellerName, verified, institution, pages, previewUrl }
async function noteCard(note) {
  const { canvas, ctx } = base();
  const page = await tryImage(note.previewUrl);
  const textW = page ? 640 : 1040;

  logo(ctx, 72, 60);

  let y = 152;
  if (note.module_code) {
    pill(ctx, note.module_code, 72, y, { font: F.bodyBold(24), bg: C.yellow, fg: C.ink, h: 44 });
    y += 72;
  } else {
    y += 20;
  }

  ctx.fillStyle = C.ink;
  // Smaller type for longer titles so the title, seller and price always fit
  let size = 64;
  ctx.font = F.display(size);
  let lines = wrap(ctx, note.title, textW, 3);
  if (lines.length > 2) { size = 48; ctx.font = F.display(size); lines = wrap(ctx, note.title, textW, 3); }
  for (const l of lines) { y += size * 1.0; ctx.fillText(l, 72, y); y += size * 0.16; }

  y += 56;
  ctx.font = F.body(28);
  ctx.fillStyle = C.soft;
  const by = 'by ';
  ctx.fillText(by, 72, y);
  let x = 72 + ctx.measureText(by).width;
  ctx.font = F.bodyBold(28);
  ctx.fillStyle = C.ink;
  const name = wrap(ctx, note.sellerName, textW - 120, 1)[0];
  ctx.fillText(name, x, y);
  x += ctx.measureText(name).width;
  if (note.verified) tick(ctx, x + 22, y - 9, 13);

  // price and facts along the bottom
  const by2 = H - 46;
  const pw = pill(ctx, note.price, 72, by2 - 64, { font: F.display(36), bg: C.blue, fg: '#fff', padX: 26, h: 68 });
  ctx.font = F.body(24);
  ctx.fillStyle = C.muted;
  const facts = ['Instant PDF download', note.pages ? `${note.pages} pages` : ''].filter(Boolean).join(' · ');
  ctx.fillText(wrap(ctx, facts, textW - pw - 30, 1)[0] || '', 72 + pw + 26, by2 - 22);

  if (page) {
    // first page of the free preview, tilted slightly, with the bottom faded out
    const pw2 = 400;
    const ph = Math.min(560, (page.height / page.width) * pw2);
    ctx.save();
    ctx.translate(990, 330);
    ctx.rotate(0.035);
    ctx.shadowColor = 'rgba(14,26,58,0.22)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
    ctx.fillStyle = '#fff'; roundRect(ctx, -pw2 / 2, -ph / 2 + 40, pw2, ph, 10); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.save(); roundRect(ctx, -pw2 / 2, -ph / 2 + 40, pw2, ph, 10); ctx.clip();
    ctx.drawImage(page, 0, 0, page.width, Math.min(page.height, (ph / pw2) * page.width), -pw2 / 2, -ph / 2 + 40, pw2, ph);
    const fade = ctx.createLinearGradient(0, ph / 2 - 120, 0, ph / 2 + 40);
    fade.addColorStop(0, 'rgba(255,255,255,0)'); fade.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = fade; ctx.fillRect(-pw2 / 2, ph / 2 - 120, pw2, 160);
    ctx.restore();
    ctx.restore();
  }
  return png(canvas);
}

/* ---------- A storefront ---------- */

// store: { name, verified, degree, institution, headline, notes, rating, ratingCount, avatarUrl }
async function storeCard(store) {
  const { canvas, ctx } = base();
  logo(ctx, 72, 60);

  const av = await tryImage(store.avatarUrl);
  const cx = 72 + 90;
  const cy = 300;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, 90, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = C.blueSoft; ctx.fill(); ctx.clip();
  if (av) {
    const s = Math.min(av.width, av.height);
    ctx.drawImage(av, (av.width - s) / 2, (av.height - s) / 2, s, s, cx - 90, cy - 90, 180, 180);
  } else {
    ctx.fillStyle = C.blue; ctx.font = F.display(64); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ini = String(store.name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    ctx.fillText(ini, cx, cy + 3);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  const x = 72 + 180 + 44;
  const w = W - x - 72;
  let size = 60;
  ctx.font = F.display(size);
  let lines = wrap(ctx, store.name, w, 2);
  if (lines.length > 1) { size = 50; ctx.font = F.display(size); lines = wrap(ctx, store.name, w, 2); }
  let y = 250 - (lines.length - 1) * size * 0.55;
  ctx.fillStyle = C.ink;
  for (const l of lines) { ctx.fillText(l, x, y); y += size * 1.08; }

  if (store.verified) {
    tick(ctx, x + 14, y - 8, 14);
    ctx.font = F.bodyBold(26); ctx.fillStyle = C.ok; ctx.fillText('Verified academic', x + 38, y);
    y += 46;
  }
  const edu = [store.degree, store.institution].filter(Boolean).join(', ');
  if (edu) {
    ctx.font = F.body(28); ctx.fillStyle = C.soft;
    for (const l of wrap(ctx, edu, w, 2)) { ctx.fillText(l, x, y); y += 38; }
  }

  // notes count and rating along the bottom
  let bx = 72;
  const byy = H - 70 - 60;
  if (store.notes) bx += pill(ctx, `${store.notes} ${store.notes === 1 ? 'set of notes' : 'sets of notes'}`, bx, byy, { font: F.bodyBold(26), bg: '#fff', fg: C.ink, h: 60, padX: 24 }) + 16;
  if (store.ratingCount) {
    const label = `      ${store.rating.toFixed(1)}  ·  ${store.ratingCount} ${store.ratingCount === 1 ? 'review' : 'reviews'}`;
    pill(ctx, label, bx, byy, { font: F.bodyBold(26), bg: '#FFF4CC', fg: '#7A5A00', h: 60, padX: 24 });
    star(ctx, bx + 40, byy + 30, 15, '#E3A008');
  }
  return png(canvas);
}

/* ---------- Everything else ---------- */

async function siteCard() {
  const { canvas, ctx } = base();
  logo(ctx, 72, 60, 1.2);
  ctx.fillStyle = C.ink;
  ctx.font = F.display(76);
  let y = 270;
  for (const l of ['Study notes from students', 'who already passed.']) { ctx.fillText(l, 72, y); y += 88; }
  ctx.font = F.body(32);
  ctx.fillStyle = C.soft;
  ctx.fillText('Verified South African graduates. Free preview, instant PDF download.', 72, y + 22);
  ctx.font = F.bodyBold(28);
  ctx.fillStyle = C.blue;
  ctx.fillText('easynotes.co.za', 72, H - 70);
  return png(canvas);
}

module.exports = { noteCard, storeCard, siteCard, W, H };

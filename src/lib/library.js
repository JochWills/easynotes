// Signed "your notes" links: /library?t=... lists every paid purchase for one email.
const crypto = require('crypto');
const config = require('./config');
const db = require('./supabase');
const mail = require('./mailer');

const LINK_DAYS = 7;
const key = crypto.createHmac('sha256', config.sessionSecret).update('library-link').digest();
const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

function libraryUrl(email) {
  const payload = Buffer.from(JSON.stringify({ e: email, x: Date.now() + LINK_DAYS * 86400000 })).toString('base64url');
  return `${config.baseUrl}/library?t=${payload}.${sign(payload)}`;
}

// Returns { email, expires } for a valid, unexpired token, otherwise null.
function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof e !== 'string' || !(x > Date.now())) return null;
    return { email: e, expires: new Date(x) };
  } catch {
    return null;
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function sendLibraryLink(email, noteTitle) {
  const url = libraryUrl(email);
  const intro = noteTitle
    ? `Thanks for your purchase. <strong>${esc(noteTitle)}</strong> is ready to download.`
    : 'Here’s your link to download the notes you’ve bought on EasyNotes.';
  const html = `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#14213D;max-width:520px">
  <p>${intro}</p>
  <p><a href="${url}" style="display:inline-block;background:#FFE45C;color:#14213D;border:2px solid #14213D;border-radius:8px;padding:10px 20px;font-weight:bold;text-decoration:none">Download your notes</a></p>
  <p style="font-size:14px;color:#5A6882">This link shows every purchase made with ${esc(email)} and works for ${LINK_DAYS} days. Need a new one? Enter your email at ${esc(config.baseUrl)}/download.</p>
  <p style="font-size:14px;color:#5A6882">Questions? Reply to this email or write to ${esc(config.supportEmail)}.</p>
</div>`;
  const text = `${noteTitle ? `Thanks for your purchase. "${noteTitle}" is ready to download.` : 'Here’s your link to download the notes you’ve bought on EasyNotes.'}

Download your notes: ${url}

This link shows every purchase made with ${email} and works for ${LINK_DAYS} days. Need a new one? Enter your email at ${config.baseUrl}/download.`;
  return mail.send({ to: email, subject: noteTitle ? `Your notes are ready: ${noteTitle}` : 'Your EasyNotes download link', html, text });
}

async function sendPurchaseEmail(order) {
  const { data: note } = await db.from('notes').select('title').eq('id', order.note_id).maybeSingle();
  return sendLibraryLink(order.email, note?.title || 'Your notes');
}

module.exports = { LINK_DAYS, libraryUrl, readToken, sendLibraryLink, sendPurchaseEmail };

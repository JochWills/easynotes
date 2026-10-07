// Every email the site sends. All go out from MAIL_FROM (the noreply address) via mailer.js;
// replies go to SUPPORT_EMAIL.
const config = require('./config');
const db = require('./supabase');
const mail = require('./mailer');
const tokens = require('./tokens');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// One layout for all emails: heading, paragraphs, one button, small print.
function compose({ heading, paragraphs, button, small = [] }) {
  const p = (t, extra = '') => `<p style="margin:0 0 16px;${extra}">${t}</p>`;
  const html = `<div style="background:#F6F8FC;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E4E9F2;border-radius:14px;padding:32px 28px;color:#0E1A3A;font-size:16px;line-height:1.55">
    <p style="margin:0 0 24px;font-weight:bold;font-size:20px;letter-spacing:-0.5px">Easy<span style="color:#1E5BD8">Notes</span></p>
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.25">${esc(heading)}</h1>
    ${paragraphs.map((t) => p(t)).join('\n    ')}
    ${button ? `<p style="margin:24px 0"><a href="${button.url}" style="display:inline-block;background:#1E5BD8;color:#fff;border-radius:10px;padding:12px 22px;font-weight:bold;text-decoration:none">${esc(button.label)}</a></p>` : ''}
    ${small.map((t) => p(t, 'font-size:14px;color:#5F6B85')).join('\n    ')}
    <p style="margin:24px 0 0;font-size:13px;color:#8390A8">Questions? Reply to this email or write to ${esc(config.supportEmail)}.</p>
  </div>
</div>`;
  const strip = (t) => t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const text = [heading, '', ...paragraphs.map(strip), ...(button ? ['', `${button.label}: ${button.url}`] : []), '', ...small.map(strip)].join('\n');
  return { html, text };
}

/* ---------- Buyers: link to every purchase ---------- */

const LIBRARY_DAYS = 7;
const libraryUrl = (email) => `${config.baseUrl}/library?t=${tokens.make('library-link', { e: email }, LIBRARY_DAYS * 86400000)}`;

function readLibraryToken(token) {
  const t = tokens.read('library-link', token);
  return t && typeof t.e === 'string' ? { email: t.e, expires: t.expires } : null;
}

async function sendLibraryLink(email, noteTitle) {
  const { html, text } = compose({
    heading: noteTitle ? 'Your notes are ready' : 'Your download link',
    paragraphs: [
      noteTitle
        ? `Thanks for your purchase. <strong>${esc(noteTitle)}</strong> is ready to download.`
        : 'Here’s your link to download the notes you’ve bought on EasyNotes.',
    ],
    button: { url: libraryUrl(email), label: 'Download your notes' },
    small: [`This link shows every purchase made with ${esc(email)} and works for ${LIBRARY_DAYS} days. Need a new one? Enter your email at ${esc(config.baseUrl)}/download.`],
  });
  return mail.send({ to: email, subject: noteTitle ? `Your notes are ready: ${noteTitle}` : 'Your EasyNotes download link', html, text });
}

async function sendPurchaseEmail(order) {
  const { data: note } = await db.from('notes').select('title').eq('id', order.note_id).maybeSingle();
  return sendLibraryLink(order.email, note?.title || 'Your notes');
}

/* ---------- Sellers and admins: password reset ---------- */

const RESET_MINUTES = 60;
// The token carries a piece of the current password hash, so it stops working once the password changes.
const hashTag = (passwordHash) => String(passwordHash).slice(-12);

const resetUrl = (user, minutes) =>
  `${config.baseUrl}/reset?t=${tokens.make('password-reset', { u: user.id, h: hashTag(user.password_hash) }, minutes * 60000)}`;

async function sendPasswordReset(user) {
  const { html, text } = compose({
    heading: 'Reset your password',
    paragraphs: ['Someone (hopefully you) asked to reset the password for your EasyNotes account.'],
    button: { url: resetUrl(user, RESET_MINUTES), label: 'Choose a new password' },
    small: [`This link works once and expires in ${RESET_MINUTES} minutes. If you didn’t ask for this, ignore this email and your password stays the same.`],
  });
  return mail.send({ to: user.email, subject: 'Reset your EasyNotes password', html, text });
}

const INVITE_HOURS = 24;

async function sendAdminInvite(user, invitedBy) {
  const { html, text } = compose({
    heading: 'You’re now an EasyNotes admin',
    paragraphs: [`${esc(invitedBy)} added you as an admin on EasyNotes. Choose a password to log in to the admin dashboard.`],
    button: { url: resetUrl(user, INVITE_HOURS * 60), label: 'Choose your password' },
    small: [`This link works once and expires in ${INVITE_HOURS} hours. After that, use “Forgot your password?” on the login page.`],
  });
  return mail.send({ to: user.email, subject: 'You’ve been added as an EasyNotes admin', html, text });
}

async function sendTestEmail(to) {
  const { html, text } = compose({
    heading: 'Test email',
    paragraphs: ['If you can read this, EasyNotes emails are working.', `Sent from ${esc(config.mailFrom)} at ${new Date().toUTCString()}.`],
  });
  return mail.send({ to, subject: 'EasyNotes test email', html, text });
}

// Returns the user for a valid reset token, otherwise null.
async function readResetToken(token) {
  const t = tokens.read('password-reset', token);
  if (!t || typeof t.u !== 'string') return null;
  const { data: user } = await db.from('users').select('id,email,role,password_hash').eq('id', t.u).maybeSingle();
  if (!user || hashTag(user.password_hash) !== t.h) return null;
  return user;
}

/* ---------- Verification ---------- */

async function sendVerificationDecision(sellerId) {
  const { data: s } = await db.from('sellers').select('display_name,verification_status,verification_note,paystack_subaccount_code,users(email)').eq('id', sellerId).maybeSingle();
  if (!s || !s.users) return false;
  const approved = s.verification_status === 'approved';
  const { html, text } = approved
    ? compose({
        heading: 'You’re verified',
        paragraphs: [
          `Good news, ${esc(s.display_name)}: we’ve checked your documents and your seller account is approved.`,
          s.paystack_subaccount_code
            ? 'Your published notes are now live for students.'
            : 'One step left: add your bank details so Paystack can pay you. Your notes go live once that’s done.',
        ],
        button: { url: `${config.baseUrl}/seller${s.paystack_subaccount_code ? '' : '/payouts'}`, label: s.paystack_subaccount_code ? 'Go to your dashboard' : 'Add payout details' },
      })
    : compose({
        heading: 'We couldn’t verify your account yet',
        paragraphs: [
          `Hi ${esc(s.display_name)}, we reviewed your documents but couldn’t approve them. Here’s why:`,
          `<em>${esc(s.verification_note || 'No reason given.')}</em>`,
          'Fix this and send your documents again. We’ll review them as soon as they arrive.',
        ],
        button: { url: `${config.baseUrl}/seller/verification`, label: 'Update your documents' },
      });
  return mail.send({ to: s.users.email, subject: approved ? 'You’re verified on EasyNotes' : 'Your EasyNotes verification needs another look', html, text });
}

module.exports = {
  LIBRARY_DAYS, libraryUrl, readLibraryToken, sendLibraryLink, sendPurchaseEmail,
  RESET_MINUTES, sendPasswordReset, readResetToken, sendAdminInvite, sendTestEmail,
  sendVerificationDecision,
};

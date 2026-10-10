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

// noteTitle: what was just bought (omit for a plain "here's your link"); count > 1 for cart purchases.
async function sendLibraryLink(email, noteTitle, count = 1, name = '') {
  const first = String(name || '').trim().split(' ')[0];
  const intro = count > 1
    ? `Thanks for your purchase. Your <strong>${count} sets of notes</strong> are ready to download.`
    : noteTitle
      ? `Thanks for your purchase. <strong>${esc(noteTitle)}</strong> is ready to download.`
      : 'Here’s your link to download the notes you’ve bought on EasyNotes.';
  const { html, text } = compose({
    heading: noteTitle || count > 1 ? 'Your notes are ready' : 'Your download link',
    paragraphs: first ? [`Hi ${esc(first)},`, intro] : [intro],
    button: { url: libraryUrl(email), label: 'Download your notes' },
    small: [`This link shows every purchase made with ${esc(email)} and works for ${LIBRARY_DAYS} days. Need a new one? Enter your email at ${esc(config.baseUrl)}/download.`],
  });
  const subject = count > 1 ? `Your ${count} sets of notes are ready` : noteTitle ? `Your notes are ready: ${noteTitle}` : 'Your EasyNotes download link';
  return mail.send({ to: email, subject, html, text });
}

// One email per payment, however many notes were in it.
async function sendPurchaseEmail(orders) {
  orders = [].concat(orders);
  if (!orders.length) return false;
  const name = orders[0].buyer_name;
  if (orders.length > 1) return sendLibraryLink(orders[0].email, null, orders.length, name);
  const { data: note } = await db.from('notes').select('title').eq('id', orders[0].note_id).maybeSingle();
  return sendLibraryLink(orders[0].email, note?.title || 'Your notes', 1, name);
}

/* ---------- Sellers: you made a sale ---------- */

const rands = (cents) => 'R' + (cents / 100).toFixed(2);

// One email per seller per payment (a cart can hold notes from several sellers).
async function sendSaleEmails(orders) {
  const bySeller = new Map();
  for (const o of [].concat(orders)) bySeller.set(o.seller_id, [...(bySeller.get(o.seller_id) || []), o]);
  for (const [sellerId, list] of bySeller) {
    try {
      const [{ data: s }, { data: notes }] = await Promise.all([
        db.from('sellers').select('*,users(email)').eq('id', sellerId).maybeSingle(),
        db.from('notes').select('id,title').in('id', list.map((o) => o.note_id)),
      ]);
      if (!s || !s.users || s.notify_sales === false) continue; // switched off in Settings
      const title = (id) => (notes || []).find((n) => n.id === id)?.title || 'Your notes';
      const first = String(s.full_name || s.display_name || '').trim().split(' ')[0];
      const earned = list.reduce((sum, o) => sum + o.seller_earnings_cents, 0);
      const items = list.map((o) => `<strong>${esc(title(o.note_id))}</strong> · you earn ${rands(o.seller_earnings_cents)}`);
      const { html, text } = compose({
        heading: list.length > 1 ? `You sold ${list.length} sets of notes` : 'You made a sale',
        paragraphs: [
          `Hi ${esc(first)}, a student just bought ${list.length > 1 ? 'these notes' : 'your notes'}:`,
          items.join('<br>\n'),
          `Your share of <strong>${rands(earned)}</strong> is paid straight to your bank account, usually the next working day.`,
        ],
        button: { url: `${config.baseUrl}/seller`, label: 'See your sales' },
        small: ['Tip: buyers who loved your notes are your best advertising. Share your review link from your storefront’s Reviews tab.'],
      });
      const subject = list.length > 1 ? `You sold ${list.length} sets of notes (${rands(earned)})` : `You made a sale: ${title(list[0].note_id)} (${rands(earned)})`;
      await mail.send({ to: s.users.email, subject, html, text });
    } catch (err) {
      console.error('[emails] sale email not sent', err.message);
    }
  }
}

// Confirms a seller deleted their account. Sent to the address they used, which we no longer keep.
async function sendAccountDeleted(email, name, hadSales) {
  const first = String(name || '').trim().split(' ')[0];
  const { html, text } = compose({
    heading: 'Your account is deleted',
    paragraphs: [
      `Hi ${esc(first)}, as you asked, we’ve deleted your EasyNotes seller account. Your storefront, profile, documents and unsold notes are gone.`,
      hadSales
        ? 'Students who bought your notes can still download them, and we keep a record of those sales as the law requires. Money from recent sales is still paid to your bank account as usual.'
        : '',
      'Thanks for being part of EasyNotes. You’re welcome back any time.',
    ].filter(Boolean),
    small: ['Didn’t do this? Reply to this email straight away.'],
  });
  return mail.send({ to: email, subject: 'Your EasyNotes account is deleted', html, text });
}

/* ---------- Sellers: changing their login email ---------- */

const EMAIL_CHANGE_HOURS = 24;

// The link goes to the new address, so the change only happens once they've shown they can read it.
async function sendEmailChangeLink(user, newEmail, name) {
  const t = tokens.make('email-change', { u: user.id, from: user.email, to: newEmail }, EMAIL_CHANGE_HOURS * 3600000);
  const first = String(name || '').trim().split(' ')[0];
  const { html, text } = compose({
    heading: 'Confirm your new email',
    paragraphs: [`Hi ${esc(first)}, you asked to log in to EasyNotes with this email address from now on. Confirm it’s yours to make the switch.`],
    button: { url: `${config.baseUrl}/confirm-email?t=${t}`, label: 'Confirm new email' },
    small: [`This link works for ${EMAIL_CHANGE_HOURS} hours. Until you confirm, you keep logging in with ${esc(user.email)}. Didn’t ask for this? Ignore this email.`],
  });
  return mail.send({ to: newEmail, subject: 'Confirm your new EasyNotes email', html, text });
}

function readEmailChangeToken(token) {
  const t = tokens.read('email-change', token);
  return t && t.u && t.from && t.to ? t : null;
}

// Heads-up to the old address once the change is made.
async function sendEmailChangedNotice(oldEmail, newEmail, name) {
  const first = String(name || '').trim().split(' ')[0];
  const { html, text } = compose({
    heading: 'Your login email changed',
    paragraphs: [`Hi ${esc(first)}, your EasyNotes account now logs in with <strong>${esc(newEmail)}</strong>. Emails about sales and reviews go there too.`],
    small: ['Didn’t do this? Reply to this email straight away and we’ll lock the account.'],
  });
  return mail.send({ to: oldEmail, subject: 'Your EasyNotes login email changed', html, text });
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
  const { data: s } = await db.from('sellers').select('*, users(email)').eq('id', sellerId).maybeSingle();
  if (!s || !s.users) return false;
  const approved = s.verification_status === 'approved';
  const first = String(s.full_name || s.display_name || '').trim().split(' ')[0];
  const { html, text } = approved
    ? compose({
        heading: 'You’re verified',
        paragraphs: [
          `Good news, ${esc(first)}: we’ve checked your documents and your seller account is approved.`,
          s.paystack_subaccount_code
            ? 'Your published notes are now live for students.'
            : 'One step left: add your bank details so we can pay you. Your notes go live once that’s done.',
        ],
        button: { url: `${config.baseUrl}/seller${s.paystack_subaccount_code ? '' : '/payouts'}`, label: s.paystack_subaccount_code ? 'Go to your dashboard' : 'Add payout details' },
      })
    : compose({
        heading: 'We couldn’t verify your account yet',
        paragraphs: [
          `Hi ${esc(first)}, we reviewed your documents but couldn’t approve them. Here’s why:`,
          `<em>${esc(s.verification_note || 'No reason given.')}</em>`,
          'Fix this and send your documents again. We’ll review them as soon as they arrive.',
        ],
        button: { url: `${config.baseUrl}/seller/verification`, label: 'Update your documents' },
      });
  return mail.send({ to: s.users.email, subject: approved ? 'You’re verified on EasyNotes' : 'Your EasyNotes verification needs another look', html, text });
}

/* ---------- Reports about notes ---------- */

const REPORT_REASONS = {
  copyright_mine: 'I own the copyright (takedown request)',
  copyright_other: 'Contains someone else’s material (slides, textbook, past papers)',
  wrong: 'Doesn’t match its description, or the file is broken',
  offensive: 'Offensive or inappropriate',
  other: 'Something else',
};

// Goes to the support inbox; replying answers the person who reported.
async function sendReportNotice(report) {
  const { html, text } = compose({
    heading: report.reason === 'copyright_mine' ? 'Copyright takedown request' : 'Notes reported',
    paragraphs: [
      `<strong>${esc(report.title)}</strong> was reported: ${esc(REPORT_REASONS[report.reason] || report.reason)}.`,
      `From: ${esc(report.name || 'No name given')} &lt;${esc(report.email)}&gt;`,
      `<em>${esc(report.details).replace(/\n/g, '<br>')}</em>`,
      report.reason === 'copyright_mine' ? 'We said we’d act within 2 working days. Remove the notes from Admin → Reports while you look into it.' : 'Review it in Admin → Reports.',
    ],
    button: { url: `${config.baseUrl}/admin/reports`, label: 'Open Admin → Reports' },
  });
  return mail.send({ to: config.supportEmail, replyTo: report.email, subject: `${report.reason === 'copyright_mine' ? 'Takedown request' : 'Report'}: ${report.title}`, html, text });
}

async function sendReportReceipt(report) {
  const { html, text } = compose({
    heading: 'We’ve received your report',
    paragraphs: [
      `Thanks for telling us about <strong>${esc(report.title)}</strong>.`,
      report.reason === 'copyright_mine'
        ? 'We’ll review your takedown request and act within 2 working days. If we need more information we’ll reply to this email.'
        : 'We’ll look into it. If we need more information we’ll reply to this email.',
    ],
  });
  return mail.send({ to: report.email, subject: 'We’ve received your report', html, text });
}

// Tells a seller someone reviewed their storefront.
async function sendNewReview(sellerId, review) {
  const { data: s } = await db.from('sellers').select('*,users(email)').eq('id', sellerId).maybeSingle();
  if (!s || !s.users || s.notify_reviews === false) return false; // switched off in Settings
  const first = String(s.full_name || s.display_name || '').trim().split(' ')[0];
  const stars = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
  const { html, text } = compose({
    heading: 'You have a new review',
    paragraphs: [
      `Hi ${esc(first)}, ${esc(review.reviewer_name || 'a buyer')} reviewed your storefront: <strong>${stars}</strong>`,
      review.body ? `<em>“${esc(review.body)}”</em>` : '',
      'If a review breaks our rules, reply to this email and we’ll take a look.',
    ].filter(Boolean),
    button: { url: `${config.baseUrl}/${s.slug}#reviews`, label: 'See your reviews' },
  });
  return mail.send({ to: s.users.email, subject: `New ${review.rating}-star review on EasyNotes`, html, text });
}

// Sent once the expected finish month of something a seller is still studying has passed.
async function sendStudyReminder(qualId) {
  const { data: q } = await db.from('qualifications').select('id,name,sellers(display_name,full_name,users(email))').eq('id', qualId).maybeSingle();
  const s = q && q.sellers;
  if (!s || !s.users) return false;
  const first = String(s.full_name || s.display_name || '').trim().split(' ')[0];
  const { html, text } = compose({
    heading: 'Have you finished?',
    paragraphs: [
      `Hi ${esc(first)}, you told us you expected to finish <strong>${esc(q.name)}</strong> by now. Congratulations if you have!`,
      'Upload your certificate or final academic record and we’ll update your storefront, including any distinction you earned. Still studying? Update your expected finish date so your storefront stays current.',
    ],
    button: { url: `${config.baseUrl}/seller/verification`, label: 'Update your education' },
  });
  return mail.send({ to: s.users.email, subject: `Finished ${q.name}? Update your EasyNotes storefront`, html, text });
}

// A verified seller's added or finished education was approved or not.
async function sendQualificationDecision(qualId) {
  const { data: q } = await db.from('qualifications').select('name,review_status,review_note,sellers(display_name,full_name,users(email))').eq('id', qualId).maybeSingle();
  const s = q && q.sellers;
  if (!s || !s.users) return false;
  const first = String(s.full_name || s.display_name || '').trim().split(' ')[0];
  const approved = q.review_status === 'approved';
  const { html, text } = approved
    ? compose({
        heading: 'Your education is verified',
        paragraphs: [`Hi ${esc(first)}, we’ve checked your documents and <strong>${esc(q.name)}</strong> now shows on your storefront.`],
        button: { url: `${config.baseUrl}/seller/verification`, label: 'See your education' },
      })
    : compose({
        heading: 'We couldn’t verify this yet',
        paragraphs: [
          `Hi ${esc(first)}, we reviewed <strong>${esc(q.name)}</strong> but couldn’t approve it. Here’s why:`,
          `<em>${esc(q.review_note || 'No reason given.')}</em>`,
          'Your storefront hasn’t changed. Fix this and send it again whenever you’re ready.',
        ],
        button: { url: `${config.baseUrl}/seller/verification`, label: 'Update your education' },
      });
  return mail.send({ to: s.users.email, subject: approved ? `${q.name} is verified on EasyNotes` : 'Your EasyNotes education update needs another look', html, text });
}

module.exports = {
  sendNewReview,
  sendStudyReminder,
  sendQualificationDecision,
  REPORT_REASONS, sendReportNotice, sendReportReceipt,
  sendAccountDeleted, EMAIL_CHANGE_HOURS, sendEmailChangeLink, readEmailChangeToken, sendEmailChangedNotice,
  LIBRARY_DAYS, libraryUrl, readLibraryToken, sendLibraryLink, sendPurchaseEmail, sendSaleEmails,
  RESET_MINUTES, sendPasswordReset, readResetToken, sendAdminInvite, sendTestEmail,
  sendVerificationDecision,
};

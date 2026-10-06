const config = require('./config');
const { maskEmail } = require('./helpers');

// Sends through Resend's HTTP API (Render's free plan blocks SMTP). Without RESEND_API_KEY emails are skipped.
async function send({ to, subject, html, text }) {
  if (!config.resendApiKey) {
    console.log(`[mail] RESEND_API_KEY not set, skipped "${subject}" to ${maskEmail(to)}`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mailFrom, to: [to], reply_to: config.supportEmail, subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return true;
}

module.exports = { send };

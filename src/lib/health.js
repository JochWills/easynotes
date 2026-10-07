// Live checks for the admin Health tab. Each returns { name, status: ok|warn|fail, detail, fix? }.
const config = require('./config');
const db = require('./supabase');
const paystack = require('./paystack');
const events = require('./events');

const withTimeout = (promise, ms = 8000) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`No answer after ${ms / 1000}s`)), ms))]);

const ago = (d) => {
  const mins = Math.round((Date.now() - new Date(d)) / 60000);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
};

const checks = {
  async database() {
    const { count, error } = await db.from('users').select('id', { count: 'exact', head: true });
    if (error) throw error;
    return { status: 'ok', detail: `Connected. ${count} account${count === 1 ? '' : 's'}.` };
  },

  async storage() {
    const want = { notes: false, samples: true, verification: false };
    const problems = [];
    for (const [id, isPublic] of Object.entries(want)) {
      const { data, error } = await db.storage.getBucket(id);
      if (error || !data) problems.push(`"${id}" bucket missing`);
      else if (data.public !== isPublic) problems.push(`"${id}" should be ${isPublic ? 'public' : 'private'}`);
    }
    if (problems.length) return { status: 'fail', detail: problems.join('; ') + '.', fix: 'Run supabase/schema.sql in the Supabase SQL Editor.' };
    return { status: 'ok', detail: 'notes (private), samples (public, for previews) and verification (private) are set up.' };
  },

  // Makes a one-page PDF and turns it into a preview image, the same way note uploads do.
  async previews() {
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    page.drawText('EasyNotes preview check', { x: 20, y: 100, size: 16, font: await doc.embedFont(StandardFonts.Helvetica) });
    const [image] = await require('./preview').renderImages(Buffer.from(await doc.save()), 1);
    if (!image || !image.length) throw new Error('No image was produced.');
    const { data: bucket } = await db.storage.getBucket('samples');
    if (!bucket || (bucket.allowed_mime_types && !bucket.allowed_mime_types.includes('image/webp'))) {
      return { status: 'fail', detail: 'Previews render, but the samples bucket won’t accept the images.', fix: 'In Supabase → Storage → samples → Edit bucket, add image/webp to the allowed file types.' };
    }
    return { status: 'ok', detail: 'Note previews can be made and saved.' };
  },

  async paystack() {
    const key = config.paystackSecret;
    const mode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : null;
    if (!mode || /placeholder|xxx/i.test(key)) {
      return { status: 'fail', detail: 'No real Paystack key set, so checkout won’t work.', fix: 'Set PAYSTACK_SECRET_KEY in Render → Environment.' };
    }
    await paystack.listBanks();
    return mode === 'live'
      ? { status: 'ok', detail: 'Live key works. Real payments are on.' }
      : { status: 'warn', detail: 'Test key works. Payments are test-only, no real money moves.', fix: 'Switch to your sk_live_ key when Paystack approves your business.' };
  },

  async webhook() {
    const list = await events.recent({ limit: 1, kinds: ['webhook.received'] });
    const url = `${config.baseUrl}/webhooks/paystack`;
    if (list === null) return { status: 'warn', detail: 'Activity log table not created, so webhooks can’t be tracked.', fix: 'Run the events snippet from supabase/schema.sql in Supabase.' };
    if (!list.length) return { status: 'warn', detail: 'No Paystack webhook received yet.', fix: `In Paystack → Settings → API Keys & Webhooks, set the webhook URL to ${url}` };
    return { status: 'ok', detail: `Last received ${ago(list[0].created_at)} (${list[0].detail?.event || 'event'}).` };
  },

  async email() {
    if (!config.resendApiKey) return { status: 'warn', detail: 'RESEND_API_KEY not set, so no emails are sent.', fix: 'Add RESEND_API_KEY in Render → Environment.' };
    const fromDomain = (config.mailFrom.match(/@([^>\s]+)/) || [])[1];
    const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${config.resendApiKey}` } });
    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      if (/restricted|sending/i.test(body)) return { status: 'ok', detail: `Sending key set. Sending from ${config.mailFrom}. Use “Send test email” to confirm delivery.` };
      return { status: 'fail', detail: 'Resend rejected the API key.', fix: 'Create a new key in Resend and update RESEND_API_KEY.' };
    }
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
    const { data = [] } = await res.json();
    const d = data.find((x) => x.name === fromDomain);
    if (!d) return { status: 'fail', detail: `${fromDomain} isn’t added in Resend.`, fix: 'Add the domain in Resend → Domains.' };
    if (d.status !== 'verified') return { status: 'fail', detail: `${fromDomain} is “${d.status}” in Resend.`, fix: 'Check the DNS records in Resend → Domains and click Verify.' };
    return { status: 'ok', detail: `${fromDomain} verified. Sending from ${config.mailFrom}.` };
  },
};

function configChecks(reqHost) {
  const out = [];
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' && config.isProd) out.push({ name: 'Site address', status: 'fail', detail: `BASE_URL is ${config.baseUrl}, not https.`, fix: 'Set BASE_URL to https://easynotes.co.za' });
  else if (reqHost && base.host !== reqHost) out.push({ name: 'Site address', status: 'warn', detail: `BASE_URL is ${base.host} but you’re on ${reqHost}. Email links and Paystack returns go to ${base.host}.`, fix: `Set BASE_URL to https://${reqHost} if that’s the main address.` });
  else out.push({ name: 'Site address', status: 'ok', detail: `BASE_URL is ${config.baseUrl}.` });

  const weak = config.sessionSecret.length < 32;
  out.push(weak
    ? { name: 'Login security', status: 'fail', detail: 'SESSION_SECRET is short, so login cookies are easier to forge.', fix: 'Set a long random SESSION_SECRET in Render (32+ characters).' }
    : config.isProd
      ? { name: 'Login security', status: 'ok', detail: 'Strong session secret, secure cookies on.' }
      : { name: 'Login security', status: 'warn', detail: 'NODE_ENV isn’t “production”, so cookies aren’t marked secure.', fix: 'Set NODE_ENV=production in Render.' });

  out.push(config.supportEmail
    ? { name: 'Support address', status: 'ok', detail: `Replies and contact links go to ${config.supportEmail}.` }
    : { name: 'Support address', status: 'warn', detail: 'No SUPPORT_EMAIL set.', fix: 'Set SUPPORT_EMAIL in Render.' });
  return out;
}

const LABELS = { database: 'Database', storage: 'File storage', previews: 'Note previews', paystack: 'Paystack', webhook: 'Paystack webhook', email: 'Email (Resend)' };

async function runAll(reqHost) {
  const live = await Promise.all(
    Object.entries(checks).map(async ([key, fn]) => {
      try {
        return { name: LABELS[key], ...(await withTimeout(fn())) };
      } catch (err) {
        return { name: LABELS[key], status: 'fail', detail: err.message || 'Check failed.' };
      }
    })
  );
  return [...live, ...configChecks(reqHost)];
}

function appInfo() {
  const up = Math.round(process.uptime() / 60);
  return {
    node: process.version,
    uptime: up < 60 ? `${up} min` : `${Math.round(up / 60)} h`,
    memory: `${Math.round(process.memoryUsage().rss / 1048576)} MB`,
    commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'local',
    env: config.isProd ? 'production' : 'development',
  };
}

module.exports = { runAll, appInfo };

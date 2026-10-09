const crypto = require('crypto');
const express = require('express');
const config = require('../lib/config');
const db = require('../lib/supabase');
const paystack = require('../lib/paystack');
const storage = require('../lib/storage');
const upload = require('../lib/upload');
const preview = require('../lib/preview');
const events = require('../lib/events');
const profanity = require('../lib/profanity');
const { scanPdf } = require('../lib/scan');

// After an upload: record the seller's declaration and flag anything that looks like someone else's
// material for an admin to check (Admin > Reports). Never blocks the upload.
async function afterPdfSaved(req, noteId, title, buffer) {
  events.log('note.uploaded', { note_id: noteId, title, seller_id: req.seller.id, declaration: 'own-work-v3' }, req.user.email);
  const flags = await scanPdf(buffer);
  if (flags.length) events.log('note.flagged', { note_id: noteId, title, seller_id: req.seller.id, flags }, 'scanner');
}
const flash = require('../lib/flash');
const { requireSeller } = require('../lib/auth');
const { verifyCsrf } = require('../lib/csrf');
const avatar = require('../lib/avatar');
const { slugify, str, isUuid } = require('../lib/helpers');
const { RESERVED_SLUGS } = require('../lib/constants');
const { NOTE_INSTITUTIONS, LEVELS, DEGREE_UNIVERSITIES, OTHER_UNIVERSITY, SUBJECTS, QUAL_LEVELS, STUDY_YEARS, HONOURS } = require('../lib/constants');
const education = require('../lib/education');

const router = express.Router();
router.use(requireSeller);

const MB = upload.MB;

// Upload errors are handled before CSRF so an oversize file gives a useful message.
const afterUpload = (back) => (req, res, next) => {
  if (req.uploadError) {
    flash(req, 'error', req.uploadError);
    return res.redirect(back(req));
  }
  next();
};

/* ---------- Overview ---------- */

// Overview periods. "Today" starts at midnight in South Africa (UTC+2, no daylight saving).
const PERIODS = [
  ['today', 'Today', 'Today'],
  ['7d', 'Last 7 days', '7 days'],
  ['30d', 'Last 30 days', '30 days'],
  ['year', 'Last year', '1 year'],
  ['all', 'All time', 'All'],
];
function periodStart(period) {
  const now = Date.now();
  const day = 86400000;
  if (period === 'today') {
    const sast = now + 2 * 3600000;
    return new Date(sast - (sast % day) - 2 * 3600000);
  }
  if (period === '7d') return new Date(now - 7 * day);
  if (period === '30d') return new Date(now - 30 * day);
  if (period === 'year') return new Date(now - 365 * day);
  return null;
}

router.get('/', async (req, res) => {
  const s = req.seller;
  const period = PERIODS.some((p) => p[0] === req.query.period) ? req.query.period : 'all';
  const since = periodStart(period);
  const paid = (cols) => {
    let q = db.from('orders').select(cols).eq('seller_id', s.id).eq('status', 'paid');
    return since ? q.gte('paid_at', since.toISOString()) : q;
  };
  const [{ data: notes }, { data: orders }, totals] = await Promise.all([
    db.from('notes').select('id,status').eq('seller_id', s.id).neq('status', 'deleted'),
    paid('reference,email,amount_cents,seller_earnings_cents,paid_at,notes(title)').order('paid_at', { ascending: false }).limit(200),
    since
      ? paid('seller_earnings_cents').limit(10000).then(({ data }) => ({ sales: (data || []).length, earnings: (data || []).reduce((t, o) => t + (o.seller_earnings_cents || 0), 0) }))
      : db.rpc('seller_totals', { p_seller_id: s.id }).then(({ data }) => (data && data[0]) || { sales: 0, earnings: 0 }),
  ]);
  res.render('seller/dashboard', {
    title: 'Seller dashboard',
    tab: 'overview',
    periods: PERIODS,
    period,
    hasNotes: (notes || []).length > 0,
    published: (notes || []).filter((n) => n.status === 'published').length,
    orders: orders || [],
    sales: Number(totals.sales),
    earnings: Number(totals.earnings),
    feeBearer: config.feeBearer,
  });
});

/* ---------- Notes ---------- */

router.get('/notes', async (req, res) => {
  const { data: notes } = await db
    .from('notes')
    .select('id,title,slug,status,price_cents,sales_count,page_count,module_code,subject,created_at')
    .eq('seller_id', req.seller.id)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false });
  res.render('seller/notes', { title: 'Your notes', tab: 'notes', notesList: true, notes: notes || [] });
});

/* ---------- Storefront profile ---------- */

router.get('/profile', (req, res) => {
  res.render('seller/profile', { title: 'Your storefront', tab: 'profile', values: req.seller, errors: {} });
});

router.post('/profile', upload.fields([{ name: 'avatar', maxCount: 1 }]), afterUpload(() => '/seller/profile'), verifyCsrf, async (req, res) => {
  const picture = req.files?.avatar?.[0];
  const values = {
    full_name: str(req.body.full_name, 80),
    display_name: str(req.body.display_name, 80),
    headline: str(req.body.headline, 120),
    bio: str(req.body.bio, 1500),
    slug: slugify(req.body.slug || req.body.display_name).slice(0, 40),
  };
  const errors = {};
  if (values.full_name.length < 2) errors.full_name = 'Enter your full name.';
  const pictureError = avatar.checkAvatar(picture);
  if (pictureError) errors.avatar = pictureError;
  if (values.display_name.length < 2) errors.display_name = 'Enter the name students will see.';
  if (values.slug.length < 3) errors.slug = 'Use at least 3 letters or numbers.';
  else if (RESERVED_SLUGS.has(values.slug)) errors.slug = 'That link is reserved by EasyNotes. Try another.';
  profanity.checkFields(values, ['full_name', 'display_name', 'headline', 'bio', 'slug'], errors);
  if (!errors.slug) {
    const { data: taken } = await db.from('sellers').select('id').eq('slug', values.slug).neq('id', req.seller.id).maybeSingle();
    if (taken) errors.slug = 'That link is taken. Try another.';
  }
  if (Object.keys(errors).length) {
    return res.status(400).render('seller/profile', { title: 'Your storefront', tab: 'profile', values: { ...req.seller, ...values }, errors });
  }
  const update = { ...values, headline: values.headline || null, bio: values.bio || null };
  const oldPicture = req.seller.avatar_path;
  if (picture) update.avatar_path = await avatar.saveAvatar(req.seller.id, picture.buffer);
  else if (req.body.remove_avatar === 'on') update.avatar_path = null;
  const { error } = await db.from('sellers').update(update).eq('id', req.seller.id);
  if (error) {
    if (picture) await avatar.removeAvatar(update.avatar_path);
    throw error;
  }
  if ('avatar_path' in update && oldPicture) await avatar.removeAvatar(oldPicture);
  flash(req, 'ok', 'Storefront saved.');
  res.redirect('/seller/profile');
});

/* ---------- Verification (education + ID) ---------- */

const eduLocals = (extra) => ({
  tab: 'verification', errors: {}, universities: DEGREE_UNIVERSITIES, otherLabel: OTHER_UNIVERSITY,
  levels: QUAL_LEVELS, studyYears: STUDY_YEARS, honours: HONOURS, months: education.MONTHS, ...extra,
});
const eduFiles = (extra = []) => upload.fields([{ name: 'doc', maxCount: 1 }, { name: 'record', maxCount: 1 }, ...extra]);

router.get('/verification', async (req, res) => {
  const quals = await education.forSeller(req.seller.id);
  res.render('seller/verification', eduLocals({ title: req.seller.verification_status === 'approved' ? 'Education' : 'Verification', quals, q: {} }));
});

// First verification: a completed degree plus ID. Starts over if an earlier attempt was rejected.
router.post('/verification', eduFiles([{ name: 'id_doc', maxCount: 1 }]), afterUpload(() => '/seller/verification'), verifyCsrf, async (req, res) => {
  const s = req.seller;
  if (!['unsubmitted', 'rejected'].includes(s.verification_status)) return res.redirect('/seller/verification');

  const { values, errors, docs } = education.validate(req.body, req.files);
  const idFile = req.files?.id_doc?.[0];
  const idType = idFile && storage.detectType(idFile.buffer);
  if (!idFile) errors.id_doc = 'Upload your ID document.';
  else if (!idType) errors.id_doc = 'Upload a PDF, JPG or PNG.';
  else if (idFile.size > 10 * MB) errors.id_doc = 'This file is larger than 10 MB.';
  if (Object.keys(errors).length) {
    return res.status(400).render('seller/verification', eduLocals({ title: 'Verification', quals: [], q: values, errors }));
  }

  // Clear out any earlier attempt
  const { data: old } = await db.from('qualifications').select('id,doc_path,record_path').eq('seller_id', s.id);
  const paths = await education.saveDocs(s.id, docs);
  const idPath = `${s.id}/id-${Date.now()}.${idType.ext}`;
  await storage.upload('verification', idPath, idFile.buffer, idType.mime);
  if (old && old.length) await db.from('qualifications').delete().eq('seller_id', s.id);
  const { error: qErr } = await db.from('qualifications').insert({ seller_id: s.id, ...education.rowFrom(values), ...paths });
  if (qErr) throw qErr;
  const { error } = await db
    .from('sellers')
    .update({
      ...education.headlineOf([{ ...values, review_status: 'approved' }]), // shown to admins while in review
      id_doc_path: idPath,
      degree_doc_path: paths.doc_path,
      verification_status: 'pending',
      verification_note: null,
      submitted_at: new Date().toISOString(),
    })
    .eq('id', s.id);
  if (error) throw error;
  await storage.remove('verification', [s.id_doc_path, s.degree_doc_path, ...(old || []).flatMap((q) => [q.doc_path, q.record_path])]);

  flash(req, 'ok', 'Documents sent. We’ll review them and update your status here.');
  res.redirect('/seller');
});

// Adding education, or "I've finished this" (?finish=id) / "Fix and send again" (?retry=id), once verified.
// Which entry a form is about, and how:
//   finish  - "I've finished this" on a verified entry still being studied (sent for review, replaces it once approved)
//   edit    - any change to a verified entry (same: reviewed, the current one stays live meanwhile)
//   retry   - "Fix and send again" on an entry that wasn't approved
// Anything under review is locked until the team decides.
async function eduStart(req) {
  const src = { ...req.query, ...(req.body || {}) };
  const id = src.finish || src.edit || src.retry || src.replaces;
  if (!id || !isUuid(String(id))) return { q: {}, mode: 'add' };
  const quals = await education.forSeller(req.seller.id);
  const row = quals.find((x) => x.id === id);
  if (!row) return { q: {}, mode: 'gone' };
  const { doc_path, record_path, review_note, ...fields } = row;
  if (src.retry && row.review_status === 'rejected') return { q: fields, mode: 'retry', retryOf: row };
  if (row.review_status !== 'approved') return { q: {}, mode: 'gone' };
  if (quals.some((x) => x.replaces_id === row.id && x.review_status === 'pending')) return { q: {}, mode: 'gone' }; // a change is already in review
  const isDegree = (x) => x.review_status === 'approved' && x.status === 'completed';
  const onlyDegree = isDegree(row) && quals.filter(isDegree).length === 1;
  if ((src.finish || src.mode === 'finish') && row.status === 'in_progress') {
    const { status, year_completed, current_year, expected_completion, ...keep } = fields;
    return { q: keep, mode: 'finish', replaces: row };
  }
  return { q: fields, mode: 'edit', replaces: row, onlyDegree };
}

const EDU_TITLES = { add: 'Add education', finish: 'Finished your studies', edit: 'Edit education', retry: 'Fix and send again' };
// Finishing is always "completed"; your only completed degree can't become "still studying".
const studyingAllowed = (st) => !(st.mode === 'finish' || st.onlyDegree);

router.get('/verification/education/new', async (req, res) => {
  if (req.seller.verification_status !== 'approved') return res.redirect('/seller/verification');
  const st = await eduStart(req);
  if (st.mode === 'gone') return res.redirect('/seller/verification');
  res.render('seller/education-form', eduLocals({ title: EDU_TITLES[st.mode], ...st, allowStudying: studyingAllowed(st) }));
});

router.post('/verification/education', eduFiles(), afterUpload(() => '/seller/verification'), verifyCsrf, async (req, res) => {
  const s = req.seller;
  if (s.verification_status !== 'approved') return res.redirect('/seller/verification');
  const st = await eduStart(req);
  if (st.mode === 'gone') return res.redirect('/seller/verification'); // already changed, removed or not theirs
  const keepsDocs = st.mode === 'edit';
  const { values, errors, docs } = education.validate(req.body, req.files, { allowStudying: studyingAllowed(st), docOptional: keepsDocs });
  if (Object.keys(errors).length) {
    return res.status(400).render('seller/education-form', eduLocals({ title: EDU_TITLES[st.mode], ...st, q: values, errors, allowStudying: studyingAllowed(st) }));
  }
  const fields = education.rowFrom(values);
  const before = st.replaces;
  if (keepsDocs && !docs.doc && !docs.record && !education.changes(before, fields).length) {
    flash(req, 'ok', 'Nothing changed, so there was nothing to send.');
    return res.redirect('/seller/verification');
  }
  const paths = await education.saveDocs(s.id, docs);
  // Edits keep the documents already on file unless new ones were uploaded
  if (keepsDocs) {
    paths.doc_path = paths.doc_path || before.doc_path;
    paths.record_path = paths.record_path || before.record_path;
  }

  const { data: row, error } = await db
    .from('qualifications')
    .insert({ seller_id: s.id, ...fields, ...paths, replaces_id: st.replaces ? st.replaces.id : null })
    .select('id')
    .single();
  if (error) {
    await education.removeUnusedFiles([docs.doc && paths.doc_path, docs.record && paths.record_path]);
    throw error;
  }
  if (st.retryOf) {
    // The new entry takes the place of the one that wasn't approved
    await db.from('qualifications').delete().eq('id', st.retryOf.id).eq('seller_id', s.id);
    await education.removeUnusedFiles([st.retryOf.doc_path, st.retryOf.record_path]);
  }
  events.log('qualification.submitted', { seller_id: s.id, qualification_id: row.id, name: values.name, seller: s.display_name, finished: st.mode === 'finish', updated: st.mode === 'edit' }, req.user.email);
  flash(req, 'ok', 'Sent for review. You can’t change it while we check it, and your storefront stays as it is until then.');
  res.redirect('/seller/verification');
});

// Lets sellers open documents they uploaded for verification, through short-lived links (the bucket is private).
const openPrivate = async (res, path) => {
  res.set('Cache-Control', 'no-store');
  res.redirect(await storage.signedUrl('verification', path, 120));
};
router.get('/verification/education/:id/file/:which', async (req, res, next) => {
  if (!isUuid(req.params.id) || !['doc', 'record'].includes(req.params.which)) return next();
  const { data: q } = await db.from('qualifications').select('doc_path,record_path').eq('id', req.params.id).eq('seller_id', req.seller.id).maybeSingle();
  const path = q && q[req.params.which + '_path'];
  if (!path) return next();
  await openPrivate(res, path);
});
router.get('/verification/id-file', async (req, res, next) => {
  if (!req.seller.id_doc_path) return next();
  await openPrivate(res, req.seller.id_doc_path);
});

// Taking an entry off (dropped out, added by mistake). No review needed: removing can't overstate anything.
// The last verified finished qualification stays, since a completed degree is what keeps the seller verified.
router.post('/verification/education/:id/remove', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const s = req.seller;
  const quals = await education.forSeller(s.id);
  const q = quals.find((x) => x.id === req.params.id);
  if (!q) return res.redirect('/seller/verification');
  if (q.review_status === 'pending' || quals.some((x) => x.replaces_id === q.id && x.review_status === 'pending')) {
    flash(req, 'error', 'This is under review, so it can’t be changed until we’ve checked it.');
    return res.redirect('/seller/verification');
  }
  const isDegree = (x) => x.review_status === 'approved' && x.status === 'completed';
  if (isDegree(q) && quals.filter(isDegree).length === 1) {
    flash(req, 'error', 'This is the completed degree your verification is based on, so it can’t be removed.');
    return res.redirect('/seller/verification');
  }
  // A change waiting on this entry goes with it
  const linked = quals.filter((x) => x.replaces_id === q.id && x.review_status === 'pending');
  const gone = [q, ...linked];
  await db.from('qualifications').delete().in('id', gone.map((x) => x.id)).eq('seller_id', s.id);
  await education.removeUnusedFiles(gone.flatMap((x) => [x.doc_path, x.record_path]));
  if (q.review_status === 'approved') await education.refreshHeadline(s.id);
  events.log('qualification.removed', { seller_id: s.id, name: q.name, seller: s.display_name }, req.user.email);
  flash(req, 'ok', `${q.name} removed from your education.`);
  res.redirect('/seller/verification');
});

/* ---------- Payouts (Paystack subaccount) ---------- */

async function renderPayouts(res, req, values, errors, status = 200, changeOpen = false) {
  let banks = [];
  let bankError = null;
  try {
    banks = await paystack.listBanks();
  } catch (err) {
    console.error('[payouts] bank list failed', err.message);
    bankError = 'The bank list didn’t load from Paystack. Refresh the page to try again.';
  }
  // Payout history comes straight from Paystack; the page still works if that call fails.
  const s = req.seller;
  let payouts = [];
  let payoutsError = null;
  const [{ data: totals }] = await Promise.all([
    db.rpc('seller_totals', { p_seller_id: s.id }),
    s.paystack_subaccount_code
      ? paystack.listSettlements(s.paystack_subaccount_code).then((list) => { payouts = list; }).catch((err) => {
          console.error('[payouts] settlements failed', err.message);
          payoutsError = 'Your payout history didn’t load from Paystack. Refresh the page to try again.';
        })
      : null,
  ]);
  const t = (totals && totals[0]) || { sales: 0, earnings: 0 };
  res.status(status).render('seller/payouts', {
    title: 'Payouts',
    tab: 'payouts',
    changeOpen,
    banks,
    bankError,
    values,
    errors,
    payouts,
    payoutsError,
    earned: Number(t.earnings) || 0,
    paidOut: payouts.filter((p) => p.status === 'success').reduce((sum, p) => sum + p.amount, 0),
    testMode: !config.paystackSecret.startsWith('sk_live_'),
  });
}

router.get('/payouts', (req, res) => renderPayouts(res, req, { business_name: req.seller.business_name || '', bank_code: req.seller.bank_code || '' }, {}, 200, req.query.change === '1'));

router.post('/payouts', async (req, res) => {
  const s = req.seller;
  const values = {
    business_name: str(req.body.business_name, 100),
    bank_code: str(req.body.bank_code, 20),
    account_number: str(req.body.account_number, 20).replace(/\s/g, ''),
  };
  const errors = {};
  let banks = [];
  try {
    banks = await paystack.listBanks();
  } catch {}
  const bank = banks.find((b) => b.code === values.bank_code);
  if (values.business_name.length < 2) errors.business_name = 'Enter the account holder’s name.';
  if (!bank) errors.bank_code = 'Choose your bank.';
  if (!/^\d{6,16}$/.test(values.account_number)) errors.account_number = 'Enter your account number using digits only.';
  if (Object.keys(errors).length) return renderPayouts(res, req, values, errors, 400, true);

  const payload = {
    business_name: values.business_name,
    settlement_bank: values.bank_code,
    account_number: values.account_number,
    percentage_charge: config.platformFeePercent,
    description: `EasyNotes seller: ${s.slug}`,
    primary_contact_email: req.user.email,
    primary_contact_name: s.full_name || s.display_name,
  };

  let code = s.paystack_subaccount_code;
  try {
    if (code) await paystack.updateSubaccount(code, payload);
    else code = (await paystack.createSubaccount(payload)).subaccount_code;
  } catch (err) {
    console.error('[payouts] subaccount failed', err.message, err.paystack);
    return renderPayouts(res, req, values, { form: `Paystack didn’t accept these details: ${err.message}` }, 400, true);
  }

  const { error } = await db
    .from('sellers')
    .update({
      paystack_subaccount_code: code,
      business_name: values.business_name,
      bank_code: bank.code,
      bank_name: bank.name,
      account_number_last4: values.account_number.slice(-4),
    })
    .eq('id', s.id);
  if (error) throw error;
  flash(req, 'ok', `Payout account saved. Your share of each sale will be paid into ${bank.name} ••••${values.account_number.slice(-4)}.`);
  res.redirect(s.paystack_subaccount_code ? '/seller/payouts' : '/seller'); // first setup goes back to the checklist
});

/* ---------- Notes ---------- */

function requireApproved(req, res, next) {
  if (req.seller.verification_status !== 'approved') {
    flash(req, 'info', 'You can upload notes once your degree has been verified.');
    return res.redirect('/seller');
  }
  next();
}

async function ownNote(req, res, next) {
  if (!isUuid(req.params.id)) return res.status(404).render('404', { title: 'Page not found' });
  const { data: note } = await db.from('notes').select('*').eq('id', req.params.id).eq('seller_id', req.seller.id).neq('status', 'deleted').maybeSingle();
  if (!note) return res.status(404).render('404', { title: 'Page not found' });
  req.note = note;
  next();
}

function validateNote(body) {
  const priceRand = parseFloat(String(body.price || '').replace(/[R\s]/gi, '').replace(',', '.')); // "R 120,50" → 120.5
  const values = {
    title: str(body.title, 120),
    description: str(body.description, 4000),
    subject: str(body.subject, 80),
    module_code: str(body.module_code, 20).toUpperCase().replace(/\s+/g, '') || null,
    university: str(body.university, 120),
    level: str(body.level, 40),
    price_cents: Number.isFinite(priceRand) ? Math.round(priceRand * 100) : NaN,
  };
  const errors = {};
  if (values.title.length < 5) errors.title = 'Give your notes a clear title (at least 5 characters).';
  if (values.description.length < 40) errors.description = 'Describe what’s covered in at least 40 characters. Students buy on this.';
  if (values.subject.length < 2) errors.subject = 'Enter the subject, e.g. Financial Accounting.';
  values.university = NOTE_INSTITUTIONS.find((u) => u.toLowerCase() === values.university.toLowerCase()) || values.university;
  if (values.university.length < 2) errors.university = 'Choose an institution, or type a new one to add it.';
  if (!LEVELS.includes(values.level)) errors.level = 'Choose a level.';
  if (!(values.price_cents >= 1000 && values.price_cents <= 200000)) errors.price = 'Set a price between R10 and R2,000.';
  if (body.own_work !== 'on') errors.own_work = 'Confirm the notes are your own work and contain none of the listed material.';
  profanity.checkFields(values, ['title', 'description', 'subject', 'university', 'module_code'], errors);
  return { values, errors };
}

const noteFiles = upload.fields([{ name: 'pdf', maxCount: 1 }]);

function checkFiles(req, errors, { pdfRequired }) {
  const pdf = req.files?.pdf?.[0];
  if (!pdf && pdfRequired) errors.pdf = 'Choose the PDF of your notes.';
  if (pdf && !storage.isPdf(pdf.buffer)) errors.pdf = 'This file isn’t a PDF. Export your notes as PDF and try again.';
  if (Object.keys(errors).some((k) => k !== 'pdf') && pdf) {
    errors.files = 'Fix the fields marked below, then choose your PDF again: browsers clear file fields when a form is sent back.';
  }
  return { pdf };
}

// Suggestions for a field (subject, institution): the standard list plus any this seller has added themselves
// (other sellers' own ones stay theirs), one entry regardless of capitals, always including the one on the form.
async function ownOptions(sellerId, column, base, current) {
  const { data } = await db.from('notes').select(column).eq('seller_id', sellerId).neq('status', 'deleted').limit(1000);
  const byKey = new Map();
  for (const s of [...base, ...(data || []).map((n) => n[column]), current]) {
    const name = String(s || '').trim();
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return [...byKey.values()];
}
const byName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });

const formLocals = async (req, extra) => ({
  tab: 'notes', levels: LEVELS, feePercent: config.platformFeePercent,
  subjects: (await ownOptions(req.seller.id, 'subject', SUBJECTS, extra.values && extra.values.subject)).sort(byName),
  // Universities first in their usual order, then the seller's own additions
  institutions: await ownOptions(req.seller.id, 'university', NOTE_INSTITUTIONS, extra.values && extra.values.university),
  ...extra,
});

router.get('/notes/new', requireApproved, async (req, res) => {
  // Start on the institution the seller verified with (if it's one students can filter by).
  const university = NOTE_INSTITUTIONS.includes(req.seller.university) ? req.seller.university : '';
  res.render('seller/note-form', await formLocals(req, { title: 'Upload notes', note: null, values: { university, level: '' }, errors: {} }));
});

router.post('/notes', requireApproved, noteFiles, afterUpload(() => '/seller/notes/new'), verifyCsrf, async (req, res) => {
  const { values, errors } = validateNote(req.body);
  const { pdf } = checkFiles(req, errors, { pdfRequired: true });
  if (Object.keys(errors).length) {
    return res.status(400).render('seller/note-form', await formLocals(req, { title: 'Upload notes', note: null, values: { ...values, price: req.body.price }, errors }));
  }

  const id = crypto.randomUUID();
  const stamp = Date.now();
  const filePath = `${req.seller.id}/${id}-${stamp}.pdf`;
  await storage.upload('notes', filePath, pdf.buffer, 'application/pdf');

  const pageCount = await storage.countPages(pdf.buffer);
  const { error } = await db.from('notes').insert({
    id,
    seller_id: req.seller.id,
    ...values,
    slug: slugify(values.title),
    file_path: filePath,
    file_size: pdf.size,
    page_count: pageCount,
    status: req.body.publish === '1' ? 'published' : 'draft',
  });
  if (error) {
    await storage.remove('notes', [filePath]);
    throw error;
  }
  await preview.makePreview(filePath, pdf.buffer, pageCount);
  await afterPdfSaved(req, id, values.title, pdf.buffer);

  const live = req.body.publish === '1';
  const noPayouts = !req.seller.paystack_subaccount_code;
  flash(
    req,
    'ok',
    live
      ? noPayouts
        ? 'Notes published. They’ll appear to students once you add your payout details.'
        : 'Notes published. Students can buy them now.'
      : 'Saved as a draft. Publish when you’re ready.'
  );
  res.redirect('/seller/notes');
});

// Lets the seller open the PDF they uploaded, through a short-lived link (the notes bucket is private).
router.get('/notes/:id/file', ownNote, async (req, res) => {
  const url = await storage.signedUrl('notes', req.note.file_path, 120);
  res.set('Cache-Control', 'no-store');
  res.redirect(url);
});

router.get('/notes/:id/edit', ownNote, async (req, res) => {
  const n = req.note;
  res.render('seller/note-form', await formLocals(req, { title: 'Edit notes', note: n, values: { ...n, price: (n.price_cents / 100).toFixed(2) }, errors: {} }));
});

router.post('/notes/:id', ownNote, noteFiles, afterUpload((req) => `/seller/notes/${req.params.id}/edit`), verifyCsrf, async (req, res) => {
  const n = req.note;
  if (n.status === 'removed') {
    flash(req, 'error', 'These notes were removed by EasyNotes and can’t be edited. Contact support.');
    return res.redirect('/seller/notes');
  }
  const { values, errors } = validateNote(req.body);
  const { pdf } = checkFiles(req, errors, { pdfRequired: false });
  if (Object.keys(errors).length) {
    return res.status(400).render('seller/note-form', await formLocals(req, { title: 'Edit notes', note: n, values: { ...n, ...values, price: req.body.price }, errors }));
  }

  const update = { ...values, slug: slugify(values.title) };
  const stamp = Date.now();
  const oldFiles = [];
  if (pdf) {
    update.file_path = `${req.seller.id}/${n.id}-${stamp}.pdf`;
    update.file_size = pdf.size;
    update.page_count = await storage.countPages(pdf.buffer);
    await storage.upload('notes', update.file_path, pdf.buffer, 'application/pdf');
    oldFiles.push(n.file_path);
  }

  const { error } = await db.from('notes').update(update).eq('id', n.id);
  if (error) throw error;
  if (pdf) {
    await preview.makePreview(update.file_path, pdf.buffer, update.page_count);
    await preview.removePreview(n.file_path, n.page_count);
    await afterPdfSaved(req, n.id, values.title, pdf.buffer);
  }
  await storage.remove('notes', oldFiles);
  flash(req, 'ok', pdf ? 'Changes saved. Past buyers will get the new file when they download again.' : 'Changes saved.');
  res.redirect('/seller/notes');
});

router.post('/notes/:id/status', ownNote, async (req, res) => {
  const n = req.note;
  if (n.status === 'removed') {
    flash(req, 'error', 'These notes were removed by EasyNotes. Contact support if you think this is a mistake.');
    return res.redirect('/seller/notes');
  }
  const status = req.body.action === 'publish' ? 'published' : 'unpublished';
  if (status === 'published' && req.seller.verification_status !== 'approved') return requireApproved(req, res);
  await db.from('notes').update({ status }).eq('id', n.id);
  flash(req, 'ok', status === 'published' ? `“${n.title}” is published.` : `“${n.title}” is hidden from students. Past buyers can still download it.`);
  res.redirect('/seller/notes');
});

/* ---------- Delete ---------- */

const PENDING_GRACE_MS = 2 * 60 * 60 * 1000; // a checkout started in the last 2 hours may still be paid

router.get('/notes/:id/delete', ownNote, async (req, res) => {
  const { count } = await db.from('orders').select('id', { count: 'exact', head: true }).eq('note_id', req.note.id).eq('status', 'paid');
  res.render('seller/note-delete', { title: 'Delete notes', note: req.note, sold: count || 0 });
});

// Notes nobody bought are erased with their PDF. Sold notes are marked deleted instead: gone for the
// seller and students, but the PDF stays so past buyers can still download what they paid for.
router.post('/notes/:id/delete', ownNote, async (req, res) => {
  const n = req.note;
  const { data: orders, error } = await db.from('orders').select('id,status,created_at').eq('note_id', n.id);
  if (error) throw error;
  const sold = orders.some((o) => o.status === 'paid');
  const checkingOut = orders.some((o) => o.status === 'pending' && Date.now() - new Date(o.created_at).getTime() < PENDING_GRACE_MS);
  if (!sold && checkingOut) {
    flash(req, 'error', `Someone is paying for “${n.title}” right now. Hide it instead, or try deleting again in a couple of hours.`);
    return res.redirect('/seller/notes');
  }

  if (sold) {
    const { error: upErr } = await db.from('notes').update({ status: 'deleted' }).eq('id', n.id);
    if (upErr) throw upErr;
  } else {
    // Unpaid checkouts (failed or abandoned) would otherwise block deleting the row.
    if (orders.length) {
      const { error: delOrdersErr } = await db.from('orders').delete().eq('note_id', n.id).neq('status', 'paid');
      if (delOrdersErr) throw delOrdersErr;
    }
    const { error: delErr } = await db.from('notes').delete().eq('id', n.id);
    if (delErr) throw delErr;
    await storage.remove('notes', [n.file_path]);
  }
  await preview.removePreview(n.file_path, n.page_count);
  events.log('note.deleted', { note_id: n.id, title: n.title, sold }, req.user.email);
  flash(req, 'ok', sold ? `“${n.title}” is deleted. People who bought it can still download it.` : `“${n.title}” is deleted.`);
  res.redirect('/seller/notes');
});

/* ---------- Old Sales tab ---------- */

// Sales now live on the overview
router.get('/sales', (req, res) => res.redirect(301, '/seller'));

module.exports = router;

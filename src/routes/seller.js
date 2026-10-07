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
  events.log('note.uploaded', { note_id: noteId, title, seller_id: req.seller.id, declaration: 'own-work-v2' }, req.user.email);
  const flags = await scanPdf(buffer);
  if (flags.length) events.log('note.flagged', { note_id: noteId, title, seller_id: req.seller.id, flags }, 'scanner');
}
const flash = require('../lib/flash');
const { requireSeller } = require('../lib/auth');
const { verifyCsrf } = require('../lib/csrf');
const { slugify, str, isUuid } = require('../lib/helpers');
const { RESERVED_SLUGS } = require('../lib/constants');
const { NOTE_INSTITUTIONS, LEVELS, DEGREE_UNIVERSITIES, OTHER_UNIVERSITY } = require('../lib/constants');

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

router.get('/', async (req, res) => {
  const s = req.seller;
  const [{ data: notes }, { data: totals }] = await Promise.all([
    db.from('notes').select('id,title,slug,status,price_cents,sales_count,page_count,module_code,created_at').eq('seller_id', s.id).neq('status', 'deleted').order('created_at', { ascending: false }),
    db.rpc('seller_totals', { p_seller_id: s.id }),
  ]);
  const t = (totals && totals[0]) || { sales: 0, earnings: 0 };
  res.render('seller/dashboard', {
    title: 'Seller dashboard',
    tab: 'overview',
    notes: notes || [],
    sales: Number(t.sales),
    earnings: Number(t.earnings),
  });
});

/* ---------- Storefront profile ---------- */

router.get('/profile', (req, res) => {
  res.render('seller/profile', { title: 'Your storefront', tab: 'profile', values: req.seller, errors: {} });
});

router.post('/profile', async (req, res) => {
  const values = {
    display_name: str(req.body.display_name, 80),
    headline: str(req.body.headline, 120),
    bio: str(req.body.bio, 1500),
    slug: slugify(req.body.slug || req.body.display_name).slice(0, 40),
  };
  const errors = {};
  if (values.display_name.length < 2) errors.display_name = 'Enter the name students will see.';
  if (values.slug.length < 3) errors.slug = 'Use at least 3 letters or numbers.';
  else if (RESERVED_SLUGS.has(values.slug)) errors.slug = 'That link is reserved by EasyNotes. Try another.';
  profanity.checkFields(values, ['display_name', 'headline', 'bio', 'slug'], errors);
  if (!errors.slug) {
    const { data: taken } = await db.from('sellers').select('id').eq('slug', values.slug).neq('id', req.seller.id).maybeSingle();
    if (taken) errors.slug = 'That link is taken. Try another.';
  }
  if (Object.keys(errors).length) {
    return res.status(400).render('seller/profile', { title: 'Your storefront', tab: 'profile', values: { ...req.seller, ...values }, errors });
  }
  const { error } = await db.from('sellers').update({ ...values, headline: values.headline || null, bio: values.bio || null }).eq('id', req.seller.id);
  if (error) throw error;
  flash(req, 'ok', 'Storefront saved.');
  res.redirect('/seller/profile');
});

/* ---------- Verification ---------- */

router.get('/verification', (req, res) => {
  res.render('seller/verification', {
    title: 'Verify your degree',
    tab: 'verification',
    values: req.seller,
    errors: {},
    universities: DEGREE_UNIVERSITIES,
    otherLabel: OTHER_UNIVERSITY,
  });
});

router.post(
  '/verification',
  upload.fields([{ name: 'degree_doc', maxCount: 1 }, { name: 'id_doc', maxCount: 1 }]),
  afterUpload(() => '/seller/verification'),
  verifyCsrf,
  async (req, res) => {
    const s = req.seller;
    if (!['unsubmitted', 'rejected'].includes(s.verification_status)) return res.redirect('/seller/verification');

    const thisYear = new Date().getFullYear();
    const pickedUni = str(req.body.university, 120);
    const values = {
      degree: str(req.body.degree, 120),
      university: pickedUni === OTHER_UNIVERSITY ? str(req.body.university_other, 120) : pickedUni,
      graduation_year: parseInt(req.body.graduation_year, 10),
    };
    const errors = {};
    if (values.degree.length < 3) errors.degree = 'Enter your degree, e.g. BCom Accounting.';
    if (!values.university || (pickedUni !== OTHER_UNIVERSITY && !DEGREE_UNIVERSITIES.includes(pickedUni)))
      errors.university = 'Choose the institution that awarded your degree.';
    if (!(values.graduation_year >= 1960 && values.graduation_year <= thisYear))
      errors.graduation_year = `Enter a year between 1960 and ${thisYear}.`;
    profanity.checkFields(values, ['degree', 'university'], errors);

    const docs = {};
    for (const [field, label] of [['degree_doc', 'degree certificate or academic transcript'], ['id_doc', 'ID document']]) {
      const f = req.files?.[field]?.[0];
      const type = f && storage.detectType(f.buffer);
      if (!f) errors[field] = `Upload your ${label}.`;
      else if (!type) errors[field] = 'Upload a PDF, JPG or PNG.';
      else if (f.size > 10 * MB) errors[field] = 'This file is larger than 10 MB.';
      else docs[field] = { file: f, type };
    }

    if (Object.keys(errors).length) {
      return res.status(400).render('seller/verification', {
        title: 'Verify your degree',
        tab: 'verification',
        values: { ...s, ...values, university: pickedUni, university_other: req.body.university_other },
        errors,
        universities: DEGREE_UNIVERSITIES,
        otherLabel: OTHER_UNIVERSITY,
      });
    }

    const stamp = Date.now();
    const degreePath = `${s.id}/degree-${stamp}.${docs.degree_doc.type.ext}`;
    const idPath = `${s.id}/id-${stamp}.${docs.id_doc.type.ext}`;
    await storage.upload('verification', degreePath, docs.degree_doc.file.buffer, docs.degree_doc.type.mime);
    await storage.upload('verification', idPath, docs.id_doc.file.buffer, docs.id_doc.type.mime);

    const { error } = await db
      .from('sellers')
      .update({
        ...values,
        degree_doc_path: degreePath,
        id_doc_path: idPath,
        verification_status: 'pending',
        verification_note: null,
        submitted_at: new Date().toISOString(),
      })
      .eq('id', s.id);
    if (error) throw error;
    await storage.remove('verification', [s.degree_doc_path, s.id_doc_path]);

    flash(req, 'ok', 'Documents sent. We’ll review them and update your status here.');
    res.redirect('/seller');
  }
);

/* ---------- Payouts (Paystack subaccount) ---------- */

async function renderPayouts(res, req, values, errors, status = 200) {
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

router.get('/payouts', (req, res) => renderPayouts(res, req, { business_name: req.seller.business_name || '', bank_code: req.seller.bank_code || '' }, {}));

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
  if (Object.keys(errors).length) return renderPayouts(res, req, values, errors, 400);

  const payload = {
    business_name: values.business_name,
    settlement_bank: values.bank_code,
    account_number: values.account_number,
    percentage_charge: config.platformFeePercent,
    description: `EasyNotes seller: ${s.slug}`,
    primary_contact_email: req.user.email,
    primary_contact_name: s.display_name,
  };

  let code = s.paystack_subaccount_code;
  try {
    if (code) await paystack.updateSubaccount(code, payload);
    else code = (await paystack.createSubaccount(payload)).subaccount_code;
  } catch (err) {
    console.error('[payouts] subaccount failed', err.message, err.paystack);
    return renderPayouts(res, req, values, { form: `Paystack didn’t accept these details: ${err.message}` }, 400);
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
  res.redirect('/seller');
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
  const priceRand = parseFloat(String(body.price || '').replace(',', '.'));
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
  if (!NOTE_INSTITUTIONS.includes(values.university)) errors.university = 'Choose an institution.';
  if (!LEVELS.includes(values.level)) errors.level = 'Choose a level.';
  if (!(values.price_cents >= 1000 && values.price_cents <= 200000)) errors.price = 'Set a price between R10 and R2,000.';
  if (body.own_work !== 'on') errors.own_work = 'Confirm the notes are your own work and contain none of the listed material.';
  profanity.checkFields(values, ['title', 'description', 'subject', 'module_code'], errors);
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

const formLocals = (extra) => ({ tab: 'notes', institutions: NOTE_INSTITUTIONS, levels: LEVELS, feePercent: config.platformFeePercent, ...extra });

router.get('/notes/new', requireApproved, (req, res) => {
  // Start on the institution the seller verified with (if it's one students can filter by).
  const university = NOTE_INSTITUTIONS.includes(req.seller.university) ? req.seller.university : '';
  res.render('seller/note-form', formLocals({ title: 'Upload notes', note: null, values: { university, level: '' }, errors: {} }));
});

router.post('/notes', requireApproved, noteFiles, afterUpload(() => '/seller/notes/new'), verifyCsrf, async (req, res) => {
  const { values, errors } = validateNote(req.body);
  const { pdf } = checkFiles(req, errors, { pdfRequired: true });
  if (Object.keys(errors).length) {
    return res.status(400).render('seller/note-form', formLocals({ title: 'Upload notes', note: null, values: { ...values, price: req.body.price }, errors }));
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
  res.redirect('/seller');
});

// Lets the seller open the PDF they uploaded, through a short-lived link (the notes bucket is private).
router.get('/notes/:id/file', ownNote, async (req, res) => {
  const url = await storage.signedUrl('notes', req.note.file_path, 120);
  res.set('Cache-Control', 'no-store');
  res.redirect(url);
});

router.get('/notes/:id/edit', ownNote, (req, res) => {
  const n = req.note;
  res.render('seller/note-form', formLocals({ title: 'Edit notes', note: n, values: { ...n, price: (n.price_cents / 100).toFixed(2) }, errors: {} }));
});

router.post('/notes/:id', ownNote, noteFiles, afterUpload((req) => `/seller/notes/${req.params.id}/edit`), verifyCsrf, async (req, res) => {
  const n = req.note;
  if (n.status === 'removed') {
    flash(req, 'error', 'These notes were removed by EasyNotes and can’t be edited. Contact support.');
    return res.redirect('/seller');
  }
  const { values, errors } = validateNote(req.body);
  const { pdf } = checkFiles(req, errors, { pdfRequired: false });
  if (Object.keys(errors).length) {
    return res.status(400).render('seller/note-form', formLocals({ title: 'Edit notes', note: n, values: { ...n, ...values, price: req.body.price }, errors }));
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
  res.redirect('/seller');
});

router.post('/notes/:id/status', ownNote, async (req, res) => {
  const n = req.note;
  if (n.status === 'removed') {
    flash(req, 'error', 'These notes were removed by EasyNotes. Contact support if you think this is a mistake.');
    return res.redirect('/seller');
  }
  const status = req.body.action === 'publish' ? 'published' : 'unpublished';
  if (status === 'published' && req.seller.verification_status !== 'approved') return requireApproved(req, res);
  await db.from('notes').update({ status }).eq('id', n.id);
  flash(req, 'ok', status === 'published' ? `“${n.title}” is published.` : `“${n.title}” is hidden from students. Past buyers can still download it.`);
  res.redirect('/seller');
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
    return res.redirect('/seller');
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
  res.redirect('/seller');
});

/* ---------- Sales ---------- */

router.get('/sales', async (req, res) => {
  const { data: orders } = await db
    .from('orders')
    .select('reference,email,amount_cents,seller_earnings_cents,paid_at,notes(title)')
    .eq('seller_id', req.seller.id)
    .eq('status', 'paid')
    .order('paid_at', { ascending: false })
    .limit(200);
  res.render('seller/sales', { title: 'Sales', tab: 'sales', orders: orders || [], feeBearer: config.feeBearer });
});

module.exports = router;

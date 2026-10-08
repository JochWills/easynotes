const express = require('express');
const db = require('../lib/supabase');
const config = require('../lib/config');
const preview = require('../lib/preview');
const { publicNotes, isPublic } = require('../lib/queries');
const { UNIVERSITIES, NOTE_INSTITUTIONS, LEVELS } = require('../lib/constants');
const { isUuid, noteUrl, storeUrl, str } = require('../lib/helpers');
const rateLimit = require('express-rate-limit');
const events = require('../lib/events');
const emails = require('../lib/emails');
const flash = require('../lib/flash');

const router = express.Router();
const PAGE_SIZE = 24;

const cleanSearch = (q) =>
  String(q || '').replace(/["%,()*\\:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

router.get('/', async (req, res) => {
  const { data: notes, count } = await publicNotes().order('created_at', { ascending: false }).limit(8);
  res.render('home', {
    title: null,
    notes: notes || [],
    total: count || 0,
    popularUnis: UNIVERSITIES.filter((u) => u.popular),
  });
});

router.get('/notes', async (req, res) => {
  const q = cleanSearch(req.query.q);
  const university = NOTE_INSTITUTIONS.includes(req.query.university) ? req.query.university : '';
  const level = LEVELS.includes(req.query.level) ? req.query.level : '';
  const sorts = {
    new: ['created_at', false],
    popular: ['sales_count', false],
    price_asc: ['price_cents', true],
    price_desc: ['price_cents', false],
  };
  const sort = sorts[req.query.sort] ? req.query.sort : 'new';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  // Subjects that have notes on sale right now (so picking one never shows an empty page), one per spelling
  const { data: subjectRows } = await publicNotes('subject,sellers!inner(verification_status,paystack_subaccount_code)').limit(5000);
  const subjectsByKey = new Map();
  for (const r of subjectRows || []) {
    const name = String(r.subject || '').trim();
    if (name && !subjectsByKey.has(name.toLowerCase())) subjectsByKey.set(name.toLowerCase(), name);
  }
  const subjects = [...subjectsByKey.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  const subject = subjectsByKey.get(String(req.query.subject || '').trim().toLowerCase()) || '';

  let query = publicNotes();
  if (q) query = query.or(['title', 'subject', 'module_code', 'description'].map((c) => `${c}.ilike."%${q}%"`).join(','));
  if (university) query = query.eq('university', university);
  if (level) query = query.eq('level', level);
  if (subject) query = query.ilike('subject', subject.replace(/[\\%_]/g, (c) => '\\' + c)); // any capitals
  const [col, asc] = sorts[sort];
  query = query
    .order(col, { ascending: asc })
    .order('created_at', { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  const { data: notes, count, error } = await query;
  if (error) {
    if (page > 1) return res.redirect('/notes');
    throw error;
  }

  res.render('browse', {
    title: q ? `Notes matching "${q}"` : subject && university ? `${subject} notes for ${university}` : subject ? `${subject} notes` : university ? `Notes for ${university}` : 'Browse notes',
    notes: notes || [],
    count: count || 0,
    filters: { q, subject, university, level, sort },
    subjects,
    page,
    pages: Math.max(1, Math.ceil((count || 0) / PAGE_SIZE)),
    institutions: NOTE_INSTITUTIONS,
    levels: LEVELS,
  });
});

/* ---------- Reporting notes (and copyright takedown requests) ---------- */

const reportLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
const REPORT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function reportableNote(id) {
  if (!isUuid(id)) return null;
  const { data: note } = await db
    .from('notes')
    .select('id,title,slug,status,seller_id,sellers(display_name,verification_status,paystack_subaccount_code)')
    .eq('id', id)
    .maybeSingle();
  return note && isPublic(note) ? note : null;
}

router.get('/note/:id/report', async (req, res, next) => {
  const note = await reportableNote(req.params.id);
  if (!note) return next();
  const reason = Object.keys(emails.REPORT_REASONS).includes(req.query.reason) ? req.query.reason : '';
  res.render('report', { title: 'Report notes', noindex: true, note, reasons: emails.REPORT_REASONS, values: { reason }, errors: {} });
});

router.post('/note/:id/report', reportLimiter, async (req, res, next) => {
  const note = await reportableNote(req.params.id);
  if (!note) return next();
  const values = {
    reason: Object.keys(emails.REPORT_REASONS).includes(req.body.reason) ? req.body.reason : '',
    details: str(req.body.details, 2000),
    name: str(req.body.name, 100),
    email: str(req.body.email, 200).toLowerCase(),
    good_faith: req.body.good_faith === 'on',
  };
  const errors = {};
  if (!values.reason) errors.reason = 'Choose what’s wrong.';
  if (values.details.length < 20) errors.details = 'Tell us a bit more (at least 20 characters), for example which pages and what they were copied from.';
  if (!REPORT_EMAIL_RE.test(values.email)) errors.email = 'Enter your email so we can follow up.';
  if (values.reason === 'copyright_mine') {
    if (values.name.length < 2) errors.name = 'Enter your full name.';
    if (!values.good_faith) errors.good_faith = 'Confirm the statement to send a takedown request.';
  }
  if (Object.keys(errors).length) {
    return res.status(400).render('report', { title: 'Report notes', noindex: true, note, reasons: emails.REPORT_REASONS, values, errors });
  }

  const report = { note_id: note.id, title: note.title, seller_id: note.seller_id, reason: values.reason, details: values.details, name: values.name || null, email: values.email };
  await events.log('note.reported', report, values.email);
  emails.sendReportNotice(report).catch((err) => console.error('[report] notice not sent', err.message));
  emails.sendReportReceipt(report).catch((err) => console.error('[report] receipt not sent', err.message));
  flash(req, 'ok', values.reason === 'copyright_mine' ? 'Takedown request sent. We’ll act within 2 working days and email you.' : 'Thanks, your report was sent. We’ll look into it.');
  res.redirect(303, noteUrl(note));
});

router.get(['/note/:id', '/note/:id/:slug'], async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const { data: note } = await db
    .from('notes')
    .select('*, sellers(id,display_name,slug,avatar_path,headline,degree,university,graduation_year,verification_status,paystack_subaccount_code)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!note) return next();
  if (note.status === 'deleted' && req.user?.role !== 'admin') return next();

  const live = isPublic(note);
  const isOwner = !!(req.seller && req.seller.id === note.seller_id);
  const isAdmin = req.user?.role === 'admin';
  if (!live && !isOwner && !isAdmin) return next();
  if (live && req.params.slug !== note.slug) return res.redirect(301, noteUrl(note));

  const { data: more } = await publicNotes()
    .eq('seller_id', note.seller_id)
    .neq('id', note.id)
    .order('sales_count', { ascending: false })
    .limit(4);

  res.render('note', {
    title: note.module_code ? `${note.module_code}: ${note.title}` : note.title,
    description: note.description.slice(0, 155),
    note,
    author: note.sellers,
    live,
    isOwner,
    more: more || [],
    previewImages: preview.previewUrls(note),
    previewPlan: preview.previewPlan(note.page_count),
  });
});

// For search engines: the main pages, every live note and every verified seller's storefront.
const xmlEscape = (v) => String(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
router.get('/sitemap.xml', async (req, res) => {
  const [{ data: notes, error: notesErr }, { data: sellers, error: sellersErr }] = await Promise.all([
    publicNotes('id,slug,updated_at,sellers!inner(verification_status,paystack_subaccount_code)').order('updated_at', { ascending: false }).limit(45000),
    db.from('sellers').select('slug').eq('verification_status', 'approved'),
  ]);
  if (notesErr) throw notesErr;
  if (sellersErr) throw sellersErr;
  const urls = [
    ...['/', '/notes', '/how-it-works', '/sell', '/terms', '/seller-terms', '/privacy'].map((p) => ({ loc: p })),
    ...(notes || []).map((n) => ({ loc: noteUrl(n), lastmod: n.updated_at })),
    ...(sellers || []).map((s) => ({ loc: storeUrl(s) })),
  ];
  const body = urls
    .map((u) => `  <url><loc>${xmlEscape(config.baseUrl + u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString()}</lastmod>` : ''}</url>`)
    .join('\n');
  res.set('Cache-Control', 'max-age=3600');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
});

router.get('/how-it-works', (req, res) => res.render('how', { title: 'How EasyNotes works' }));
router.get('/sell', (req, res) => res.render('sell', { title: 'Sell your notes' }));
router.get('/terms', (req, res) => res.render('terms', { title: 'Terms of sale' }));
router.get('/seller-terms', (req, res) => res.render('seller-terms', { title: 'Seller terms' }));
router.get('/privacy', (req, res) => res.render('privacy', { title: 'Privacy policy' }));
router.get('/copyright', (req, res) => res.render('copyright', { title: 'Copyright and takedown' }));

module.exports = router;

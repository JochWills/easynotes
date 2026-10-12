const express = require('express');
const db = require('../lib/supabase');
const config = require('../lib/config');
const preview = require('../lib/preview');
const { publicNotes, isPublic } = require('../lib/queries');
const { UNIVERSITIES, NOTE_INSTITUTIONS, LEVELS } = require('../lib/constants');

const { isUuid, noteUrl, storeUrl, str, rand, qs } = require('../lib/helpers');
const { limit } = require('../lib/limits');
const events = require('../lib/events');
const emails = require('../lib/emails');
const flash = require('../lib/flash');
const reviews = require('../lib/reviews');

const router = express.Router();
const PAGE_SIZE = 24;

const cleanSearch = (q) =>
  String(q || '').replace(/["%,()*\\:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

// Search looks for each word on its own, in any order, so "tax deferred" finds "Deferred Tax" and "FR EP" finds FREP.
// A code typed without a space also matches it with one ("IAS12" finds "IAS 12").
const SEARCH_COLUMNS = ['title', 'subject', 'module_code', 'description', 'university'];
const FILLER_WORDS = new Set(['notes', 'note', 'the', 'and', 'for', 'of', 'in', 'on', 'a', 'an', 'to']);
function searchWords(q) {
  const words = [...new Set(q.toLowerCase().split(' ').filter(Boolean))];
  return words.filter((w) => !FILLER_WORDS.has(w)).slice(0, 6); // just "notes": no filter, everything shows
}
const wordForms = (w) => [...new Set([w, w.replace(/([a-z])(\d)/g, '$1 $2')])];

// "Popular at" on the home page: the institutions from our list with the most notes on sale right now (then the
// most sales), so every link leads to notes. Shown by their short name (UCT, UJ...). Institutions sellers typed in
// themselves ("Other") and "Private institution" are left out.
async function popularInstitutions(max = 8) {
  const { data } = await publicNotes('university,sales_count,sellers!inner(verification_status,paystack_subaccount_code)').limit(5000);
  const byKey = new Map();
  for (const n of data || []) {
    const uni = UNIVERSITIES.find((u) => u.name.toLowerCase() === String(n.university || '').trim().toLowerCase());
    if (!uni) continue;
    const key = uni.name;
    const row = byKey.get(key) || { name: uni.name, short: uni.short, notes: 0, sales: 0 };
    row.notes += 1;
    row.sales += n.sales_count || 0;
    byKey.set(key, row);
  }
  return [...byKey.values()]
    .sort((a, b) => b.notes - a.notes || b.sales - a.sales || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((r) => ({ name: r.name, short: r.short }));
}

router.get('/', async (req, res) => {
  const [{ data: notes, count }, popularUnis] = await Promise.all([
    publicNotes().order('created_at', { ascending: false }).limit(8),
    popularInstitutions(),
  ]);
  res.render('home', {
    title: null,
    jsonLd: [
      { '@context': 'https://schema.org', '@type': 'WebSite', name: 'EasyNotes', url: config.baseUrl + '/',
        potentialAction: { '@type': 'SearchAction', target: `${config.baseUrl}/notes?q={search_term_string}`, 'query-input': 'required name=search_term_string' } },
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'EasyNotes', url: config.baseUrl + '/', logo: config.baseUrl + '/icon-512.png', email: config.supportEmail },
    ],
    notes: notes || [],
    total: count || 0,
    popularUnis,
  });
});

router.get('/notes', async (req, res) => {
  const q = cleanSearch(req.query.q);
  const level = LEVELS.includes(req.query.level) ? req.query.level : '';
  const sorts = {
    new: ['created_at', false],
    popular: ['sales_count', false],
    price_asc: ['price_cents', true],
    price_desc: ['price_cents', false],
  };
  const sort = Object.hasOwn(sorts, String(req.query.sort)) ? req.query.sort : 'new'; // not names every object has, like ?sort=constructor
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  // Subjects and added institutions that have notes on sale right now (so picking one never shows an empty page), one per spelling
  const { data: optionRows } = await publicNotes('subject,university,sellers!inner(verification_status,paystack_subaccount_code)').limit(5000);
  const distinct = (base, column) => {
    const byKey = new Map();
    for (const name of [...base, ...(optionRows || []).map((r) => String(r[column] || '').trim())]) {
      if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
    }
    return byKey;
  };
  const subjectsByKey = distinct([], 'subject');
  const subjects = [...subjectsByKey.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  const subject = subjectsByKey.get(String(req.query.subject || '').trim().toLowerCase()) || '';
  // The standard universities, then institutions sellers added
  const institutionsByKey = distinct(NOTE_INSTITUTIONS, 'university');
  const institutions = [...institutionsByKey.values()];
  const university = institutionsByKey.get(String(req.query.university || '').trim().toLowerCase()) || '';
  const anyCase = (v) => v.replace(/[\\%_]/g, (c) => '\\' + c);

  let query = publicNotes();
  // One condition per word (all must match), each true if the word is in any of the columns
  for (const w of q ? searchWords(q) : []) query = query.or(SEARCH_COLUMNS.flatMap((c) => wordForms(w).map((f) => `${c}.ilike."%${f}%"`)).join(','));
  if (university) query = query.ilike('university', anyCase(university));
  if (level) query = query.eq('level', level);
  if (subject) query = query.ilike('subject', anyCase(subject)); // any capitals
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

  const where = university ? ` at ${university}` : '';
  const kind = subject ? `${subject} notes` : level ? `${level} notes` : 'Study notes';
  res.render('browse', {
    title: q ? `Notes matching "${q}"` : subject && university ? `${subject} notes for ${university}` : subject ? `${subject} notes` : university ? `Notes for ${university}` : 'Browse notes',
    description: `${kind}${where} from verified academics who passed the module. Free preview of every set, pay once and download the PDF instantly.`,
    // Searches are endless and thin, so they stay out of search results (their links are still followed).
    noindex: q ? 'follow' : false,
    canonical: ('/notes' + qs({ university, subject, level, page: page > 1 ? page : undefined })).replace(/\?$/, ''),
    notes: notes || [],
    count: count || 0,
    filters: { q, subject, university, level, sort },
    subjects,
    page,
    pages: Math.max(1, Math.ceil((count || 0) / PAGE_SIZE)),
    institutions,
    levels: LEVELS,
  });
});

/* ---------- Reporting notes (and copyright takedown requests) ---------- */

const reportLimiter = limit(15, 15);
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

  const [{ data: more }, rev] = await Promise.all([
    publicNotes().eq('seller_id', note.seller_id).neq('id', note.id).order('sales_count', { ascending: false }).limit(4),
    reviews.forSeller(note.seller_id), // the seller's star rating, shown by their name
  ]);

  const uni = UNIVERSITIES.find((u) => u.name === note.university);
  const named = /\b(notes?|summary|summaries|guide)\b/i.test(note.title) ? note.title : `${note.title} notes`;
  const titled = `${note.module_code && !note.title.includes(note.module_code) ? note.module_code + ' ' : ''}${named}`;
  const withUni = `${titled} (${uni ? uni.short : note.university})`;
  res.render('note', {
    title: withUni.length <= 58 ? withUni : titled, // e.g. "FAC2002F Deferred Tax notes (UCT)"
    canonical: noteUrl(note),
    jsonLd: live ? [
      {
        '@context': 'https://schema.org', '@type': 'Product', name: note.title, description: note.description.slice(0, 500),
        sku: note.id, category: note.subject, url: config.baseUrl + noteUrl(note),
        image: `${config.baseUrl}/og/note/${note.id}.png`,
        brand: { '@type': 'Brand', name: 'EasyNotes' },
        offers: { '@type': 'Offer', price: (note.price_cents / 100).toFixed(2), priceCurrency: 'ZAR', availability: 'https://schema.org/InStock', url: config.baseUrl + noteUrl(note),
          seller: { '@type': 'Person', name: note.sellers.display_name, url: config.baseUrl + storeUrl(note.sellers) } },
      },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Notes', item: config.baseUrl + '/notes' },
        { '@type': 'ListItem', position: 2, name: note.subject, item: config.baseUrl + '/notes' + qs({ subject: note.subject }) },
        { '@type': 'ListItem', position: 3, name: note.title },
      ] },
    ] : null,
    description: note.description.slice(0, 155),
    ogTitle: `${note.module_code ? note.module_code + ': ' : ''}${note.title} · ${rand(note.price_cents)}`,
    // the version changes when the note is edited or the seller renames their storefront, so apps fetch a fresh picture
    ogImage: live ? `/og/note/${note.id}.png?v=${require('crypto').createHash('sha1').update(note.updated_at + '|' + note.sellers.display_name).digest('hex').slice(0, 8)}` : null,
    note,
    author: note.sellers,
    live,
    isOwner,
    more: more || [],
    rating: reviews.combinedRating(rev.list, note.sellers.slug),
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
    ...['/', '/notes', '/how-it-works', '/sell', '/digital-notes', '/terms', '/seller-terms', '/privacy'].map((p) => ({ loc: p })),
    ...(notes || []).map((n) => ({ loc: noteUrl(n), lastmod: n.updated_at })),
    ...(sellers || []).map((s) => ({ loc: storeUrl(s) })),
  ];
  const body = urls
    .map((u) => `  <url><loc>${xmlEscape(config.baseUrl + u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString()}</lastmod>` : ''}</url>`)
    .join('\n');
  res.set('Cache-Control', 'max-age=3600');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
});

router.get('/how-it-works', (req, res) => res.render('how', { title: 'How EasyNotes works', description: 'How buying study notes on EasyNotes works: preview pages for free, pay once by card, download the PDF straight away. Every seller is a verified academic.' }));
router.get('/sell', (req, res) => res.render('sell', { title: 'Sell your notes' }));
router.get('/digital-notes', (req, res) => res.render('digital-notes', { title: 'Turn handwritten notes into a PDF with AI', description: 'A step-by-step guide for EasyNotes sellers: use free AI to type up your handwritten notes, add exam traps and get a finished PDF to sell.' }));
router.get('/terms', (req, res) => res.render('terms', { title: 'Terms of sale' }));
router.get('/seller-terms', (req, res) => res.render('seller-terms', { title: 'Seller terms' }));
router.get('/privacy', (req, res) => res.render('privacy', { title: 'Privacy policy' }));
router.get('/copyright', (req, res) => res.render('copyright', { title: 'Copyright and takedown' }));

module.exports = router;

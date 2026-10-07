const express = require('express');
const db = require('../lib/supabase');
const preview = require('../lib/preview');
const { publicNotes, isPublic } = require('../lib/queries');
const { UNIVERSITIES, NOTE_INSTITUTIONS, LEVELS } = require('../lib/constants');
const { isUuid, noteUrl } = require('../lib/helpers');

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

  let query = publicNotes();
  if (q) query = query.or(['title', 'subject', 'module_code', 'description'].map((c) => `${c}.ilike."%${q}%"`).join(','));
  if (university) query = query.eq('university', university);
  if (level) query = query.eq('level', level);
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
    title: q ? `Notes matching "${q}"` : university ? `Notes for ${university}` : 'Browse notes',
    notes: notes || [],
    count: count || 0,
    filters: { q, university, level, sort },
    page,
    pages: Math.max(1, Math.ceil((count || 0) / PAGE_SIZE)),
    institutions: NOTE_INSTITUTIONS,
    levels: LEVELS,
  });
});

router.get(['/note/:id', '/note/:id/:slug'], async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const { data: note } = await db
    .from('notes')
    .select('*, sellers(id,display_name,slug,headline,degree,university,graduation_year,verification_status,paystack_subaccount_code)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!note) return next();

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

router.get('/how-it-works', (req, res) => res.render('how', { title: 'How EasyNotes works' }));
router.get('/sell', (req, res) => res.render('sell', { title: 'Sell your notes' }));
router.get('/terms', (req, res) => res.render('terms', { title: 'Terms of sale' }));
router.get('/seller-terms', (req, res) => res.render('seller-terms', { title: 'Seller terms' }));
router.get('/privacy', (req, res) => res.render('privacy', { title: 'Privacy policy' }));

module.exports = router;

const express = require('express');
const rateLimit = require('express-rate-limit');
const education = require('../lib/education');
const reviews = require('../lib/reviews');
const events = require('../lib/events');
const emails = require('../lib/emails');
const flash = require('../lib/flash');
const db = require('../lib/supabase');
const { publicNotes } = require('../lib/queries');
const config = require('../lib/config');
const { RESERVED_SLUGS } = require('../lib/constants');

// Mounted after every other route: /<slug> is a seller's storefront.
const router = express.Router();
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Old storefront links (/s/<slug>) keep working.
router.get('/s/:slug', (req, res) => res.redirect(301, '/' + encodeURIComponent(String(req.params.slug).toLowerCase())));

async function loadStore(req) {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 40 || RESERVED_SLUGS.has(slug)) return null;
  const { data: author } = await db
    .from('sellers')
    .select('id,user_id,display_name,slug,avatar_path,headline,bio,degree,university,graduation_year,verification_status,created_at')
    .eq('slug', slug)
    .maybeSingle();
  if (!author) return null;
  // Unverified storefronts are hidden, except from their own seller and admins (who see a preview banner).
  const live = author.verification_status === 'approved';
  const canPreview = (req.seller && req.seller.id === author.id) || req.user?.role === 'admin';
  if (!live && !canPreview) return null;
  return { slug, author, live };
}

async function renderStore(req, res, { author, live }, extra = {}) {
  const [{ data: notes }, quals, rev] = await Promise.all([
    publicNotes().eq('seller_id', author.id).order('sales_count', { ascending: false }),
    education.forSeller(author.id, { verifiedOnly: true }),
    reviews.forSeller(author.id),
  ]);
  res.status(extra.status || 200).render('storefront', {
    title: `${author.display_name}'s notes`,
    noindex: !live,
    live,
    description: author.headline || `Study notes by ${author.display_name}, a verified academic on EasyNotes.`,
    author,
    quals,
    notes: notes || [],
    reviews: rev,
    reviewUrl: `${config.baseUrl}/${author.slug}/review`,
    isOwner: !!(req.seller && req.seller.id === author.id),
    review: { values: {}, errors: {}, ...extra.review },
    tab: extra.tab || '',
  });
}

router.get('/:slug', async (req, res, next) => {
  if (req.params.slug !== String(req.params.slug).toLowerCase() && SLUG_RE.test(String(req.params.slug).toLowerCase())) {
    return res.redirect(301, '/' + String(req.params.slug).toLowerCase());
  }
  const store = await loadStore(req);
  if (!store) return next();
  await renderStore(req, res, store);
});

// Review link sellers share with their buyers: the storefront opens on Reviews with the form ready.
router.get('/:slug/review', async (req, res, next) => {
  const store = await loadStore(req);
  if (!store) return next();
  await renderStore(req, res, store, { tab: 'reviews', review: { open: store.live } });
});

const reviewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

router.post('/:slug/reviews', reviewLimiter, async (req, res, next) => {
  const store = await loadStore(req);
  if (!store || !store.live) return next();
  const { values, errors, review } = await reviews.prepare(store.author, req.body);
  if (!review) return renderStore(req, res, store, { status: 400, tab: 'reviews', review: { values, errors, open: true } });
  const { error } = await db.from('reviews').insert(review);
  if (error) {
    if (error.code === '23505') return renderStore(req, res, store, { status: 400, tab: 'reviews', review: { values, errors: { reference: 'You’ve already reviewed this purchase. Thanks!' }, open: true } });
    throw error;
  }
  events.log('review.posted', { seller_id: store.author.id, seller: store.author.display_name, rating: review.rating, ref: review.payment_ref }, values.email);
  emails.sendNewReview(store.author.id, review).catch((err) => console.error('[reviews] seller email not sent', err.message));
  flash(req, 'ok', 'Thanks for your review! It’s now on this storefront.');
  res.redirect(303, '/' + store.slug + '#reviews');
});

module.exports = router;

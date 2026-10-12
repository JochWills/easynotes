const express = require('express');
const { limit } = require('../lib/limits');
const education = require('../lib/education');
const reviews = require('../lib/reviews');
const events = require('../lib/events');
const emails = require('../lib/emails');
const notify = require('../lib/notify');
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

// A storefront link from before the seller changed their link: where that seller's storefront is now, or null.
async function movedStore(req) {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 40 || RESERVED_SLUGS.has(slug)) return null;
  const { data: moves } = await db.from('events').select('detail').eq('kind', 'seller.slug_changed').eq('detail->>from', slug).order('created_at', { ascending: false }).limit(1);
  const sellerId = moves && moves[0] && moves[0].detail.seller_id;
  if (!sellerId) return null;
  const { data: s } = await db.from('sellers').select('slug,verification_status').eq('id', sellerId).maybeSingle();
  return s && s.verification_status === 'approved' && s.slug !== slug ? s.slug : null;
}

async function renderStore(req, res, { author, live }, extra = {}) {
  const [{ data: notes }, quals, rev] = await Promise.all([
    publicNotes().eq('seller_id', author.id).order('sales_count', { ascending: false }),
    education.forSeller(author.id, { verifiedOnly: true }),
    reviews.forSeller(author.id),
  ]);
  const previous = reviews.previousFor(author.slug);
  const rating = reviews.combinedRating(rev.list, author.slug);
  // Link-preview image; the version changes when anything on it changes, so apps fetch the new one
  const ogVersion = require('crypto').createHash('sha1').update(JSON.stringify([author.display_name, author.avatar_path, author.degree, author.university, (notes || []).length, rating.avg, rating.count])).digest('hex').slice(0, 8);
  res.status(extra.status || 200).render('storefront', {
    title: /\bnotes?\b/i.test(author.display_name) ? author.display_name : `${author.display_name}’s notes`, // not "Josh’s Notes’s notes"
    noindex: !live,
    live,
    description: author.headline || `Study notes by ${author.display_name}, a verified academic on EasyNotes.`,
    ogTitle: `${author.display_name} on EasyNotes`,
    ogImage: live ? `/og/store/${author.slug}.png?v=${ogVersion}` : null,
    author,
    quals,
    notes: notes || [],
    reviews: rev,
    previous,
    rating,
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
  if (!store) {
    // 302, not 301: another seller may take the old link later
    const moved = await movedStore(req);
    return moved ? res.redirect(302, '/' + moved) : next();
  }
  await renderStore(req, res, store);
});

// Review link sellers share with their buyers: the storefront opens on Reviews with the form ready.
router.get('/:slug/review', async (req, res, next) => {
  const store = await loadStore(req);
  if (!store) {
    const moved = await movedStore(req);
    return moved ? res.redirect(302, '/' + moved + '/review') : next();
  }
  await renderStore(req, res, store, { tab: 'reviews', review: { open: store.live } });
});

const reviewLimiter = limit(15, 20);

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
  notify.add(store.author.id, { kind: 'review', title: `New ${review.rating}-star review`, body: review.body ? `“${review.body.slice(0, 140)}${review.body.length > 140 ? '…' : ''}” · ${review.reviewer_name || 'a buyer'}` : `From ${review.reviewer_name || 'a buyer'}`, link: `/${store.slug}#reviews` });
  flash(req, 'ok', 'Thanks for your review! It’s now on this storefront.');
  res.redirect(303, '/' + store.slug + '#reviews');
});

module.exports = router;

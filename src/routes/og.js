// Link-preview images for shared links (see lib/og.js). Pages point at these with a ?v= that changes
// whenever the picture would, so apps that cache previews pick up changes.
const express = require('express');
const db = require('../lib/supabase');
const og = require('../lib/og');
const preview = require('../lib/preview');
const reviews = require('../lib/reviews');
const { publicNotes, isPublic } = require('../lib/queries');
const { isUuid, rand, avatarUrl } = require('../lib/helpers');

const router = express.Router();

// Drawn images are kept in memory for a while; the newest few hundred are plenty.
const cache = new Map();
const MAX_CACHED = 200;
async function cached(key, draw) {
  if (cache.has(key)) return cache.get(key);
  const buf = await draw();
  cache.set(key, buf);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return buf;
}

function send(res, buf) {
  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=604800', // a week: the ?v= changes when the picture does
    'Cross-Origin-Resource-Policy': 'cross-origin', // social apps load it from their own sites
  });
  res.send(buf);
}

router.get('/og/site.png', async (req, res) => send(res, await cached('site', og.siteCard)));

router.get('/og/note/:id.png', async (req, res, next) => {
  if (!isUuid(req.params.id)) return next();
  const { data: note } = await db
    .from('notes')
    .select('id,title,module_code,price_cents,page_count,file_path,status,updated_at,sellers(display_name,verification_status,paystack_subaccount_code)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!note || !isPublic(note)) return next();
  const buf = await cached(`note:${note.id}:${note.updated_at}`, () =>
    og.noteCard({
      title: note.title,
      module_code: note.module_code,
      price: rand(note.price_cents),
      sellerName: note.sellers.display_name,
      verified: true,
      pages: note.page_count,
      previewUrl: preview.previewUrls(note)[0],
    })
  );
  send(res, buf);
});

router.get('/og/store/:slug.png', async (req, res, next) => {
  const slug = String(req.params.slug).toLowerCase();
  const { data: s } = await db.from('sellers').select('id,display_name,slug,avatar_path,degree,university,verification_status').eq('slug', slug).maybeSingle();
  if (!s || s.verification_status !== 'approved') return next();
  const [{ count }, rev] = await Promise.all([
    publicNotes('id,sellers!inner(verification_status,paystack_subaccount_code)').eq('seller_id', s.id).limit(1),
    reviews.forSeller(s.id),
  ]);
  const rating = reviews.combinedRating(rev.list, s.slug);
  const key = `store:${JSON.stringify([s.id, s.display_name, s.avatar_path, s.degree, s.university, count, rating.avg, rating.count])}`;
  const buf = await cached(key, () =>
    og.storeCard({
      name: s.display_name,
      verified: true,
      degree: s.degree,
      institution: s.university,
      notes: count || 0,
      rating: rating.avg,
      ratingCount: rating.count,
      avatarUrl: avatarUrl(s),
    })
  );
  send(res, buf);
});

module.exports = router;

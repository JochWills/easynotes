const express = require('express');
const db = require('../lib/supabase');
const { publicNotes } = require('../lib/queries');
const { RESERVED_SLUGS } = require('../lib/constants');

// Mounted after every other route: /<slug> is a seller's storefront.
const router = express.Router();
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Old storefront links (/s/<slug>) keep working.
router.get('/s/:slug', (req, res) => res.redirect(301, '/' + encodeURIComponent(String(req.params.slug).toLowerCase())));

router.get('/:slug', async (req, res, next) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_RE.test(slug) || slug.length > 40 || RESERVED_SLUGS.has(slug)) return next();
  if (req.params.slug !== slug) return res.redirect(301, '/' + slug);

  const { data: author } = await db
    .from('sellers')
    .select('id,display_name,slug,headline,bio,degree,university,graduation_year,verification_status,created_at')
    .eq('slug', slug)
    .maybeSingle();
  if (!author) return next();
  // Unverified storefronts are hidden, except from their own seller and admins (who see a preview banner).
  const live = author.verification_status === 'approved';
  const canPreview = (req.seller && req.seller.id === author.id) || req.user?.role === 'admin';
  if (!live && !canPreview) return next();

  const { data: notes } = await publicNotes().eq('seller_id', author.id).order('sales_count', { ascending: false });
  res.render('storefront', {
    title: `${author.display_name}'s notes`,
    noindex: !live,
    live,
    description: author.headline || `Study notes by ${author.display_name}, a verified academic on EasyNotes.`,
    author,
    notes: notes || [],
  });
});

module.exports = router;

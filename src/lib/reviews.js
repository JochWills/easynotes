// Storefront reviews. Only buyers can leave one: they prove it with the reference from their receipt and
// the email they paid with, and get one review per seller per purchase.
const db = require('./supabase');
const profanity = require('./profanity');
const { str } = require('./helpers');

const REF_RE = /^EN[A-Z0-9]+(-\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function forSeller(sellerId) {
  const { data } = await db
    .from('reviews')
    .select('id,rating,body,reviewer_name,notes_bought,created_at')
    .eq('seller_id', sellerId)
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .limit(200);
  const list = data || [];
  const avg = list.length ? list.reduce((s, r) => s + r.rating, 0) / list.length : 0;
  const breakdown = [5, 4, 3, 2, 1].map((stars) => ({ stars, count: list.filter((r) => r.rating === stars).length }));
  return { list, count: list.length, avg: Math.round(avg * 10) / 10, breakdown };
}

// "Thabo Mokoena" -> "Thabo M."
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

// Checks the form and the purchase. Returns { values, errors } or { review } ready to insert.
async function prepare(seller, body) {
  const values = {
    reference: str(body.reference, 40).toUpperCase().replace(/\s+/g, ''),
    email: str(body.email, 200).toLowerCase(),
    rating: parseInt(body.rating, 10),
    body: str(body.body, 1000),
  };
  const errors = {};
  if (!(values.rating >= 1 && values.rating <= 5)) errors.rating = 'Choose a star rating.';
  if (values.body && values.body.length < 10) errors.body = 'Write a little more, or leave this empty.';
  if (!REF_RE.test(values.reference)) errors.reference = 'Enter the reference from your receipt. It starts with EN.';
  if (!EMAIL_RE.test(values.email)) errors.email = 'Enter the email you paid with.';
  profanity.checkFields(values, ['body'], errors);
  if (Object.keys(errors).length) return { values, errors };

  // The receipt reference covers the whole payment; each note in it also has its own (…-1, …-2).
  const { data: orders } = await db
    .from('orders')
    .select('id,reference,payment_ref,email,buyer_name,status,seller_id,notes(title)')
    .or(`reference.eq.${values.reference},payment_ref.eq.${values.reference}`);
  const mine = (orders || []).filter((o) => o.status === 'paid' && o.email.toLowerCase() === values.email && o.seller_id === seller.id);
  if (!mine.length) {
    errors.reference = `We couldn’t find a purchase from ${seller.display_name} with that reference and email. Check both against your receipt.`;
    return { values, errors };
  }
  const paymentRef = mine[0].payment_ref || mine[0].reference;
  const { data: existing } = await db.from('reviews').select('id').eq('seller_id', seller.id).eq('payment_ref', paymentRef).maybeSingle();
  if (existing) {
    errors.reference = 'You’ve already reviewed this purchase. Thanks!';
    return { values, errors };
  }
  // Sellers can't review themselves
  const { data: owner } = await db.from('users').select('email').eq('id', seller.user_id).maybeSingle();
  if (owner && owner.email.toLowerCase() === values.email) {
    errors.reference = 'You can’t review your own storefront.';
    return { values, errors };
  }
  return {
    values,
    errors,
    review: {
      seller_id: seller.id,
      payment_ref: paymentRef,
      notes_bought: [...new Set(mine.map((o) => o.notes?.title).filter(Boolean))].join(', ').slice(0, 500) || null,
      rating: values.rating,
      body: values.body || null,
      reviewer_name: shortName(mine[0].buyer_name),
    },
  };
}

module.exports = { forSeller, prepare, shortName };

const db = require('./supabase');

const NOTE_CARD =
  'id,title,slug,subject,module_code,university,level,price_cents,page_count,sales_count,created_at,seller_id,' +
  'sellers!inner(display_name,slug,degree,university,verification_status,paystack_subaccount_code)';

// Notes a student is allowed to see and buy: published, by an approved seller with payouts set up.
function publicNotes(select = NOTE_CARD) {
  return db
    .from('notes')
    .select(select, { count: 'exact' })
    .eq('status', 'published')
    .eq('sellers.verification_status', 'approved')
    .not('sellers.paystack_subaccount_code', 'is', null);
}

function isPublic(note) {
  const s = note.sellers;
  return note.status === 'published' && s && s.verification_status === 'approved' && !!s.paystack_subaccount_code;
}

module.exports = { NOTE_CARD, publicNotes, isPublic };

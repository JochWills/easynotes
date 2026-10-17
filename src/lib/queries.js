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

// Notes an admin hid (Admin > Notes > Hide) and hasn't allowed back since: the seller can't publish them again.
// Worked out from the activity log, so it needs no extra column. If the log can't be read, nothing counts as hidden.
async function hiddenByAdmin(noteIds) {
  const ids = [...new Set(noteIds.filter(Boolean))];
  const hidden = new Set();
  if (!ids.length) return hidden;
  const { data } = await db.from('events').select('kind,detail').in('kind', ['note.hidden', 'note.restored']).in('detail->>note_id', ids).order('id', { ascending: false });
  const seen = new Set();
  for (const e of data || []) {
    const id = e.detail?.note_id;
    if (seen.has(id)) continue; // only the latest decision counts
    seen.add(id);
    if (e.kind === 'note.hidden') hidden.add(id);
  }
  return hidden;
}

module.exports = { NOTE_CARD, publicNotes, isPublic, hiddenByAdmin };

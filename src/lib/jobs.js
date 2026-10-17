// Housekeeping that runs a few times a day while the server is up (Render's free plan sleeps when idle,
// so each run catches up on anything that came due in between). Every task is safe to repeat.
const db = require('./supabase');
const storage = require('./storage');
const events = require('./events');
const emails = require('./emails');
const notify = require('./notify');
const buyerUpdates = require('./buyer-updates');

const DAY = 24 * 60 * 60 * 1000;
const ID_KEEP_DAYS = 30; // ID copies are deleted this long after approval (POPIA: keep only what's needed)
const REJECTED_KEEP_DAYS = 60; // ...or this long after a rejected submission that was never resent
const WEBHOOK_LOG_KEEP_DAYS = 30; // every Paystack webhook is logged; old entries are only noise
const READ_NOTIFICATIONS_KEEP_DAYS = 180; // sellers see the newest 50 anyway
const OVERDUE_FLAG_MONTHS = 3; // still "studying" this long after the expected finish: an admin checks
const LATE_PAYMENT_DAYS = 3; // a payment can still come through this long after checkout started (see routes/seller.js)
const REPLACED_KEEP_DAYS = 30; // a PDF replaced after sales is kept this long (and until its report is resolved)

const thisMonth = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// "Finished yet?" email once the expected finish month of something still being studied has passed.
async function remindOverdueStudies() {
  const { data: due } = await db
    .from('qualifications')
    .select('id,seller_id,name,expected_completion,sellers!inner(verification_status)')
    .eq('review_status', 'approved')
    .eq('status', 'in_progress')
    .lt('expected_completion', thisMonth())
    .is('reminded_at', null)
    .eq('sellers.verification_status', 'approved')
    .limit(50);
  let sent = 0;
  for (const q of due || []) {
    // Skip if they've already sent an update for it
    const { count } = await db.from('qualifications').select('id', { count: 'exact', head: true }).eq('replaces_id', q.id).eq('review_status', 'pending');
    if (!count) {
      try {
        await emails.sendStudyReminder(q.id);
        await notify.add(q.seller_id, { kind: 'education', title: `Finished ${q.name}?`, body: 'Upload your certificate or final record, or update your expected finish date.', link: '/seller/verification' });
        sent++;
      } catch (err) {
        console.error('[jobs] reminder not sent', err.message);
        continue; // try again next run
      }
    }
    await db.from('qualifications').update({ reminded_at: new Date().toISOString() }).eq('id', q.id);
  }
  return sent;
}

// Sellers still marked as studying OVERDUE_FLAG_MONTHS after their expected finish (they had the reminder above and
// didn't update): flagged once in Admin > Reports, so someone checks they're still a student.
async function flagOverdueStudies() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - OVERDUE_FLAG_MONTHS);
  const { data: due, error } = await db
    .from('qualifications')
    .select('id,seller_id,name,expected_completion,sellers!inner(display_name,verification_status)')
    .eq('review_status', 'approved')
    .eq('status', 'in_progress')
    .lt('expected_completion', thisMonth(cutoff))
    .eq('sellers.verification_status', 'approved')
    .limit(500);
  if (error) throw error;
  if (!due || !due.length) return 0;
  const ids = due.map((q) => q.id);
  const [{ data: seen, error: seenErr }, { data: waiting }] = await Promise.all([
    db.from('events').select('detail').eq('kind', 'qualification.overdue').in('detail->>qualification_id', ids),
    db.from('qualifications').select('replaces_id').in('replaces_id', ids).eq('review_status', 'pending'),
  ]);
  if (seenErr) throw seenErr; // can't tell what's been flagged: try next run rather than flag twice
  const skip = new Set([...(seen || []).map((e) => e.detail?.qualification_id), ...(waiting || []).map((w) => w.replaces_id)]);
  let flagged = 0;
  for (const q of due) {
    if (skip.has(q.id)) continue;
    await events.log('qualification.overdue', { seller_id: q.seller_id, seller: q.sellers.display_name, qualification_id: q.id, name: q.name, expected: q.expected_completion }, 'system');
    flagged++;
  }
  return flagged;
}

// Notes deleted while a payment for them might still come through are kept (marked deleted) rather than erased
// (routes/seller.js). Once that's no longer possible and nobody bought them, they're erased with their PDF.
async function eraseDeletedNotes() {
  const { data: notes, error } = await db.from('notes').select('id,file_path').eq('status', 'deleted').eq('sales_count', 0).limit(100);
  if (error) throw error;
  const since = new Date(Date.now() - LATE_PAYMENT_DAYS * DAY).toISOString();
  let erased = 0;
  for (const n of notes || []) {
    const [{ count: paid }, { count: recent }] = await Promise.all([
      db.from('orders').select('id', { count: 'exact', head: true }).eq('note_id', n.id).eq('status', 'paid'),
      db.from('orders').select('id', { count: 'exact', head: true }).eq('note_id', n.id).neq('status', 'paid').gt('created_at', since),
    ]);
    if (paid !== 0 || recent !== 0) continue; // bought (kept for its buyers), still payable, or a count failed
    const { error: oErr } = await db.from('orders').delete().eq('note_id', n.id).neq('status', 'paid');
    if (oErr) continue;
    const { data: gone, error: nErr } = await db.from('notes').delete().eq('id', n.id).eq('status', 'deleted').select('id');
    if (nErr || !gone || !gone.length) continue;
    await storage.remove('notes', [n.file_path]);
    erased++;
  }
  return erased;
}

// PDFs replaced after they'd sold are kept so an admin can compare (Admin > Reports). Once the report is resolved
// and REPLACED_KEEP_DAYS have passed, the old file goes, unless a note uses it again.
async function deleteReplacedPdfs() {
  const before = new Date(Date.now() - REPLACED_KEEP_DAYS * DAY).toISOString();
  const { data: flagged, error } = await db
    .from('events')
    .select('id,detail')
    .eq('kind', 'note.flagged')
    .lt('created_at', before)
    .not('detail->>previous_file', 'is', null)
    .is('detail->>previous_file_deleted', null)
    .order('id')
    .limit(200);
  if (error) throw error;
  if (!flagged || !flagged.length) return 0;
  const { data: resolved, error: rErr } = await db.from('events').select('detail').eq('kind', 'report.resolved').in('detail->>report_id', flagged.map((e) => String(e.id)));
  if (rErr) throw rErr;
  const done = new Set((resolved || []).map((e) => String(e.detail?.report_id)));
  const ready = flagged.filter((e) => done.has(String(e.id)));
  if (!ready.length) return 0;
  const { data: inUse, error: uErr } = await db.from('notes').select('file_path').in('file_path', ready.map((e) => e.detail.previous_file));
  if (uErr) throw uErr;
  const used = new Set((inUse || []).map((n) => n.file_path));
  await storage.remove('notes', ready.map((e) => e.detail.previous_file).filter((p) => !used.has(p)));
  for (const e of ready) await db.from('events').update({ detail: { ...e.detail, previous_file_deleted: true } }).eq('id', e.id);
  return ready.length;
}

async function deleteOldIdDocs() {
  const approvedBefore = new Date(Date.now() - ID_KEEP_DAYS * DAY).toISOString();
  const rejectedBefore = new Date(Date.now() - REJECTED_KEEP_DAYS * DAY).toISOString();
  const [{ data: approved }, { data: rejected }] = await Promise.all([
    db.from('sellers').select('id,id_doc_path').eq('verification_status', 'approved').lt('verified_at', approvedBefore).not('id_doc_path', 'is', null).limit(100),
    db.from('sellers').select('id,id_doc_path').eq('verification_status', 'rejected').lt('submitted_at', rejectedBefore).not('id_doc_path', 'is', null).limit(100),
  ]);
  const list = [...(approved || []), ...(rejected || [])];
  if (!list.length) return 0;
  await storage.remove('verification', list.map((s) => s.id_doc_path));
  await db.from('sellers').update({ id_doc_path: null }).in('id', list.map((s) => s.id));
  await events.log('id.deleted', { count: list.length }, 'system');
  return list.length;
}

async function pruneWebhookLog() {
  const before = new Date(Date.now() - WEBHOOK_LOG_KEEP_DAYS * DAY).toISOString();
  const { data, error } = await db.from('events').delete().eq('kind', 'webhook.received').lt('created_at', before).select('id');
  if (error) throw error;
  return (data || []).length;
}

async function pruneReadNotifications() {
  const before = new Date(Date.now() - READ_NOTIFICATIONS_KEEP_DAYS * DAY).toISOString();
  const { data, error } = await db.from('notifications').delete().not('read_at', 'is', null).lt('created_at', before).select('id');
  if (error) throw error;
  return (data || []).length;
}

async function runAll() {
  for (const [name, task] of [['study reminders', remindOverdueStudies], ['overdue studies', flagOverdueStudies], ['deleted notes', eraseDeletedNotes], ['replaced PDFs', deleteReplacedPdfs], ['ID clean-up', deleteOldIdDocs], ['webhook log clean-up', pruneWebhookLog], ['notification clean-up', pruneReadNotifications], ['update emails', buyerUpdates.sendQueued]]) {
    try {
      const n = await task();
      if (n) console.log(`[jobs] ${name}: ${n}`);
    } catch (err) {
      console.error(`[jobs] ${name} failed`, err.message);
    }
  }
}

function start() {
  setTimeout(runAll, 60 * 1000).unref();
  setInterval(runAll, 6 * 60 * 60 * 1000).unref();
}

module.exports = { start, runAll, remindOverdueStudies, flagOverdueStudies, eraseDeletedNotes, deleteReplacedPdfs, deleteOldIdDocs, pruneWebhookLog, ID_KEEP_DAYS, LATE_PAYMENT_DAYS };

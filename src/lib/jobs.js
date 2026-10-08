// Housekeeping that runs a few times a day while the server is up (Render's free plan sleeps when idle,
// so each run catches up on anything that came due in between). Every task is safe to repeat.
const db = require('./supabase');
const storage = require('./storage');
const events = require('./events');
const emails = require('./emails');

const DAY = 24 * 60 * 60 * 1000;
const ID_KEEP_DAYS = 30; // ID copies are deleted this long after approval (POPIA: keep only what's needed)
const REJECTED_KEEP_DAYS = 60; // ...or this long after a rejected submission that was never resent

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

async function runAll() {
  for (const [name, task] of [['study reminders', remindOverdueStudies], ['ID clean-up', deleteOldIdDocs]]) {
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

module.exports = { start, runAll, remindOverdueStudies, deleteOldIdDocs, ID_KEEP_DAYS };

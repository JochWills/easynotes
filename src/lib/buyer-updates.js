// Emails telling past buyers that a seller uploaded a new version of notes they bought. They're queued in the
// database (update_emails) and sent one at a time, so a restart part-way through picks up where it stopped
// (jobs.js runs the queue soon after the site starts) and nobody gets the same email twice.
const db = require('./supabase');
const config = require('./config');
const events = require('./events');
const emails = require('./emails');

const DAY = 24 * 60 * 60 * 1000;
const MAX_TRIES = 3; // an address that keeps failing is given up on
const GAP_MS = 600; // Resend allows a couple of emails a second

// Were this note's buyers emailed in the last day? Re-uploading again and again mustn't flood them.
async function emailedRecently(noteId) {
  const since = new Date(Date.now() - DAY).toISOString();
  const { data, error } = await db.from('events').select('id').eq('kind', 'note.buyers_emailed').eq('detail->>note_id', noteId).gte('created_at', since).limit(1);
  return !!error || !!(data && data.length); // can't tell: don't send
}

// Queues an email to everyone who bought the note and gives each purchase one download back, so getting the new
// version doesn't use up their allowance. Returns how many buyers were queued (0: none, or emails are off).
async function queue(noteId, { title, sellerId, actor, reportId } = {}) {
  if (!config.resendApiKey) return 0;
  const buyers = new Map(); // email -> name from their latest purchase
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('orders').select('email,buyer_name').eq('note_id', noteId).eq('status', 'paid').order('paid_at', { ascending: false }).order('id').range(from, from + 999);
    if (error) throw error;
    for (const o of data) if (!buyers.has(o.email)) buyers.set(o.email, o.buyer_name);
    if (data.length < 1000) break;
  }
  // Anyone still waiting for an earlier email about this note gets just that one
  const { data: waiting } = await db.from('update_emails').select('email').eq('note_id', noteId).is('sent_at', null).lt('attempts', MAX_TRIES);
  for (const w of waiting || []) buyers.delete(w.email);
  if (!buyers.size) return 0;

  const rows = [...buyers].map(([email, buyer_name]) => ({ note_id: noteId, email, buyer_name }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('update_emails').insert(rows.slice(i, i + 500));
    if (error) {
      console.error('[updates] not queued (run supabase/schema.sql?)', error.message);
      if (i === 0) return 0;
      break;
    }
  }
  const { error: creditErr } = await db.rpc('credit_download', { p_note_id: noteId });
  if (creditErr) console.error('[updates] downloads not credited', creditErr.message);
  await events.log('note.buyers_emailed', { note_id: noteId, title, seller_id: sellerId, buyers: buyers.size, report_id: reportId }, actor);
  sendQueued().catch((err) => console.error('[updates] sending stopped', err.message));
  return buyers.size;
}

// Sends everything waiting in the queue, trying each email once per run (one that fails is tried again on a later
// run, MAX_TRIES times in all). Only one run at a time; a run started meanwhile does nothing.
let running = false;
async function sendQueued() {
  if (running || !config.resendApiKey) return 0;
  running = true;
  let sent = 0;
  try {
    const notes = new Map();
    for (let after = 0; ; ) {
      const { data, error } = await db.from('update_emails').select('id,note_id,email,buyer_name,attempts').is('sent_at', null).lt('attempts', MAX_TRIES).gt('id', after).order('id').limit(50);
      if (error) throw error;
      if (!data.length) break;
      for (const row of data) {
        after = row.id;
        if (!notes.has(row.note_id)) {
          const { data: note } = await db.from('notes').select('title,sellers(display_name)').eq('id', row.note_id).maybeSingle();
          notes.set(row.note_id, note);
        }
        const note = notes.get(row.note_id);
        let done = true;
        try {
          if (note) await emails.sendNoteUpdated(note, row.email, row.buyer_name); // notes gone since: nothing to send
        } catch (err) {
          console.error('[updates] email not sent', err.message);
          done = false;
        }
        const { error: markErr } = await db.from('update_emails').update(done ? { sent_at: new Date().toISOString() } : { attempts: row.attempts + 1 }).eq('id', row.id);
        if (markErr) throw markErr; // otherwise the same row would come round again and again
        if (done && note) sent++;
        await new Promise((r) => setTimeout(r, GAP_MS));
      }
    }
  } finally {
    running = false;
  }
  return sent;
}

module.exports = { emailedRecently, queue, sendQueued };

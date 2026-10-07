// Makes preview images for notes uploaded before previews existed (new uploads get them automatically).
// Usage: npm run make-previews            (every note with a PDF)
//        npm run make-previews -- <note id> [<note id> ...]
require('dotenv').config();
const db = require('../src/lib/supabase');
const preview = require('../src/lib/preview');

(async () => {
  const ids = process.argv.slice(2);
  let query = db.from('notes').select('id,title,file_path,page_count').not('file_path', 'is', null);
  if (ids.length) query = query.in('id', ids);
  const { data: notes, error } = await query;
  if (error) throw error;
  let made = 0;
  for (const n of notes) {
    if (!n.page_count) {
      console.log(`- skipped "${n.title}" (page count unknown)`);
      continue;
    }
    const { data: blob, error: dlErr } = await db.storage.from('notes').download(n.file_path);
    if (dlErr) {
      console.log(`- skipped "${n.title}" (${dlErr.message})`);
      continue;
    }
    const ok = await preview.makePreview(n.file_path, Buffer.from(await blob.arrayBuffer()), n.page_count);
    console.log(`${ok ? '✓' : '✗'} ${n.title}`);
    if (ok) made++;
  }
  console.log(`Done: ${made} of ${notes.length} notes have previews.`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

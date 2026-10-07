const db = require('./supabase');

async function upload(bucket, path, buffer, contentType, { upsert = false } = {}) {
  const { error } = await db.storage.from(bucket).upload(path, buffer, { contentType, upsert });
  if (error) throw error;
  return path;
}

async function remove(bucket, paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  const { error } = await db.storage.from(bucket).remove(list);
  if (error) console.error(`[storage] could not remove from ${bucket}`, error.message);
}

async function signedUrl(bucket, path, seconds, downloadName) {
  const opts = downloadName ? { download: downloadName } : undefined;
  const { data, error } = await db.storage.from(bucket).createSignedUrl(path, seconds, opts);
  if (error) throw error;
  return data.signedUrl;
}

function publicUrl(bucket, path) {
  return db.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

// Identify a file by its first bytes rather than trusting the browser's mimetype.
function detectType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.slice(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  if (buffer[0] === 0x89 && buffer.slice(1, 4).toString('latin1') === 'PNG') return { ext: 'png', mime: 'image/png' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  return null;
}

const isPdf = (buffer) => detectType(buffer)?.ext === 'pdf';

async function countPages(buffer) {
  try {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return null;
  }
}

module.exports = { upload, remove, signedUrl, publicUrl, detectType, isPdf, countPages };

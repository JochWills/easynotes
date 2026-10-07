// Turns the first pages of a note's PDF into images for the preview on its page.
// Images (not a cut-down PDF) so the text can't be copied out and the last page really is cut in half.
const path = require('path');
const storage = require('./storage');

const WIDTH = 1100; // px, enough to read comfortably when zoomed in a bit
const HALF = 0.5; // share of the last preview page that is shown

// How much of a note is previewed: about 2.5 pages, less for short notes so the preview isn't most of it.
function previewPlan(pageCount) {
  const n = Number(pageCount) || 0;
  if (n < 1) return { full: 0, half: false, images: 0 };
  const full = n >= 6 ? 2 : n >= 3 ? 1 : 0;
  return { full, half: true, images: full + 1 };
}

// Files live in the public samples bucket next to the seller's samples, named after the note's PDF so a
// replaced PDF gets new previews (and old ones can be cleaned up).
function previewPaths(filePath, pageCount) {
  const base = 'previews/' + filePath.replace(/\.pdf$/i, '');
  return Array.from({ length: previewPlan(pageCount).images }, (_, i) => `${base}-p${i + 1}.webp`);
}

let pdfjs;
async function loadPdfjs() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

async function renderImages(buffer, pageCount) {
  const plan = previewPlan(pageCount);
  if (!plan.images) return [];
  const { getDocument } = await loadPdfjs();
  const { createCanvas } = require('@napi-rs/canvas');
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep,
    cMapUrl: path.join(root, 'cmaps') + path.sep,
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const images = [];
    for (let i = 1; i <= plan.images; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: WIDTH / base.width });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      let out = canvas;
      if (i === plan.images && plan.half) {
        out = createCanvas(canvas.width, Math.round(canvas.height * HALF));
        out.getContext('2d').drawImage(canvas, 0, 0);
      }
      images.push(await out.encode('webp', 78));
    }
    return images;
  } finally {
    await doc.destroy();
  }
}

// Best effort: a note without a preview still sells, so failures are logged, never thrown.
async function makePreview(filePath, buffer, pageCount) {
  try {
    const images = await renderImages(buffer, pageCount);
    const paths = previewPaths(filePath, pageCount);
    for (let i = 0; i < images.length; i++) {
      await storage.upload('samples', paths[i], images[i], 'image/webp', { upsert: true });
    }
    return true;
  } catch (err) {
    console.error('[preview] could not make preview for', filePath, err.message);
    return false;
  }
}

async function removePreview(filePath, pageCount) {
  if (filePath) await storage.remove('samples', previewPaths(filePath, pageCount));
}

function previewUrls(note) {
  if (!note.file_path || !note.page_count) return [];
  return previewPaths(note.file_path, note.page_count).map((p) => storage.publicUrl('samples', p));
}

module.exports = { previewPlan, previewPaths, renderImages, makePreview, removePreview, previewUrls };

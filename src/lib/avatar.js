// Seller profile pictures: any JPEG, PNG or WebP is cropped to a centred square and saved as a small WebP
// in the public samples bucket (re-encoding also strips camera data such as GPS location).
const storage = require('./storage');

const SIZE = 400; // px, sharp on the 92px storefront avatar at high-DPI
const MAX_MB = 8;

function isImage(buffer) {
  const t = storage.detectType(buffer);
  if (t && (t.ext === 'jpg' || t.ext === 'png')) return true;
  return buffer.length > 12 && buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP';
}

// Returns an error message for the form, or null if the file is fine.
function checkAvatar(file) {
  if (!file) return null;
  if (file.size > MAX_MB * 1024 * 1024) return `That picture is larger than ${MAX_MB} MB. Choose a smaller one.`;
  if (!isImage(file.buffer)) return 'Use a JPG, PNG or WebP picture.';
  return null;
}

async function toSquareWebp(buffer) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const img = await loadImage(buffer); // phone photos come out the right way up (EXIF orientation is applied)
  const side = Math.min(img.width, img.height);
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  return canvas.encode('webp', 82);
}

// Saves the new picture and returns its path (a new name each time, so browsers don't show an old cached one).
async function saveAvatar(sellerId, buffer) {
  const webp = await toSquareWebp(buffer);
  const path = `avatars/${sellerId}-${Date.now()}.webp`;
  await storage.upload('samples', path, webp, 'image/webp');
  return path;
}

async function removeAvatar(path) {
  if (path) await storage.remove('samples', [path]).catch(() => {});
}

module.exports = { checkAvatar, saveAvatar, removeAvatar, MAX_MB };

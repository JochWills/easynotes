// Seller profile pictures: any JPEG, PNG or WebP is cropped to a centred square and saved as a small WebP
// in the public samples bucket (re-encoding also strips camera data such as GPS location).
const storage = require('./storage');

const SIZE = 400; // px, sharp on the 92px storefront avatar at high-DPI
const MAX_MB = 8;
const MAX_PIXELS = 25e6; // decoding takes 4 bytes a pixel, so a small file with huge dimensions could use gigabytes

function isImage(buffer) {
  const t = storage.detectType(buffer);
  if (t && (t.ext === 'jpg' || t.ext === 'png')) return true;
  return buffer.length > 12 && buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP';
}

// Width and height from the file's header (without decoding it), or null if they can't be read.
function imageSize(buf) {
  try {
    const t = storage.detectType(buf);
    if (t && t.ext === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (t && t.ext === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        if (marker === 0xd8 || marker === 0x01 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) { i += marker === 0xff ? 1 : 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (isImage(buf)) {
      const chunk = buf.slice(12, 16).toString('latin1');
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
  } catch {}
  return null;
}

// Returns an error message for the form, or null if the file is fine.
function checkAvatar(file) {
  if (!file) return null;
  if (file.size > MAX_MB * 1024 * 1024) return `That picture is larger than ${MAX_MB} MB. Choose a smaller one.`;
  if (!isImage(file.buffer)) return 'Use a JPG, PNG or WebP picture.';
  const size = imageSize(file.buffer);
  if (!size || !size.width || !size.height) return 'That picture couldn’t be read. Try saving it again as a JPG.';
  if (size.width * size.height > MAX_PIXELS) return 'That picture is too big. Choose one under 25 megapixels, or crop it first.';
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

module.exports = { checkAvatar, imageSize, saveAvatar, removeAvatar, MAX_MB };

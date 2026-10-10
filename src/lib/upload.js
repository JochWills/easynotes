const multer = require('multer');
const rateLimit = require('express-rate-limit');

const MB = 1024 * 1024;

// Uploads are held in memory while they're checked, so only a few run at once (Render's free plan has 512 MB)
// and each route only accepts files as big as it needs.
const MAX_ACTIVE = 4;
let active = 0;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => {
    req.uploadError = 'You’ve sent a lot of uploads in a short time. Wait a few minutes, then try again.';
    next();
  },
});

// Wrap multer so oversize/invalid uploads become a friendly message instead of a 500.
function fields(spec, { maxMb = 50 } = {}) {
  const mw = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * MB, files: spec.length, fields: 30 } }).fields(spec);
  const parse = (req, res, next) => {
    if (req.uploadError) return next();
    if (active >= MAX_ACTIVE) {
      req.uploadError = 'The site is busy with other uploads right now. Try again in a minute.';
      return next();
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    res.once('finish', release);
    res.once('close', release);
    mw(req, res, (err) => {
      if (err) {
        req.uploadError =
          err.code === 'LIMIT_FILE_SIZE' ? `That file is larger than ${maxMb} MB. Compress it and try again.`
          : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files were attached. Try again with one file per box.'
          : 'The upload failed. Try again.';
        console.error('[upload]', err.code || err.message);
      }
      next();
    });
  };
  return [limiter, parse];
}

module.exports = { fields, MB };

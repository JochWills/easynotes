const multer = require('multer');

const MB = 1024 * 1024;
const multerInstance = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * MB, files: 2, fields: 30 } });

// Wrap multer so oversize/invalid uploads become a friendly message instead of a 500.
function fields(spec) {
  const mw = multerInstance.fields(spec);
  return (req, res, next) =>
    mw(req, res, (err) => {
      if (err) {
        req.uploadError =
          err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 50 MB. Compress the PDF and try again.' : 'The upload failed. Try again.';
      }
      next();
    });
}

module.exports = { fields, MB };

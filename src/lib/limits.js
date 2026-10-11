// Rate limits, counted per visitor's internet address. Students on one campus's wifi often share an address,
// so limits on the pages buyers use are generous. Going over shows a proper page instead of plain text.
const rateLimit = require('express-rate-limit');

const MESSAGE = 'You’ve tried this a lot in a short time. Wait a few minutes, then try again.';

function limit(minutes, max) {
  return rateLimit({
    windowMs: minutes * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      // The buy buttons and add-to-cart buttons ask for JSON
      if (req.get('X-Checkout') === 'popup' || req.get('accept') === 'application/json') return res.status(429).json({ error: MESSAGE });
      res.status(429).render('error', { title: 'Too many tries', message: MESSAGE });
    },
  });
}

module.exports = { limit, MESSAGE };

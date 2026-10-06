const express = require('express');
const paystack = require('../lib/paystack');
const { markPaid } = require('../lib/orders');

const router = express.Router();

// Set this URL in Paystack > Settings > API Keys & Webhooks: https://YOUR-DOMAIN/webhooks/paystack
router.post('/paystack', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!paystack.validSignature(req.body, req.get('x-paystack-signature'))) return res.sendStatus(401);

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  try {
    if (event.event === 'charge.success' && event.data?.reference) {
      await markPaid(event.data.reference, event.data);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook] failed to process', err);
    res.sendStatus(500); // Paystack retries on non-200
  }
});

module.exports = router;

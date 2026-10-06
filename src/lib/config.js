require('dotenv').config();

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable ${key}. See .env.example.`);
  return value;
}

const fee = Number(process.env.PLATFORM_FEE_PERCENT || 20);
if (!(fee >= 0 && fee < 100)) throw new Error('PLATFORM_FEE_PERCENT must be between 0 and 99');

module.exports = {
  port: process.env.PORT || 3000,
  isProd: process.env.NODE_ENV === 'production',
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  sessionSecret: required('SESSION_SECRET'),
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  paystackSecret: required('PAYSTACK_SECRET_KEY'),
  platformFeePercent: fee,
  feeBearer: process.env.PAYSTACK_FEE_BEARER === 'subaccount' ? 'subaccount' : 'account',
  maxDownloads: Number(process.env.MAX_DOWNLOADS || 10),
  supportEmail: process.env.SUPPORT_EMAIL || 'support@easynotes.co.za',
};

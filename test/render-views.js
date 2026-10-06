// Renders every template with mock data to catch template errors without a database.
// Usage: node test/render-views.js
process.env.SESSION_SECRET ||= 'x'; process.env.SUPABASE_URL ||= 'https://demo.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'x'; process.env.PAYSTACK_SECRET_KEY ||= 'x';
const ejs = require('ejs');
const path = require('path');
const fs = require('fs');
const helpers = require('../src/lib/helpers');
const C = require('../src/lib/constants');

const seller = { id: 's1', display_name: 'Thandi Mokoena', slug: 'thandi-mokoena', headline: 'CA(SA). Accounting notes that stick.', bio: 'Distinctions in Accounting I–III.', degree: 'BCom Honours in Accounting', university: 'University of Cape Town', graduation_year: 2023, verification_status: 'approved', verified_at: new Date(), paystack_subaccount_code: 'ACCT_x', bank_name: 'Capitec Bank', account_number_last4: '1234', business_name: 'T Mokoena', submitted_at: new Date(), users: { email: 'thandi@example.com' } };
const note = { id: '11111111-1111-1111-1111-111111111111', title: 'Financial Accounting I: complete exam summary', slug: 'financial-accounting-i', subject: 'Accounting', module_code: 'ACC1006F', university: 'University of Cape Town', level: 'Undergraduate', price_cents: 12000, page_count: 46, file_size: 2400000, sales_count: 12, status: 'published', description: 'Covers IFRS 15 revenue, inventories, PPE.\nWorked examples throughout.', created_at: new Date(), updated_at: new Date(), sellers: seller, sample_path: 'x' };
const order = { reference: 'ENABC123DEF', email: 'student@example.com', status: 'paid', amount_cents: 12000, platform_fee_cents: 2400, seller_earnings_cents: 9600, paid_at: new Date(), created_at: new Date(), download_count: 1, notes: { title: note.title }, sellers: seller };

const base = { ...helpers, emailEnabled: true, csrf: 'tok', currentPath: '/', feePercent: 20, supportEmail: 'support@easynotes.co.za', maxDownloads: 10, flash: null, user: null, me: seller };
const sellerBase = { ...base, user: { role: 'seller', email: 'a@b.c' } };
const adminBase = { ...base, user: { role: 'admin', email: 'a@b.c' } };

const cases = {
  home: [{ ...base, title: null, notes: [note, { ...note, subject: 'Finance' }, { ...note, subject: 'Law', module_code: null }, note], total: 10, popularUnis: C.UNIVERSITIES.filter(u => u.popular) }, { ...base, notes: [], total: 0, popularUnis: [] }],
  browse: [{ ...base, title: 'Browse', notes: [note], count: 30, filters: { q: 'acc', university: '', level: '', sort: 'new' }, page: 1, pages: 2, institutions: C.NOTE_INSTITUTIONS, levels: C.LEVELS }, { ...base, notes: [], count: 0, filters: { q: '', university: 'Rhodes University', level: 'Undergraduate', sort: 'new' }, page: 1, pages: 1, institutions: C.NOTE_INSTITUTIONS, levels: C.LEVELS }],
  note: [{ ...base, title: 'x', note, author: seller, live: true, more: [note], sampleUrl: 'https://x' }, { ...sellerBase, note: { ...note, status: 'draft' }, author: seller, live: false, more: [], sampleUrl: null }],
  storefront: [{ ...base, author: seller, notes: [note] }, { ...base, author: seller, notes: [] }],
  'checkout-complete': ['paid', 'pending', 'failed'].map(s => ({ ...base, order: { ...order, status: s }, note })),
  library: [{ ...base, title: 'Your notes', email: order.email, expires: new Date(Date.now() + 7 * 864e5), orders: [order, { ...order, reference: 'ENXYZ', download_count: 10 }], linkDays: 7 }, { ...base, email: order.email, expires: new Date(), orders: [], linkDays: 7 }, { ...base, title: 'Link expired', orders: null, linkDays: 7 }],
  download: [{ ...base, email: '', reference: '', error: null }, { ...base, email: 'a', reference: 'b', error: 'Nope' }],
  login: [{ ...base, email: '', error: 'bad', next: '' }],
  signup: [{ ...base, values: {}, errors: { email: 'Bad', accept: 'Tick' } }],
  how: [base], sell: [base], terms: [base], 'seller-terms': [base], privacy: [base], '404': [base],
  error: [{ ...base, title: 'Oops', message: 'Bad' }, { title: 'No locals', message: 'Minimal', ...helpers }],
  'seller/dashboard': [{ ...sellerBase, title: 'Seller dashboard', tab: 'overview', notes: [note, { ...note, status: 'draft' }, { ...note, status: 'removed' }], sales: 3, earnings: 28800 }, { ...sellerBase, me: { ...seller, verification_status: 'rejected', verification_note: 'Blurry', paystack_subaccount_code: null }, title: 'D', tab: 'overview', notes: [], sales: 0, earnings: 0 }],
  'seller/profile': [{ ...sellerBase, flash: { type: 'ok', msg: 'Saved.' }, title: 'Storefront', tab: 'profile', values: seller, errors: { slug: 'taken' } }],
  'seller/verification': ['unsubmitted', 'rejected', 'pending', 'approved'].map(st => ({ ...sellerBase, me: { ...seller, verification_status: st, verification_note: 'x' }, title: 'V', tab: 'verification', values: {}, errors: { degree: 'x' }, universities: C.DEGREE_UNIVERSITIES, otherLabel: C.OTHER_UNIVERSITY })),
  'seller/payouts': [{ ...sellerBase, title: 'P', tab: 'payouts', banks: [{ name: 'Capitec Bank', code: '470010' }], bankError: null, values: { bank_code: '470010' }, errors: { form: 'Paystack said no' } }],
  'seller/note-form': [{ ...sellerBase, title: 'Upload', tab: 'notes', note: null, values: {}, errors: { files: 'x', title: 'y' }, institutions: C.NOTE_INSTITUTIONS, levels: C.LEVELS }, { ...sellerBase, title: 'Edit', tab: 'notes', note, values: { ...note, price: '120.00' }, errors: {}, institutions: C.NOTE_INSTITUTIONS, levels: C.LEVELS }],
  'seller/sales': [{ ...sellerBase, title: 'Sales', tab: 'sales', orders: [order], feeBearer: 'subaccount' }, { ...sellerBase, title: 'Sales', tab: 'sales', orders: [], feeBearer: 'account' }],
  'admin/index': [{ ...adminBase, title: 'Admin', tab: 'overview', totals: { sales: 3, gross: 36000, fees: 7200 }, pending: [seller], recent: [order], sellerCount: 1, noteCount: 2 }],
  'admin/sellers': [{ ...adminBase, title: 'Sellers', tab: 'sellers', sellers: [seller], status: 'pending', statuses: ['pending', 'approved', 'rejected', 'unsubmitted'] }],
  'admin/seller': [{ ...adminBase, title: 'T', tab: 'sellers', s: { ...seller, verification_note: 'old' }, notes: [note], degreeUrl: 'https://x', idUrl: null }],
  'admin/notes': [{ ...adminBase, title: 'Notes', tab: 'notes', notes: [note, { ...note, status: 'removed' }], q: '' }],
  'admin/orders': [{ ...adminBase, title: 'Orders', tab: 'orders', orders: [order], status: 'paid', reference: '' }],
};

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const [view, list] of Object.entries(cases)) {
  list.forEach((locals, i) => {
    try {
      const html = ejs.render(fs.readFileSync(path.join(__dirname, '..', 'views', view + '.ejs'), 'utf8'), locals, { filename: path.join(__dirname, '..', 'views', view + '.ejs') });
      fs.writeFileSync(path.join(outDir, view.replace('/', '_') + `-${i}.html`), html);
    } catch (e) {
      failed++;
      console.error(`FAIL ${view}[${i}]:`, e.message.split('\n').slice(-3).join(' | '));
    }
  });
}
const all = fs.readdirSync(path.join(__dirname, '..', 'views'), { recursive: true }).filter(f => f.endsWith('.ejs') && !f.startsWith('partials')).map(f => f.replace('.ejs', ''));
const missing = all.filter(v => !cases[v]);
if (missing.length) console.log('Untested views:', missing.join(', '));
console.log(failed ? `${failed} failures` : 'All views rendered');
process.exit(failed ? 1 : 0);

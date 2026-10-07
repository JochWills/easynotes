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
const note = { id: '11111111-1111-1111-1111-111111111111', title: 'Financial Accounting I: complete exam summary', slug: 'financial-accounting-i', subject: 'Accounting', module_code: 'ACC1006F', university: 'University of Cape Town', level: 'Undergraduate', price_cents: 12000, page_count: 46, file_size: 2400000, sales_count: 12, status: 'published', description: 'Covers IFRS 15 revenue, inventories, PPE.\nWorked examples throughout.', created_at: new Date(), updated_at: new Date(), sellers: seller, file_path: 's1/n1-1791332710339.pdf' };
const order = { reference: 'ENABC123DEF', email: 'student@example.com', buyer_name: 'Sipho Dlamini', status: 'paid', amount_cents: 12000, platform_fee_cents: 2400, seller_earnings_cents: 9600, paid_at: new Date(), created_at: new Date(), download_count: 1, notes: { title: note.title }, sellers: seller };

const base = { ...helpers, emailEnabled: true, csrf: 'tok', currentPath: '/', feePercent: 20, supportEmail: 'support@easynotes.co.za', maxDownloads: 10, flash: null, user: null, me: seller };
const sellerBase = { ...base, user: { role: 'seller', email: 'a@b.c' } };
const adminBase = { ...base, user: { role: 'admin', email: 'a@b.c' } };

const cases = {
  home: [{ ...sellerBase, title: null, notes: [], total: 0, popularUnis: [] }, { ...adminBase, notes: [], total: 0, popularUnis: [] }, { ...base, title: null, notes: [note, { ...note, subject: 'Finance' }, { ...note, subject: 'Law', module_code: null }, note], total: 10, popularUnis: C.UNIVERSITIES.filter(u => u.popular) }, { ...base, notes: [], total: 0, popularUnis: [] }],
  browse: [{ ...base, title: 'Browse', notes: [note], count: 30, filters: { q: 'acc', university: '', level: '', sort: 'new' }, page: 1, pages: 2, institutions: C.NOTE_INSTITUTIONS, levels: C.LEVELS }, { ...base, notes: [], count: 0, filters: { q: '', university: 'Rhodes University', level: 'Undergraduate', sort: 'new' }, page: 1, pages: 1, institutions: C.NOTE_INSTITUTIONS, levels: C.LEVELS }],
  note: [
    { ...base, cartIds: [], title: 'x', note: { ...note, page_count: 12, description: 'Explanations, questions and exam traps. The best notes I have made by a landslide.\nCovers IFRS 15 revenue, inventories, PPE.\nWorked examples throughout.' }, author: seller, live: true, isOwner: false, more: [note, note], previewImages: [1, 2, 3].map((i) => `/_preview/long-p${i}.webp`), previewPlan: { full: 2, half: true, images: 3 } },
    { ...sellerBase, note: { ...note, seller_id: 's1' }, author: seller, live: true, isOwner: true, more: [{ ...note, seller_id: 's1' }], previewImages: [], previewPlan: { full: 0, half: false, images: 0 } },
    { ...sellerBase, note: { ...note, status: 'draft' }, author: seller, live: false, isOwner: true, more: [], previewImages: [], previewPlan: { full: 0, half: false, images: 0 } },
    { ...base, cartIds: [note.id], note: { ...note, page_count: 2, file_size: 46560 }, author: seller, live: true, isOwner: false, more: [], previewImages: ['/_preview/missing.webp'], previewPlan: { full: 0, half: true, images: 1 } },
  ],
  storefront: [{ ...base, author: seller, notes: [note] }, { ...base, author: seller, notes: [] }],
  'checkout-complete': [
    ...['paid', 'pending', 'failed'].map(st => ({ ...base, status: st, paymentRef: 'ENABC123DEF', email: order.email, total: 12000, orders: [{ ...order, note_id: note.id, notes: note }] })),
    ...['paid', 'failed'].map(st => ({ ...base, status: st, paymentRef: 'ENMULTI1', email: order.email, total: 24000, orders: [{ ...order, reference: 'ENMULTI1-1', note_id: note.id, notes: note }, { ...order, reference: 'ENMULTI1-2', note_id: note.id, notes: { ...note, title: 'Tax 101' } }] })),
  ],
  cart: [{ ...base, title: 'Your cart', notes: [note, { ...note, id: '22222222-2222-2222-2222-222222222222', title: 'Tax 101', module_code: null }], dropped: 1, total: 24000 }, { ...base, title: 'Your cart', notes: [], dropped: 0, total: 0 }],
  'partials/cart-panel': [{ ...base, notes: [note, { ...note, id: '22222222-2222-2222-2222-222222222222', title: 'Tax 101: a very long title that should wrap neatly inside the panel', module_code: null }], dropped: 0, total: 24000 }, { ...base, notes: [], dropped: 1, total: 0 }],
  library: [{ ...base, expires: null, title: 'Your notes', email: order.email, orders: [order], linkDays: 7 }, { ...base, title: 'Your notes', email: order.email, expires: new Date(Date.now() + 7 * 864e5), orders: [order, { ...order, reference: 'ENXYZ', download_count: 10 }], linkDays: 7 }, { ...base, email: order.email, expires: new Date(), orders: [], linkDays: 7 }, { ...base, title: 'Link expired', orders: null, linkDays: 7 }],
  download: [{ ...base, email: '', reference: '', error: null }, { ...base, email: 'a', reference: 'b', error: 'Nope' }],
  login: [{ ...base, email: '', error: 'bad', next: '' }],
  forgot: [{ ...base, email: '', sent: false }, { ...base, email: 'a@b.co', sent: false, error: 'Enter the email' }, { ...base, email: 'a@b.co', sent: true }, { ...base, emailEnabled: false, email: '', sent: false }],
  reset: [{ ...base, token: 'tok', errors: {} }, { ...base, token: 'tok', errors: { confirm: 'No match' } }, { ...base, token: null, errors: {} }],
  signup: [{ ...base, values: {}, errors: { email: 'Bad', accept: 'Tick' } }],
  how: [base, sellerBase, adminBase], sell: [base, sellerBase, adminBase], terms: [base], 'seller-terms': [base], privacy: [base], '404': [base],
  error: [{ ...base, title: 'Oops', message: 'Bad' }, { title: 'No locals', message: 'Minimal', ...helpers }],
  'seller/dashboard': [{ ...sellerBase, title: 'Seller dashboard', tab: 'overview', notes: [note, { ...note, status: 'draft' }, { ...note, status: 'removed' }], sales: 3, earnings: 28800 }, { ...sellerBase, me: { ...seller, verification_status: 'rejected', verification_note: 'Blurry', paystack_subaccount_code: null }, title: 'D', tab: 'overview', notes: [], sales: 0, earnings: 0 }],
  report: [{ ...base, title: 'Report', note, reasons: require('../src/lib/emails').REPORT_REASONS, values: {}, errors: {} }, { ...base, title: 'Report', note, reasons: require('../src/lib/emails').REPORT_REASONS, values: { reason: 'copyright_mine', details: 'x' }, errors: { details: 'More', name: 'Name', good_faith: 'Tick' } }],
  copyright: [base],
  'admin/reports': [{ ...adminBase, title: 'Reports', tab: 'reports', reportCount: 2, notesById: { [note.id]: note }, reasons: require('../src/lib/emails').REPORT_REASONS, items: [
    { id: 7, kind: 'note.reported', created_at: new Date(), detail: { note_id: note.id, title: note.title, reason: 'copyright_mine', details: 'Pages 3-10 are my week 4 slides.\nPlease remove.', name: 'Dr A Lecturer', email: 'lecturer@uct.ac.za' } },
    { id: 8, kind: 'note.flagged', created_at: new Date(), detail: { note_id: note.id, title: note.title, flags: ['Lecture slide wording', 'Pages are slide-shaped (landscape)'] } },
    { id: 9, kind: 'note.reported', created_at: new Date(), detail: { note_id: 'gone', title: 'Old notes', reason: 'wrong', details: 'File is blank after page 2', email: 'a@b.co' } },
  ] }, { ...adminBase, title: 'Reports', tab: 'reports', notesById: {}, reasons: {}, items: [] }, { ...adminBase, title: 'Reports', tab: 'reports', notesById: {}, reasons: {}, items: null }],
  'seller/note-delete': [{ ...sellerBase, title: 'Delete notes', note: { ...note, status: 'published' }, sold: 3 }, { ...sellerBase, title: 'Delete notes', note: { ...note, status: 'draft' }, sold: 0 }],
  'seller/profile': [{ ...sellerBase, flash: { type: 'ok', msg: 'Saved.' }, title: 'Storefront', tab: 'profile', values: seller, errors: { slug: 'taken' } }],
  'seller/verification': ['unsubmitted', 'rejected', 'pending', 'approved'].map(st => ({ ...sellerBase, me: { ...seller, verification_status: st, verification_note: 'x' }, title: 'V', tab: 'verification', values: {}, errors: { degree: 'x' }, universities: C.DEGREE_UNIVERSITIES, otherLabel: C.OTHER_UNIVERSITY })),
  'seller/payouts': [
    { ...sellerBase, title: 'P', tab: 'payouts', banks: [{ name: 'Capitec Bank', code: '470010' }], bankError: null, values: { bank_code: '470010' }, errors: { form: 'Paystack said no' }, payouts: [{ id: 1, status: 'success', amount: 19200, date: new Date() }, { id: 2, status: 'processing', amount: 9600, date: new Date() }, { id: 3, status: 'pending', amount: 4800, date: null }, { id: 4, status: 'failed', amount: 9600, date: new Date() }], payoutsError: null, earned: 43200, paidOut: 19200, testMode: false },
    { ...sellerBase, title: 'P', tab: 'payouts', banks: [], bankError: null, values: {}, errors: {}, payouts: [], payoutsError: null, earned: 0, paidOut: 0, testMode: true },
    { ...sellerBase, me: { ...seller, paystack_subaccount_code: null }, title: 'P', tab: 'payouts', banks: [], bankError: null, values: {}, errors: {}, payouts: [], payoutsError: null, earned: 0, paidOut: 0, testMode: true },
    { ...sellerBase, title: 'P', tab: 'payouts', banks: [], bankError: null, values: {}, errors: {}, payouts: [], payoutsError: 'Your payout history didn’t load.', earned: 0, paidOut: 0, testMode: false },
  ],
  'seller/note-form': [{ ...sellerBase, title: 'Upload', tab: 'notes', note: null, values: {}, errors: { files: 'x', title: 'y' }, institutions: C.NOTE_INSTITUTIONS, levels: C.LEVELS }, { ...sellerBase, title: 'Edit', tab: 'notes', note, values: { ...note, price: '120.00' }, errors: {}, institutions: C.NOTE_INSTITUTIONS, levels: C.LEVELS }],
  'seller/sales': [{ ...sellerBase, title: 'Sales', tab: 'sales', orders: [order], feeBearer: 'subaccount' }, { ...sellerBase, title: 'Sales', tab: 'sales', orders: [], feeBearer: 'account' }],
  'admin/index': [{ ...adminBase, pendingCount: 2, title: 'Admin', tab: 'overview', totals: { sales: 3, gross: 36000, fees: 7200 }, recent: [order], sellerCount: 1, noteCount: 2, noPayouts: 1, activity: [{ kind: 'webhook.received', detail: { event: 'charge.success', reference: 'ENABC' }, created_at: new Date() }, { kind: 'seller.rejected', actor: 'a@b.c', detail: { name: 'Thandi', reason: 'Blurry' }, created_at: new Date() }, { kind: 'admin.added', actor: 'a@b.c', detail: { email: 'x@y.z' }, created_at: new Date() }, { kind: 'mystery', detail: {}, created_at: new Date() }] }, { ...adminBase, pendingCount: 0, title: 'Admin', tab: 'overview', totals: { sales: 0, gross: 0, fees: 0 }, recent: [], sellerCount: 0, noteCount: 0, noPayouts: 0, activity: null }],
  'admin/verifications': [{ ...adminBase, pendingCount: 1, title: 'Verifications', tab: 'verifications', queue: [{ ...seller, degreeUrl: 'https://x', idUrl: null, verification_note: 'Old reason' }], decided: [{ kind: 'webhook.received', detail: { event: 'charge.success', reference: 'ENABC' }, created_at: new Date() }, { kind: 'seller.rejected', actor: 'a@b.c', detail: { name: 'Thandi', reason: 'Blurry' }, created_at: new Date() }, { kind: 'admin.added', actor: 'a@b.c', detail: { email: 'x@y.z' }, created_at: new Date() }, { kind: 'mystery', detail: {}, created_at: new Date() }] }, { ...adminBase, title: 'Verifications', tab: 'verifications', queue: [], decided: [] }],
  'admin/money': [{ ...adminBase, title: 'Money', tab: 'money', all: { sales: 3, gross: 36000, fees: 7200, payouts: 28800 }, months: [{ label: 'Oct 2026', sales: 3, gross: 36000, fees: 7200, payouts: 28800 }, { label: 'Sep 2026', sales: 0, gross: 0, fees: 0, payouts: 0 }], sellers: [{ id: 's1', name: 'Thandi', sales: 3, gross: 36000, fees: 7200, payouts: 28800, last: new Date() }], noPayouts: [seller], capped: false, feeBearerText: 'paid by EasyNotes' }, { ...adminBase, title: 'Money', tab: 'money', all: { sales: 0, gross: 0, fees: 0, payouts: 0 }, months: [], sellers: [], noPayouts: [], capped: false, feeBearerText: 'x' }],
  'admin/health': [{ ...adminBase, user: { role: 'admin', email: 'a@b.c' }, title: 'Health', tab: 'health', checks: [{ name: 'Database', status: 'ok', detail: 'Connected.' }, { name: 'Paystack', status: 'warn', detail: 'Test key.', fix: 'Switch to live.' }, { name: 'Email', status: 'fail', detail: 'Bad key.', fix: 'New key.' }], app: { node: 'v22', uptime: '5 min', memory: '80 MB', commit: 'abc1234', env: 'production' } }, { ...adminBase, title: 'Health', tab: 'health', checks: [{ name: 'Database', status: 'ok', detail: 'ok' }], app: { node: 'v22', uptime: '1 h', memory: '1 MB', commit: 'local', env: 'development' } }],
  'admin/settings': [{ ...adminBase, user: { id: 'a1', role: 'admin', email: 'a@b.c' }, title: 'Settings', tab: 'settings', admins: [{ id: 'a1', email: 'a@b.c', created_at: new Date() }, { id: 'a2', email: 'x@y.z', created_at: new Date() }], settings: [['Site address', 'https://easynotes.co.za', 'BASE_URL']] }],
  'admin/sellers': [{ ...adminBase, q: '', title: 'Sellers', tab: 'sellers', sellers: [seller], status: 'pending', statuses: ['pending', 'approved', 'rejected', 'unsubmitted'] }],
  'admin/seller': [{ ...adminBase, totals: { sales: 3, earnings: 28800 }, title: 'T', tab: 'sellers', s: { ...seller, verification_note: 'old' }, notes: [note], degreeUrl: 'https://x', idUrl: null }],
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

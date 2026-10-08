// Sellers' education: qualifications they've finished or are still studying, each checked by the team.
const db = require('./supabase');
const storage = require('./storage');
const profanity = require('./profanity');
const { str } = require('./helpers');
const { QUAL_LEVELS, QUAL_RANK, HONOURS, STUDY_YEARS, STUDYING_MIN_RANK, DEGREE_UNIVERSITIES, OTHER_UNIVERSITY } = require('./constants');

const MB = 1024 * 1024;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Checks the education form. `files` holds multer's doc / record uploads.
// allowStudying: false for the first verification (a finished degree is the minimum) and for "I've finished this".
// docOptional: editing an entry, where the documents already on file can be kept.
function validate(body, files, { allowStudying = false, docOptional = false } = {}) {
  const now = new Date();
  const thisYear = now.getFullYear();
  const pickedUni = str(body.institution, 120);
  const status = !allowStudying ? 'completed' : body.status === 'in_progress' ? 'in_progress' : body.status === 'completed' ? 'completed' : '';
  const values = {
    level: QUAL_LEVELS.includes(body.level) ? body.level : '',
    name: str(body.name, 120),
    institution: pickedUni === OTHER_UNIVERSITY ? str(body.institution_other, 120) : pickedUni,
    status,
    year_completed: null,
    current_year: null,
    expected_completion: null,
    honours: Object.prototype.hasOwnProperty.call(HONOURS, body.honours) ? body.honours : 'none',
    average_mark: null,
    distinctions: str(body.distinctions, 160) || null,
  };
  const errors = {};
  if (!values.level) errors.level = 'Choose the level of this qualification.';
  if (values.name.length < 3) errors.name = 'Enter the qualification, e.g. BCom Accounting.';
  if (!values.institution || (pickedUni !== OTHER_UNIVERSITY && !DEGREE_UNIVERSITIES.includes(pickedUni))) errors.institution = 'Choose your institution.';
  if (!status) errors.status = 'Say whether you’ve finished or are still studying.';
  if (status === 'completed') {
    const y = parseInt(body.year_completed, 10);
    if (y >= 1960 && y <= thisYear) values.year_completed = y;
    else errors.year_completed = `Enter a year between 1960 and ${thisYear}.`;
  }
  const avg = String(body.average_mark || '').replace('%', '').trim();
  if (avg) {
    const n = Math.round(Number(avg));
    if (Number.isFinite(n) && n >= 50 && n <= 100) values.average_mark = n;
    else errors.average_mark = 'Enter your average as a number between 50 and 100.';
  }
  // Cum laude and summa cum laude are only awarded once a qualification is finished
  if (status === 'in_progress' && (values.honours === 'cum_laude' || values.honours === 'summa_cum_laude')) {
    errors.honours = 'Cum laude and summa cum laude are awarded when you finish. Choose “Distinction” for Dean’s merit list and similar.';
  }
  if (status === 'in_progress' && values.level && (QUAL_RANK[values.level] || 0) < STUDYING_MIN_RANK) {
    errors.level = 'Only further study, like honours, a master’s or a PhD, can be added while you’re still studying.';
  }
  if (status === 'in_progress') {
    values.current_year = STUDY_YEARS.includes(body.current_year) ? body.current_year : null;
    const m = parseInt(body.expected_month, 10);
    const y = parseInt(body.expected_year, 10);
    const future = y > thisYear || (y === thisYear && m >= now.getMonth() + 1);
    if (m >= 1 && m <= 12 && y >= thisYear && y <= thisYear + 8 && future) values.expected_completion = `${y}-${String(m).padStart(2, '0')}`;
    else errors.expected_completion = 'Choose the month and year you expect to finish.';
  }
  profanity.checkFields(values, ['name', 'institution', 'distinctions'], errors);

  const docs = {};
  const checkFile = (field, required, missing) => {
    const f = files?.[field]?.[0];
    const type = f && storage.detectType(f.buffer);
    if (!f) {
      if (required) errors[field] = missing;
    } else if (!type) errors[field] = 'Upload a PDF, JPG or PNG.';
    else if (f.size > 10 * MB) errors[field] = 'This file is larger than 10 MB.';
    else docs[field] = { file: f, type };
  };
  checkFile('doc', !docOptional, status === 'in_progress' ? 'Upload your proof of registration or latest academic record.' : 'Upload your certificate or academic record.');
  checkFile('record', false);
  return { values: { ...values, institution_picked: pickedUni, institution_other: body.institution_other, expected_month: body.expected_month, expected_year: body.expected_year }, errors, docs };
}

// Stores the uploaded documents privately and returns the row fields for them.
async function saveDocs(sellerId, docs) {
  const stamp = Date.now();
  const out = { doc_path: null, record_path: null };
  if (docs.doc) {
    out.doc_path = `${sellerId}/qual-${stamp}.${docs.doc.type.ext}`;
    await storage.upload('verification', out.doc_path, docs.doc.file.buffer, docs.doc.type.mime);
  }
  if (docs.record) {
    out.record_path = `${sellerId}/record-${stamp}.${docs.record.type.ext}`;
    await storage.upload('verification', out.record_path, docs.record.file.buffer, docs.record.type.mime);
  }
  return out;
}

// The row to insert from validated values (drops the form-only fields).
const rowFrom = (v) => ({
  level: v.level, name: v.name, institution: v.institution, status: v.status, year_completed: v.year_completed,
  current_year: v.current_year, expected_completion: v.expected_completion, honours: v.honours,
  average_mark: v.average_mark, distinctions: v.distinctions,
});

async function forSeller(sellerId, { verifiedOnly = false } = {}) {
  let q = db.from('qualifications').select('*').eq('seller_id', sellerId);
  q = verifiedOnly ? q.eq('review_status', 'approved') : q.neq('review_status', 'superseded');
  const { data } = await q.order('submitted_at', { ascending: false });
  return sortQuals(data || []);
}

// Highest level first; finished before still-studying at the same level; newest first after that.
function sortQuals(list) {
  return list.slice().sort((a, b) =>
    (QUAL_RANK[b.level] || 0) - (QUAL_RANK[a.level] || 0) ||
    (a.status === 'completed' ? 0 : 1) - (b.status === 'completed' ? 0 : 1) ||
    (b.year_completed || 0) - (a.year_completed || 0));
}

// "BCom Accounting (cum laude)" or "BCom Honours (in progress)": the one line shown on note pages.
function headlineOf(quals) {
  const verified = sortQuals(quals.filter((q) => q.review_status === 'approved'));
  const top = verified.find((q) => q.status === 'completed') || verified[0];
  if (!top) return null;
  const extra = top.status === 'in_progress' ? 'in progress' : top.honours !== 'none' ? HONOURS[top.honours].toLowerCase() : '';
  return { degree: top.name + (extra ? ` (${extra})` : ''), university: top.institution, graduation_year: top.status === 'completed' ? top.year_completed : null };
}

// Copies the highest verified qualification onto the seller, where notes and storefronts read it.
async function refreshHeadline(sellerId) {
  const quals = await forSeller(sellerId, { verifiedOnly: true });
  const h = headlineOf(quals);
  if (h) await db.from('sellers').update(h).eq('id', sellerId);
}

// Has the expected finish month of something still being studied gone by?
function isOverdue(q, now = new Date()) {
  if (q.status !== 'in_progress' || !q.expected_completion) return false;
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return q.expected_completion < current;
}

// "Completed 2021", "Studying now · Final year · finishing Nov 2027", or once that date has passed
// without an update, the neutral "Due to finish Nov 2027"
function when(q) {
  if (q.status === 'completed') return q.year_completed ? `Completed ${q.year_completed}` : 'Completed';
  const [y, m] = String(q.expected_completion || '').split('-');
  const month = y ? `${MONTHS[Number(m) - 1] || ''} ${y}`.trim() : '';
  if (isOverdue(q)) return `Due to finish ${month}`;
  return ['Studying now', q.current_year, month && `finishing ${month}`].filter(Boolean).join(' · ');
}

// "78% average · Distinctions in Tax and Auditing"
function results(q) {
  return [q.average_mark ? `${q.average_mark}% average` : '', q.distinctions ? `Distinctions in ${q.distinctions}` : ''].filter(Boolean).join(' · ');
}

const honoursLabel = (q) => HONOURS[q.honours] || '';

// What a seller changed in an entry, in words, for the review queue: [['Average', '78%', '81%'], ...]
const FIELDS = [
  ['level', 'Level', (q) => q.level],
  ['name', 'Qualification', (q) => q.name],
  ['institution', 'Institution', (q) => q.institution],
  ['status', 'Status', (q) => when(q)],
  ['honours', 'Award', (q) => honoursLabel(q) || 'None'],
  ['average_mark', 'Average', (q) => (q.average_mark ? q.average_mark + '%' : 'None')],
  ['distinctions', 'Distinctions in', (q) => q.distinctions || 'None'],
];
function changes(before, after) {
  return FIELDS.map(([, label, show]) => [label, show(before), show(after)]).filter(([, a, b]) => a !== b);
}

// Deletes documents no entry points at any more (an edit can keep using the files of the entry it replaces).
async function removeUnusedFiles(paths) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return;
  const quoted = list.map((p) => `"${p}"`).join(',');
  const { data: still } = await db.from('qualifications').select('doc_path,record_path').or(`doc_path.in.(${quoted}),record_path.in.(${quoted})`);
  const used = new Set((still || []).flatMap((q) => [q.doc_path, q.record_path]));
  await storage.remove('verification', list.filter((p) => !used.has(p)));
}

module.exports = { changes, removeUnusedFiles, validate, saveDocs, rowFrom, forSeller, sortQuals, headlineOf, refreshHeadline, when, results, isOverdue, honoursLabel, MONTHS };

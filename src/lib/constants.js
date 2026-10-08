const UNIVERSITIES = [
  { name: 'University of Cape Town', short: 'UCT', popular: true },
  { name: 'University of the Witwatersrand', short: 'Wits', popular: true },
  { name: 'Stellenbosch University', short: 'Stellenbosch', popular: true },
  { name: 'University of Pretoria', short: 'UP', popular: true },
  { name: 'University of Johannesburg', short: 'UJ', popular: true },
  { name: 'University of KwaZulu-Natal', short: 'UKZN', popular: true },
  { name: 'Nelson Mandela University', short: 'NMU', popular: true },
  { name: 'University of South Africa (UNISA)', short: 'UNISA', popular: true },
  { name: 'Rhodes University', short: 'Rhodes', popular: true },
  { name: 'North-West University', short: 'NWU', popular: true },
  { name: 'University of the Free State', short: 'UFS', popular: true },
  { name: 'University of the Western Cape', short: 'UWC' },
  { name: 'Cape Peninsula University of Technology', short: 'CPUT' },
  { name: 'Durban University of Technology', short: 'DUT' },
  { name: 'Tshwane University of Technology', short: 'TUT' },
  { name: 'Central University of Technology', short: 'CUT' },
  { name: 'Vaal University of Technology', short: 'VUT' },
  { name: 'Mangosuthu University of Technology', short: 'MUT' },
  { name: 'Walter Sisulu University', short: 'WSU' },
  { name: 'University of Fort Hare', short: 'Fort Hare' },
  { name: 'University of Limpopo', short: 'UL' },
  { name: 'University of Venda', short: 'Univen' },
  { name: 'University of Zululand', short: 'UniZulu' },
  { name: 'Sefako Makgatho Health Sciences University', short: 'SMU' },
  { name: 'Sol Plaatje University', short: 'SPU' },
  { name: 'University of Mpumalanga', short: 'UMP' },
  { name: 'Emeris', short: 'Emeris' },
  { name: 'Milpark Education', short: 'Milpark' },
];

const ANY_INSTITUTION = 'Any institution / professional exam';
const PRIVATE_INSTITUTION = 'Private institution';

// Institutions a set of notes can be "for"
const NOTE_INSTITUTIONS = [...UNIVERSITIES.map((u) => u.name), PRIVATE_INSTITUTION, ANY_INSTITUTION];

// Where a seller's degree can be from (an "Other" option lets admins judge foreign universities)
const DEGREE_UNIVERSITIES = UNIVERSITIES.map((u) => u.name);
const OTHER_UNIVERSITY = 'Other (type it in)';

// Education a seller can verify, lowest to highest (the highest verified one is shown on their notes).
// Sellers need a completed degree; only further study above a bachelor's can be added while still in progress.
const QUAL_LEVELS = [
  'Bachelor’s degree',
  'Honours degree or Postgraduate Diploma',
  'Master’s degree',
  'Doctorate (PhD)',
  'Professional qualification',
];
// Professional qualifications (CA(SA), admitted attorney...) rank with honours degrees
const QUAL_RANK = { 'Bachelor’s degree': 3, 'Honours degree or Postgraduate Diploma': 4, 'Professional qualification': 4, 'Master’s degree': 5, 'Doctorate (PhD)': 6 };
const HONOURS = { none: '', merit: 'With merit or distinction', cum_laude: 'Cum laude', summa_cum_laude: 'Summa cum laude' };
const STUDY_YEARS = ['1st year', '2nd year', '3rd year or later', 'Final year'];
const STUDYING_MIN_RANK = 4; // honours / PGDip and up


// Suggested subjects on the upload form. Sellers can add their own; those then show for everyone.
const SUBJECTS = [
  'Accounting', 'Actuarial Science', 'Afrikaans', 'Anatomy', 'Auditing', 'Biochemistry', 'Biology', 'Botany',
  'Business Management', 'Chemistry', 'Civil Engineering', 'Commercial Law', 'Computer Science', 'Constitutional Law',
  'Contract Law', 'Corporate Finance', 'Criminal Law', 'Criminology', 'Economics', 'Education', 'Electrical Engineering',
  'English', 'Environmental Science', 'Financial Accounting', 'Financial Management', 'Geography', 'Geology', 'History',
  'Human Resource Management', 'Industrial Psychology', 'Information Systems', 'isiXhosa', 'isiZulu', 'Law of Delict',
  'Life Sciences', 'Management Accounting', 'Marketing', 'Mathematical Literacy', 'Mathematics', 'Mechanical Engineering',
  'Medicine', 'Microbiology', 'Nursing', 'Pharmacology', 'Philosophy', 'Physical Sciences', 'Physics', 'Physiology',
  'Political Science', 'Private Law', 'Psychology', 'Public Administration', 'Sociology', 'Statistics', 'Supply Chain Management',
  'Taxation', 'Zoology',
];

const LEVELS = ['Undergraduate', 'Honours / postgraduate', 'Professional exam', 'Matric (NSC / IEB)'];

// Storefronts live at /<slug>, so a seller can't take a name the site already uses (or may use later).
const RESERVED_SLUGS = new Set([
  'about', 'account', 'admin', 'api', 'app', 'assets', 'blog', 'browse', 'cart', 'checkout', 'contact', 'css',
  'dashboard', 'download', 'downloads', 'easynotes', 'favicon', 'forgot', 'help', 'healthz', 'how-it-works', 'img', 'js',
  'library', 'login', 'logout', 'note', 'notes', 'pricing', 'privacy', 'copyright', 'report', 'reports', 'register', 'reset', 'robots', 'search', 'sell',
  'seller', 'seller-terms', 'sellers', 'settings', 'signup', 'sitemap', 'static', 'store', 'support', 'terms',
  'webhooks', 'www',
]);

module.exports = { STUDYING_MIN_RANK, QUAL_LEVELS, QUAL_RANK, HONOURS, STUDY_YEARS, SUBJECTS, RESERVED_SLUGS, UNIVERSITIES, NOTE_INSTITUTIONS, DEGREE_UNIVERSITIES, OTHER_UNIVERSITY, LEVELS, ANY_INSTITUTION, PRIVATE_INSTITUTION };

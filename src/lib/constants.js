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
];

const ANY_INSTITUTION = 'Any institution / professional exam';
const PRIVATE_INSTITUTION = 'Private institution';

// Institutions a set of notes can be "for"
const NOTE_INSTITUTIONS = [...UNIVERSITIES.map((u) => u.name), PRIVATE_INSTITUTION, ANY_INSTITUTION];

// Where a seller's degree can be from (an "Other" option lets admins judge foreign universities)
const DEGREE_UNIVERSITIES = UNIVERSITIES.map((u) => u.name);
const OTHER_UNIVERSITY = 'Other (type it in)';

const LEVELS = ['Undergraduate', 'Honours / postgraduate', 'Professional exam', 'Matric (NSC / IEB)'];

// Storefronts live at /<slug>, so a seller can't take a name the site already uses (or may use later).
const RESERVED_SLUGS = new Set([
  'about', 'account', 'admin', 'api', 'app', 'assets', 'blog', 'browse', 'cart', 'checkout', 'contact', 'css',
  'dashboard', 'download', 'downloads', 'easynotes', 'favicon', 'help', 'healthz', 'how-it-works', 'img', 'js',
  'library', 'login', 'logout', 'note', 'notes', 'pricing', 'privacy', 'register', 'robots', 'search', 'sell',
  'seller', 'seller-terms', 'sellers', 'settings', 'signup', 'sitemap', 'static', 'store', 'support', 'terms',
  'webhooks', 'www',
]);

module.exports = { RESERVED_SLUGS, UNIVERSITIES, NOTE_INSTITUTIONS, DEGREE_UNIVERSITIES, OTHER_UNIVERSITY, LEVELS, ANY_INSTITUTION, PRIVATE_INSTITUTION };

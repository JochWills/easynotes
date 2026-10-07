// Catches swearing and slurs in text people type into the site (names, storefronts, note listings).
// Deliberately narrow: this is a study marketplace, so words with real academic uses (rape, sex,
// cum laude, retarded acceleration, assessment...) must never trip it.

// Matched anywhere inside a word ("motherfucker", "bullshit"), unless the word is a known exception.
const STEMS = ['fuck', 'shit', 'cunt', 'nigger', 'nigga', 'kaffir', 'kaffer', 'faggot', 'bitch', 'whore', 'slut', 'asshole', 'arsehole', 'dickhead'];
const STEM_EXCEPTIONS = new Set(['shiitake', 'shitake', 'scunthorpe', 'slutsky', 'snigger', 'sniggered', 'sniggering']); // Slutsky: economics

// Matched as whole words only (plurals and -ing/-ed forms are handled below).
const WORDS = new Set([
  // English
  'bastard', 'bollocks', 'wank', 'wanker', 'twat', 'pussy', 'porn', 'porno', 'fag', 'coon', 'spic', 'chink', 'kike', 'paki', 'tranny', 'jizz',
  'fuk', 'fck', 'fcuk', 'phuck', 'stfu', 'wtf', 'milf',
  // Afrikaans / South African
  'poes', 'fok', 'fokken', 'fokking', 'fokof', 'moffie', 'piel', 'hotnot',
]);

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };

function normalise(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // é -> e
    .toLowerCase()
    .replace(/[013457 8@$!|]/g, (c) => (c === ' ' ? ' ' : LEET[c] || c));
}

// "f u c k", "f.u.c.k" and "f-u-c-k" are joined back into one word.
function tokens(text) {
  const raw = normalise(text).split(/[^a-z*]+/).filter(Boolean);
  const out = [...raw];
  let run = '';
  for (const t of raw.concat([''])) {
    if (t.length === 1) run += t;
    else {
      if (run.length >= 3) out.push(run);
      run = '';
    }
  }
  return out;
}

const variants = (w) => {
  const list = [w, w.replace(/(.)\1{2,}/g, '$1'), w.replace(/(.)\1{2,}/g, '$1$1')]; // fuuuck, assss
  for (const v of list.slice()) for (const suf of ['ing', 'ers', 'er', 'ed', 'es', 's', 'y']) if (v.length > suf.length + 2 && v.endsWith(suf)) list.push(v.slice(0, -suf.length));
  return [...new Set(list)];
};

// "f*ck", "sh!t" (after leet) and "c**t": a * stands in for any letter.
function maskedHit(token) {
  if (!token.includes('*') || token.replace(/\*/g, '').length < 2) return false;
  const re = new RegExp('^' + token.replace(/\*+/g, (m) => `[a-z]{${m.length}}`) + '$');
  return STEMS.some((s) => re.test(s)) || [...WORDS].some((w) => w.length > 3 && re.test(w));
}

function isProfane(text) {
  for (const token of tokens(text)) {
    if (maskedHit(token)) return true;
    const word = token.replace(/\*/g, '');
    const forms = word ? variants(word) : [];
    if (!word || forms.some((v) => STEM_EXCEPTIONS.has(v))) continue;
    for (const v of forms) {
      if (WORDS.has(v)) return true;
      if (STEMS.some((s) => v.includes(s))) return true;
    }
  }
  return false;
}

const MESSAGE = 'Please remove offensive language.';

// Adds an error for each listed field whose value is profane (keeping any error already there).
function checkFields(values, fields, errors) {
  for (const f of fields) if (!errors[f] && values[f] && isProfane(values[f])) errors[f] = MESSAGE;
  return errors;
}

module.exports = { isProfane, checkFields, MESSAGE };

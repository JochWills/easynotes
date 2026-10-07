// Reads an uploaded PDF and flags signs that it may contain someone else's material (lecture
// slides, textbook pages, exam papers, memos). It never blocks an upload: flags show up in
// Admin > Reports for a person to check.
const { openPdf } = require('./preview');

const MAX_PAGES = 40; // enough to judge; keeps big uploads quick

const RULES = [
  // A seller's own "© My Name 2024" is fine; an institution's or publisher's notice isn't.
  { flag: 'Institution or publisher copyright notice', re: /all rights reserved|(©|\(c\)|\bcopyright\b)[^©]{0,80}?\b(university|universiteit|college|institute|faculty|department|school of|press|publish(ing|ers)|\(pty\)|ltd)\b/i },
  { flag: 'Exam or test paper wording', re: /instructions to candidates|answer all (the )?questions|time allowed|total marks|question paper|examination paper|do not turn (this|the) page|examiner'?s? (name|signature)|invigilator/i },
  // "Memorandum of Incorporation" is normal in law notes, so only exam/marking memos count.
  { flag: 'Memo or answer-key wording', re: /marking (guide|scheme|rubric|memo)|answer key|model answers?|suggested solutions?|\bmemo(randum)?\s+(for|to|of)\s+(the\s+)?(\d{4}\s+)?(exam|examination|test|assignment|tutorial|paper|quiz)/i },
  { flag: 'Lecture slide wording', re: /\blecture\s*\d+\b|\blecturer\s*:|\bslide\s*\d+\b|\bweek\s*\d+\s*(lecture|slides)\b/i },
  { flag: 'Textbook or publisher text', re: /\bisbn\b|pearson|mcgraw[- ]?hill|wiley|cengage|oxford university press|cambridge university press|juta\b|lexisnexis|van schaik|sage publications|routledge|elsevier/i },
  { flag: 'Institution study guide or course pack wording', re: /study guide|tutorial letter|course (pack|reader)|learner guide|not for (sale|distribution)|for internal use only/i },
];

async function scanPdf(buffer) {
  const flags = new Set();
  let doc;
  try {
    doc = await openPdf(buffer);
    const pages = Math.min(doc.numPages, MAX_PAGES);
    let text = '';
    let landscape = 0;
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      if (vp.width / vp.height >= 1.25) landscape++;
      const content = await page.getTextContent();
      text += ' ' + content.items.map((it) => it.str || '').join(' ');
      page.cleanup();
    }
    for (const r of RULES) if (r.re.test(text)) flags.add(r.flag);
    if (pages >= 3 && landscape / pages >= 0.6) flags.add('Pages are slide-shaped (landscape)');
    const chars = text.replace(/\s+/g, '').length;
    if (pages >= 2 && chars / pages < 40) flags.add('Little or no text (scanned or photographed pages)');
  } catch (err) {
    console.error('[scan] could not read PDF', err.message);
    return ['Could not be read for checking'];
  } finally {
    if (doc) await doc.destroy().catch(() => {});
  }
  return [...flags];
}

module.exports = { scanPdf };

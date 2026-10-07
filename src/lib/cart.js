// The cart lives in the session cookie as a list of note ids.
const { publicNotes } = require('./queries');
const { isUuid } = require('./helpers');

const MAX_ITEMS = 20;

const ids = (req) => (Array.isArray(req.session.cart) ? req.session.cart.filter(isUuid) : []);

function add(req, noteId) {
  const list = ids(req);
  if (list.includes(noteId)) return 'already';
  if (list.length >= MAX_ITEMS) return 'full';
  req.session.cart = [...list, noteId];
  return 'added';
}

function remove(req, noteId) {
  req.session.cart = ids(req).filter((id) => id !== noteId);
}

function clear(req) {
  req.session.cart = [];
}

// Notes in the cart that can still be bought. Drops any that have since been hidden or removed.
async function load(req) {
  const list = ids(req);
  if (!list.length) return { notes: [], dropped: 0 };
  const { data } = await publicNotes().in('id', list);
  const byId = Object.fromEntries((data || []).map((n) => [n.id, n]));
  const notes = list.map((id) => byId[id]).filter(Boolean);
  if (notes.length !== list.length) req.session.cart = notes.map((n) => n.id);
  return { notes, dropped: list.length - notes.length };
}

module.exports = { MAX_ITEMS, ids, add, remove, clear, load };

function flash(req, type, msg) {
  req.session.flash = { type, msg };
}
module.exports = flash;

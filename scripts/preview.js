// Design preview: serves every page with mock data, no database or keys needed.
// Usage: npm run preview  →  http://localhost:3001  (refresh the browser after editing a view or CSS)
const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'test', 'out');
const port = process.env.PREVIEW_PORT || 3001;

// Real site URL → mock-rendered page in test/out
const routes = [
  [/^\/$/, 'home-0'], [/^\/notes$/, 'browse-0'], [/^\/note\//, 'note-0'], [/^\/s\//, 'storefront-0'],
  [/^\/how-it-works$/, 'how-0'], [/^\/sell$/, 'sell-0'], [/^\/terms$/, 'terms-0'], [/^\/seller-terms$/, 'seller-terms-0'],
  [/^\/privacy$/, 'privacy-0'], [/^\/download$/, 'download-0'], [/^\/login$/, 'login-0'], [/^\/signup$/, 'signup-0'],
  [/^\/checkout\//, 'checkout-complete-0'],
  [/^\/seller$/, 'seller_dashboard-0'], [/^\/seller\/profile$/, 'seller_profile-0'], [/^\/seller\/verification$/, 'seller_verification-0'],
  [/^\/seller\/payouts$/, 'seller_payouts-0'], [/^\/seller\/notes\/new$/, 'seller_note-form-0'], [/^\/seller\/notes\/.+\/edit$/, 'seller_note-form-1'],
  [/^\/seller\/sales$/, 'seller_sales-0'],
  [/^\/admin$/, 'admin_index-0'], [/^\/admin\/sellers$/, 'admin_sellers-0'], [/^\/admin\/sellers\//, 'admin_seller-0'],
  [/^\/admin\/notes$/, 'admin_notes-0'], [/^\/admin\/orders$/, 'admin_orders-0'],
];

// Re-render all templates so edits show up on refresh
function render() {
  try { execFileSync(process.execPath, [path.join(root, 'test', 'render-views.js')], { stdio: 'pipe' }); }
  catch (e) { return String(e.stderr || e.stdout || e.message); }
  return null;
}

const app = express();
app.use(express.static(path.join(root, 'public')));

app.get('/_pages', (req, res) => {
  const err = render();
  const files = fs.readdirSync(outDir).filter(f => f.endsWith('.html')).sort();
  res.send(`<!doctype html><meta charset="utf-8"><title>All pages</title><body style="font-family:system-ui;max-width:640px;margin:2rem auto;padding:0 16px">
    <h1>Every page (mock data)</h1>${err ? `<pre style="color:#b00">${err}</pre>` : ''}
    <ul>${files.map(f => `<li><a href="/_pages/${f}">${f.replace('.html', '')}</a></li>`).join('')}</ul>`);
});

app.get('/_pages/:file', (req, res) => {
  render();
  res.sendFile(path.join(outDir, path.basename(req.params.file)));
});

app.use((req, res) => {
  const err = render();
  if (err) return res.status(500).type('text').send(err);
  const match = routes.find(([re]) => re.test(req.path));
  if (!match) return res.redirect('/_pages');
  res.sendFile(path.join(outDir, match[1] + '.html'));
});

app.listen(port, () => console.log(`Preview running: http://localhost:${port}  (all pages: http://localhost:${port}/_pages)`));

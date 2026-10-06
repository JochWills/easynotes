(function () {
  // Open the download dialog straight after payment
  document.querySelectorAll('dialog[data-autoshow]').forEach(function (d) {
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  });
  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { b.closest('dialog').close(); });
  });

  // Account dropdown: close on outside click or Escape
  document.querySelectorAll('details.profile').forEach(function (d) {
    document.addEventListener('click', function (e) { if (d.open && !d.contains(e.target)) d.open = false; });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && d.open) { d.open = false; d.querySelector('summary').focus(); }
    });
  });

  // Copy buttons
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
        var label = b.textContent;
        b.textContent = 'Copied';
        setTimeout(function () { b.textContent = label; }, 1600);
      });
    });
  });

  // Download buttons: show feedback, re-enable shortly after so another try is possible
  document.querySelectorAll('form[data-download]').forEach(function (f) {
    f.addEventListener('submit', function () {
      var btn = f.querySelector('button[type="submit"]');
      if (!btn) return;
      var label = btn.textContent;
      btn.textContent = 'Starting download…';
      btn.disabled = true;
      setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 4000);
    });
  });

  // Label table cells with their column heading so tables can stack into cards on phones
  document.querySelectorAll('table.data').forEach(function (t) {
    var heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (th) {
      return th.querySelector('.sr-only') ? '' : th.textContent.trim();
    });
    t.querySelectorAll('tbody tr').forEach(function (tr) {
      Array.prototype.forEach.call(tr.children, function (td, i) {
        if (heads[i]) td.setAttribute('data-label', heads[i]);
      });
    });
  });

  // Confirm destructive actions
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Browse filters apply as soon as a dropdown changes
  document.querySelectorAll('form[data-autosubmit] select').forEach(function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
  });

  // "Other" university reveals a text field
  document.querySelectorAll('select[data-other]').forEach(function (s) {
    var target = document.getElementById(s.getAttribute('data-other'));
    if (!target) return;
    var sync = function () { target.hidden = s.value !== s.getAttribute('data-other-value'); };
    s.addEventListener('change', sync);
    sync();
  });

  // Live "you'll earn" calculator on the upload form
  var price = document.querySelector('[data-price]');
  var earn = document.querySelector('[data-earn]');
  if (price && earn) {
    var pct = Number(price.getAttribute('data-fee'));
    var update = function () {
      var v = parseFloat(String(price.value).replace(',', '.'));
      earn.textContent = isFinite(v) && v > 0 ? 'R' + (v * (100 - pct) / 100).toFixed(2) : 'R0.00';
    };
    price.addEventListener('input', update);
    update();
  }

  // Disable submit buttons on upload forms so big PDFs aren't sent twice
  document.querySelectorAll('form[enctype="multipart/form-data"]').forEach(function (f) {
    f.addEventListener('submit', function () {
      f.querySelectorAll('button[type="submit"]').forEach(function (b) {
        setTimeout(function () { b.disabled = true; b.textContent = 'Uploading…'; }, 0);
      });
    });
  });
})();

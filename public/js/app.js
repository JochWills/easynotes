(function () {
  // Thin loading bar while a page that wasn't loaded ahead of time is on its way.
  var bar = document.createElement('div');
  bar.className = 'load-bar';
  bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);
  var startBar = function () { bar.classList.remove('is-loading'); void bar.offsetWidth; bar.classList.add('is-loading'); };
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target === '_blank' || a.hasAttribute('download') || a.origin !== location.origin) return;
    if (a.pathname === location.pathname && a.search === location.search && a.hash) return;
    startBar();
  });
  document.addEventListener('submit', function (e) {
    if (!e.defaultPrevented && !e.target.hasAttribute('data-download')) startBar();
  });
  // Coming back with the Back button: don't leave the bar running.
  window.addEventListener('pageshow', function () { bar.classList.remove('is-loading'); });

  // Open the download dialog straight after payment
  document.querySelectorAll('dialog[data-autoshow]').forEach(function (d) {
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  });
  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { b.closest('dialog').close(); });
  });

  // Notification popups: slide away after 5 seconds (paused while hovered or focused), or on ×
  document.querySelectorAll('[data-toast]').forEach(function (t) {
    var timer;
    var hide = function () {
      t.classList.add('is-hiding');
      setTimeout(function () { t.remove(); }, 400);
    };
    var start = function () { clearTimeout(timer); timer = setTimeout(hide, 5000); };
    var pause = function () { clearTimeout(timer); };
    t.querySelector('.toast-close').addEventListener('click', hide);
    t.addEventListener('mouseenter', pause);
    t.addEventListener('mouseleave', start);
    t.addEventListener('focusin', pause);
    t.addEventListener('focusout', start);
    start();
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

  // Custom dropdowns. The native <select> stays in the form (hidden) and remains the source of truth,
  // so form posts, `required`, and the change listeners below keep working.
  var uid = 0;
  document.querySelectorAll('select:not([multiple]):not([data-native])').forEach(function (sel) {
    var id = 'dd' + (++uid);
    var label = sel.id && document.querySelector('label[for="' + sel.id + '"]');
    if (label && !label.id) label.id = id + '-label';

    var wrap = document.createElement('div');
    wrap.className = 'dd';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('dd-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    btn.id = id + '-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', id + '-list');
    if (label) btn.setAttribute('aria-labelledby', label.id + ' ' + btn.id);
    btn.innerHTML = '<span class="dd-value"></span><svg class="dd-chevron" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    wrap.appendChild(btn);
    if (label) label.addEventListener('click', function (e) { e.preventDefault(); btn.focus(); });

    var pop = document.createElement('div');
    pop.className = 'dd-pop';
    pop.hidden = true;
    var search = null;
    if (sel.options.length > 10) {
      search = document.createElement('input');
      search.type = 'search';
      search.className = 'dd-search';
      search.placeholder = 'Type to search';
      search.setAttribute('aria-label', 'Search options');
      search.setAttribute('aria-controls', id + '-list');
      search.autocomplete = 'off';
      pop.appendChild(search);
    }
    var list = document.createElement('ul');
    list.className = 'dd-list';
    list.id = id + '-list';
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    if (label) list.setAttribute('aria-labelledby', label.id);
    pop.appendChild(list);
    var empty = document.createElement('p');
    empty.className = 'dd-empty';
    empty.textContent = 'No matches';
    empty.hidden = true;
    pop.appendChild(empty);
    wrap.appendChild(pop);

    var items = Array.prototype.map.call(sel.options, function (o, i) {
      var li = document.createElement('li');
      li.id = id + '-o' + i;
      li.setAttribute('role', 'option');
      li.className = 'dd-opt' + (o.value === '' ? ' dd-placeholder' : '');
      li.textContent = o.textContent;
      if (o.disabled) li.setAttribute('aria-disabled', 'true');
      li.addEventListener('mousedown', function (e) { e.preventDefault(); });
      li.addEventListener('click', function () { if (!o.disabled) choose(i); });
      li.addEventListener('mousemove', function () { setActive(i); });
      list.appendChild(li);
      return li;
    });
    var active = -1;

    function visible() { return items.filter(function (li) { return !li.hidden && li.getAttribute('aria-disabled') !== 'true'; }); }
    function render() {
      var o = sel.options[sel.selectedIndex];
      btn.querySelector('.dd-value').textContent = o ? o.textContent : '';
      btn.classList.toggle('is-placeholder', !o || o.value === '');
      items.forEach(function (li, i) { li.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false'); });
    }
    function setActive(i) {
      if (active > -1) items[active].classList.remove('is-active');
      active = i;
      if (i > -1) {
        items[i].classList.add('is-active');
        items[i].scrollIntoView({ block: 'nearest' });
        (search || list).setAttribute('aria-activedescendant', items[i].id);
      }
    }
    function open() {
      if (!pop.hidden) return;
      document.querySelectorAll('.dd.is-open').forEach(function (d) { if (d !== wrap) d.ddClose(); });
      pop.hidden = false;
      wrap.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      var r = btn.getBoundingClientRect();
      wrap.classList.toggle('dd-up', window.innerHeight - r.bottom < 280 && r.top > window.innerHeight - r.bottom);
      setActive(Math.max(sel.selectedIndex, 0));
      if (search && window.matchMedia('(pointer: fine)').matches) search.focus();
      else list.focus();
    }
    function close(refocus) {
      if (pop.hidden) return;
      pop.hidden = true;
      wrap.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      if (search) { search.value = ''; filter(''); }
      if (refocus) btn.focus();
    }
    wrap.ddClose = function () { close(false); };
    function choose(i) {
      var changed = sel.selectedIndex !== i;
      sel.selectedIndex = i;
      render();
      close(true);
      if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function filter(q) {
      q = q.trim().toLowerCase();
      items.forEach(function (li) { li.hidden = q !== '' && li.textContent.toLowerCase().indexOf(q) === -1; });
      var v = visible();
      empty.hidden = v.length > 0;
      setActive(v.length ? items.indexOf(v[0]) : -1);
    }
    function move(step) {
      var v = visible();
      if (!v.length) return;
      var pos = v.indexOf(items[active]);
      setActive(items.indexOf(v[Math.min(v.length - 1, Math.max(0, pos + step))]));
    }
    var typed = '', typedAt = 0;
    function keys(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); pop.hidden ? open() : move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); pop.hidden ? open() : move(-1); }
      else if (e.key === 'Home' && !pop.hidden && e.target !== search) { e.preventDefault(); setActive(items.indexOf(visible()[0])); }
      else if (e.key === 'End' && !pop.hidden && e.target !== search) { e.preventDefault(); var v = visible(); setActive(items.indexOf(v[v.length - 1])); }
      else if (e.key === 'Enter' || (e.key === ' ' && e.target !== search)) {
        e.preventDefault();
        if (pop.hidden) open(); else if (active > -1) choose(active);
      }
      else if (e.key === 'Escape' && !pop.hidden) { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') close(false);
      else if (e.key.length === 1 && e.target !== search && !e.metaKey && !e.ctrlKey) {
        // Type the first letters of an option to jump to it
        typed = Date.now() - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
        typedAt = Date.now();
        var hit = items.findIndex(function (li) { return !li.hidden && li.textContent.toLowerCase().indexOf(typed) === 0; });
        if (hit > -1) { if (pop.hidden) open(); setActive(hit); }
      }
    }
    btn.addEventListener('click', function () { pop.hidden ? open() : close(true); });
    btn.addEventListener('keydown', keys);
    list.addEventListener('keydown', keys);
    if (search) {
      search.addEventListener('keydown', keys);
      search.addEventListener('input', function () { filter(search.value); });
    }
    document.addEventListener('mousedown', function (e) { if (!wrap.contains(e.target)) close(false); });
    sel.addEventListener('focus', function () { btn.focus(); });
    sel.addEventListener('change', render);
    sel.addEventListener('invalid', function () { wrap.classList.add('is-invalid'); });
    render();
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

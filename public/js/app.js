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
    setTimeout(function () { if (!e.defaultPrevented) startBar(); }, 0); // later handlers may cancel the click
  });
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.hasAttribute('data-download') || f.hasAttribute('data-cart-add') || f.hasAttribute('data-cart-remove')) return;
    setTimeout(function () { if (!e.defaultPrevented) startBar(); }, 0);
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
  var setupToast = function (t) {
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
  };
  document.querySelectorAll('[data-toast]').forEach(setupToast);
  var showToast = function (msg, type) {
    document.querySelectorAll('[data-toast]').forEach(function (old) { old.remove(); });
    var t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');
    t.setAttribute('data-toast', '');
    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = type === 'error' ? '!' : '✓';
    var p = document.createElement('p');
    p.textContent = msg;
    var close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    t.append(icon, p, close);
    document.body.appendChild(t);
    setupToast(t);
  };

  // Slide-in cart panel. Links to /cart open it instead (the /cart page stays for browsers without JS).
  var drawer = document.getElementById('cart-drawer');
  var openDrawer = function () {};
  if (drawer && typeof drawer.showModal === 'function' && window.fetch) {
    var body = drawer.querySelector('[data-cart-body]');
    var loadPanel = function () {
      if (!body.children.length) body.innerHTML = '<div class="drawer-loading" aria-label="Loading your cart"><span></span><span></span><span></span></div>';
      return fetch('/cart/panel', { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function (html) { body.innerHTML = html; })
        .catch(function () { location.href = '/cart'; });
    };
    openDrawer = function () {
      drawer.classList.remove('is-closing');
      if (!drawer.open) drawer.showModal();
      loadPanel();
    };
    var closeDrawer = function () {
      if (!drawer.open || drawer.classList.contains('is-closing')) return;
      drawer.classList.add('is-closing');
      var finished = false;
      var finish = function () {
        if (finished) return;
        finished = true;
        drawer.classList.remove('is-closing');
        drawer.close();
      };
      drawer.addEventListener('animationend', function (e) { if (e.target === drawer) finish(); }, { once: true });
      setTimeout(finish, 400);
    };
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a[href]');
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (a.origin !== location.origin || a.pathname !== '/cart' || location.pathname === '/cart') return;
      e.preventDefault();
      openDrawer();
    }, true);
    drawer.querySelector('[data-drawer-close]').addEventListener('click', closeDrawer);
    drawer.addEventListener('click', function (e) { if (e.target === drawer) closeDrawer(); }); // the dimmed area
    drawer.addEventListener('cancel', function (e) { e.preventDefault(); closeDrawer(); }); // Esc
    window.addEventListener('pageshow', function (e) { if (e.persisted && drawer.open) drawer.close(); });

    // Remove from inside the panel without reloading
    drawer.addEventListener('submit', function (e) {
      var f = e.target;
      var id = f.getAttribute('data-cart-remove');
      if (!id) return;
      e.preventDefault();
      var item = f.closest('.drawer-item');
      if (item) item.classList.add('is-removing');
      fetch(f.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams(new FormData(f)),
        credentials: 'same-origin',
      }).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      }).then(function (data) {
        setCartCount(data.count);
        restoreCardButtons(id, f.querySelector('[name=_csrf]').value);
        return loadPanel();
      }).catch(function () { f.submit(); });
    });
  }

  // A note taken out of the cart gets its "Add to cart" button back on any card showing it
  var CART_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2.2l2.1 10.4a1.6 1.6 0 001.6 1.3h8.4a1.6 1.6 0 001.6-1.2L20.5 8H6.1" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9.5" cy="19.5" r="1.4" fill="currentColor"/><circle cx="17" cy="19.5" r="1.4" fill="currentColor"/></svg>';
  var restoreCardButtons = function (id, csrf) {
    document.querySelectorAll('.card-cart.is-in[data-note="' + id + '"]').forEach(function (link) {
      var card = link.closest('.note-card');
      var title = card && card.querySelector('h3 a') ? card.querySelector('h3 a').textContent : 'these notes';
      var f = document.createElement('form');
      f.method = 'post';
      f.action = '/cart/add/' + id;
      f.setAttribute('data-cart-add', '');
      f.setAttribute('data-note', id);
      var token = document.createElement('input');
      token.type = 'hidden';
      token.name = '_csrf';
      token.value = csrf;
      var btn = document.createElement('button');
      btn.className = 'card-cart';
      btn.type = 'submit';
      btn.setAttribute('aria-label', 'Add ' + title + ' to cart');
      btn.innerHTML = CART_ICON;
      btn.appendChild(document.createTextNode('Add to cart'));
      f.append(token, btn);
      link.replaceWith(f);
    });
  };

  // Pages shown from the Back button or preloaded in the background can be out of date: re-check the
  // cart whenever a page becomes visible and fix the count and the card buttons.
  var syncCart = function () {
    if (!window.fetch) return;
    fetch('/cart/state', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        setCartCount(data.ids.length);
        // An old copy of the page can carry an out-of-date form token (logged out and in since): refresh them all
        if (data.csrf) document.querySelectorAll('input[name="_csrf"]').forEach(function (i) { i.value = data.csrf; });
        var token = document.querySelector('input[name="_csrf"]');
        document.querySelectorAll('form[data-cart-add][data-note]').forEach(function (f) {
          var id = f.getAttribute('data-note');
          if (data.ids.indexOf(id) === -1) return;
          var done = document.createElement('a');
          done.className = 'card-cart is-in';
          done.href = '/cart';
          done.textContent = '✓ In cart';
          done.setAttribute('data-note', id);
          f.replaceWith(done);
        });
        document.querySelectorAll('.card-cart.is-in[data-note]').forEach(function (a) {
          var id = a.getAttribute('data-note');
          if (data.ids.indexOf(id) === -1 && token) restoreCardButtons(id, token.value);
        });
      })
      .catch(function () {});
  };
  window.addEventListener('pageshow', function (e) { if (e.persisted) syncCart(); });
  // Back/Forward can also reload an old copy of the page from the browser's cache.
  var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
  if (nav && nav.type === 'back_forward' && !document.prerendering) syncCart();
  document.addEventListener('prerenderingchange', syncCart);

  // Add to cart from a note card without leaving the page (the form still works without JS)
  var setCartCount = function (count) {
    var link = document.querySelector('.cart-link');
    if (!link) return;
    var badge = link.querySelector('.cart-count');
    if (!badge && count) {
      badge = document.createElement('span');
      badge.className = 'cart-count';
      badge.setAttribute('aria-hidden', 'true');
      link.appendChild(badge);
    }
    if (badge && !count) badge.remove();
    else if (badge) badge.textContent = count;
    link.setAttribute('aria-label', 'Cart, ' + count + (count === 1 ? ' item' : ' items'));
  };
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.hasAttribute('data-cart-add') || !window.fetch) return;
    e.preventDefault();
    var btn = f.querySelector('button');
    btn.disabled = true;
    fetch(f.action, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams(new FormData(f)),
      credentials: 'same-origin',
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (data) {
      if (data.result === 'own') {
        btn.disabled = false;
        showToast('You can’t buy your own notes.', 'error');
        return;
      }
      if (data.result === 'full') {
        btn.disabled = false;
        showToast('Your cart is full (' + data.max + ' sets of notes). Check out, then start a new cart.', 'error');
        return;
      }
      setCartCount(data.count);
      var done = document.createElement('a');
      done.className = 'card-cart is-in';
      done.href = '/cart';
      done.textContent = '✓ In cart';
      done.setAttribute('data-note', f.getAttribute('data-note'));
      f.replaceWith(done);
      showToast(data.result === 'already' ? 'That’s already in your cart.' : 'Added to your cart.', 'ok');
    }).catch(function () {
      // Fall back to a normal form post (which handles an expired session, etc.)
      f.submit();
    });
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
        var target = b.querySelector('[data-copy-label]') || b;
        var label = target.textContent;
        target.textContent = 'Copied!';
        b.classList.add('is-copied');
        setTimeout(function () { target.textContent = label; b.classList.remove('is-copied'); }, 1800);
      });
    });
  });

  // Read-only links select in full when tapped, ready to copy by hand
  document.querySelectorAll('[data-select-all]').forEach(function (i) {
    i.addEventListener('focus', function () { i.select(); });
  });

  // Storefront link: the copy button copies the saved link, so it's off while an unsaved change is typed
  document.querySelectorAll('[data-saved-slug]').forEach(function (input) {
    var btn = input.parentNode.querySelector('.copy-in');
    if (!btn) return;
    var label = btn.querySelector('[data-copy-label]');
    input.addEventListener('input', function () {
      var changed = input.value.trim().toLowerCase() !== input.getAttribute('data-saved-slug');
      btn.disabled = changed;
      label.textContent = changed ? 'Save first' : 'Copy';
      btn.title = changed ? 'Save your new link before copying it' : '';
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
    var creatable = sel.hasAttribute('data-creatable'); // the search box can also add a new option
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
    if (sel.options.length > 10 || creatable) {
      search = document.createElement('input');
      search.type = 'search';
      search.className = 'dd-search';
      search.placeholder = creatable ? 'Search, or type a new one' : 'Type to search';
      search.maxLength = 80;
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

    function makeItem(o, i) {
      var li = document.createElement('li');
      li.id = id + '-o' + i;
      li.setAttribute('role', 'option');
      li.className = 'dd-opt' + (o.value === '' ? ' dd-placeholder' : '');
      li.textContent = o.textContent;
      if (o.disabled) li.setAttribute('aria-disabled', 'true');
      li.addEventListener('mousedown', function (e) { e.preventDefault(); });
      li.addEventListener('click', function () { if (!o.disabled) choose(items.indexOf(li)); });
      li.addEventListener('mousemove', function () { setActive(items.indexOf(li)); });
      return li;
    }
    var items = Array.prototype.map.call(sel.options, function (o, i) {
      var li = makeItem(o, i);
      list.appendChild(li);
      return li;
    });
    var active = -1;
    // "Add “…”": the last item, shown while the search text doesn't match an option exactly
    var addLi = null;
    if (creatable) {
      addLi = document.createElement('li');
      addLi.id = id + '-add';
      addLi.setAttribute('role', 'option');
      addLi.className = 'dd-opt dd-add';
      addLi.hidden = true;
      addLi.addEventListener('mousedown', function (e) { e.preventDefault(); });
      addLi.addEventListener('click', function () { choose(items.indexOf(addLi)); });
      addLi.addEventListener('mousemove', function () { setActive(items.indexOf(addLi)); });
      list.appendChild(addLi);
      items.push(addLi);
    }
    var tidy = function (t) { t = t.replace(/\s+/g, ' ').trim().slice(0, 80); return t.charAt(0).toUpperCase() + t.slice(1); };
    function findOption(text) {
      var k = text.toLowerCase();
      return Array.prototype.findIndex.call(sel.options, function (o) { return o.value !== '' && o.value.toLowerCase() === k; });
    }
    function addOption(text) {
      var found = findOption(text);
      if (found > -1) return found;
      var o = new Option(text, text);
      sel.appendChild(o);
      var i = sel.options.length - 1;
      var li = makeItem(o, i);
      list.insertBefore(li, addLi);
      items.splice(items.length - 1, 0, li);
      return i;
    }

    function visible() { return items.filter(function (li) { return !li.hidden && li.getAttribute('aria-disabled') !== 'true'; }); }
    function render() {
      var o = sel.options[sel.selectedIndex];
      btn.querySelector('.dd-value').textContent = o ? o.textContent : '';
      btn.title = o && o.value !== '' ? o.textContent : ''; // full name on hover when it's cut short
      btn.classList.toggle('is-placeholder', !o || o.value === '');
      items.forEach(function (li, i) { li.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false'); });
    }
    function setActive(i) {
      list.querySelectorAll('.is-active').forEach(function (li) { li.classList.remove('is-active'); });
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
      if (addLi && items[i] === addLi) {
        var text = tidy(search.value);
        if (text.length < 2) return;
        i = addOption(text);
      }
      var changed = sel.selectedIndex !== i;
      sel.selectedIndex = i;
      render();
      close(true);
      if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function filter(q) {
      var raw = q;
      q = q.trim().toLowerCase();
      items.forEach(function (li) { if (li !== addLi) li.hidden = q !== '' && li.textContent.toLowerCase().indexOf(q) === -1; });
      if (addLi) {
        var text = tidy(raw);
        addLi.hidden = text.length < 2 || findOption(text) > -1;
        addLi.textContent = '';
        addLi.appendChild(document.createTextNode('Add '));
        var b = document.createElement('strong');
        b.textContent = '“' + text + '”';
        addLi.appendChild(b);
      }
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

  // Unsaved changes: leaving a form someone has edited (a link, another button such as Log out, or
  // closing the tab) asks first, with Save / Don't save. Forms opt in with data-unsaved.
  var unsavedForm = document.querySelector('form[data-unsaved]');
  if (unsavedForm) {
    var snapshot = function () {
      return Array.prototype.map.call(unsavedForm.elements, function (el) {
        if (!el.name || el.name === '_csrf' || el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return '';
        if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : '0';
        if (el.type === 'file') return el.files && el.files.length ? el.files[0].name + el.files[0].size : '';
        return el.value;
      }).join('\u0001');
    };
    // A form sent back with errors holds what the seller typed, none of it saved yet
    var saved = unsavedForm.querySelector('.has-error, .error-text') ? null : snapshot();
    var leaving = false;
    var isDirty = function () { return !leaving && (saved === null || snapshot() !== saved); };
    unsavedForm.addEventListener('submit', function (e) {
      // Only stop warning once the form is really on its way (not blocked by the checks above)
      setTimeout(function () { if (!e.defaultPrevented) leaving = true; }, 0);
    });

    var saveBtn = unsavedForm.querySelector('[data-unsaved-save]') || unsavedForm.querySelector('button[type="submit"]:not([formaction])');
    var dlg = null, proceed = null;
    var ask = function (onLeave) {
      if (typeof HTMLDialogElement !== 'function') return window.confirm('You have unsaved changes. Leave without saving?') && onLeave();
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.className = 'unsaved';
        dlg.setAttribute('aria-labelledby', 'unsaved-title');
        dlg.innerHTML = '<h2 id="unsaved-title">Save your changes?</h2>' +
          '<p>You’ve changed something on this page that hasn’t been saved yet.</p>' +
          '<div class="unsaved-actions">' +
          '<button type="button" class="btn btn-hi" data-act="save"></button>' +
          '<button type="button" class="btn btn-ghost" data-act="discard">Don’t save</button>' +
          '<button type="button" class="linklike" data-act="stay">Keep editing</button></div>';
        dlg.querySelector('[data-act="save"]').textContent = saveBtn ? saveBtn.textContent.trim() : 'Save';
        dlg.addEventListener('click', function (e) {
          var act = e.target.closest('[data-act]');
          if (e.target === dlg) act = { getAttribute: function () { return 'stay'; } }; // click on the backdrop
          if (!act) return;
          var a = act.getAttribute('data-act');
          dlg.close();
          if (a === 'save') {
            if (unsavedForm.requestSubmit) unsavedForm.requestSubmit(saveBtn || undefined); else unsavedForm.submit();
          } else if (a === 'discard') {
            leaving = true;
            if (proceed) proceed();
          }
        });
        document.body.appendChild(dlg);
      }
      proceed = onLeave;
      dlg.showModal();
      dlg.querySelector('[data-act="save"]').focus();
    };

    // Links to another page
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a[href]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (a.target === '_blank' || a.hasAttribute('download') || /^(mailto|tel):/i.test(a.getAttribute('href'))) return;
      var url = new URL(a.href, location.href);
      if (url.pathname === location.pathname && url.search === location.search && url.hash) return; // same-page jump
      if (!isDirty()) return;
      e.preventDefault();
      ask(function () { location.href = a.href; });
    });
    // Other forms on the page (Log out, the cart, the header search...)
    document.addEventListener('submit', function (e) {
      var f = e.target;
      if (f === unsavedForm || e.defaultPrevented || !isDirty()) return;
      e.preventDefault();
      ask(function () { HTMLFormElement.prototype.submit.call(f); });
    }, true);
    // Closing the tab, reloading or Back: browsers only allow their own generic warning here
    window.addEventListener('beforeunload', function (e) {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  // Pop-up forms (e.g. Change bank details). Without JavaScript the open link loads the page with it open.
  document.querySelectorAll('dialog.modal').forEach(function (d) {
    if (typeof d.showModal !== 'function') return;
    var form = d.querySelector('form');
    var reset = function () {
      if (!form || d.querySelector('.has-error')) return; // keep what they typed if it was sent back with errors
      form.reset();
      form.querySelectorAll('select').forEach(function (s) { s.dispatchEvent(new Event('change', { bubbles: true })); });
    };
    if (d.hasAttribute('data-open-on-load')) { d.close(); d.showModal(); }
    document.querySelectorAll('[data-dialog-open="' + d.id + '"]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); d.showModal(); var f = d.querySelector(d.hasAttribute('data-focus') ? d.getAttribute('data-focus') : 'input:not([type=hidden])'); if (f) f.focus(); });
    });
    d.querySelectorAll('[data-dialog-close]').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); d.close(); });
    });
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); }); // click outside
    d.addEventListener('close', function () {
      reset();
      if (/[?&]change=1/.test(location.search)) history.replaceState(null, '', location.pathname);
    });
  });

  // Share pop-up: phones get a "More" option that opens their own share sheet
  document.querySelectorAll('[data-native-share]').forEach(function (b) {
    if (!navigator.share) return;
    b.closest('[data-native-share-item]').hidden = false;
    b.addEventListener('click', function () {
      navigator.share({ title: b.getAttribute('data-share-title'), text: b.getAttribute('data-share-text'), url: b.getAttribute('data-share-url') }).catch(function () {});
    });
  });

  // Refresh button on the seller overview spins while the page reloads
  document.querySelectorAll('[data-refresh]').forEach(function (b) {
    b.addEventListener('click', function () { b.classList.add('is-spinning'); });
  });

  // Confirm destructive actions
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Browse filters apply as soon as a dropdown changes
  document.querySelectorAll('form[data-autosubmit] select, select[form]').forEach(function (s) {
    if (!s.form || !s.form.hasAttribute('data-autosubmit')) return;
    s.addEventListener('change', function () { s.form.submit(); });
  });

  // Main menu on phones and tablets: Esc, choosing a link or growing to desktop width closes it
  var menuToggle = document.getElementById('menu-toggle');
  if (menuToggle) {
    var closeMenu = function () { if (menuToggle.checked) { menuToggle.checked = false; } };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuToggle.checked) { closeMenu(); menuToggle.focus(); }
    });
    document.querySelectorAll('#site-menu a').forEach(function (a) { a.addEventListener('click', closeMenu); });
    window.matchMedia('(min-width: 921px)').addEventListener('change', function (m) { if (m.matches) closeMenu(); });
    window.addEventListener('pageshow', closeMenu); // coming back with the back button
  }

  // Swipeable seller menu: start with the current page in view
  var navCurrent = document.querySelector('.dash-nav [aria-current="page"]');
  if (navCurrent && navCurrent.parentElement.scrollWidth > navCurrent.parentElement.clientWidth) {
    var nav = navCurrent.parentElement;
    nav.scrollLeft = navCurrent.offsetLeft - (nav.clientWidth - navCurrent.offsetWidth) / 2;
  }

  // Phones and tablets: the filter box folds away behind a Filters button
  var filtersToggle = document.querySelector('[data-filters-toggle]');
  if (filtersToggle) {
    var filtersBox = document.getElementById(filtersToggle.getAttribute('aria-controls'));
    document.documentElement.classList.add('filters-js');
    filtersToggle.addEventListener('click', function () {
      var open = filtersToggle.getAttribute('aria-expanded') !== 'true';
      filtersToggle.setAttribute('aria-expanded', String(open));
      filtersBox.classList.toggle('is-open', open);
      if (open) { var first = filtersBox.querySelector('input, button'); if (first) first.focus({ preventScroll: true }); }
    });
  }

  // "Other" university reveals a text field
  document.querySelectorAll('select[data-other]').forEach(function (s) {
    var target = document.getElementById(s.getAttribute('data-other'));
    if (!target) return;
    var sync = function () { target.hidden = s.value !== s.getAttribute('data-other-value'); };
    s.addEventListener('change', sync);
    sync();
  });

  // Education form: show the fields for "finished" or "still studying"
  document.querySelectorAll('[data-qual-form]').forEach(function (f) {
    var update = function () {
      var picked = f.querySelector('input[name="status"]:checked, input[type="hidden"][name="status"]');
      var st = picked ? picked.value : '';
      f.querySelectorAll('[data-when]').forEach(function (el) {
        var on = el.getAttribute('data-when') === st || (!st && el.tagName === 'SPAN' && el.getAttribute('data-when') === 'completed');
        el.hidden = !on;
      });
      // Cum laude / summa are only awarded on finishing
      f.querySelectorAll('[data-completed-only]').forEach(function (el) {
        var off = st === 'in_progress';
        el.hidden = off;
        var r = el.querySelector('input');
        if (off && r.checked) { r.checked = false; var none = f.querySelector('input[name="honours"][value="none"]'); if (none) none.checked = true; }
      });
    };
    f.addEventListener('change', function (e) { if (e.target.name === 'status') update(); });
    update();
  });

  // Live "you'll earn" calculator on the upload form
  var price = document.querySelector('[data-price]');
  var earn = document.querySelector('[data-earn]');
  if (price && earn) {
    var pct = Number(price.getAttribute('data-fee'));
    var update = function () {
      var v = parseFloat(String(price.value).replace(/[R\s]/gi, '').replace(',', '.'));
      earn.textContent = isFinite(v) && v > 0 ? 'R' + (v * (100 - pct) / 100).toFixed(2) : 'R0.00';
    };
    price.addEventListener('input', update);
    update();
  }

  // "What you'd earn" slider on How it works
  document.querySelectorAll('[data-earn-card]').forEach(function (card) {
    var pct = Number(card.getAttribute('data-fee'));
    var range = card.querySelector('input[type="range"]');
    var r = function (n) { return 'R' + n.toFixed(2); };
    var update = function () {
      var p = Number(range.value), fee = Math.round(p * pct) / 100;
      card.querySelector('[data-earn-price]').textContent = 'R' + p;
      card.querySelector('[data-earn-pays]').textContent = r(p);
      card.querySelector('[data-earn-fee]').textContent = r(fee);
      card.querySelector('[data-earn-you]').textContent = r(p - fee);
    };
    range.addEventListener('input', update);
    update();
  });

  // Note page: "Buy now" first opens the email + terms fields, then becomes the Pay button.
  // (Handled on click, before the browser checks the still-hidden required fields.)
  document.querySelectorAll('[data-buy-form]').forEach(function (f) {
    var btn = f.querySelector('[data-buy-btn]');
    var open = function (focus) {
      f.classList.add('is-open');
      f.querySelector('[data-buy-fields]').classList.add('is-revealed');
      f.querySelector('[data-buy-label]').textContent = btn.getAttribute('data-pay-label');
      if (focus) f.querySelector('[data-buy-fields] input').focus();
    };
    btn.addEventListener('click', function (e) {
      if (f.classList.contains('is-open')) return;
      e.preventDefault();
      open(true);
    });
    // Checkout problems send the buyer back to #buy: show the fields again so they can fix them.
    if (location.hash === '#buy') open(false);
  });

  // Note page tabs (all panels show without JS)
  document.querySelectorAll('[data-tabs]').forEach(function (list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    var select = function (tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) tab.focus();
    };
    document.documentElement.classList.add('tabs-on');
    // Storefront tabs have their own address (#reviews, #about) so they can be linked to and survive a reload
    var byHash = function (h) { h = String(h || '').replace('#', ''); return h && tabs.filter(function (t) { return t.getAttribute('data-hash') === h; })[0]; };
    select(byHash(location.hash) || byHash(list.getAttribute('data-initial')) || tabs[0]);
    // Opened straight on a tab (e.g. the review link a seller shares): bring the tabs into view
    if (!location.hash && list.getAttribute('data-initial')) list.scrollIntoView({ block: 'start' });
    window.addEventListener('hashchange', function () { var t = byHash(location.hash); if (t) { select(t); list.scrollIntoView({ block: 'start' }); } });
    document.querySelectorAll('[data-tab-link]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var t = byHash(a.getAttribute('data-tab-link'));
        if (!t) return;
        e.preventDefault();
        select(t);
        history.replaceState(null, '', '#' + t.getAttribute('data-hash'));
        list.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () {
        select(t);
        if (t.hasAttribute('data-hash')) history.replaceState(null, '', i === 0 ? location.pathname + location.search : '#' + t.getAttribute('data-hash'));
      });
      t.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { e.preventDefault(); select(tabs[(i + d + tabs.length) % tabs.length], true); }
      });
    });
  });

  // Note preview viewer: page number, zoom, thumbnails and full screen
  document.querySelectorAll('[data-viewer]').forEach(function (v) {
    var scroller = v.querySelector('[data-viewer-scroll]');
    var stack = v.querySelector('[data-viewer-stack]');
    var pages = Array.prototype.slice.call(v.querySelectorAll('[data-page]'));
    var thumbs = Array.prototype.slice.call(v.querySelectorAll('[data-thumb]'));
    var num = v.querySelector('[data-viewer-page]');

    // If the preview images aren't there (still being made), say so instead of showing empty pages
    var first = pages[0] && pages[0].querySelector('img');
    var broken = function () {
      v.classList.add('is-broken');
      v.querySelector('[data-viewer-missing]').hidden = false;
    };
    if (first) {
      if (first.complete && first.naturalWidth === 0) broken();
      first.addEventListener('error', broken);
    }

    var setCurrent = function (n) {
      num.textContent = n;
      thumbs.forEach(function (t) { t.classList.toggle('is-current', Number(t.getAttribute('data-thumb')) === n); });
    };
    if ('IntersectionObserver' in window) {
      var seen = {};
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { seen[en.target.getAttribute('data-page')] = en.intersectionRatio; });
        var best = 1, max = -1;
        Object.keys(seen).forEach(function (k) { if (seen[k] > max) { max = seen[k]; best = Number(k); } });
        setCurrent(best);
      }, { root: scroller, threshold: [0, 0.25, 0.5, 0.75, 1] });
      pages.forEach(function (p) { io.observe(p); });
    }
    var goTo = function (n) {
      var p = pages[n - 1];
      if (p) scroller.scrollTo({ top: p.offsetTop - stack.offsetTop, behavior: 'smooth' });
      setCurrent(n);
    };
    thumbs.forEach(function (t) {
      t.addEventListener('click', function (e) { e.preventDefault(); goTo(Number(t.getAttribute('data-thumb'))); });
    });

    var levels = [0.75, 1, 1.25, 1.5, 2];
    var at = 1;
    var label = v.querySelector('[data-zoom-level]');
    var out = v.querySelector('[data-zoom="-1"]');
    var inn = v.querySelector('[data-zoom="1"]');
    var zoom = function (d) {
      var ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
      at = Math.max(0, Math.min(levels.length - 1, at + d));
      stack.style.setProperty('--zoom', levels[at]);
      label.textContent = Math.round(levels[at] * 100) + '%';
      out.disabled = at === 0;
      inn.disabled = at === levels.length - 1;
      // Keep roughly the same spot in view once the width transition finishes
      setTimeout(function () { scroller.scrollTop = ratio * scroller.scrollHeight; }, 220);
    };
    out.addEventListener('click', function () { zoom(-1); });
    inn.addEventListener('click', function () { zoom(1); });

    var full = v.querySelector('[data-fullscreen]');
    if (v.requestFullscreen) {
      full.hidden = false;
      full.addEventListener('click', function () {
        if (document.fullscreenElement) document.exitFullscreen();
        else v.requestFullscreen().catch(function () {});
      });
      document.addEventListener('fullscreenchange', function () {
        full.setAttribute('aria-label', document.fullscreenElement === v ? 'Exit full screen' : 'Full screen');
      });
    }
    // Links to #buy inside full screen: leave full screen first so the buy box is visible
    v.querySelectorAll('a[href="#buy"]').forEach(function (a) {
      a.addEventListener('click', function () { if (document.fullscreenElement) document.exitFullscreen(); });
    });
    // The preview is a taste, not a download: no right-click save on the page images
    v.addEventListener('contextmenu', function (e) { if (e.target.closest('.viewer-page, .viewer-thumb')) e.preventDefault(); });
  });

  // Report form: the takedown statement only applies to copyright owners
  document.querySelectorAll('[data-report-form]').forEach(function (f) {
    var box = f.querySelector('[data-takedown-only]');
    var update = function () {
      var picked = f.querySelector('input[name="reason"]:checked');
      box.classList.toggle('js-hide', !picked || picked.value !== 'copyright_mine');
    };
    f.addEventListener('change', update);
    update();
  });

  // Show / hide password (the button stays hidden without JavaScript)
  document.querySelectorAll('[data-pass-toggle]').forEach(function (b) {
    var input = document.getElementById(b.getAttribute('aria-controls'));
    if (!input) return;
    b.hidden = false;
    b.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-pressed', String(show));
      input.focus();
    });
  });

  // Profile picture: show the chosen photo straight away (cropped square, like the saved one will be)
  document.querySelectorAll('[data-avatar-edit]').forEach(function (box) {
    var input = box.querySelector('input[type="file"]');
    var remove = box.querySelector('input[name="remove_avatar"]');
    var form = input.form;
    var slots = form.parentNode.querySelectorAll('[data-avatar-slot]');
    var originals = Array.prototype.map.call(slots, function (s) { return s.innerHTML; });
    var url = null;
    var show = function (src) {
      slots.forEach(function (slot, i) {
        if (!src) { slot.innerHTML = originals[i]; return; }
        var old = slot.querySelector('.avatar');
        var img = document.createElement('img');
        img.className = old ? old.className : 'avatar';
        img.alt = '';
        img.src = src;
        slot.innerHTML = '';
        slot.appendChild(img);
      });
    };
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (url) { URL.revokeObjectURL(url); url = null; }
      if (!file) return show(null);
      var field = box.closest('.field');
      var err = field.querySelector('.error-text');
      if (err) err.remove();
      field.classList.remove('has-error');
      var maxMb = Number(input.getAttribute('data-max-mb'));
      var problem = !/^image\/(jpeg|png|webp)$/.test(file.type) ? 'Use a JPG, PNG or WebP picture.' : file.size > maxMb * 1048576 ? 'That picture is larger than ' + maxMb + ' MB. Choose a smaller one.' : '';
      if (problem) {
        input.value = '';
        field.classList.add('has-error');
        err = document.createElement('span');
        err.className = 'error-text';
        err.textContent = problem;
        field.appendChild(err);
        return show(null);
      }
      if (remove) remove.checked = false;
      url = URL.createObjectURL(file);
      show(url);
    });
    if (remove) remove.addEventListener('change', function () {
      if (remove.checked) {
        input.value = '';
        slots.forEach(function (slot) {
          var old = slot.querySelector('.avatar');
          var div = document.createElement('div');
          div.className = old ? old.className : 'avatar';
          div.setAttribute('aria-hidden', 'true');
          div.textContent = box.getAttribute('data-initials') || '';
          slot.innerHTML = '';
          slot.appendChild(div);
        });
      } else show(null);
    });
  });

  // Sign up: the storefront name box only shows when it should differ from the seller's own name
  document.querySelectorAll('[data-same-name]').forEach(function (f) {
    var box = f.querySelector('input[name="same_name"]');
    var wrap = f.querySelector('[data-store-name]');
    var update = function () {
      wrap.hidden = box.checked;
      if (!box.checked) { var i = wrap.querySelector('input'); if (!i.value) setTimeout(function () { i.focus(); }, 0); }
    };
    box.addEventListener('change', update);
    wrap.hidden = box.checked;
  });

  // Password strength bar on sign up: a rough guide only (the server just needs 8+ characters)
  document.querySelectorAll('[data-pass-meter]').forEach(function (input) {
    var meter = document.getElementById(input.getAttribute('data-pass-meter'));
    if (!meter) return;
    var label = meter.querySelector('.pass-label');
    var names = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];
    var score = function (p) {
      if (p.length < 8) return 0;
      var kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(function (r) { return r.test(p); }).length;
      var s = 1;
      if (p.length >= 12) s++;
      if (p.length >= 16) s++;
      if (kinds >= 3) s++;
      if (/^(.)\1+$/.test(p) || /^(password|12345678|qwerty)/i.test(p)) s = 1;
      return Math.min(s, 4);
    };
    var update = function () {
      var p = input.value;
      meter.hidden = !p;
      var s = score(p);
      meter.setAttribute('data-score', s);
      label.textContent = names[s];
    };
    input.addEventListener('input', update);
    update();
  });

  // PDF drop zone: drag a file on, or click to choose; shows the chosen file's name and size
  var fmtSize = function (n) { return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; };
  document.querySelectorAll('[data-dropzone]').forEach(function (zone) {
    var input = zone.querySelector('input[type="file"]');
    var empty = zone.querySelector('.dropzone-empty');
    var chosen = zone.querySelector('.dropzone-chosen');
    var update = function () {
      var file = input.files && input.files[0];
      zone.classList.toggle('has-file', !!file);
      empty.hidden = !!file;
      chosen.hidden = !file;
      if (file) {
        chosen.querySelector('[data-file-name]').textContent = file.name;
        chosen.querySelector('[data-file-meta]').textContent = fmtSize(file.size) + ' · click to change';
      }
    };
    input.addEventListener('change', update);
    ['dragenter', 'dragover'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add('is-over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { zone.addEventListener(t, function () { zone.classList.remove('is-over'); }); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      try { input.files = e.dataTransfer.files; } catch (err) { return; }
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    update();
  });

  // Character count under "What's covered"
  document.querySelectorAll('[data-counter]').forEach(function (el) {
    var out = document.getElementById(el.getAttribute('data-counter'));
    var min = Number(el.getAttribute('data-min')) || 0;
    var max = Number(el.getAttribute('maxlength')) || 0;
    var update = function () {
      var n = el.value.trim().length;
      var short = n < min;
      out.classList.toggle('is-short', short && n > 0);
      out.textContent = short ? (min - n) + ' more characters needed' : n.toLocaleString('en-US') + ' / ' + max.toLocaleString('en-US');
    };
    el.addEventListener('input', update);
    update();
  });

  // Upload form: check the fields before sending, so a big PDF isn't uploaded only to be sent back
  // (the server checks everything again; these messages match its own)
  document.querySelectorAll('[data-note-form]').forEach(function (f) {
    var setError = function (el, msg) {
      var field = el.closest('.field');
      var box = el.closest('.declaration') || field;
      var old = field.querySelector('.error-text');
      if (old) old.remove();
      box.classList.toggle('has-error', !!msg);
      if (field !== box) field.classList.toggle('has-error', !!msg);
      if (msg) {
        var s = document.createElement('span');
        s.className = 'error-text';
        s.textContent = msg;
        field.appendChild(s);
      }
    };
    var check = function (el) {
      var v = el.type === 'checkbox' ? el.checked : el.value.trim();
      if (el.type === 'checkbox') return v ? '' : el.getAttribute('data-msg');
      if (el.type === 'file') {
        var file = el.files && el.files[0];
        if (!file) return el.required ? 'Choose the PDF of your notes.' : '';
        if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return 'This file isn’t a PDF. Export your notes as PDF and try again.';
        if (file.size > Number(el.getAttribute('data-max-mb')) * 1048576) return 'This PDF is ' + fmtSize(file.size) + '. The limit is ' + el.getAttribute('data-max-mb') + ' MB: try exporting it with smaller images.';
        return '';
      }
      if (el.hasAttribute('data-price')) {
        var p = parseFloat(v.replace(/[R\s]/gi, '').replace(',', '.'));
        var lo = Number(el.getAttribute('data-price-min')) || 25, hi = Number(el.getAttribute('data-price-max')) || 500;
        return isFinite(p) && p >= lo && p <= hi ? '' : 'Set a price between R' + lo + ' and R' + hi + '.';
      }
      var min = Number(el.getAttribute('data-min')) || (el.required ? 1 : 0);
      return v.length < min ? el.getAttribute('data-msg') : '';
    };
    var fields = function () { return f.querySelectorAll('[data-msg], [data-price], input[type="file"]'); };
    // Clear a field's error as soon as it's fixed
    f.addEventListener('input', function (e) { if (e.target.closest('.has-error') && !check(e.target)) setError(e.target, ''); });
    f.addEventListener('change', function (e) {
      if (!e.target.matches('[data-msg], [data-price], input[type="file"]')) return;
      var msg = check(e.target);
      if (e.target.type === 'file' || !msg) setError(e.target, msg);
    });
    f.addEventListener('submit', function (e) {
      var first = null;
      fields().forEach(function (el) {
        var msg = check(el);
        setError(el, msg);
        if (msg && !first) first = el;
      });
      if (!first) return;
      e.preventDefault();
      var target = first.closest('.field') || first;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      first.focus({ preventScroll: true });
    });
  });

  // Disable submit buttons on upload forms so big PDFs aren't sent twice
  document.querySelectorAll('form[enctype="multipart/form-data"]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      setTimeout(function () {
        if (e.defaultPrevented) return;
        f.querySelectorAll('button[type="submit"]').forEach(function (b) {
          b.disabled = true;
          if (b === e.submitter || !e.submitter) b.textContent = f.querySelector('input[type="file"]') && f.querySelector('input[type="file"]').files.length ? 'Uploading…' : 'Saving…';
        });
      }, 0);
    });
  });
})();

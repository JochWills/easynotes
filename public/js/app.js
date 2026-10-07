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
    var f = e.target;
    if (!e.defaultPrevented && !f.hasAttribute('data-download') && !f.hasAttribute('data-cart-add') && !f.hasAttribute('data-cart-remove')) startBar();
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
    btn.addEventListener('click', function (e) {
      if (f.classList.contains('is-open')) return;
      e.preventDefault();
      f.classList.add('is-open');
      f.querySelector('[data-buy-fields]').classList.add('is-revealed');
      f.querySelector('[data-buy-label]').textContent = btn.getAttribute('data-pay-label');
      f.querySelector('[data-buy-fields] input').focus();
    });
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
    select(tabs[0]);
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t); });
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

  // Disable submit buttons on upload forms so big PDFs aren't sent twice
  document.querySelectorAll('form[enctype="multipart/form-data"]').forEach(function (f) {
    f.addEventListener('submit', function () {
      f.querySelectorAll('button[type="submit"]').forEach(function (b) {
        setTimeout(function () { b.disabled = true; b.textContent = 'Uploading…'; }, 0);
      });
    });
  });
})();

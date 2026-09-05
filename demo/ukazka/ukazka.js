/*
 * ukazka.js
 *
 * Storefront of "Dobrá domácnosť", the fictional Slovak demo shop for ARLing
 * Asistent. Reads feed.xml (the same Heureka XML the worker ingested for the
 * demo tenant) in the browser, renders the category list and one product row
 * per SHOPITEM (anchor id "p-<ITEM_ID>", which is where the widget's product
 * links point), and wires the four suggested-question buttons to the
 * widget's public API (window.ArlingAsistent.ask, see widget/widget.js).
 * No build step, no inline script (CSP script-src 'self'), no dependencies.
 * Every value from the feed goes into the DOM through textContent or
 * setAttribute, never innerHTML.
 */
(function () {
  'use strict';

  var CATEGORIES = ['Kuchyňa', 'Kávovary a čaj', 'Záhrada', 'Upratovanie', 'Deti', 'Darčeky'];

  function slug(name) {
    return String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function text(node, tag) {
    var el = node.getElementsByTagName(tag)[0];
    return el && el.textContent ? el.textContent.trim() : '';
  }

  function formatPrice(raw) {
    var n = Number(String(raw).replace(',', '.'));
    if (!isFinite(n)) return String(raw);
    return n.toFixed(2).replace('.', ',') + ' €';
  }

  function availability(deliveryDate) {
    var d = String(deliveryDate || '').trim();
    if (d === '0') return { label: 'Skladom', cls: 'ok' };
    if (/^\d+$/.test(d)) return { label: 'Do ' + d + ' dní', cls: 'wait' };
    return { label: 'Na objednávku', cls: 'wait' };
  }

  function parseFeed(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('feed_parse_error');
    var items = doc.getElementsByTagName('SHOPITEM');
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var cat = text(it, 'CATEGORYTEXT').split('|').map(function (s) { return s.trim(); });
      var params = [];
      var pnodes = it.getElementsByTagName('PARAM');
      for (var j = 0; j < pnodes.length; j++) {
        var name = text(pnodes[j], 'PARAM_NAME');
        var val = text(pnodes[j], 'VAL');
        if (name && val) params.push(name + ': ' + val);
      }
      out.push({
        id: text(it, 'ITEM_ID'),
        name: text(it, 'PRODUCTNAME'),
        description: text(it, 'DESCRIPTION'),
        price: text(it, 'PRICE_VAT'),
        image: text(it, 'IMGURL'),
        brand: text(it, 'MANUFACTURER'),
        category: cat[0] || '',
        subcategory: cat[1] || '',
        delivery: text(it, 'DELIVERY_DATE'),
        params: params,
      });
    }
    return out;
  }

  function el(tag, cls, content) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (content != null) node.textContent = content;
    return node;
  }

  function renderProduct(p) {
    var row = el('article', 'product');
    row.id = 'p-' + p.id.replace(/[^A-Za-z0-9_-]/g, '');

    var img = document.createElement('img');
    img.className = 'product-img';
    img.setAttribute('loading', 'lazy');
    img.setAttribute('width', '96');
    img.setAttribute('height', '96');
    img.alt = '';
    img.src = 'img/' + encodeURIComponent(p.id) + '.svg';
    row.appendChild(img);

    var body = el('div', 'product-body');
    body.appendChild(el('h3', 'product-name', p.name));
    var meta = el('p', 'product-meta');
    meta.appendChild(el('span', null, p.brand));
    if (p.subcategory) {
      meta.appendChild(document.createTextNode(' · '));
      meta.appendChild(el('span', null, p.subcategory));
    }
    meta.appendChild(document.createTextNode(' · '));
    meta.appendChild(el('span', 'product-id', p.id));
    body.appendChild(meta);
    body.appendChild(el('p', 'product-desc', p.description));
    if (p.params.length) body.appendChild(el('p', 'product-params', p.params.join(' · ')));
    row.appendChild(body);

    var side = el('div', 'product-side');
    side.appendChild(el('span', 'product-price', formatPrice(p.price)));
    var av = availability(p.delivery);
    side.appendChild(el('span', 'product-avail product-avail-' + av.cls, av.label));
    side.appendChild(el('span', 'product-noshop', 'ukážka, nedá sa kúpiť'));
    row.appendChild(side);
    return row;
  }

  function render(products) {
    var byCat = {};
    products.forEach(function (p) { (byCat[p.category] = byCat[p.category] || []).push(p); });
    var order = CATEGORIES.slice();
    Object.keys(byCat).forEach(function (c) { if (order.indexOf(c) < 0) order.push(c); });

    var catList = document.getElementById('categories');
    var main = document.getElementById('catalogue');
    catList.textContent = '';
    main.textContent = '';

    var n = 0;
    order.forEach(function (cat) {
      var list = byCat[cat];
      if (!list || !list.length) return;
      n += 1;
      var id = 'k-' + slug(cat);

      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#' + id;
      a.textContent = cat;
      var count = el('span', 'cat-count', ' ' + list.length);
      a.appendChild(count);
      li.appendChild(a);
      catList.appendChild(li);

      var section = el('section', 'cat');
      section.id = id;
      var wrap = el('div', 'wrap');
      wrap.appendChild(el('p', 'kicker', String(n).padStart(2, '0')));
      var h2 = el('h2', null, cat);
      wrap.appendChild(h2);
      wrap.appendChild(el('p', 'sub', list.length + (list.length === 1 ? ' výrobok' : list.length < 5 ? ' výrobky' : ' výrobkov')));
      var listEl = el('div', 'products');
      list.forEach(function (p) { listEl.appendChild(renderProduct(p)); });
      wrap.appendChild(listEl);
      section.appendChild(wrap);
      main.appendChild(section);
    });

    var total = document.getElementById('product-total');
    if (total) total.textContent = String(products.length);
    document.documentElement.setAttribute('data-products', String(products.length));

    // The widget's product links open this page at #p-<ITEM_ID>; the rows only
    // exist after this render, so re-apply the hash the browser could not
    // scroll to on load.
    if (location.hash && /^#p-[A-Za-z0-9_-]+$/.test(location.hash)) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('is-target');
      }
    }
  }

  function showError() {
    var main = document.getElementById('catalogue');
    main.textContent = '';
    var wrap = el('div', 'wrap');
    wrap.appendChild(el('p', 'feed-error', 'Feed výrobkov sa nepodarilo načítať. Otvorte feed.xml priamo, alebo skúste stránku obnoviť.'));
    main.appendChild(wrap);
  }

  // Suggested questions (Umami counts the clicks itself through the buttons'
  // data-umami-event attributes): hand the text to the widget. If the widget has not
  // booted yet (slow network), retry a few times, then give up quietly: the
  // question stays visible as text and the visitor can type it.
  function ask(question, tries) {
    var api = window.ArlingAsistent;
    if (api && typeof api.ask === 'function') {
      api.ask(question);
      return;
    }
    if (tries > 0) setTimeout(function () { ask(question, tries - 1); }, 300);
  }

  var buttons = document.querySelectorAll('button[data-q]');
  for (var b = 0; b < buttons.length; b++) {
    buttons[b].addEventListener('click', function (evt) {
      var q = evt.currentTarget.getAttribute('data-q') || '';
      ask(q, 10);
    });
  }

  var openBtn = document.getElementById('open-widget');
  if (openBtn) {
    openBtn.addEventListener('click', function () {
      var api = window.ArlingAsistent;
      if (api && typeof api.open === 'function') api.open();
    });
  }

  fetch('feed.xml', { cache: 'no-cache' })
    .then(function (res) {
      if (!res.ok) throw new Error('feed_http_' + res.status);
      return res.text();
    })
    .then(function (xml) { render(parseFeed(xml)); })
    .catch(function () { showError(); });
})();

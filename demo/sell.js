/*
 * sell.js
 *
 * Paper Sell shared bits for this page: a privacy-safe "someone clicked the
 * main CTA" beacon to the owner, and the mobile sticky trial bar (shows
 * after the hero, closable, remembered for the tab via sessionStorage).
 *
 * This page's CSP (see the meta tag in index.html) has no 'unsafe-inline'
 * in script-src, same as app.js already notes, so this logic lives in its
 * own small file instead of an inline <script> block.
 */
(function () {
  'use strict';

  var SLUG = 'asistent';

  function pingOwner(evt, plan) {
    try {
      var url = 'https://homelab.tailbf8f27.ts.net/subscribe/api/ping?e=' + encodeURIComponent(evt) + '&t=' + SLUG + (plan ? '&p=' + encodeURIComponent(plan) : '');
      if (navigator.sendBeacon) { navigator.sendBeacon(url); }
      else if (window.fetch) { fetch(url, { keepalive: true, mode: 'no-cors' }).catch(function () {}); }
    } catch (e) {}
  }

  document.querySelectorAll('[data-umami-event="buy_click"],[data-umami-event="trial_click"],[data-umami-event="download_click"],[data-umami-event="bundle_click"]').forEach(function (el) {
    el.addEventListener('click', function () {
      pingOwner(el.getAttribute('data-umami-event'), el.getAttribute('data-umami-event-plan') || '');
    });
  });

  // Sticky mobile CTA bar: shows after the hero, closable, remembered per tab.
  var bar = document.getElementById('sticky-cta');
  if (bar) {
    var KEY = 'arling_sticky_closed_' + SLUG;
    var closeBtn = document.getElementById('sticky-cta-close');
    var hero = document.querySelector('.hero');
    var isClosed = function () { try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } };
    var onScroll = function () {
      if (isClosed()) { bar.hidden = true; return; }
      var pastHero = !hero || hero.getBoundingClientRect().bottom <= 0;
      bar.hidden = !pastHero;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
        bar.hidden = true;
      });
    }
  }
})();

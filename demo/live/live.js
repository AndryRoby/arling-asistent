/* Live demo page: reads ?t=<tenant id>&shop=<domain> and mounts the ARLing Asistent widget
   for that tenant. Texts follow the visitor's browser language (sk, cs, de, en). */
(function () {
  var q = new URLSearchParams(location.search);
  var tenant = (q.get('t') || '').replace(/[^A-Za-z0-9-]/g, '');
  var shop = (q.get('shop') || '').replace(/[^A-Za-z0-9.-]/g, '');
  var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  var lang = ['sk', 'cs', 'de', 'en'].indexOf(nav) >= 0 ? nav : 'en';
  var T = {
    sk: { title: 'Živé demo ARLing Asistenta', lead: 'Asistent nižšie odpovedá z verejného produktového feedu tohto obchodu. Nič, čo napíšete, sa neukladá.', try: 'Skúste sa opýtať na produkt, cenu alebo čo sa hodí na váš účel. Chat je vpravo dole.', cta: 'Chcete ARLing Asistenta pre svoj e-shop? Nastavenie z feedu za 10 minút, zadarmo do 100 rozhovorov mesačne.', missing: 'V odkaze chýba id ukážky. Otvorte demo zo stránky, ktorá ho vytvorila, alebo si spravte vlastné na arling.sk/asistent.' },
    cs: { title: 'Živé demo ARLing Asistenta', lead: 'Asistent níže odpovídá z veřejného produktového feedu tohoto obchodu. Nic, co napíšete, se neukládá.', try: 'Zkuste se zeptat na produkt, cenu nebo co se hodí pro váš účel. Chat je vpravo dole.', cta: 'Chcete ARLing Asistenta pro svůj e-shop? Nastavení z feedu za 10 minut, zdarma do 100 konverzací měsíčně.', missing: 'V odkazu chybí id ukázky. Otevřete demo ze stránky, která ho vytvořila, nebo si udělejte vlastní na arling.sk/asistent.' },
    de: { title: 'Live-Demo von ARLing Asistent', lead: 'Der Assistent unten antwortet aus dem öffentlichen Produktfeed dieses Shops. Nichts, was Sie schreiben, wird gespeichert.', try: 'Fragen Sie nach einem Produkt, einem Preis oder was zu Ihrem Bedarf passt. Der Chat öffnet sich unten rechts.', cta: 'ARLing Asistent für den eigenen Shop: in 10 Minuten aus dem Feed eingerichtet, kostenlos bis 100 Gespräche im Monat.', missing: 'Im Link fehlt die Demo-ID. Öffnen Sie die Demo von der Seite, die sie erstellt hat, oder starten Sie Ihre eigene auf arling.sk/asistent.' },
    en: { title: 'Live demo of ARLing Asistent', lead: 'The assistant below answers from this shop\'s public product feed. Nothing you type is stored.', try: 'Try it: ask about a product, a price, or what fits your need. Chat opens in the bottom right corner.', cta: 'Get ARLing Asistent for your own shop: set up from your feed in 10 minutes, free up to 100 conversations a month.', missing: 'No tenant id in the link. Open the demo from the page that created it, or start your own at arling.sk/asistent.' }
  };
  var t = T[lang];
  document.documentElement.lang = lang;
  var title = document.getElementById('title');
  title.textContent = t.title + (shop ? ': ' + shop : '');
  document.getElementById('lead').textContent = t.lead;
  document.getElementById('try').textContent = t.try;
  var cta = document.getElementById('cta');
  cta.textContent = '';
  var a = document.createElement('a');
  a.href = 'https://arling.sk/asistent/';
  a.textContent = t.cta;
  cta.appendChild(a);
  if (!tenant) {
    var m = document.getElementById('missing');
    m.textContent = t.missing;
    m.hidden = false;
    return;
  }
  var s = document.createElement('script');
  s.src = '../widget.js';
  s.setAttribute('data-tenant', tenant);
  s.setAttribute('data-lang', 'auto');
  s.setAttribute('data-endpoint', 'https://arling-asistent.arling.workers.dev');
  s.setAttribute('data-title', shop ? shop : 'ARLing Asistent');
  s.defer = true;
  document.body.appendChild(s);
})();

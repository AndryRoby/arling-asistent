/* Live demo page: reads ?t=<tenant id> and mounts the ARLing Asistent widget
   for that tenant. Texts follow the visitor's browser language (sk, cs, de, en).
   Staršia kópia stránky z hubu (products/arling-sk/asistent/live/live.js). Bezpečnostná kontrola
   29. 9. 2026 (nález 4): meno obchodu už nie z odkazu (?shop=), ale zo servera, a widget len pre
   obchod, ktorý ukážku dovolí: ukážkový obchod, skúška z tohto prehliadača alebo live_demo či
   outreach_demo v GET /v1/tenants/:id/status (rovnaké pravidlo ako v hube). */
(function () {
  var q = new URLSearchParams(location.search);
  var tenant = (q.get('t') || '').replace(/[^A-Za-z0-9-]/g, '');
  var shop = '';
  var ENDPOINT = 'https://arling-asistent.arling.workers.dev';
  var DEMO_TENANT = 'ce535d37-f297-4b43-89dd-30aa7b6301dd';
  var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  var lang = ['sk', 'cs', 'de', 'en'].indexOf(nav) >= 0 ? nav : 'en';
  var T = {
    sk: { title: 'Živé demo ARLing Asistenta', lead: 'Asistent nižšie odpovedá z verejného produktového feedu tohto obchodu. Nič, čo napíšete, sa neukladá.', try: 'Skúste sa opýtať na produkt, cenu alebo čo sa hodí na váš účel. Chat je vpravo dole.', cta: 'Chcete ARLing Asistenta pre svoj e-shop? Nastavenie z feedu za 10 minút, zadarmo do 100 rozhovorov mesačne.', missing: 'V odkaze chýba id ukážky. Otvorte demo zo stránky, ktorá ho vytvorila, alebo si spravte vlastné na arling.sk/asistent.', nepovolena: 'Túto ukážku tu nevieme ukázať. Živá ukážka beží len pre obchod, ktorý si ju sám vytvoril, alebo z odkazu, ktorý ste dostali od nás. Vyskúšajte Asistenta na vlastnom feede na arling.sk/asistent.' },
    cs: { title: 'Živé demo ARLing Asistenta', lead: 'Asistent níže odpovídá z veřejného produktového feedu tohoto obchodu. Nic, co napíšete, se neukládá.', try: 'Zkuste se zeptat na produkt, cenu nebo co se hodí pro váš účel. Chat je vpravo dole.', cta: 'Chcete ARLing Asistenta pro svůj e-shop? Nastavení z feedu za 10 minut, zdarma do 100 konverzací měsíčně.', missing: 'V odkazu chybí id ukázky. Otevřete demo ze stránky, která ho vytvořila, nebo si udělejte vlastní na arling.sk/asistent.', nepovolena: 'Tuto ukázku tu neumíme zobrazit. Živá ukázka běží jen pro obchod, který si ji sám vytvořil, nebo z odkazu, který jste dostali od nás. Vyzkoušejte Asistenta na vlastním feedu na arling.sk/asistent.' },
    de: { title: 'Live-Demo von ARLing Asistent', lead: 'Der Assistent unten antwortet aus dem öffentlichen Produktfeed dieses Shops. Nichts, was Sie schreiben, wird gespeichert.', try: 'Fragen Sie nach einem Produkt, einem Preis oder was zu Ihrem Bedarf passt. Der Chat öffnet sich unten rechts.', cta: 'ARLing Asistent für den eigenen Shop: in 10 Minuten aus dem Feed eingerichtet, kostenlos bis 100 Gespräche im Monat.', missing: 'Im Link fehlt die Demo-ID. Öffnen Sie die Demo von der Seite, die sie erstellt hat, oder starten Sie Ihre eigene auf arling.sk/asistent.', nepovolena: 'Diese Demo können wir hier nicht zeigen. Die Live-Demo läuft nur für einen Shop, der sie selbst erstellt hat, oder über einen Link, den Sie von uns bekommen haben. Testen Sie den Assistenten mit Ihrem eigenen Feed auf arling.sk/asistent.' },
    en: { title: 'Live demo of ARLing Asistent', lead: 'The assistant below answers from this shop\'s public product feed. Nothing you type is stored.', try: 'Try it: ask about a product, a price, or what fits your need. Chat opens in the bottom right corner.', cta: 'Get ARLing Asistent for your own shop: set up from your feed in 10 minutes, free up to 100 conversations a month.', missing: 'No tenant id in the link. Open the demo from the page that created it, or start your own at arling.sk/asistent.', nepovolena: 'We cannot show this demo here. The live demo runs only for a shop that created it itself, or from a link you received from us. Try the assistant on your own feed at arling.sk/asistent.' }
  };
  var t = T[lang];
  document.documentElement.lang = lang;
  var title = document.getElementById('title');
  title.textContent = t.title;
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
  function vlastnaSkuska(id) {
    try {
      var zoznam = JSON.parse(window.localStorage.getItem('arling_asistent_skusky') || '[]');
      return Array.isArray(zoznam) && zoznam.indexOf(id) >= 0;
    } catch (e) {
      return false;
    }
  }
  function nacitaj(data) {
    shop = String((data && data.domain) || '').replace(/[^A-Za-z0-9.-]/g, '');
    if (shop) title.textContent = t.title + ': ' + shop;
    var s = document.createElement('script');
    s.src = '../widget.js';
    s.setAttribute('data-tenant', tenant);
    s.setAttribute('data-lang', 'auto');
    s.setAttribute('data-endpoint', ENDPOINT);
    s.setAttribute('data-title', shop ? shop : 'ARLing Asistent');
    s.defer = true;
    document.body.appendChild(s);
  }
  function nepovolena() {
    var m = document.getElementById('missing');
    m.textContent = t.nepovolena;
    m.hidden = false;
  }
  var lokalne = tenant === DEMO_TENANT || vlastnaSkuska(tenant);
  fetch(ENDPOINT + '/v1/tenants/' + encodeURIComponent(tenant) + '/status')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (data && (lokalne || data.live_demo === true || data.outreach_demo === true)) nacitaj(data);
      else nepovolena();
    })
    .catch(function () {
      if (lokalne) nacitaj(null);
      else nepovolena();
    });
})();

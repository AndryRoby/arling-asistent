// i18n.js: SK/EN dictionary and tiny rendering engine for the ARLing Asistent
// landing page, so the same page works for Slovak visitors and for
// wordpress.org / Shopify app-store visitors who read English. No framework:
// every visible string lives in the DICT object below, keyed by {sk, en};
// index.html marks translatable elements with data-i18n* attributes, and
// applyI18n() below fills them in. Pattern follows
// products/camt053-to-excel/i18n.js, trimmed to two languages.
//
// app.js (the trial-form wiring) and widget.js are not edited by this file's
// author: app.js hardcodes a handful of Slovak status strings and writes
// them into #trial-status via textContent at runtime (feed processing,
// success, error messages). Rather than touching app.js, this module
// attaches a MutationObserver to #trial-status (see "status text bridge"
// below) and swaps in the English text after app.js writes it, whenever the
// page's active language is English. The exact Slovak strings are mirrored
// from demo/app.js on purpose; if app.js's wording ever changes, update the
// STATUS_TRANSLATIONS list below to match.
//
// Split in two halves on purpose, same as camt053-to-excel/i18n.js:
//  - pure helpers (t, tf, langFromLocale, detectLang's query/storage logic,
//    translateStatusText) never touch the DOM.
//  - DOM-touching code (applyI18n, setLang, the status-text bridge, the
//    bootstrap at the bottom) is guarded behind `typeof document !==
//    'undefined'` so importing this file under Node never throws.

export const LANGS = ['sk', 'en'];
export const DEFAULT_LANG = 'en';
export const STORAGE_KEY = 'arling_lang';

// ─────────────────────────────── dictionary ────────────────────────────────
// Every value has both languages. verify-i18n-asistent.mjs (scratch check
// script run during development) asserts this exhaustively.

export const DICT = {
  // ── header / nav / language switch ────────────────────────────────────
  'skip': { sk: 'Skočiť na skúšobnú verziu', en: 'Skip to the trial form' },
  'brand.sub': { sk: 'nástroj ARLing', en: 'an ARLing tool' },
  'nav.how': { sk: 'Ako to funguje', en: 'How it works' },
  'nav.try': { sk: 'Vyskúšať', en: 'Try it' },
  'nav.demo': { sk: 'Ukážka', en: 'Demo shop' },
  'nav.pricing': { sk: 'Cenník', en: 'Pricing' },
  'nav.privacy': { sk: 'Súkromie', en: 'Privacy' },
  'nav.faq': { sk: 'Otázky', en: 'FAQ' },
  'lang.switch.aria': { sk: 'Jazyk stránky', en: 'Page language' },
  'lang.sk.aria': { sk: 'Slovenčina', en: 'Slovak' },
  'lang.en.aria': { sk: 'English', en: 'English' },
  'lang.de.aria': { sk: 'Nemčina (samostatná stránka)', en: 'German (separate page)' },

  // ── hero ─────────────────────────────────────────────────────────────
  'hero.h1': {
    sk: 'Predajný asistent pre váš e-shop, nastavený za 10 minút z feedu.',
    en: 'A sales assistant for your e-shop, set up from your feed in 10 minutes.',
  },
  'hero.lead': {
    sk: 'Vložíte URL produktového feedu a e-mail. Asistent odpovedá zákazníkom z vašich skutočných produktov, v ich jazyku, a vždy pridá odkazy na konkrétny tovar. Bez ukladania rozhovorov, bez cookies.',
    en: 'Paste your product feed URL and an email address. The assistant answers customers from your real products, in their language, and always adds links to specific items. No conversations stored, no cookies.',
  },
  'cta.startFree': { sk: 'Začať zadarmo', en: 'Start for free' },
  'hero.source': { sk: 'Zdrojový kód na GitHube', en: 'Source code on GitHub' },
  'hero.fact.formats': { sk: '<b>5</b> formátov feedu', en: '<b>5</b> feed formats' },
  'hero.fact.stored': { sk: '<b>0</b> rozhovorov sa ukladá', en: '<b>0</b> conversations stored' },
  'hero.fact.free': { sk: '<b>100</b> rozhovorov/mesiac zadarmo', en: '<b>100</b> conversations/month free' },
  'hero.fact.langs': { sk: 'SK · CS · EN · DE', en: 'SK · CS · EN · DE' },
  'hero.fact.infra': { sk: 'beží na Cloudflare Workers', en: 'runs on Cloudflare Workers' },

  // ── section 01: how it works ────────────────────────────────────────
  's1.h2': { sk: 'Ako to funguje', en: 'How it works' },
  's1.sub': { sk: 'Tri kroky, žiadna inštalácia na strane servera, žiadny obchodník.', en: 'Three steps, no server-side install, no salesperson.' },
  's1.r1.title': { sk: 'Vložíte URL feedu a e-mail.', en: 'You paste your feed URL and email.' },
  // Feed formats: Heureka/Zbozi.cz XML is the SHOP/SHOPITEM format
  // (https://sluzby.heureka.sk/napoveda/xml-feed/). Shoptet exports it as a
  // system feed (https://podpora.shoptet.sk/xml-feedy/) and Upgates generates
  // it automatically (https://www.upgates.cz/a/export-produktu-na-heureku);
  // both help pages read 2026-09-05.
  's1.r1.body': {
    sk: 'Podporujeme Heureka/Zboží.cz XML (exportuje ho Shoptet aj Upgates), Google Shopping RSS/XML, Shopify <code>/products.json</code>, WooCommerce REST/Store API JSON a bežný XML feed so značkami <code>item/name/price/url</code>.',
    en: 'We support Heureka/Zboží.cz XML (the feed Shoptet and Upgates export), Google Shopping RSS/XML, Shopify <code>/products.json</code>, WooCommerce REST/Store API JSON, and a generic XML feed with <code>item/name/price/url</code> tags.',
  },
  's1.r2.title': { sk: 'Feed sa spracuje na embeddings.', en: 'Your feed is processed into embeddings.' },
  's1.r2.body': {
    sk: 'Worker stiahne feed, popisy skráti a rozdelí na časti a uloží do Cloudflare Vectorize (najviac 5000 produktov). Feed sa obnovuje automaticky raz denne.',
    en: 'A Worker downloads the feed, shortens and splits the descriptions into chunks, and stores them in Cloudflare Vectorize (up to 5,000 products). The feed refreshes automatically once a day.',
  },
  's1.r3.title': { sk: 'Vložíte jeden <code>&lt;script&gt;</code> tag.', en: 'You add one <code>&lt;script&gt;</code> tag.' },
  's1.r3.body': {
    sk: 'Asistent sa zobrazí vpravo dole na stránke. Odpovedá výhradne z vášho feedu a obchodných kontaktov, nikdy si nič nevymýšľa; ak nevie, odporučí kontaktovať obchod.',
    en: 'The assistant appears in the bottom right of the page. It answers only from your feed and your shop’s contact details, never makes anything up, and if it does not know, it points to your shop’s contact instead.',
  },

  // ── section 02: pricing ──────────────────────────────────────────────
  's2.h2': { sk: 'Cenník', en: 'Pricing' },
  's2.sub': {
    sk: 'Zadarmo navždy do 100 rozhovorov mesačne, bez karty. Nad tento limit jednoduchá cena podľa počtu rozhovorov za mesiac. Ročné predplatné zatiaľ neponúkame, len mesačné.',
    en: 'Free forever up to 100 conversations a month, no card. Above that, a simple price by monthly conversation volume. No annual plan yet, monthly billing only.',
  },
  's2.th.plan': { sk: 'Plán', en: 'Plan' },
  's2.th.price': { sk: 'Cena', en: 'Price' },
  's2.th.conversations': { sk: 'Rozhovory / mesiac', en: 'Conversations / month' },
  'pricing.limit.free': { sk: 'do 100', en: 'up to 100' },
  'pricing.limit.starter': { sk: 'do 1 000', en: 'up to 1,000' },
  'pricing.limit.growth': { sk: 'do 3 000', en: 'up to 3,000' },
  's2.note': {
    sk: 'Do 100 rozhovorov mesačne zadarmo, navždy, bez platobnej karty. Nad tento limit prejde e-shop na plán Starter (19 € mesačne, do 1 000 rozhovorov) alebo Pro (39 € mesačne, do 3 000) zo stránky svojho účtu, ktorej odkaz dostane hneď po vytvorení účtu. Platba kartou cez Stripe, zrušiť kedykoľvek. Ročné predplatné zatiaľ nie je v ponuke.',
    en: 'Free up to 100 conversations a month, forever, no payment card. Above that, the shop upgrades to Starter (19 EUR a month, up to 1,000 conversations) or Pro (39 EUR a month, up to 3,000) from its account page, linked right after the account is created. Card payment through Stripe, cancel any time. No annual plan yet.',
  },
  's2.objections.label': { sk: 'Predtým, než začnete', en: 'Before you start' },

  'obj1.q': { sk: 'Ukladáte rozhovory zákazníkov?', en: 'Do you store customer conversations?' },
  'obj1.a': {
    sk: 'Nie. Obsah rozhovoru sa nikde neukladá, ani u nás, ani v databáze. Ukladáme len počítadlá: koľko rozhovorov a kliknutí na produkt sa za deň udialo, kvôli fakturácii a mesačnému limitu.',
    en: 'No. The content of a conversation is never stored, not by us, not in any database. We only keep counters: how many conversations and product clicks happened per day, for billing and the monthly limit.',
  },
  'obj2.q': { sk: 'Máte zmluvu podľa čl. 28 GDPR?', en: 'Do you have a GDPR Article 28 agreement?' },
  'obj2.a': {
    sk: 'Áno. ARLing s. r. o. je pri spracúvaní správ návštevníkov vášho e-shopu sprostredkovateľom. Vzor zmluvy: <a href="https://github.com/AndryRoby/arling-asistent/blob/main/legal/dpa-sk.md" target="_blank" rel="noopener">Zmluva o spracúvaní osobných údajov (DPA)</a>.',
    en: 'Yes. ARLing s. r. o. acts as processor for the messages your e-shop’s visitors send. Template agreement: <a href="https://github.com/AndryRoby/arling-asistent/blob/main/legal/dpa-sk.md" target="_blank" rel="noopener">Data Processing Agreement (DPA)</a>. The template is written in Slovak; an English translation is available on request at andrej@arling.sk.',
  },
  'obj3.q': { sk: 'Ako zrušiť, keď mi to nesadne?', en: 'How do I cancel if it does not work out?' },
  'obj3.a': {
    sk: 'Voľný plán do 100 rozhovorov mesačne nemá žiadny záväzok ani kartu, jednoducho ho prestanete používať. Platené predplatné nad týmto limitom ide cez Stripe a dá sa zrušiť kedykoľvek, rovnako ako pri ostatných nástrojoch ARLing.',
    en: 'The free plan up to 100 conversations a month has no commitment and no card, you simply stop using it. A paid plan above that limit runs through Stripe and can be cancelled any time, same as every other ARLing tool.',
  },
  'obj4.q': { sk: 'Čo ak môj feed nie je v žiadnom z podporovaných formátov?', en: 'What if my feed is not in any of the supported formats?' },
  'obj4.a': {
    sk: 'Podporujeme Heureka/Zboží.cz XML (značky <code>SHOP/SHOPITEM</code>, exportuje ho napríklad Shoptet alebo Upgates), Google Shopping RSS/XML (značky <code>g:</code>), Shopify <code>/products.json</code>, WooCommerce REST/Store API JSON a bežný XML feed so značkami <code>item/name/price/url/description/image</code>. Iný formát vyskúšajte vo formulári nižšie; ak ho spracovanie odmietne, napíšte na andrej@arling.sk s ukážkou feedu.',
    en: 'We support Heureka/Zboží.cz XML (<code>SHOP/SHOPITEM</code> tags, exported by Shoptet or Upgates, for example), Google Shopping RSS/XML (<code>g:</code> tags), Shopify <code>/products.json</code>, WooCommerce REST/Store API JSON, and a generic XML feed with <code>item/name/price/url/description/image</code> tags. Try a different format in the form below; if processing rejects it, write to andrej@arling.sk with a sample of your feed.',
  },

  // ── section 03: playground / trial form ─────────────────────────────
  's3.h2': { sk: 'Vyskúšajte to s vlastným feedom', en: 'Try it with your own feed' },
  's3.sub': {
    sk: 'Zadajte URL feedu produktov a e-mail. Za pár minút sa vpravo dole na tejto stránke objaví chat s vašimi vlastnými produktmi. Doménu odvodíme automaticky z URL feedu.',
    en: 'Enter your product feed URL and an email address. Within a few minutes a chat with your own products appears in the bottom right of this page. The domain is derived automatically from the feed URL.',
  },
  's3.label.feed': { sk: 'URL feedu produktov', en: 'Product feed URL' },
  's3.placeholder.feed': { sk: 'https://vasobchod.sk/feed.xml', en: 'https://yourstore.com/feed.xml' },
  's3.label.email': { sk: 'E-mail', en: 'Email' },
  's3.placeholder.email': { sk: 'vy@vasobchod.sk', en: 'you@yourstore.com' },
  's3.label.lang': { sk: 'Jazyk odpovedí', en: 'Answer language' },
  's3.lang.auto': { sk: 'Automaticky podľa zákazníka', en: 'Automatic, follows the customer' },
  's3.lang.hint': { sk: 'Automaticky znamená, že asistent odpovie v jazyku, v ktorom sa zákazník opýta.', en: 'Automatic means the assistant answers in whatever language the customer writes in.' },
  's3.submit': { sk: 'Spustiť skúšobnú verziu', en: 'Start the trial' },
  's3.hint': {
    sk: 'Feed sa použije len na vytvorenie skúšobného asistenta pre túto ukážku. Samotný rozhovor v chate sa nikde neukladá. Zadarmo do 100 rozhovorov mesačne, žiadna platobná karta.',
    en: 'The feed is used only to create a trial assistant for this demo. The chat conversation itself is never stored anywhere. Free up to 100 conversations a month, no payment card.',
  },
  's3.widgetNote': { sk: 'Asistent je pripravený. Hľadajte okrúhle tlačidlo vpravo dole na tejto stránke.', en: 'The assistant is ready. Look for the round button in the bottom right of this page.' },
  's3.embed.title': { sk: 'Váš embed kód', en: 'Your embed code' },
  's3.embed.idLabel': { sk: 'ID skúšobného účtu', en: 'Trial account ID' },
  's3.embed.snippetLabel': { sk: 'Kód na vloženie do stránky', en: 'Code to paste into your page' },
  's3.embed.copy': { sk: 'Kopírovať', en: 'Copy' },
  's3.embed.copied': { sk: 'Skopírované', en: 'Copied' },
  's3.embed.note': {
    sk: 'Vložte pred </body> vo vašej šablóne, alebo použite WooCommerce plugin.',
    en: 'Paste before </body> in your theme, or use the WooCommerce plugin.',
  },
  's3.embed.tenantPage': { sk: 'Používanie a prechod na platený plán:', en: 'Usage and upgrade:' },

  // ── section 04: privacy ──────────────────────────────────────────────
  's4.h2': { sk: 'Súkromie ako vlastnosť, nie dodatok', en: 'Privacy as a feature, not an afterthought' },
  's4.sub': { sk: 'Widget je postavený tak, aby o návštevníkoch vášho e-shopu vedel čo najmenej.', en: 'The widget is built to know as little as possible about your e-shop’s visitors.' },
  's4.item1': {
    sk: '<b>Rozhovory sa neukladajú.</b> Obsah správ nikde nepretrváva, ani u nás, ani v databáze. Ukladáme len denné počítadlá rozhovorov a kliknutí na produkt, kvôli mesačnému limitu a fakturácii.',
    en: '<b>Conversations are not stored.</b> The content of messages never persists anywhere, not with us, not in any database. We only keep daily counters of conversations and product clicks, for the monthly limit and billing.',
  },
  's4.item2': {
    sk: '<b>Žiadne cookies.</b> Widget nepoužíva cookies ani localStorage okrem voliteľného identifikátora relácie, ktorý žije len v pamäti prehliadača a mizne pri zatvorení stránky.',
    en: '<b>No cookies.</b> The widget uses no cookies and no localStorage, apart from an optional session identifier that lives only in the browser’s memory and disappears when the page is closed.',
  },
  's4.item3': {
    sk: '<b>Feed produktov je jediný zdroj pravdy.</b> Asistent odpovedá len z toho, čo je vo vašom feede a v kontaktných údajoch, nikdy si nič nevymýšľa a text produktov berie ako dáta, nie ako pokyny.',
    en: '<b>Your product feed is the single source of truth.</b> The assistant answers only from what is in your feed and your contact details, never makes anything up, and treats product text as data, never as instructions.',
  },
  's4.item4': {
    sk: '<b>Zmluva podľa čl. 28 GDPR.</b> ARLing s. r. o. je pri spracúvaní správ návštevníkov vášho e-shopu sprostredkovateľom. Vzor zmluvy: <a href="https://github.com/AndryRoby/arling-asistent/blob/main/legal/dpa-sk.md" target="_blank" rel="noopener">Zmluva o spracúvaní osobných údajov (DPA)</a>.',
    en: '<b>GDPR Article 28 agreement.</b> ARLing s. r. o. acts as processor for the messages your e-shop’s visitors send. Template agreement: <a href="https://github.com/AndryRoby/arling-asistent/blob/main/legal/dpa-sk.md" target="_blank" rel="noopener">Data Processing Agreement (DPA)</a>, written in Slovak; an English translation is available on request.',
  },
  's4.item5': {
    sk: '<b>Beh na globálnej sieti Cloudflare.</b> Presná EU-only lokalita spracovania Workers AI nie je Cloudflare verejne garantovaná; DPA preto počíta so štandardnými zmluvnými doložkami (SCC) a certifikáciou Cloudflare podľa EU Cloud Code of Conduct.',
    en: '<b>Runs on Cloudflare’s global network.</b> Cloudflare does not publicly guarantee EU-only processing location for Workers AI; the DPA therefore relies on Standard Contractual Clauses (SCC) and Cloudflare’s certification under the EU Cloud Code of Conduct.',
  },

  // ── FAQ section ──────────────────────────────────────────────────────
  'faqs.h2': { sk: 'Otázky', en: 'FAQ' },
  'faq.setup.q': { sk: 'Ako dlho trvá nastavenie?', en: 'How long does setup take?' },
  'faq.setup.a': {
    sk: 'Vložíte URL feedu produktov a e-mail. Worker feed stiahne, rozdelí na časti a uloží ako embeddings, zvyčajne do pár minút podľa veľkosti katalógu (limit je 5000 produktov). Potom stačí vložiť jeden <code>&lt;script&gt;</code> tag do e-shopu.',
    en: 'Paste your product feed URL and email. A Worker downloads the feed, chunks it, and stores it as embeddings, usually within a few minutes depending on catalogue size (the limit is 5,000 products). Then you add one <code>&lt;script&gt;</code> tag to your e-shop.',
  },
  'faq.formats.q': { sk: 'Aké formáty feedu podporujete?', en: 'Which feed formats do you support?' },
  'faq.formats.a': {
    sk: 'Heureka/Zboží.cz XML (značky <code>SHOP/SHOPITEM</code>, exportuje ho napríklad Shoptet alebo Upgates), Google Shopping RSS/XML (značky <code>g:</code>), Shopify <code>/products.json</code>, WooCommerce REST/Store API JSON a bežný XML feed so značkami <code>item/name/price/url/description/image</code>.',
    en: 'Heureka/Zboží.cz XML (<code>SHOP/SHOPITEM</code> tags, exported by Shoptet or Upgates, for example), Google Shopping RSS/XML (<code>g:</code> tags), Shopify <code>/products.json</code>, WooCommerce REST/Store API JSON, and a generic XML feed with <code>item/name/price/url/description/image</code> tags.',
  },
  'faq.lang.q': { sk: 'V akom jazyku asistent odpovedá?', en: 'What language does the assistant reply in?' },
  'faq.lang.a': {
    sk: 'Slovensky, česky, anglicky alebo nemecky, podľa nastavenia widgetu na stránke (<code>data-lang</code>). Odpoveď je vždy len z produktov vo vašom feede, nikdy si nič nevymýšľa.',
    en: 'Slovak, Czech, English or German, depending on the widget’s <code>data-lang</code> setting on the page. The answer always comes only from the products in your feed and never makes anything up.',
  },
  'faq.cantanswer.q': { sk: 'Čo ak asistent nevie odpovedať?', en: 'What if the assistant cannot answer?' },
  'faq.cantanswer.a': {
    sk: 'Ak sa vo feede nenájde nič relevantné k otázke, asistent to jasne povie a odporučí zákazníkovi kontaktovať obchod priamo, na e-mail zadaný pri nastavení.',
    en: 'If nothing relevant to the question is found in the feed, the assistant says so clearly and points the customer to contact the shop directly, at the email address entered during setup.',
  },
  'faq.platforms.q': { sk: 'Funguje to aj na Shoptete, WooCommerce alebo Shopify?', en: 'Does this work on Shoptet, WooCommerce or Shopify?' },
  'faq.platforms.a': {
    sk: 'Skript funguje na akomkoľvek e-shope hneď, stačí vložiť jeden <code>&lt;script&gt;</code> tag do administrácie alebo šablóny. Samostatný <a href="woocommerce/">WooCommerce plugin</a> je odoslaný na wordpress.org a čaká na schválenie (dovtedy sa inštaluje zo ZIP súboru z GitHubu), <a href="shopify/">Shopify aplikácia</a> je v príprave. Pre Shoptet a Upgates je samostatný <a href="shoptet/">návod</a>: Heureka XML feed z administrácie a script tag cez HTML kód. Ako widget vyzerá na slovenskom e-shope, ukazuje <a href="ukazka/">ukážkový obchod Dobrá domácnosť</a>.',
    en: 'The script works on any e-shop right away, you just add one <code>&lt;script&gt;</code> tag to the admin or theme. The dedicated <a href="woocommerce/">WooCommerce plugin</a> has been submitted to wordpress.org and is awaiting review (until then it installs from a ZIP file from GitHub); the <a href="shopify/">Shopify app</a> is in preparation. Shoptet and Upgates shops have a separate <a href="shoptet/">guide</a> (Heureka XML feed from the admin, script tag through the HTML code editor). The <a href="ukazka/">Slovak demo shop</a> shows the widget on a fictional Slovak store.',
  },
  'faq.free.q': { sk: 'Čo je zadarmo?', en: 'What is free?' },
  'faq.free.a': {
    sk: 'Do 100 rozhovorov mesačne, navždy, bez platobnej karty. Vyskúšať si to môžete priamo na tejto stránke s vlastným feedom, chat sa objaví vpravo dole.',
    en: 'Up to 100 conversations a month, forever, no payment card. You can try it right on this page with your own feed, the chat appears in the bottom right.',
  },
  'faq.datalocation.q': { sk: 'Kde bežia dáta?', en: 'Where does the data run?' },
  'faq.datalocation.a': {
    sk: 'Na globálnej sieti Cloudflare (Workers, Vectorize, D1). Presná EU-only lokalita spracovania nie je Cloudflare verejne garantovaná, preto zmluva o spracúvaní osobných údajov (DPA) medzi ARLingom a e-shopom počíta so štandardnými zmluvnými doložkami (SCC) a Cloudflare EU Cloud Code of Conduct.',
    en: 'On Cloudflare’s global network (Workers, Vectorize, D1). Cloudflare does not publicly guarantee an EU-only processing location, so the Data Processing Agreement (DPA) between ARLing and the e-shop relies on Standard Contractual Clauses (SCC) and Cloudflare’s EU Cloud Code of Conduct.',
  },
  'faq.billing.q': { sk: 'Ako funguje platba a fakturácia?', en: 'How does payment and billing work?' },
  'faq.billing.a': {
    sk: 'Do 100 rozhovorov mesačne je používanie úplne zadarmo, bez karty. Nad tento limit prejdete na plán Starter (19 € mesačne, do 1 000 rozhovorov) alebo Pro (39 € mesačne, do 3 000 rozhovorov) zo stránky svojho účtu (arling.sk/asistent/tenant/?t=id účtu), ktorej odkaz dostanete hneď po vytvorení účtu. Platíte kartou cez Stripe, potvrdenie a faktúru pošle Stripe e-mailom, zrušiť sa dá kedykoľvek.',
    en: 'Up to 100 conversations a month, use is completely free, no card. Above that you upgrade to Starter (19 EUR a month, up to 1,000 conversations) or Pro (39 EUR a month, up to 3,000) from your account page (arling.sk/asistent/tenant/?t=your account id), linked right after the account is created. You pay by card through Stripe, Stripe e-mails the receipt and invoice, and you can cancel any time.',
  },

  'subscribe.ask': { sk: 'Chcete vedieť, keď WooCommerce plugin prejde schválením na wordpress.org alebo pribudne Shopify aplikácia?', en: 'Want to know when the WooCommerce plugin is approved on wordpress.org, or when the Shopify app goes live?' },
  'subscribe.email.placeholder': { sk: 'vas@email.sk', en: 'you@email.com' },
  'subscribe.btn': { sk: 'Dajte mi vedieť', en: 'Notify me' },
  'subscribe.privacy': { sk: 'Len e-mail o novinkách k ARLing Asistentovi. Odhlásenie kedykoľvek jedným klikom.', en: 'Only email about ARLing Asistent news. Unsubscribe any time with one click.' },
  'subscribe.thanks': { sk: 'Ďakujeme, ozveme sa.', en: 'Thanks, we’ll be in touch.' },
  'subscribe.error': {
    sk: 'Niečo sa pokazilo, skúste to prosím znova alebo napíšte na andrej@arling.sk.',
    en: 'Something went wrong, please try again or write to andrej@arling.sk.',
  },

  // ── closing CTA ──────────────────────────────────────────────────────
  'closing.sub': { sk: 'Vložte URL feedu a e-mail. Zadarmo do 100 rozhovorov mesačne, bez platobnej karty.', en: 'Paste your feed URL and email. Free up to 100 conversations a month, no payment card.' },

  // ── footer ───────────────────────────────────────────────────────────
  'footer.tool': { sk: 'nástroj', en: 'a tool by' },
  'footer.regIds': { sk: 'IČO 56583486 · IČ DPH SK2122352100', en: 'Company ID (IČO) 56583486 · VAT ID (IČ DPH) SK2122352100' },
  'footer.sourceCode': { sk: 'Zdrojový kód (GitHub)', en: 'Source code (GitHub)' },
  'footer.dpa': { sk: 'DPA (GDPR čl. 28)', en: 'DPA (GDPR Art. 28)' },
  'footer.compare': { sk: 'Porovnanie (EN)', en: 'Compare' },
  'footer.demoSk': { sk: 'Slovenská ukážka', en: 'Slovak demo shop' },
  'footer.shoptet': { sk: 'Shoptet a Upgates', en: 'Shoptet and Upgates (Slovak, Czech)' },
  'footer.giftFinder.text': { sk: 'Hľadač darčekov', en: 'Gift Finder' },
  'footer.giftFinder.href': { sk: 'darceky/', en: 'gift-finder/' },
  'footer.note': { sk: 'Návštevnosť meriame vlastným, cookie-free nástrojom Umami. Neukladá cookies ani odtlačok prehliadača.', en: 'We measure traffic with our own cookie-free tool, Umami. It stores no cookies and no browser fingerprint.' },

  // ── sticky mobile CTA bar ────────────────────────────────────────────
  'sticky.text': { sk: 'Zadarmo do 100 rozhovorov mesačne.', en: 'Free up to 100 conversations a month.' },
  'sticky.close.aria': { sk: 'Zavrieť lištu', en: 'Close bar' },

  // ── meta / SEO ───────────────────────────────────────────────────────
  'meta.title': { sk: 'ARLing Asistent: AI predajný asistent pre e-shopy', en: 'ARLing Asistent: AI shopping assistant for e-shops' },
  'meta.description': {
    sk: 'Predajný asistent pre váš e-shop, nastavený za 10 minút z produktového feedu. Beží na Cloudflare Workers, neukladá rozhovory zákazníkov. Zadarmo do 100 rozhovorov mesačne, potom od 19 EUR mesačne.',
    en: 'A shopping assistant for your e-shop, set up from your product feed in 10 minutes. Runs on Cloudflare Workers, stores no customer conversations. Free up to 100 conversations a month, then from 19 EUR a month.',
  },
};

// ─────────────────────────────── pure helpers ───────────────────────────────

// The page's "active" language. Every helper below that takes an optional
// `lang` argument falls back to this, NOT to DEFAULT_LANG, when `lang` is
// omitted or unrecognized. Stays 'en' (DEFAULT_LANG) under Node.
let currentLang = DEFAULT_LANG;

/** Current active language. */
export function getLang() {
  return currentLang;
}

function resolveLang(lang) {
  return LANGS.includes(lang) ? lang : currentLang;
}

/** Resolves a locale tag (e.g. "sk-SK", "cs-CZ", "fr-FR") to one of LANGS.
 * Per the brief: sk/cs -> sk, everything else -> DEFAULT_LANG (en). */
export function langFromLocale(tag) {
  const s = String(tag || '').toLowerCase();
  if (s.startsWith('sk') || s.startsWith('cs')) return 'sk';
  return DEFAULT_LANG;
}

/** Translates one dictionary key. Unknown key returns the key itself so a
 * missing translation is visible instead of silently blank. Omitting
 * `lang` uses the page's current active language. */
export function t(key, lang) {
  const l = resolveLang(lang);
  const entry = DICT[key];
  if (!entry) return key;
  return entry[l] || entry.en || entry.sk || key;
}

/** Same lookup, but with {placeholders} filled in from `vars`. */
export function tf(key, vars, lang) {
  let s = t(key, lang);
  if (vars) {
    Object.keys(vars).forEach((k) => {
      s = s.split('{' + k + '}').join(String(vars[k]));
    });
  }
  return s;
}

/** Every DICT entry has a non-empty string for every LANGS member. */
export function findIncompleteEntries() {
  const bad = [];
  Object.keys(DICT).forEach((key) => {
    const entry = DICT[key];
    LANGS.forEach((l) => {
      if (typeof entry[l] !== 'string' || !entry[l].trim()) bad.push(`${key}.${l}`);
    });
  });
  return bad;
}

/** Reads ?lang= from a query string (no DOM/location dependency). */
export function langFromQueryString(search) {
  try {
    const params = new URLSearchParams(search || '');
    const q = (params.get('lang') || '').toLowerCase();
    return LANGS.includes(q) ? q : null;
  } catch (e) {
    return null;
  }
}

export function ogLocaleForLang(lang) {
  const l = resolveLang(lang);
  return l === 'sk' ? 'sk_SK' : 'en_US';
}

// ── status text bridge ──────────────────────────────────────────────────
// app.js (not edited here) writes these exact Slovak strings into
// #trial-status via textContent at runtime. translateStatusText() below
// does a plain substring swap, longest/most-specific entries first isn't
// required since none of these phrases are substrings of one another
// except the two "Nepodarilo sa vytvoriť skúšobný účet" variants (one ends
// in ": ", the other in "."), which are handled as distinct entries.

export const STATUS_TRANSLATIONS = [
  ['Sťahujeme a spracúvame váš feed produktov...', 'Downloading and processing your product feed...'],
  ['Hotovo. Otvorte chat vpravo dole a opýtajte sa niečo o vašich produktoch.', 'Done. Open the chat in the bottom right and ask something about your products.'],
  ['Feed sa nepodarilo spracovať. Skontrolujte URL feedu, alebo napíšte na andrej@arling.sk.', 'The feed could not be processed. Check the feed URL, or write to andrej@arling.sk.'],
  ['Spracovanie feedu trva dlhšie ako obvykle. Skúste obnoviť stránku o chvíľu, alebo napíšte na andrej@arling.sk.', 'Processing the feed is taking longer than usual. Try refreshing the page in a moment, or write to andrej@arling.sk.'],
  ['URL feedu musí byť platná adresa (https://vaseshop.sk/feed.xml).', 'The feed URL must be a valid address (https://yourstore.com/feed.xml).'],
  ['Nepodarilo sa vytvoriť skúšobný účet: ', 'Could not create a trial account: '],
  ['Nepodarilo sa vytvoriť skúšobný účet. Skontrolujte internetové pripojenie a skúste znova.', 'Could not create a trial account. Check your internet connection and try again.'],
  ['Neplatná požiadavka (poškodené dáta formulára).', 'Invalid request (corrupted form data).'],
  ['Skontrolujte polia formulára.', 'Check the form fields.'],
  ['Táto stránka nemá povolený prístup k API (CORS).', 'This page is not allowed to access the API (CORS).'],
  ['Príliš veľa požiadaviek naraz. Skúste to o chvíľu.', 'Too many requests at once. Try again in a moment.'],
  ['Požiadavka je príliš veľká.', 'The request is too large.'],
  ['Dnešný limit skúšobných účtov bol dosiahnutý.', 'Today’s limit of trial accounts has been reached.'],
  ['Nastala chyba na strane servera.', 'A server-side error occurred.'],
];

/** Pure string transform, sk -> en, exported so it can be unit-tested
 * without a DOM. Used by the MutationObserver below, which only ever fires
 * this direction (app.js always writes Slovak). */
export function translateStatusText(text) {
  return localizeStatusText(text, 'en');
}

/** Bidirectional version: translates a status string TOWARD `lang` (sk or
 * en), whichever direction that is. Idempotent either way: running the
 * sk->en pass over already-English text (or vice versa) matches nothing
 * and returns the input unchanged, since STATUS_TRANSLATIONS entries are
 * never substrings of each other within the same language. Used by
 * applyI18n() so that switching the language switch back and forth also
 * flips whatever status text app.js already wrote into #trial-status. */
export function localizeStatusText(text, lang) {
  const l = LANGS.includes(lang) ? lang : currentLang;
  let out = String(text || '');
  STATUS_TRANSLATIONS.forEach(([sk, en]) => {
    out = l === 'en' ? out.split(sk).join(en) : out.split(en).join(sk);
  });
  return out;
}

// ─────────────────────────────── DOM engine ────────────────────────────────
// Everything below touches document/window/localStorage/navigator and only
// ever runs in a browser; every access is guarded so importing this module
// under Node is side-effect-free beyond the pure helpers above.

function readStoredLang() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    const v = localStorage.getItem(STORAGE_KEY);
    return LANGS.includes(v) ? v : null;
  } catch (e) {
    return null;
  }
}

/** Query param wins, then localStorage, then navigator.language, then
 * DEFAULT_LANG ("en", per the brief: sk/cs -> SK, else EN). */
export function detectLang() {
  try {
    if (typeof location !== 'undefined') {
      const fromQuery = langFromQueryString(location.search);
      if (fromQuery) return fromQuery;
    }
  } catch (e) {}
  const stored = readStoredLang();
  if (stored) return stored;
  try {
    if (typeof navigator !== 'undefined' && navigator.language) return langFromLocale(navigator.language);
  } catch (e) {}
  return DEFAULT_LANG;
}

function setMetaByName(name, value) {
  const el = document.querySelector(`meta[name="${name}"]`);
  if (el) el.setAttribute('content', value);
}
function setMetaByProperty(prop, value) {
  const el = document.querySelector(`meta[property="${prop}"]`);
  if (el) el.setAttribute('content', value);
}

function updateUrlLang(lang) {
  try {
    if (typeof history === 'undefined' || typeof location === 'undefined') return;
    const url = new URL(location.href);
    url.searchParams.set('lang', lang);
    history.replaceState(null, '', url.pathname + '?' + url.searchParams.toString() + url.hash);
  } catch (e) {}
}

/** Fills in every data-i18n* element and the document-level bits (title,
 * meta description/OG, <html lang>, language-switch button state) for the
 * given (already-resolved) language. Pure DOM sync, no persistence. */
export function applyI18n(lang) {
  if (typeof document === 'undefined') return;
  const l = LANGS.includes(lang) ? lang : currentLang;
  currentLang = l;

  document.documentElement.setAttribute('lang', l);

  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n'), l); });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html'), l); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'), l)); });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'), l)); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'), l)); });
  document.querySelectorAll('[data-i18n-href]').forEach((el) => { el.setAttribute('href', t(el.getAttribute('data-i18n-href'), l)); });

  document.title = t('meta.title', l);
  setMetaByName('description', t('meta.description', l));
  setMetaByProperty('og:title', t('meta.title', l));
  setMetaByProperty('og:description', t('meta.description', l));
  setMetaByProperty('og:locale', ogLocaleForLang(l));

  document.querySelectorAll('[data-set-lang]').forEach((btn) => {
    const active = btn.getAttribute('data-set-lang') === l;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.classList.toggle('lang-active', active);
  });

  document.querySelectorAll('form[data-subscribe]').forEach((f) => f.setAttribute('data-lang', l));

  // Re-translate whatever app.js has already written into the status line
  // (see "status text bridge" above), since applyI18n() also runs once on
  // initial load, after which the MutationObserver below takes over.
  const statusEl = document.getElementById('trial-status');
  if (statusEl && statusEl.textContent) {
    const translated = localizeStatusText(statusEl.textContent, l);
    if (translated !== statusEl.textContent) {
      statusObserverIgnoreNext = true;
      statusEl.textContent = translated;
    }
  }

  try { document.dispatchEvent(new CustomEvent('arling:langchange', { detail: { lang: l } })); } catch (e) {}
}

/** Sets the active language, persists it, syncs the URL and re-renders. */
export function setLang(lang) {
  if (!LANGS.includes(lang)) return;
  currentLang = lang;
  try { if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
  applyI18n(lang);
  updateUrlLang(lang);
}

function wireLangSwitch() {
  document.querySelectorAll('[data-set-lang]').forEach((btn) => {
    btn.addEventListener('click', () => setLang(btn.getAttribute('data-set-lang')));
  });
}

// MutationObserver on #trial-status: app.js sets statusEl.textContent
// directly (Slovak strings), so this catches every future write (feed
// processing, ready, error, polling timeout) and swaps in the English text
// when the page's active language is English. statusObserverIgnoreNext
// guards against re-triggering on our own rewrite.
let statusObserverIgnoreNext = false;
function setupStatusObserver() {
  if (typeof MutationObserver === 'undefined') return;
  const statusEl = document.getElementById('trial-status');
  if (!statusEl) return;
  const observer = new MutationObserver(() => {
    if (statusObserverIgnoreNext) { statusObserverIgnoreNext = false; return; }
    if (currentLang !== 'en') return;
    const current = statusEl.textContent;
    const translated = translateStatusText(current);
    if (translated !== current) {
      statusObserverIgnoreNext = true;
      statusEl.textContent = translated;
    }
  });
  observer.observe(statusEl, { childList: true, characterData: true, subtree: true });
}

// Exposed for app.js or any future inline code to read translations without
// this module needing to be edited again; not required by app.js today
// (see the MutationObserver bridge above), kept for forward compatibility.
if (typeof window !== 'undefined') {
  window.ASISTENT_I18N = { t, tf, getLang, setLang, translateStatusText, localizeStatusText, LANGS, DEFAULT_LANG };
}

if (typeof document !== 'undefined') {
  const boot = () => {
    wireLangSwitch();
    setupStatusObserver();
    setLang(detectLang());
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

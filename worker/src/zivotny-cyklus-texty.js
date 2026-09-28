/*
 * zivotny-cyklus-texty.js
 *
 * Texty e-mailov životného cyklu Asistenta (návrh ops/asistent/zivotny-cyklus.md,
 * časti 2.3 až 2.5) v jazykoch sk, cs, en, de. Slovenčina a angličtina sú
 * prevzaté z návrhu, čeština a nemčina sú preklad agenta, opravené podľa
 * adverzárnej kontroly textov 25. 9. 2026 (NEOVERENÉ rodeným hovoriacim).
 *
 * Zámerné odchýlky od návrhu (poctivosť textu, nie štýl):
 *   - Návrh v E1 sľuboval „vyskúšať pred vložením na web“ na stránke účtu,
 *     ktorá však chat nemá (products/arling-sk/asistent/tenant/tenant.js
 *     ukazuje len využitie a kód). Chat pre ľubovoľný účet má stránka
 *     products/arling-sk/asistent/live/ (live.js číta ?t= a &shop=), preto E1
 *     odkazuje na ňu a stránku účtu uvádza zvlášť.
 *   - E3 nepíše „pred tromi dňami“, ale „pred niekoľkými dňami“: E3 ide
 *     najskôr 72 hodín po E1 a len v pracovný deň 9:00 až 17:00, takže to
 *     môžu byť aj štyri či päť dní.
 *   - Zoznam ďalších správ v päte sa objaví len vtedy, keď ďalšie správy
 *     naozaj môžu prísť (e-maily nie sú zastavené a worker má kľúč na podpis
 *     odkazu). Samostatná veta o potvrdení v tele E1 od Z-42 pokusu 2 nie je.
 *   - E0 uvádza len hostiteľa feedu, nie celú adresu, a nič z neho nerobí
 *     odkazom: adresu feedu zadal ktokoľvek a e-mail z mail.arling.sk s
 *     cudzím odkazom by bol phishingom. Odkazy v HTML vznikajú len pre
 *     povolených hostiteľov (POVOLENE_ODKAZY).
 *   - Odkaz na zastavenie zastaví všetky ďalšie e-maily vrátane uvítacieho
 *     (zivotny-cyklus.js mozeIst), päta to tak aj hovorí.
 *
 * Nič tu nesmie obsahovať dlhú ani strednú pomlčku (U+2014, U+2013); stráži
 * to test tests/zivotny-cyklus.test.mjs pre každý e-mail v každom jazyku.
 * Žiadne obrázky, žiadne sledovacie pixely, odkazy sa neprepisujú.
 *
 * Z-42 (28. 9. 2026): každý e-mail má nadpis, preheader a najviac jedno
 * tlačidlo (DOPLNKY), HTML skladá zivotny-cyklus-html.js. E2 nevie ukázať
 * otázky zákazníkov, lebo obsah rozhovorov sa neukladá (schema.sql), a hovorí
 * to na rovinu. E4 uvádza len to, čo platený plán naozaj mení v kóde:
 * mesačné rozhovory (tenants.js DEFAULT_QUOTAS) a denný strop otázok s modelom
 * (budget.js DENNY_STROP_OTAZOK).
 *
 * Z-42 pokus 2 (brána Astra 2): rozhovor je definovaný podľa relacia.js
 * (prvá otázka, tá istá karta prehliadača, platnosť RELACIA_PLATNOST_S,
 * strop otázok len keď ho volajúci pošle), WordPress má vlastný E3 bez kódu,
 * nadpisy E3 a E4 netvrdia nič nad rámec meraní, tlačidlo ide hneď pod úvodný
 * odsek a adresy v tele sú pomenované odkazy {{názov|adresa}}.
 */

import { POVOLENE_ODKAZY, jePovolenyOdkaz, blokText, zabalHtml, odkaz, textOdkazov } from './zivotny-cyklus-html.js';
import { PLANS, DEFAULT_QUOTAS } from './tenants.js';
import { DENNY_STROP_OTAZOK } from './budget.js';
import { RELACIA_PLATNOST_S } from './relacia.js';

export { POVOLENE_ODKAZY, jePovolenyOdkaz };

// Čísla plánov a rozhovoru idú z kódu, nie z textu (brána Z-42, nález 7):
// mesačné rozhovory tenants.js DEFAULT_QUOTAS, denný strop otázok s modelom
// budget.js DENNY_STROP_OTAZOK, platnosť relácie relacia.js. Ceny sú v Stripe
// (ops/stripe/cennik.md), v kóde workera konštantu nemajú.
export const CENY_EUR = { [PLANS.STARTER]: 19, [PLANS.PRO]: 39 };
const ROZH = { free: DEFAULT_QUOTAS[PLANS.FREE], starter: DEFAULT_QUOTAS[PLANS.STARTER], pro: DEFAULT_QUOTAS[PLANS.PRO] };
const STROP = { free: DENNY_STROP_OTAZOK[PLANS.FREE], starter: DENNY_STROP_OTAZOK[PLANS.STARTER], pro: DENNY_STROP_OTAZOK[PLANS.PRO] };
const HODINY_ROZHOVORU = RELACIA_PLATNOST_S / 3600;

export const JAZYKY_EMAILOV = ['sk', 'cs', 'en', 'de'];
export const KODY_EMAILOV = ['E0', 'E1', 'E1W', 'E2', 'E3', 'E4'];
export const PLATFORMY = ['wordpress', 'woocommerce', 'shopify', 'shoptet', 'eshoprychle', 'heureka', 'vseobecne'];

export const WIDGET_ORIGIN = 'https://arling-asistent.arling.workers.dev';

// Nezlomiteľná medzera: „19 €“, „80 %“ a „1 000“ sa nesmú rozdeliť na dva riadky.
const NB = ' ';

export function vkladaciKod(tenantId) {
  return `<script src="${WIDGET_ORIGIN}/widget.js" data-tenant="${tenantId}" data-lang="auto" defer></script>`;
}

// ---------------------------------------------------------------------------
// Dátumy a tvary slov
// ---------------------------------------------------------------------------

/** Časti dátumu v pásme Europe/Bratislava (alebo UTC). Intl je vo Workers aj v Node s plnými časovými pásmami. */
export function castiDatumu(date, timeZone = 'Europe/Bratislava') {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const dni = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    rok: Number(parts.year),
    mesiac: Number(parts.month),
    den: Number(parts.day),
    hodina: Number(parts.hour),
    minuta: Number(parts.minute),
    hh: String(parts.hour).padStart(2, '0'),
    mm: String(parts.minute).padStart(2, '0'),
    denTyzdna: dni[parts.weekday] || 0,
  };
}

const MESIACE_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MESIACE_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
// Lokál po predložke „v“ (v septembri, v září).
const MESIACE_SK_V = ['januári', 'februári', 'marci', 'apríli', 'máji', 'júni', 'júli', 'auguste', 'septembri', 'októbri', 'novembri', 'decembri'];
const MESIACE_CS_V = ['lednu', 'únoru', 'březnu', 'dubnu', 'květnu', 'červnu', 'červenci', 'srpnu', 'září', 'říjnu', 'listopadu', 'prosinci'];

/** „v septembri“, „v září“, „in September“, „im September“ bez predložky: vracia len tvar mesiaca (1 až 12). */
export function mesiacVTvare(jazyk, mesiac) {
  const i = Math.max(1, Math.min(12, Number(mesiac) || 1)) - 1;
  if (jazyk === 'sk') return MESIACE_SK_V[i];
  if (jazyk === 'cs') return MESIACE_CS_V[i];
  if (jazyk === 'de') return MESIACE_DE[i];
  return MESIACE_EN[i];
}

/** Dátum bez času: 25. 9. 2026 (sk, cs), 25.09.2026 (de), 25 September 2026 (en). Pásmo Bratislava. */
export function formatDatum(jazyk, date) {
  const c = castiDatumu(date);
  if (jazyk === 'de') return `${String(c.den).padStart(2, '0')}.${String(c.mesiac).padStart(2, '0')}.${c.rok}`;
  if (jazyk === 'en') return `${c.den}${NB}${MESIACE_EN[c.mesiac - 1]} ${c.rok}`;
  // Nezlomiteľné medzery: dátum sa na telefóne nerozdelí na „29.“ a „9. 2026“.
  return `${c.den}.${NB}${c.mesiac}.${NB}${c.rok}`;
}

/** Dátum a čas udalosti: Bratislava pre sk, cs, de; UTC s označením pre en (návrh 2.4, E2). */
export function formatKedy(jazyk, date) {
  if (jazyk === 'en') {
    const c = castiDatumu(date, 'UTC');
    return `${c.den} ${MESIACE_EN[c.mesiac - 1]} ${c.rok} at ${c.hh}:${c.mm} UTC`;
  }
  const c = castiDatumu(date);
  if (jazyk === 'de') return `${String(c.den).padStart(2, '0')}.${String(c.mesiac).padStart(2, '0')}.${c.rok} um ${c.hh}:${c.mm} Uhr`;
  if (jazyk === 'cs') return `${c.den}.${NB}${c.mesiac}.${NB}${c.rok} v ${c.hh}:${c.mm}`;
  return `${c.den}.${NB}${c.mesiac}.${NB}${c.rok} o ${c.hh}:${c.mm}`;
}

/** Tvar slova „produkt“ po čísle (1 produkt, 3 produkty, 5 produktov). */
export function produktov(jazyk, n) {
  const k = Math.abs(Number(n) || 0);
  if (jazyk === 'sk') return k === 1 ? 'produkt' : k >= 2 && k <= 4 ? 'produkty' : 'produktov';
  if (jazyk === 'cs') return k === 1 ? 'produkt' : k >= 2 && k <= 4 ? 'produkty' : 'produktů';
  if (jazyk === 'de') return k === 1 ? 'Produkt' : 'Produkte';
  return k === 1 ? 'product' : 'products';
}

/** Číslo s oddeľovačom tisícok podľa jazyka (1 000 s nezlomiteľnou medzerou, 1,000, 1.000). */
function cislo(jazyk, n) {
  const s = String(Math.floor(Number(n) || 0));
  const sep = jazyk === 'en' ? ',' : jazyk === 'de' ? '.' : NB;
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

const eur = (L, n) => (L === 'en' ? `${n}${NB}EUR` : `${n}${NB}€`);
const perc = (L, n) => (L === 'en' ? `${n}%` : `${n}${NB}%`);

/** Riadky tabuľky plánov v E4, čísla z DEFAULT_QUOTAS a CENY_EUR. */
const riadkyPlanov = (L, free) => [
  { bunky: [free, cislo(L, ROZH.free), eur(L, 0)], aktualny: true },
  { bunky: ['Starter', cislo(L, ROZH.starter), eur(L, CENY_EUR.starter)] },
  { bunky: ['Pro', cislo(L, ROZH.pro), eur(L, CENY_EUR.pro)] },
];

// ---------------------------------------------------------------------------
// Návod na zapojenie podľa platformy (návrh 2.3)
// ---------------------------------------------------------------------------

function navodBloky(jazyk, platforma, tenantId) {
  const kod = { pre: vkladaciKod(tenantId) };
  const N = {
    sk: {
      wordpress: ['Nemusíte nič vkladať. Plugin ARLing Shopping Assistant zobrazuje Asistenta na celom webe sám, hneď keď je pripravený. Nastavenia nájdete vo WordPresse v časti WooCommerce, ARLing Shopping Assistant.'],
      woocommerce: [
        `Najjednoduchšie je náš bezplatný ${odkaz('plugin pre WooCommerce', 'https://arling.sk/asistent/woocommerce/')}. Vo WordPresse otvorte Pluginy, Pridať nový plugin, vyhľadajte „ARLing Shopping Assistant“ a pri pripojení zadajte túto istú e-mailovú adresu (inak plugin nebude môcť načítanie opakovať).`,
        'Alebo vložte tento kód na každú stránku webu tesne pred </body>:',
        kod,
      ],
      shopify: [
        'V administrácii Shopify otvorte Online Store, Themes, pri aktívnej téme Edit code a súbor theme.liquid. Vložte tento kód tesne pred </body> a uložte:',
        kod,
        'Aplikáciu v Shopify App Store zatiaľ nemáme, preto ide o vloženie kódu.',
      ],
      shoptet: [
        'V administrácii Shoptetu otvorte Vzhľad a obsah, Editor, HTML kód, časť Pätička. Vložte tento kód a uložte:',
        kod,
        'Chat sa potom zobrazí vpravo dole na každej stránke obchodu.',
      ],
      eshoprychle: [
        'V administrácii Eshop rýchlo (Eshop-rychle) otvorte E-shop, Meracie kódy (v českej administrácii Měřící kódy), pridajte vlastný kód s umiestnením Pätička, vložte tento kód a uložte:',
        kod,
        { tlmene: 'Ak vpravo dole už máte iné tlačidlo, pridajte do kódu data-position="left".' },
      ],
      heureka: [
        'Vložte tento kód do päty každej stránky obchodu:',
        kod,
        { h: 'Kde to nájdete podľa platformy:' },
        'Shoptet: Vzhľad a obsah, Editor, HTML kód, časť Pätička.',
        'Upgates: Doplňky, Vlastní konverzní kódy, nový kód s umiestnením Všechny stránky e-shopu.',
        'Eshop rýchlo (Eshop-rychle): E-shop, Meracie kódy (Měřící kódy), vlastný kód s umiestnením Pätička.',
        'Iná platforma: tesne pred </body> na každej stránke.',
      ],
      vseobecne: [
        'Vložte tento kód na každú stránku webu tesne pred </body>. Na väčšine platforiem sa to robí v šablóne alebo v nastavení vlastných kódov do päty stránky:',
        kod,
      ],
    },
    cs: {
      wordpress: ['Nemusíte nic vkládat. Plugin ARLing Shopping Assistant zobrazuje Asistenta na celém webu sám, hned jak je připravený. Nastavení najdete ve WordPressu v části WooCommerce, ARLing Shopping Assistant.'],
      woocommerce: [
        `Nejjednodušší je náš bezplatný ${odkaz('plugin pro WooCommerce', 'https://arling.sk/asistent/woocommerce/')}. Ve WordPressu otevřete Pluginy, Přidat nový plugin, vyhledejte „ARLing Shopping Assistant“ a při připojení zadejte tuto e-mailovou adresu (jinak plugin nebude moct načtení zopakovat).`,
        'Nebo vložte tento kód na každou stránku webu těsně před </body>:',
        kod,
      ],
      shopify: [
        'V administraci Shopify otevřete Online Store, Themes, u aktivní šablony Edit code a soubor theme.liquid. Vložte tento kód těsně před </body> a uložte:',
        kod,
        'Aplikaci v Shopify App Store zatím nemáme, proto jde o vložení kódu.',
      ],
      shoptet: [
        'V administraci Shoptetu otevřete Vzhled a obsah, Editor, HTML kód, část Zápatí. Vložte tento kód a uložte:',
        kod,
        'Chat se pak zobrazí vpravo dole na každé stránce obchodu.',
      ],
      eshoprychle: [
        'V administraci Eshop-rychle otevřete E-shop, Měřící kódy, přidejte vlastní kód s umístěním Patička, vložte tento kód a uložte:',
        kod,
        { tlmene: 'Pokud vpravo dole už máte jiné tlačítko, přidejte do kódu data-position="left".' },
      ],
      heureka: [
        'Vložte tento kód do zápatí každé stránky obchodu:',
        kod,
        { h: 'Kde to najdete podle platformy:' },
        'Shoptet: Vzhled a obsah, Editor, HTML kód, část Zápatí.',
        'Upgates: Doplňky, Vlastní konverzní kódy, nový kód s umístěním Všechny stránky e-shopu.',
        'Eshop-rychle: E-shop, Měřící kódy, vlastní kód s umístěním Patička.',
        'Jiná platforma: těsně před </body> na každé stránce.',
      ],
      vseobecne: [
        'Vložte tento kód na každou stránku webu těsně před </body>. Na většině platforem se to dělá v šabloně nebo v nastavení vlastních kódů do zápatí stránky:',
        kod,
      ],
    },
    en: {
      wordpress: ['There is nothing to paste. The ARLing Shopping Assistant plugin shows the assistant across your whole site by itself as soon as it is ready. Settings are in WordPress under WooCommerce, ARLing Shopping Assistant.'],
      woocommerce: [
        `The easiest way is our free ${odkaz('WooCommerce plugin', 'https://arling.sk/asistent/woocommerce/')}. In WordPress open Plugins, Add New Plugin, search for "ARLing Shopping Assistant" and enter this same e-mail address when you connect (otherwise the plugin cannot retry loading).`,
        'Or paste this code on every page of your site just before </body>:',
        kod,
      ],
      shopify: [
        'In your Shopify admin open Online Store, Themes, then Edit code on the live theme and the file theme.liquid. Paste this code just before </body> and save:',
        kod,
        'We do not have an app in the Shopify App Store yet, so this is done by pasting the code.',
      ],
      shoptet: [
        'In the Shoptet admin open Vzhľad a obsah (Appearance and content), Editor, HTML kód, section Pätička (Footer). Paste this code and save:',
        kod,
        'The chat then appears in the bottom right corner of every shop page.',
      ],
      eshoprychle: [
        'In the Eshop-rychle admin open E-shop, Měřící kódy (measurement codes), add a custom code placed in Patička (footer), paste this code and save:',
        kod,
        { tlmene: 'If another button already sits bottom right, add data-position="left" to the code.' },
      ],
      heureka: [
        'Paste this code into the footer of every shop page:',
        kod,
        { h: 'Where to find it on your platform:' },
        'Shoptet: Vzhľad a obsah (Appearance and content), Editor, HTML kód, section Pätička (Footer).',
        'Upgates: Doplňky, Vlastní konverzní kódy (custom conversion codes), new code placed on Všechny stránky e-shopu (all shop pages).',
        'Eshop-rychle: E-shop, Měřící kódy (measurement codes), custom code placed in Patička (footer).',
        'Any other platform: just before </body> on every page.',
      ],
      vseobecne: [
        'Paste this code on every page of your site just before </body>. On most platforms this is done in the theme or in a setting for custom footer code:',
        kod,
      ],
    },
    de: {
      wordpress: ['Sie müssen nichts einfügen. Das Plugin ARLing Shopping Assistant zeigt den Assistenten selbst auf der ganzen Website an, sobald er bereit ist. Die Einstellungen finden Sie in WordPress unter WooCommerce, ARLing Shopping Assistant.'],
      woocommerce: [
        `Am einfachsten ist unser kostenloses ${odkaz('WooCommerce-Plugin', 'https://arling.sk/asistent/woocommerce/')}. Öffnen Sie in WordPress Plugins, Neues Plugin hinzufügen, suchen Sie nach „ARLing Shopping Assistant“ und geben Sie beim Verbinden dieselbe E-Mail-Adresse ein (sonst kann das Plugin das Laden nicht wiederholen).`,
        'Oder fügen Sie diesen Code auf jeder Seite Ihrer Website direkt vor </body> ein:',
        kod,
      ],
      shopify: [
        'Öffnen Sie im Shopify-Admin Online Store, Themes, beim aktiven Theme Edit code und die Datei theme.liquid. Fügen Sie diesen Code direkt vor </body> ein und speichern Sie:',
        kod,
        'Eine App im Shopify App Store gibt es noch nicht, deshalb der Weg über den Code.',
      ],
      shoptet: [
        'Öffnen Sie in der Shoptet-Verwaltung Vzhľad a obsah (Aussehen und Inhalt), Editor, HTML kód, Bereich Pätička (Fußzeile). Fügen Sie diesen Code ein und speichern Sie:',
        kod,
        'Der Chat erscheint dann unten rechts auf jeder Seite des Shops.',
      ],
      eshoprychle: [
        'In der Eshop-rychle-Verwaltung unter E-shop, Měřící kódy (Messcodes) einen eigenen Code mit Platzierung Patička (Fußzeile) anlegen, diesen Code einfügen und speichern:',
        kod,
        { tlmene: 'Ist unten rechts schon eine andere Schaltfläche, ergänzen Sie im Code data-position="left".' },
      ],
      heureka: [
        'Fügen Sie diesen Code in die Fußzeile jeder Shopseite ein:',
        kod,
        { h: 'Wo Sie das auf Ihrer Plattform finden:' },
        'Shoptet: Vzhľad a obsah (Aussehen und Inhalt), Editor, HTML kód, Bereich Pätička (Fußzeile).',
        'Upgates: Doplňky, Vlastní konverzní kódy (eigene Conversion-Codes), neuer Code mit Platzierung Všechny stránky e-shopu (alle Shopseiten).',
        'Eshop-rychle: E-shop, Měřící kódy (Messcodes), eigener Code mit Platzierung Patička (Fußzeile).',
        'Andere Plattform: direkt vor </body> auf jeder Seite.',
      ],
      vseobecne: [
        'Fügen Sie diesen Code auf jeder Seite Ihrer Website direkt vor </body> ein. Auf den meisten Plattformen geht das im Theme oder in einer Einstellung für eigenen Code in der Fußzeile:',
        kod,
      ],
    },
  };
  const L = N[jazyk] || N.en;
  return L[platforma] || L.vseobecne;
}

// ---------------------------------------------------------------------------
// Prečo sa katalóg nenačítal (E0): kód z onboarding.js classifyFeedError
// ---------------------------------------------------------------------------

const NASA_STRANA = new Set(['ai_budget_exhausted', 'internal']);

/** {dovod, rada, nasa}: nasa = chyba je na našej strane, majiteľ nemusí nič robiť. */
export function dovodChyby(jazyk, kod) {
  const c = String(kod || '');
  const http = c.match(/^feed_http_(\d{3})$/);
  const n = http ? Number(http[1]) : 0;
  const T = {
    sk: {
      auth: [`Server obchodu odmietol našu požiadavku (HTTP ${n}). Feed je pravdepodobne chránený heslom alebo ho blokuje firewall.`, 'Overte, že sa adresa feedu otvorí v súkromnom okne prehliadača bez prihlásenia, prípadne v bezpečnostnom nastavení webu povoľte jej verejné čítanie.'],
      h404: ['Na adrese feedu server odpovedal, že nič také neexistuje (HTTP 404).', 'Skontrolujte adresu feedu. Najčastejšie ju nájdete v administrácii e-shopu v časti exportov alebo feedov pre porovnávače cien.'],
      h429: ['Server obchodu obmedzil počet našich požiadaviek (HTTP 429).', 'Počkajte niekoľko minút a skúste to znova.'],
      h5xx: [`Server obchodu vrátil chybu (HTTP ${n}).`, 'Overte, že sa adresa feedu otvorí v prehliadači, a skúste to znova.'],
      hine: [`Server obchodu odpovedal kódom HTTP ${n}.`, 'Overte, že sa adresa feedu otvorí v súkromnom okne prehliadača.'],
      feed_not_readable: ['Na adrese feedu je stránka, ktorá nie je zoznam produktov, často stránka údržby, prihlásenia alebo kontroly firewallu.', 'Otvorte adresu feedu v súkromnom okne prehliadača: mal by sa zobraziť XML alebo JSON so zoznamom produktov.'],
      feed_unreachable: ['K serveru obchodu sa nepodarilo pripojiť.', 'Overte, že je web dostupný z internetu a adresa feedu je správna.'],
      url: ['Adresa feedu vedie na miestnu alebo súkromnú adresu, alebo cez príliš veľa presmerovaní, a tie z bezpečnostných dôvodov nesledujeme.', 'Použite adresu, ktorá sa otvorí priamo na verejnej doméne obchodu.'],
      no_products: ['Vo feede sme nenašli žiadne produkty.', 'Skontrolujte, či feed obsahuje aspoň jeden zverejnený produkt.'],
      ai_budget_exhausted: ['Naša služba dnes dosiahla denný limit spracovania. Chyba je na našej strane, nie na vašej.', 'Produkty skúsime načítať znova v noci okolo 3:00 UTC.'],
      internal: ['Pri spracovaní produktov sa niečo pokazilo na našej strane.', 'Skúsime to znova v noci. Ak by to pretrvávalo, odpovedzte na tento e-mail.'],
      inak: ['Príčinu sa nepodarilo presne zistiť.', 'Otvorte adresu feedu v súkromnom okne prehliadača a overte, že zobrazí zoznam produktov.'],
    },
    cs: {
      auth: [`Server obchodu odmítl náš požadavek (HTTP ${n}). Feed je pravděpodobně chráněný heslem nebo ho blokuje firewall.`, 'Ověřte, že se adresa feedu otevře v anonymním okně prohlížeče bez přihlášení, případně v bezpečnostním nastavení webu povolte její veřejné čtení.'],
      h404: ['Na adrese feedu server odpověděl, že nic takového neexistuje (HTTP 404).', 'Zkontrolujte adresu feedu. Nejčastěji ji najdete v administraci e-shopu v části exportů nebo feedů pro srovnávače cen.'],
      h429: ['Server obchodu omezil počet našich požadavků (HTTP 429).', 'Počkejte několik minut a zkuste to znovu.'],
      h5xx: [`Server obchodu vrátil chybu (HTTP ${n}).`, 'Ověřte, že se adresa feedu otevře v prohlížeči, a zkuste to znovu.'],
      hine: [`Server obchodu odpověděl kódem HTTP ${n}.`, 'Ověřte, že se adresa feedu otevře v anonymním okně prohlížeče.'],
      feed_not_readable: ['Na adrese feedu je stránka, která není seznam produktů, často stránka údržby, přihlášení nebo kontroly firewallu.', 'Otevřete adresu feedu v anonymním okně prohlížeče: měl by se zobrazit XML nebo JSON se seznamem produktů.'],
      feed_unreachable: ['K serveru obchodu se nepodařilo připojit.', 'Ověřte, že je web dostupný z internetu a adresa feedu je správná.'],
      url: ['Adresa feedu vede na místní nebo soukromou adresu, nebo přes příliš mnoho přesměrování, a ty z bezpečnostních důvodů nesledujeme.', 'Použijte adresu, která se otevře přímo na veřejné doméně obchodu.'],
      no_products: ['Ve feedu jsme nenašli žádné produkty.', 'Zkontrolujte, zda feed obsahuje alespoň jeden zveřejněný produkt.'],
      ai_budget_exhausted: ['Naše služba dnes dosáhla denního limitu zpracování. Chyba je na naší straně, ne na vaší.', 'Produkty zkusíme načíst znovu v noci kolem 3:00 UTC.'],
      internal: ['Při zpracování produktů se něco pokazilo na naší straně.', 'Zkusíme to znovu v noci. Pokud by to přetrvávalo, odpovězte na tento e-mail.'],
      inak: ['Příčinu se nepodařilo přesně zjistit.', 'Otevřete adresu feedu v anonymním okně prohlížeče a ověřte, že zobrazí seznam produktů.'],
    },
    en: {
      auth: [`The shop's server refused our request (HTTP ${n}). The feed is probably password protected or blocked by a firewall.`, 'Check that the feed address opens in a private browser window without logging in, or allow public reading of it in your site security settings.'],
      h404: ['The server said the feed address does not exist (HTTP 404).', 'Check the feed address. It is usually in your shop admin under exports or price comparison feeds.'],
      h429: ['The shop\'s server limited the number of our requests (HTTP 429).', 'Wait a few minutes and try again.'],
      h5xx: [`The shop's server returned an error (HTTP ${n}).`, 'Check that the feed address opens in a browser, then try again.'],
      hine: [`The shop's server answered with HTTP ${n}.`, 'Check that the feed address opens in a private browser window.'],
      feed_not_readable: ['The feed address shows a page that is not a product list, often a maintenance, login or firewall check page.', 'Open the feed address in a private browser window: it should show XML or JSON with your products.'],
      feed_unreachable: ['We could not connect to the shop\'s server.', 'Check that the site is reachable from the internet and that the feed address is correct.'],
      url: ['The feed address leads to a local or private address, or through too many redirects, which we do not follow for security reasons.', 'Use an address that opens directly on the shop\'s public domain.'],
      no_products: ['We found no products in the feed.', 'Check that the feed contains at least one published product.'],
      ai_budget_exhausted: ['Our service reached its daily processing limit today. This is on our side, not yours.', 'We will try to load the products again tonight at about 03:00 UTC.'],
      internal: ['Something went wrong on our side while processing the products.', 'We will try again tonight. If it keeps failing, reply to this e-mail.'],
      inak: ['We could not tell exactly why.', 'Open the feed address in a private browser window and check that it shows your products.'],
    },
    de: {
      auth: [`Der Server des Shops hat unsere Anfrage abgelehnt (HTTP ${n}). Der Feed ist wahrscheinlich passwortgeschützt oder wird von einer Firewall blockiert.`, 'Prüfen Sie, ob sich die Feed-Adresse in einem privaten Browserfenster ohne Anmeldung öffnet, oder erlauben Sie in den Sicherheitseinstellungen der Website den öffentlichen Abruf.'],
      h404: ['Der Server meldet, dass es die Feed-Adresse nicht gibt (HTTP 404).', 'Prüfen Sie die Feed-Adresse. Sie steht meist in der Shop-Verwaltung bei den Exporten oder Feeds für Preisvergleiche.'],
      h429: ['Der Server des Shops hat die Zahl unserer Anfragen begrenzt (HTTP 429).', 'Warten Sie einige Minuten und versuchen Sie es erneut.'],
      h5xx: [`Der Server des Shops hat einen Fehler gemeldet (HTTP ${n}).`, 'Prüfen Sie, ob sich die Feed-Adresse im Browser öffnet, und versuchen Sie es erneut.'],
      hine: [`Der Server des Shops hat mit HTTP ${n} geantwortet.`, 'Prüfen Sie, ob sich die Feed-Adresse in einem privaten Browserfenster öffnet.'],
      feed_not_readable: ['Unter der Feed-Adresse steht eine Seite, die keine Produktliste ist, oft eine Wartungs-, Anmelde- oder Firewall-Seite.', 'Öffnen Sie die Feed-Adresse in einem privaten Browserfenster: Es sollte XML oder JSON mit Ihren Produkten erscheinen.'],
      feed_unreachable: ['Wir konnten keine Verbindung zum Server des Shops herstellen.', 'Prüfen Sie, ob die Website aus dem Internet erreichbar und die Feed-Adresse richtig ist.'],
      url: ['Die Feed-Adresse führt zu einer lokalen oder privaten Adresse oder über zu viele Weiterleitungen, denen wir aus Sicherheitsgründen nicht folgen.', 'Verwenden Sie eine Adresse, die sich direkt auf der öffentlichen Domain des Shops öffnet.'],
      no_products: ['Im Feed haben wir keine Produkte gefunden.', 'Prüfen Sie, ob der Feed mindestens ein veröffentlichtes Produkt enthält.'],
      ai_budget_exhausted: ['Unser Dienst hat heute sein tägliches Verarbeitungslimit erreicht. Das liegt an uns, nicht an Ihnen.', 'Wir laden die Produkte heute Nacht gegen 03:00 UTC erneut.'],
      internal: ['Bei der Verarbeitung der Produkte ist auf unserer Seite etwas schiefgegangen.', 'Wir versuchen es heute Nacht erneut. Falls es dabei bleibt, antworten Sie auf diese E-Mail.'],
      inak: ['Den genauen Grund konnten wir nicht feststellen.', 'Öffnen Sie die Feed-Adresse in einem privaten Browserfenster und prüfen Sie, ob Ihre Produkte erscheinen.'],
    },
  };
  const L = T[jazyk] || T.en;
  let par;
  if (n === 401 || n === 403) par = L.auth;
  else if (n === 404) par = L.h404;
  else if (n === 429) par = L.h429;
  else if (n >= 500) par = L.h5xx;
  else if (n) par = L.hine;
  else if (/^feed_url_|^feed_too_many_redirects$/.test(c)) par = L.url;
  else par = L[c] || L.inak;
  return { dovod: par[0], rada: par[1], nasa: NASA_STRANA.has(c) };
}

// ---------------------------------------------------------------------------
// Spoločné časti
// ---------------------------------------------------------------------------

const SPOLOCNE = {
  sk: {
    pozdrav: 'Dobrý deň,',
    podpis: 'Andrej, ARLing',
    odpoved: 'Obsah rozhovorov neukladáme, len počty. Otázka? Odpovedzte, číta to Andrej.',
    zadarmo: (L, max) => `Zadarmo: ${ROZH.free} rozhovorov mesačne, bez karty. Rozhovor je prvá otázka návštevníka a ďalšie v tej istej karte prehliadača do ${HODINY_ROZHOVORU}${NB}hodín${max ? ` (najviac ${cislo(L, max)}${NB}otázok)` : ''}. Pri limite sa nič samo nespoplatní. Viac dáva Starter za ${eur(L, CENY_EUR.starter)} mesačne (${cislo(L, ROZH.starter)}${NB}rozhovorov).`,
    kde: (zdroj) => (zdroj === 'wordpress' ? 'vo WordPress plugine ARLing Shopping Assistant' : 'na arling.sk'),
    precoZriadenie: (p) => `Prečo vám to píšeme: ${p.datum} ste ${p.kde} vytvorili Asistenta pre ${p.domena} s touto adresou.`,
    precoServis: (p) => `Tento e-mail prišiel, lebo ste ${p.datum} ${p.kde} vytvorili Asistenta pre ${p.domena}.`,
    dalsieE1: `Pošleme ešte najviac tri správy: potvrdenie zapojenia, jednu ponuku pomoci a upozornenie pri ${perc('sk', 80)} limitu. Nechcete ich alebo ste Asistenta nevytvárali vy? Zastavíte ich tu: `,
    dalsieE0: `Keď sa produkty načítajú, pošleme vám e-mail s návodom a potom najviac dve ďalšie správy: potvrdenie zapojenia a upozornenie pri ${perc('sk', 80)} bezplatného limitu. Ak ich nechcete alebo ste Asistenta nevytvárali vy, všetky zastavíte tu: `,
    dalsieE1W: `K tomuto Asistentovi vám pošleme už najviac jednu správu: upozornenie pri ${perc('sk', 80)} bezplatného limitu. Ak ju nechcete alebo ste Asistenta nevytvárali vy, zastavíte ju tu: `,
    dalsieServis: 'Ďalšie správy zastavíte tu: ',
    bezDalsichE1: 'Ďalšie voliteľné správy k tomuto Asistentovi posielať nebudeme. Ak ste Asistenta nevytvárali vy, odpovedzte na tento e-mail.',
    bezDalsichE0: 'Keď sa produkty načítajú, pošleme už len e-mail s návodom. Ak ste Asistenta nevytvárali vy, odpovedzte na tento e-mail.',
    zmazat: 'Zrušenie Asistenta a zmazanie údajov do 7 dní: odpovedzte slovom „zmazať“.',
    zasady: `Ako narábame s vašimi údajmi: ${odkaz('zásady Asistenta', 'https://arling.sk/asistent/#privacy')}`,
    firma: 'ARLing s. r. o., Ivanská cesta 32E, 821 04 Bratislava, IČO 56583486',
    tri: 'Štyri veci, ktoré sa oplatí vedieť:',
    tipy: (p) => [
      'Položte mu sami otázku, ktorú vaši zákazníci kladú najčastejšie, a pozrite, či odpoveď sedí.',
      `Koľko rozhovorov už prebehlo, uvidíte na ${odkaz('stránke účtu', p.ucet)}.`,
      'Produkty si Asistent každú noc načíta znova, zmeny cien a dostupnosti preberie sám.',
      'Ak niekedy odpovie zle, pošlite nám otázku, na ktorej sa pomýlil. Pozrieme sa na to.',
    ],
    wpNastavenia: 'Nastavenia nájdete vo WordPresse v časti WooCommerce, ARLing Shopping Assistant.',
    znacka: 'ARLing Asistent',
    stopPopis: 'zastaviť e-maily',
    otazky: 'Aké otázky mu vaši zákazníci kladú, vám neukážeme, a nie z lenivosti: obsah rozhovorov neukladáme vôbec, takže ho nemáme ani my. Vidíme len počty.',
    strop: (L) => `Platený plán zvýši aj denný strop otázok, na ktoré odpovedá jazykový model: zo ${STROP.free} na ${STROP.starter} (Starter) alebo ${cislo(L, STROP.pro)} (Pro).`,
    plany: (L) => ({ hlavicka: ['Plán', 'Rozhovory', 'Mesačne'], riadky: riadkyPlanov(L, 'Free (teraz)') }),
  },
  cs: {
    pozdrav: 'Dobrý den,',
    podpis: 'Andrej, ARLing',
    odpoved: 'Obsah konverzací neukládáme, jen počty. Otázka? Odpovězte, čte to Andrej.',
    zadarmo: (L, max) => `Zdarma: ${ROZH.free} konverzací měsíčně, bez karty. Konverzace je první otázka návštěvníka a další ve stejné kartě prohlížeče do ${HODINY_ROZHOVORU}${NB}hodin${max ? ` (nejvýše ${cislo(L, max)}${NB}otázek)` : ''}. Při limitu se nic samo nezpoplatní. Víc nabízí Starter za ${eur(L, CENY_EUR.starter)} měsíčně (${cislo(L, ROZH.starter)}${NB}konverzací).`,
    kde: (zdroj) => (zdroj === 'wordpress' ? 'v pluginu ARLing Shopping Assistant pro WordPress' : 'na arling.sk'),
    precoZriadenie: (p) => `Proč vám píšeme: ${p.datum} jste ${p.kde} vytvořili Asistenta pro ${p.domena} s touto adresou.`,
    precoServis: (p) => `Tento e-mail přišel, protože jste ${p.datum} ${p.kde} vytvořili Asistenta pro ${p.domena}.`,
    dalsieE1: `Pošleme ještě nejvýše tři zprávy: potvrzení zapojení, jednu nabídku pomoci a upozornění při ${perc('cs', 80)} limitu. Nechcete je nebo jste Asistenta nevytvořili vy? Zastavíte je tady: `,
    dalsieE0: `Až se produkty načtou, pošleme vám e-mail s návodem a potom nejvýše dvě další zprávy: potvrzení zapojení a upozornění při ${perc('cs', 80)} bezplatného limitu. Pokud je nechcete nebo jste Asistenta nevytvořili vy, všechny zastavíte tady: `,
    dalsieE1W: `K tomuto Asistentovi vám pošleme už nejvýše jednu zprávu: upozornění při ${perc('cs', 80)} bezplatného limitu. Pokud ji nechcete nebo jste Asistenta nevytvořili vy, zastavíte ji tady: `,
    dalsieServis: 'Další zprávy zastavíte tady: ',
    bezDalsichE1: 'Další volitelné zprávy k tomuto Asistentovi posílat nebudeme. Pokud jste Asistenta nevytvořili vy, odpovězte na tento e-mail.',
    bezDalsichE0: 'Až se produkty načtou, pošleme už jen e-mail s návodem. Pokud jste Asistenta nevytvořili vy, odpovězte na tento e-mail.',
    zmazat: 'Zrušení Asistenta a smazání údajů do 7 dnů: odpovězte slovem „smazat“.',
    zasady: `Jak nakládáme s vašimi údaji: ${odkaz('zásady Asistenta', 'https://arling.sk/asistent/#privacy')}`,
    firma: 'ARLing s. r. o., Ivanská cesta 32E, 821 04 Bratislava, Slovensko, IČO 56583486',
    tri: 'Čtyři věci, které se vyplatí vědět:',
    tipy: (p) => [
      'Položte mu sami otázku, kterou vaši zákazníci kladou nejčastěji, a podívejte se, jestli odpověď sedí.',
      `Kolik konverzací už proběhlo, uvidíte na ${odkaz('stránce účtu', p.ucet)}.`,
      'Produkty si Asistent každou noc načte znovu, změny cen a dostupnosti převezme sám.',
      'Pokud někdy odpoví špatně, pošlete nám otázku, ve které se spletl. Podíváme se na to.',
    ],
    wpNastavenia: 'Nastavení najdete ve WordPressu v části WooCommerce, ARLing Shopping Assistant.',
    znacka: 'ARLing Asistent',
    stopPopis: 'zastavit e-maily',
    otazky: 'Jaké otázky mu vaši zákazníci kladou, vám neukážeme, a ne z lenosti: obsah konverzací neukládáme vůbec, takže ho nemáme ani my. Vidíme jen počty.',
    strop: (L) => `Placený tarif zvýší i denní strop otázek, na které odpovídá jazykový model: z ${STROP.free} na ${STROP.starter} (Starter) nebo ${cislo(L, STROP.pro)} (Pro).`,
    plany: (L) => ({ hlavicka: ['Tarif', 'Konverzace', 'Měsíčně'], riadky: riadkyPlanov(L, 'Free (teď)') }),
  },
  en: {
    pozdrav: 'Hello,',
    podpis: 'Andrej, ARLing',
    odpoved: 'We store counts, never conversation content. Questions? Just reply, Andrej reads it.',
    zadarmo: (L, max) => `Free: ${ROZH.free} conversations a month, no card. A conversation is a visitor's first question plus the next ones in the same browser tab within ${HODINY_ROZHOVORU}${NB}hours${max ? ` (up to ${cislo(L, max)}${NB}questions)` : ''}. Nothing is charged automatically at the limit. Starter gives you more for ${eur(L, CENY_EUR.starter)} a month (${cislo(L, ROZH.starter)} conversations).`,
    kde: (zdroj) => (zdroj === 'wordpress' ? 'in the ARLing Shopping Assistant WordPress plugin' : 'on arling.sk'),
    precoZriadenie: (p) => `Why you are getting this: on ${p.datum} you created an assistant for ${p.domena} ${p.kde} with this address.`,
    precoServis: (p) => `You are getting this because on ${p.datum} you created an assistant for ${p.domena} ${p.kde}.`,
    dalsieE1: 'At most three more e-mails follow: a confirmation when it goes live, one offer of help and a notice at 80% of the limit. Don\'t want them, or didn\'t create this assistant? Stop them here: ',
    dalsieE0: 'When the products load, we will send you the setup e-mail. After that, at most two more messages: a confirmation when it goes live and a notice at 80% of the free limit. Don\'t want them, or didn\'t create this assistant? You can stop all of them here: ',
    dalsieE1W: 'We will send you at most one more e-mail about this assistant: a notice at 80% of the free limit. Don\'t want it, or didn\'t create this assistant? You can stop it here: ',
    dalsieServis: 'Stop further messages here: ',
    bezDalsichE1: 'We will not send any further optional messages about this assistant. If you did not create it, reply to this e-mail.',
    bezDalsichE0: 'Once the products load, we will only send the e-mail with setup instructions. If you did not create this assistant, reply to this e-mail.',
    zmazat: 'To cancel the assistant and have your data deleted within 7 days, reply with the word "delete".',
    zasady: `How we handle your data: ${odkaz('assistant privacy notice', 'https://arling.sk/asistent/en/#privacy')}`,
    firma: 'ARLing s. r. o., Ivanská cesta 32E, 821 04 Bratislava, Slovakia, company ID 56583486',
    tri: 'Four things worth knowing:',
    tipy: (p) => [
      'Ask it the question your customers ask most often and check that the answer is right.',
      `You can see how many conversations it has had on your ${odkaz('account page', p.ucet)}.`,
      'The assistant re-reads your products every night, so price and stock changes are picked up automatically.',
      'If it ever gets an answer wrong, send us the question. We will look into it.',
    ],
    wpNastavenia: 'Settings are in WordPress under WooCommerce, ARLing Shopping Assistant.',
    znacka: 'ARLing Shopping Assistant',
    stopPopis: 'stop these e-mails',
    otazky: 'We cannot show you what your customers ask it, and not out of laziness: we do not store conversation content at all, so we do not have it either. We only see counts.',
    strop: (L) => `A paid plan also raises the daily cap on questions answered by the language model: from ${STROP.free} to ${STROP.starter} (Starter) or ${cislo(L, STROP.pro)} (Pro).`,
    plany: (L) => ({ hlavicka: ['Plan', 'Conversations', 'Per month'], riadky: riadkyPlanov(L, 'Free (now)') }),
  },
  de: {
    pozdrav: 'Guten Tag,',
    podpis: 'Andrej, ARLing',
    odpoved: 'Gesprächsinhalte speichern wir nie. Fragen? Antworten Sie, Andrej liest mit.',
    zadarmo: (L, max) => `Kostenlos: ${ROZH.free} Gespräche im Monat, ohne Karte. Ein Gespräch ist die erste Frage eines Besuchers und die weiteren im selben Browser-Tab binnen ${HODINY_ROZHOVORU}${NB}Stunden${max ? ` (höchstens ${cislo(L, max)}${NB}Fragen)` : ''}. Beim Limit wird nichts berechnet. Starter: ${eur(L, CENY_EUR.starter)} im Monat (${cislo(L, ROZH.starter)} Gespräche).`,
    kde: (zdroj) => (zdroj === 'wordpress' ? 'im WordPress-Plugin ARLing Shopping Assistant' : 'auf arling.sk'),
    precoZriadenie: (p) => `Warum Sie diese E-Mail erhalten: Am ${p.datum} haben Sie ${p.kde} mit dieser Adresse einen Assistenten für ${p.domena} erstellt.`,
    precoServis: (p) => `Sie erhalten diese E-Mail, weil Sie am ${p.datum} ${p.kde} einen Assistenten für ${p.domena} erstellt haben.`,
    dalsieE1: `Es folgen höchstens drei Nachrichten: eine Bestätigung, sobald er live ist, ein Hilfsangebot und ein Hinweis bei ${perc('de', 80)} des Limits. Nicht gewünscht oder nicht von Ihnen erstellt? Stoppen Sie sie hier: `,
    dalsieE0: `Sobald die Produkte geladen sind, schicken wir Ihnen die Anleitung. Danach höchstens zwei weitere Nachrichten: eine Bestätigung, sobald er live ist, und einen Hinweis bei ${perc('de', 80)} des kostenlosen Limits. Wenn Sie diese nicht möchten oder den Assistenten nicht erstellt haben, stoppen Sie alle hier: `,
    dalsieE1W: `Zu diesem Assistenten senden wir Ihnen höchstens noch eine Nachricht: einen Hinweis bei ${perc('de', 80)} des kostenlosen Limits. Wenn Sie diese nicht möchten oder den Assistenten nicht erstellt haben, stoppen Sie sie hier: `,
    dalsieServis: 'Weitere Nachrichten stoppen Sie hier: ',
    bezDalsichE1: 'Weitere optionale Nachrichten zu diesem Assistenten senden wir nicht. Falls Sie ihn nicht erstellt haben, antworten Sie auf diese E-Mail.',
    bezDalsichE0: 'Sobald die Produkte geladen sind, senden wir nur noch die E-Mail mit der Anleitung. Falls Sie den Assistenten nicht erstellt haben, antworten Sie auf diese E-Mail.',
    zmazat: 'Kündigen und Daten binnen 7 Tagen löschen: Antworten Sie mit „löschen“.',
    zasady: `Umgang mit Ihren Daten: ${odkaz('Datenschutzhinweis (auf Englisch)', 'https://arling.sk/asistent/en/#privacy')}`,
    firma: 'ARLing s. r. o., Ivanská cesta 32E, 821 04 Bratislava, Slowakei, Firmennummer (IČO) 56583486',
    tri: 'Vier Dinge, die Sie wissen sollten:',
    tipy: (p) => [
      'Stellen Sie ihm selbst die Frage, die Ihre Kunden am häufigsten stellen, und prüfen Sie, ob die Antwort stimmt.',
      `Wie viele Gespräche es schon gab, sehen Sie auf Ihrer ${odkaz('Kontoseite', p.ucet)}.`,
      'Der Assistent liest Ihre Produkte jede Nacht neu ein und übernimmt Preis- und Verfügbarkeitsänderungen selbst.',
      'Falls er einmal falsch antwortet, schicken Sie uns die Frage, bei der er sich geirrt hat. Wir sehen uns das an.',
    ],
    wpNastavenia: 'Die Einstellungen finden Sie in WordPress unter WooCommerce, ARLing Shopping Assistant.',
    znacka: 'ARLing Shopping Assistant',
    stopPopis: 'E-Mails stoppen',
    otazky: 'Welche Fragen Ihre Kunden ihm stellen, können wir Ihnen nicht zeigen, und das nicht aus Bequemlichkeit: Wir speichern den Inhalt der Gespräche überhaupt nicht, also haben auch wir ihn nicht. Wir sehen nur Zahlen.',
    strop: (L) => `Ein bezahlter Tarif erhöht auch die tägliche Obergrenze für Fragen, die das Sprachmodell beantwortet: von ${STROP.free} auf ${STROP.starter} (Starter) oder ${cislo(L, STROP.pro)} (Pro).`,
    plany: (L) => ({ hlavicka: ['Tarif', 'Gespräche', 'Monatlich'], riadky: riadkyPlanov(L, 'Free (aktuell)') }),
  },
};

export const ANGLICKA_VETA = 'Prefer English? Reply "English" and we will write in English from now on.';

// ---------------------------------------------------------------------------
// Nadpis, preheader a jedno tlačidlo každého e-mailu (Z-42). Humor len v
// nadpise a len vlídny; žiadne lehoty, žiadne „posledná šanca“. Tlačidlo vedie
// vždy na arling.sk (stránka účtu, skúšobná stránka, formulár), nikdy na
// cudziu adresu; bez neho ostane e-mail celý v texte.
// ---------------------------------------------------------------------------

const FORMULAR = { sk: 'https://arling.sk/asistent/', cs: 'https://arling.sk/asistent/', en: 'https://arling.sk/asistent/en/', de: 'https://arling.sk/asistent/en/' };

function tlacidloPodla(T, L) {
  return (kod, p) => {
    if (kod === 'E1') return p.wp ? { text: T.skusit, url: p.skusit } : { text: T.kod, url: p.ucet };
    if (kod === 'E1W') return { text: T.skusit, url: p.skusit };
    if (kod === 'E0') return p.nasa || p.wp ? null : { text: T.formular, url: FORMULAR[L] };
    if (kod === 'E2') return { text: T.ucet, url: p.ucet };
    // WordPress: kód sa nevkladá, na kontrolu pluginu nevedie žiadna naša adresa; výzvou je odpoveď na e-mail.
    if (kod === 'E3') return p.wp ? null : { text: T.kod, url: p.ucet };
    if (kod === 'E4') return { text: T.plany, url: p.ucet };
    return null;
  };
}

const DOPLNKY = {
  sk: {
    nadpis: (kod, p) => ({
      E1: `Asistent sa naučil ${p.nS}. Naspamäť.`,
      E1W: 'Nastúpil a hneď do služby.',
      E0: p.nasa ? 'Tentoraz zaváhala naša strana.' : 'Váš feed nám zatiaľ nepovedal ani slovo.',
      E2: 'Okienko svieti. Asistent je v práci.',
      E3: 'Pomôžeme so zapojením?',
      E4: `Využili ste ${p.used} zo ${p.quota} rozhovorov`,
    })[kod],
    preheader: (kod, p) => ({
      E1: p.wp ? 'Plugin ho na webe zapína sám, vkladať nič netreba. Vyskúšajte ho.' : 'Zostáva jediný krok: vložiť jeden riadok kódu na váš web.',
      E1W: 'Produkty má prečítané a na vašom webe už odpovedá.',
      E0: 'Čo sa stalo a čo s tým, stručne.',
      E2: 'Prvé načítanie na vašom webe sme zaznamenali. Štyri veci, ktoré sa oplatí vedieť.',
      E3: p.wp ? 'Tri veci, ktoré vo WordPresse skontrolovať. Jediná pripomienka.' : 'Návod ešte raz a tri najčastejšie prekážky. Jediná pripomienka.',
      E4: 'Čo sa stane pri limite (nič sa nespoplatní) a čo by priniesol platený plán.',
    })[kod],
    tlacidlo: tlacidloPodla({ skusit: 'Vyskúšať Asistenta', kod: 'Otvoriť kód na vloženie', formular: 'Odoslať formulár znova', ucet: 'Otvoriť stránku účtu', plany: 'Porovnať plány na stránke účtu' }, 'sk'),
  },
  cs: {
    nadpis: (kod, p) => ({
      E1: `Asistent se naučil ${p.nS}. Nazpaměť.`,
      E1W: 'Nastoupil a rovnou do služby.',
      E0: p.nasa ? 'Tentokrát zaváhala naše strana.' : 'Váš feed nám zatím neřekl ani slovo.',
      E2: 'Okénko svítí. Asistent je v práci.',
      E3: 'Pomůžeme se zapojením?',
      E4: `Využili jste ${p.used} ze ${p.quota} konverzací`,
    })[kod],
    preheader: (kod, p) => ({
      E1: p.wp ? 'Plugin ho na webu zapíná sám, nic se nevkládá. Vyzkoušejte ho.' : 'Zbývá jediný krok: vložit jeden řádek kódu na váš web.',
      E1W: 'Produkty má přečtené a na vašem webu už odpovídá.',
      E0: 'Co se stalo a co s tím, stručně.',
      E2: 'První načtení na vašem webu jsme zaznamenali. Čtyři věci, které se vyplatí vědět.',
      E3: p.wp ? 'Tři věci, které ve WordPressu zkontrolovat. Jediná připomínka.' : 'Návod ještě jednou a tři nejčastější překážky. Jediná připomínka.',
      E4: 'Co se stane při limitu (nic se nezpoplatní) a co by přinesl placený tarif.',
    })[kod],
    tlacidlo: tlacidloPodla({ skusit: 'Vyzkoušet Asistenta', kod: 'Otevřít kód pro vložení', formular: 'Odeslat formulář znovu', ucet: 'Otevřít stránku účtu', plany: 'Porovnat tarify na stránce účtu' }, 'cs'),
  },
  en: {
    nadpis: (kod, p) => ({
      E1: `Your assistant has learned ${p.nS}. By heart.`,
      E1W: 'Hired, and already on shift.',
      E0: p.nasa ? 'This time the hiccup is on our side.' : 'Your feed has not said a word to us yet.',
      E2: 'The chat window is on. Your assistant is at work.',
      E3: 'Need a hand with setup?',
      E4: `You have used ${p.used} of ${p.quota} conversations`,
    })[kod],
    preheader: (kod, p) => ({
      E1: p.wp ? 'The plugin switches it on by itself, nothing to paste. Give it a try.' : 'One step left: paste one line of code into your site.',
      E1W: 'It has read your products and is already answering on your site.',
      E0: 'What happened and what to do, in short.',
      E2: 'We saw it load on your site for the first time. Four things worth knowing.',
      E3: p.wp ? 'Three things to check in WordPress. The only reminder.' : 'The instructions again and the three most common obstacles. The only reminder.',
      E4: 'What happens at the limit (nothing is charged) and what a paid plan would add.',
    })[kod],
    tlacidlo: tlacidloPodla({ skusit: 'Try the assistant', kod: 'Open the embed code', formular: 'Submit the form again', ucet: 'Open your account page', plany: 'Compare plans on your account page' }, 'en'),
  },
  de: {
    nadpis: (kod, p) => ({
      E1: `Ihr Assistent kennt jetzt ${p.nS}. Auswendig.`,
      E1W: 'Eingestellt und schon im Dienst.',
      E0: p.nasa ? 'Diesmal hakt es bei uns.' : 'Ihr Feed hat uns noch kein Wort verraten.',
      E2: 'Das Chatfenster ist an. Ihr Assistent ist bei der Arbeit.',
      E3: 'Sollen wir beim Einbinden helfen?',
      E4: `Sie haben ${p.used} von ${p.quota} Gesprächen genutzt`,
    })[kod],
    preheader: (kod, p) => ({
      E1: p.wp ? 'Das Plugin schaltet ihn selbst ein, nichts einzufügen. Probieren Sie ihn aus.' : 'Nur noch ein Schritt: eine Zeile Code in Ihre Website einfügen.',
      E1W: 'Er kennt Ihre Produkte und antwortet schon auf Ihrer Website.',
      E0: 'Was passiert ist und was zu tun ist, kurz gefasst.',
      E2: 'Wir haben das erste Laden auf Ihrer Website bemerkt. Vier Dinge, die Sie wissen sollten.',
      E3: p.wp ? 'Drei Dinge, die Sie in WordPress prüfen können. Die einzige Erinnerung.' : 'Die Anleitung noch einmal und die drei häufigsten Hindernisse. Die einzige Erinnerung.',
      E4: 'Was beim Limit passiert (es wird nichts berechnet) und was ein bezahlter Tarif bringen würde.',
    })[kod],
    tlacidlo: tlacidloPodla({ skusit: 'Assistenten ausprobieren', kod: 'Einbindungscode öffnen', formular: 'Formular erneut senden', ucet: 'Kontoseite öffnen', plany: 'Tarife auf der Kontoseite vergleichen' }, 'de'),
  },
};

// ---------------------------------------------------------------------------
// Jednotlivé e-maily: {predmet, telo: [bloky]}; blok je reťazec (odsek),
// {h: nadpis kroku}, {pre: kód} alebo {ol: [položky]}.
// ---------------------------------------------------------------------------

function sablona(kod, L, p) {
  const S = SPOLOCNE[L];
  const n = p.pocet;
  const nS = `${cislo(L, n)}${NB}${produktov(L, n)}`;
  // V predmete obyčajné medzery (vyhľadávanie a filtre v pošte), v tele nezlomiteľné.
  const nSp = nS.split(NB).join(' ');
  const d = p.domena;
  const wp = p.platforma === 'wordpress';
  const navod = navodBloky(L, p.platforma, p.tenantId);
  const chyba = dovodChyby(L, p.chybaKod);
  const h = (text) => ({ h: text });

  const D = DOPLNKY[L];
  const tl = D.tlacidlo(kod, { ...p, wp, nasa: chyba.nasa });
  const B = tl ? [{ tlacidlo: tl }] : [];
  // Strop otázok v jednom rozhovore závisí od ASISTENT_MAX_OTAZOK (relacia.js
  // maxOtazok, wrangler.toml); bez parametra ho text neuvádza, nič netvrdí.
  const max = Number.isInteger(p.maxOtazok) && p.maxOtazok > 0 ? p.maxOtazok : 0;
  const zadarmo = { tlmene: S.zadarmo(L, max) };
  // Poradie (brána Z-42, nález 4): vecný úvod, hneď tlačidlo, podrobnosti pod ním.

  const texty = {
    sk: {
      E1: {
        predmet: `Asistent pre ${d} je pripravený: ${nSp}`,
        telo: wp
          ? [
            S.pozdrav,
            `Asistent pre ${d} si prečítal ${nS} z vášho obchodu a odteraz o nich vie odpovedať.`,
            ...B,
            `Rozhovory na ${odkaz('skúšobnej stránke', p.skusit)} sa počítajú do mesačného limitu. Využitie a plán nájdete na ${odkaz('stránke účtu', p.ucet)}.`,
            ...navod,
            zadarmo, S.odpoved, S.podpis,
          ]
          : [
            S.pozdrav,
            `Asistent pre ${d} si prečítal ${nS} z vášho feedu. Zostáva jediný krok: vložiť na web jeden riadok kódu.`,
            ...B,
            `Vyskúšať ho môžete aj pred vložením, na ${odkaz('skúšobnej stránke', p.skusit)} (počíta sa do limitu).`,
            ...navod,
            zadarmo, S.odpoved, S.podpis,
          ],
      },
      E1W: {
        predmet: `Asistent pre ${d} je pripravený a už beží na vašom webe`,
        telo: [
          S.pozdrav,
          `Asistent pre ${d} si prečítal ${nS} z vášho ${wp ? 'obchodu' : 'feedu'} a ${p.kedy} sme zaznamenali, že ho stránka na vašej doméne načítala. Odteraz odpovedá vašim zákazníkom. Ak ste ho na web nevkladali, odpovedzte na tento e-mail.`,
          ...B,
          ...(wp ? [S.wpNastavenia] : []),
          h(S.tri), { ol: S.tipy(p) },
          zadarmo, S.odpoved, S.podpis,
        ],
      },
      E0: {
        predmet: `Asistent pre ${d}: produkty sa zatiaľ nepodarilo načítať`,
        telo: [
          S.pozdrav,
          `pokúsili sme sa načítať produkty pre ${d} z feedu na serveri ${p.feedHost || d}, ale nepodarilo sa to.`,
          `Prečo: ${chyba.dovod}`,
          `Čo s tým: ${chyba.rada}`,
          chyba.nasa
            ? 'Nemusíte robiť nič. Keď sa produkty načítajú, pošleme vám jeden e-mail s návodom na zapojenie.'
            : wp
              ? 'Keď to opravíte, kliknite v nastaveniach pluginu na tlačidlo „Try again“. Aj bez toho to každú noc skúsime sami. Keď sa produkty načítajú, pošleme vám jeden e-mail s návodom na zapojenie.'
              : `Keď to opravíte, odošlite ${odkaz('formulár na arling.sk', 'https://arling.sk/asistent/')} znova s tou istou e-mailovou adresou. Aj bez toho to každú noc skúsime sami. Keď sa produkty načítajú, pošleme vám jeden e-mail s návodom na zapojenie.`,
          chyba.nasa ? 'Ak by ste mali otázku, stačí odpovedať na tento e-mail.' : 'Ak si neviete rady, odpovedzte na tento e-mail a pošlite adresu feedu, pozrieme sa na to.',
          ...B,
          S.podpis,
        ],
      },
      E2: {
        predmet: `Asistent už beží na ${d}`,
        telo: [
          S.pozdrav,
          `${p.kedy} sme zaznamenali, že stránka na ${d} načítala Asistenta. Odteraz odpovedá vašim zákazníkom a pozná ${nS}. Ak ste ho na web nevkladali, odpovedzte na tento e-mail.`,
          ...B,
          h(S.tri), { ol: S.tipy(p) },
          { poznamka: S.otazky },
          S.podpis,
        ],
      },
      E3: {
        // WordPress: plugin Asistenta zapína sám, nič sa nevkladá (brána Z-42 pokus 2, nález 4)
        predmet: wp ? `Vidíte už Asistenta na ${d}? Krátka kontrola zobrazenia` : `Pomôžeme vám vložiť Asistenta na ${d}?`,
        telo: wp
          ? [
            S.pozdrav,
            `pred niekoľkými dňami ste ${p.kde} vytvorili Asistenta pre ${d}. Zatiaľ sme nezaznamenali, že by ho váš web načítal, no niektoré weby nám to neoznámia. Ak už okienko na webe vidíte, tento e-mail pokojne ignorujte.`,
            'Vkladať nič netreba, plugin zapína Asistenta sám. Ak ho nevidíte, skontrolujte vo WordPresse:',
            { ol: [
              'WooCommerce, ARLing Shopping Assistant: Asistent je pripravený a nehlási chybu načítania produktov.',
              'Voľba „Show widget on“ tam nie je „Nowhere“. Pri „WooCommerce pages only“ sa okienko ukáže len na stránkach obchodu.',
              'Plugin na zrýchlenie webu drží starú verziu stránky. Pomôže vyprázdniť jeho cache.',
            ] },
            'Ak to nepomôže, odpovedzte na tento e-mail a pošlite adresu obchodu. Pozrieme sa, čo tomu bráni. Toto je jediná pripomienka k zapojeniu.',
            S.podpis,
          ]
          : [
            S.pozdrav,
            `pred niekoľkými dňami ste si vytvorili Asistenta pre ${d}. Zatiaľ sme nezaznamenali, že by ho váš web načítal, no niektoré weby nám to neoznámia. Ak ste ho už vložili, tento e-mail pokojne ignorujte.`,
            ...B,
            h('Návod ešte raz:'),
            ...navod,
            h('Najčastejšie prekážky:'),
            { ol: [
              'Kód je v náhľade šablóny, ktorá ešte nie je zverejnená.',
              'Web má prísne nastavenie bezpečnosti (Content-Security-Policy). Treba povoliť arling-asistent.arling.workers.dev pre skripty aj pripojenia.',
              'Plugin na zrýchlenie webu drží starú verziu stránky. Pomôže vyprázdniť jeho cache.',
            ] },
            'Ak chcete, odpovedzte a pošlite adresu stránky, kam ste kód vložili. Pozrieme sa, čo tomu bráni. Toto je jediná pripomienka k zapojeniu.',
            S.podpis,
          ],
      },
      E4: {
        predmet: `Asistent na ${d}: ${p.used} zo ${p.quota} bezplatných rozhovorov v ${mesiacVTvare(L, p.mesiac)}`,
        telo: [
          S.pozdrav,
          `Asistent na ${d} mal tento mesiac ${p.used} rozhovorov z bezplatných ${p.quota}; počítajú sa aj vaše vlastné skúšky. Pri ${p.quota} bude do konca mesiaca zákazníkom namiesto odpovede slušne odporúčať váš kontakt a od ${p.dalsiMesiac} odpovedá znova sám. Nič sa samo nespoplatní.`,
          ...B,
          { plany: S.plany(L) },
          `Ak chcete vyšší mesačný limit, na stránke účtu si zapnete Starter za ${eur(L, CENY_EUR.starter)} mesačne (${cislo(L, ROZH.starter)}${NB}rozhovorov) alebo Pro za ${eur(L, CENY_EUR.pro)} mesačne (${cislo(L, ROZH.pro)}). Platí sa cez Stripe a zrušiť sa dá kedykoľvek. ${S.strop(L)}`,
          'Ak nechcete nič meniť, nemusíte robiť nič. Toto upozornenie posielame len raz.',
          S.podpis,
        ],
      },
    },
    cs: {
      E1: {
        predmet: `Asistent pro ${d} je připravený: ${nSp}`,
        telo: wp
          ? [
            S.pozdrav,
            `Asistent pro ${d} si přečetl ${nS} z vašeho obchodu a od teď umí odpovídat na otázky k nim.`,
            ...B,
            `Konverzace na ${odkaz('zkušební stránce', p.skusit)} se započítávají do měsíčního limitu. Využití a tarif najdete na ${odkaz('stránce účtu', p.ucet)}.`,
            ...navod,
            zadarmo, S.odpoved, S.podpis,
          ]
          : [
            S.pozdrav,
            `Asistent pro ${d} si přečetl ${nS} z vašeho feedu. Zbývá jediný krok: vložit na web jeden řádek kódu.`,
            ...B,
            `Vyzkoušet ho můžete i před vložením, na ${odkaz('zkušební stránce', p.skusit)} (počítá se do limitu).`,
            ...navod,
            zadarmo, S.odpoved, S.podpis,
          ],
      },
      E1W: {
        predmet: `Asistent pro ${d} je připravený a už běží na vašem webu`,
        telo: [
          S.pozdrav,
          `Asistent pro ${d} si přečetl ${nS} z ${wp ? 'vašeho obchodu' : 'vašeho feedu'} a ${p.kedy} jsme zaznamenali, že ho stránka na vaší doméně načetla. Od teď odpovídá vašim zákazníkům. Pokud jste ho na web nevkládali, odpovězte na tento e-mail.`,
          ...B,
          ...(wp ? [S.wpNastavenia] : []),
          h(S.tri), { ol: S.tipy(p) },
          zadarmo, S.odpoved, S.podpis,
        ],
      },
      E0: {
        predmet: `Asistent pro ${d}: produkty se zatím nepodařilo načíst`,
        telo: [
          S.pozdrav,
          `pokusili jsme se načíst produkty pro ${d} z feedu na serveru ${p.feedHost || d}, ale nepodařilo se to.`,
          `Proč: ${chyba.dovod}`,
          `Co s tím: ${chyba.rada}`,
          chyba.nasa
            ? 'Nemusíte dělat nic. Až se produkty načtou, pošleme vám jeden e-mail s návodem na zapojení.'
            : wp
              ? 'Až to opravíte, klikněte v nastavení pluginu na tlačítko „Try again“. I bez toho to každou noc zkusíme sami. Až se produkty načtou, pošleme vám jeden e-mail s návodem na zapojení.'
              : `Až to opravíte, odešlete ${odkaz('formulář na arling.sk', 'https://arling.sk/asistent/')} znovu se stejnou e-mailovou adresou. I bez toho to každou noc zkusíme sami. Až se produkty načtou, pošleme vám jeden e-mail s návodem na zapojení.`,
          chyba.nasa ? 'Pokud byste měli dotaz, stačí odpovědět na tento e-mail.' : 'Pokud si nevíte rady, odpovězte na tento e-mail a pošlete adresu feedu, podíváme se na to.',
          ...B,
          S.podpis,
        ],
      },
      E2: {
        predmet: `Asistent už běží na ${d}`,
        telo: [
          S.pozdrav,
          `${p.kedy} jsme zaznamenali, že stránka na ${d} načetla Asistenta. Od teď odpovídá vašim zákazníkům a zná ${nS}. Pokud jste ho na web nevkládali, odpovězte na tento e-mail.`,
          ...B,
          h(S.tri), { ol: S.tipy(p) },
          { poznamka: S.otazky },
          S.podpis,
        ],
      },
      E3: {
        predmet: wp ? `Vidíte už Asistenta na ${d}? Krátká kontrola zobrazení` : `Pomůžeme vám vložit Asistenta na ${d}?`,
        telo: wp
          ? [
            S.pozdrav,
            `před několika dny jste ${p.kde} vytvořili Asistenta pro ${d}. Zatím jsme nezaznamenali, že by ho váš web načetl, ale některé weby nám to neoznámí. Pokud už okénko na webu vidíte, tento e-mail klidně ignorujte.`,
            'Nic se nevkládá, plugin zapíná Asistenta sám. Pokud ho nevidíte, zkontrolujte ve WordPressu:',
            { ol: [
              'WooCommerce, ARLing Shopping Assistant: Asistent je připravený a nehlásí chybu načtení produktů.',
              'Volba „Show widget on“ tam není „Nowhere“. Při „WooCommerce pages only“ se okénko ukáže jen na stránkách obchodu.',
              'Plugin na zrychlení webu drží starou verzi stránky. Pomůže vyprázdnit jeho cache.',
            ] },
            'Pokud to nepomůže, odpovězte na tento e-mail a pošlete adresu obchodu. Podíváme se, co tomu brání. Toto je jediná připomínka k zapojení.',
            S.podpis,
          ]
          : [
            S.pozdrav,
            `před několika dny jste si vytvořili Asistenta pro ${d}. Zatím jsme nezaznamenali, že by ho váš web načetl, ale některé weby nám to neoznámí. Pokud jste ho už vložili, tento e-mail klidně ignorujte.`,
            ...B,
            h('Návod ještě jednou:'),
            ...navod,
            h('Nejčastější překážky:'),
            { ol: [
              'Kód je v náhledu šablony, která ještě není zveřejněná.',
              'Web má přísné nastavení zabezpečení (Content-Security-Policy). Je potřeba povolit arling-asistent.arling.workers.dev pro skripty i připojení.',
              'Plugin na zrychlení webu drží starou verzi stránky. Pomůže vyprázdnit jeho cache.',
            ] },
            'Pokud chcete, odpovězte a pošlete adresu stránky, kam jste kód vložili. Podíváme se, co tomu brání. Toto je jediná připomínka k zapojení.',
            S.podpis,
          ],
      },
      E4: {
        predmet: `Asistent na ${d}: ${p.used} z ${p.quota} bezplatných konverzací v ${mesiacVTvare(L, p.mesiac)}`,
        telo: [
          S.pozdrav,
          `Asistent na ${d} měl tento měsíc ${p.used} konverzací z bezplatných ${p.quota}; počítají se i vaše vlastní zkoušky. Při ${p.quota} bude do konce měsíce zákazníkům místo odpovědi zdvořile doporučovat váš kontakt a od ${p.dalsiMesiac} odpovídá znovu sám. Nic se samo nezpoplatní.`,
          ...B,
          { plany: S.plany(L) },
          `Pokud chcete vyšší měsíční limit, na stránce účtu si zapnete Starter za ${eur(L, CENY_EUR.starter)} měsíčně (${cislo(L, ROZH.starter)}${NB}konverzací) nebo Pro za ${eur(L, CENY_EUR.pro)} měsíčně (${cislo(L, ROZH.pro)}). Platí se přes Stripe a zrušit se dá kdykoli. ${S.strop(L)}`,
          'Pokud nechcete nic měnit, nemusíte dělat nic. Toto upozornění posíláme jen jednou.',
          S.podpis,
        ],
      },
    },
    en: {
      E1: {
        predmet: `Your assistant for ${d} is ready: ${nSp}`,
        telo: wp
          ? [
            S.pozdrav,
            `The assistant for ${d} has read ${nS} from your shop and can now answer questions about them.`,
            ...B,
            `Conversations on the ${odkaz('test page', p.skusit)} count towards the monthly limit. Usage and plan are on your ${odkaz('account page', p.ucet)}.`,
            ...navod,
            zadarmo, S.odpoved, S.podpis,
          ]
          : [
            S.pozdrav,
            `The assistant for ${d} has read ${nS} from your feed. One step left: paste one line of code into your site.`,
            ...B,
            `You can try it first on a ${odkaz('test page', p.skusit)} (it counts towards the limit).`,
            ...navod,
            zadarmo, S.odpoved, S.podpis,
          ],
      },
      E1W: {
        predmet: `Your assistant for ${d} is ready and already live on your site`,
        telo: [
          S.pozdrav,
          `The assistant for ${d} has read ${nS} from your ${wp ? 'shop' : 'feed'}, and on ${p.kedy} we saw a page on your domain load it. From now on it answers your customers. If you did not add it to your site, please reply to this e-mail.`,
          ...B,
          ...(wp ? [S.wpNastavenia] : []),
          h(S.tri), { ol: S.tipy(p) },
          zadarmo, S.odpoved, S.podpis,
        ],
      },
      E0: {
        predmet: `Your assistant for ${d}: we could not load the products yet`,
        telo: [
          S.pozdrav,
          `We tried to load the products for ${d} from the feed on ${p.feedHost || d}, but it did not work.`,
          `Why: ${chyba.dovod}`,
          `What to do: ${chyba.rada}`,
          chyba.nasa
            ? 'You do not need to do anything. When the products load, we will send you one e-mail with setup instructions.'
            : wp
              ? 'Once it is fixed, click "Try again" in the plugin settings. We also retry every night on our own. When the products load, we will send you one e-mail with setup instructions.'
              : `Once it is fixed, submit the ${odkaz('form on arling.sk', 'https://arling.sk/asistent/en/')} again with the same e-mail address. We also retry every night on our own. When the products load, we will send you one e-mail with setup instructions.`,
          chyba.nasa ? 'If you have a question, just reply to this e-mail.' : 'If you are not sure what to do, reply to this e-mail with the feed address and we will take a look.',
          ...B,
          S.podpis,
        ],
      },
      E2: {
        predmet: `The assistant is now live on ${d}`,
        telo: [
          S.pozdrav,
          `On ${p.kedy} we saw a page on ${d} load the assistant. From now on it answers your customers and knows ${nS}. If you did not add it to your site, please reply to this e-mail.`,
          ...B,
          h(S.tri), { ol: S.tipy(p) },
          { poznamka: S.otazky },
          S.podpis,
        ],
      },
      E3: {
        predmet: wp ? `Is the assistant showing on ${d}? A quick check` : `Can we help you add the assistant to ${d}?`,
        telo: wp
          ? [
            S.pozdrav,
            `A few days ago you created an assistant for ${d} ${p.kde}. We have not seen your site load it yet, but some sites do not tell us. If you can already see the chat window on your site, you can ignore this e-mail.`,
            'There is nothing to paste, the plugin switches the assistant on by itself. If you cannot see it, check in WordPress:',
            { ol: [
              'WooCommerce, ARLing Shopping Assistant: the assistant is ready and shows no product loading error.',
              '"Show widget on" is not set to "Nowhere". With "WooCommerce pages only" the chat window appears on shop pages only.',
              'A speed-up or caching plugin still serves an old version of the page. Clearing its cache helps.',
            ] },
            'If that does not help, reply to this e-mail with your shop address and we will see what is in the way. This is the only reminder about setup.',
            S.podpis,
          ]
          : [
            S.pozdrav,
            `A few days ago you created an assistant for ${d}. We have not seen your site load it yet, but some sites do not tell us. If you have already added it, you can ignore this e-mail.`,
            ...B,
            h('Here are the instructions again:'),
            ...navod,
            h('The most common obstacles:'),
            { ol: [
              'The code is in a theme preview that has not been published yet.',
              'The site has a strict security setting (Content-Security-Policy). Allow arling-asistent.arling.workers.dev for both scripts and connections.',
              'A speed-up or caching plugin still serves an old version of the page. Clearing its cache helps.',
            ] },
            'If you like, reply with the address of the page where you added the code and we will see what is in the way. This is the only reminder about setup.',
            S.podpis,
          ],
      },
      E4: {
        predmet: `Assistant on ${d}: ${p.used} of ${p.quota} free conversations in ${mesiacVTvare(L, p.mesiac)}`,
        telo: [
          S.pozdrav,
          `The assistant on ${d} has had ${p.used} of its ${p.quota} free conversations this month; your own tests count too. At ${p.quota}, until the end of the month it will politely point shoppers to your contact details instead of answering, and from ${p.dalsiMesiac} it answers again on its own. Nothing is charged automatically.`,
          ...B,
          { plany: S.plany(L) },
          `If you want a higher monthly limit, you can switch on Starter for ${eur(L, CENY_EUR.starter)} a month (${cislo(L, ROZH.starter)} conversations) or Pro for ${eur(L, CENY_EUR.pro)} a month (${cislo(L, ROZH.pro)}) on your account page. Payment is through Stripe and you can cancel at any time. ${S.strop(L)}`,
          'If you do not want to change anything, you do not need to do anything. We send this notice only once.',
          S.podpis,
        ],
      },
    },
    de: {
      E1: {
        predmet: `Ihr Assistent für ${d} ist bereit: ${nSp}`,
        telo: wp
          ? [
            S.pozdrav,
            `der Assistent für ${d} hat ${nS} aus Ihrem Shop gelesen und kann ab sofort Fragen dazu beantworten.`,
            ...B,
            `Gespräche auf der ${odkaz('Testseite', p.skusit)} zählen zum Monatslimit. Nutzung und Tarif finden Sie auf Ihrer ${odkaz('Kontoseite', p.ucet)}.`,
            ...navod,
            zadarmo, S.odpoved, S.podpis,
          ]
          : [
            S.pozdrav,
            `der Assistent für ${d} hat ${nS} aus Ihrem Feed gelesen. Nur noch ein Schritt: eine Zeile Code in Ihre Website einfügen.`,
            ...B,
            `Vorher ausprobieren können Sie ihn auf einer ${odkaz('Testseite', p.skusit)} (zählt zum Limit).`,
            ...navod,
            zadarmo, S.odpoved, S.podpis,
          ],
      },
      E1W: {
        predmet: `Ihr Assistent für ${d} ist bereit und läuft bereits auf Ihrer Website`,
        telo: [
          S.pozdrav,
          `der Assistent für ${d} hat ${nS} aus Ihrem ${wp ? 'Shop' : 'Feed'} gelesen, und am ${p.kedy} haben wir festgestellt, dass eine Seite auf Ihrer Domain ihn lädt. Ab sofort beantwortet er die Fragen Ihrer Kunden. Falls Sie ihn nicht eingebunden haben, antworten Sie bitte auf diese E-Mail.`,
          ...B,
          ...(wp ? [S.wpNastavenia] : []),
          h(S.tri), { ol: S.tipy(p) },
          zadarmo, S.odpoved, S.podpis,
        ],
      },
      E0: {
        predmet: `Assistent für ${d}: Produkte konnten noch nicht geladen werden`,
        telo: [
          S.pozdrav,
          `wir haben versucht, die Produkte für ${d} aus dem Feed auf dem Server ${p.feedHost || d} zu laden, aber es hat nicht geklappt.`,
          `Warum: ${chyba.dovod}`,
          `Was tun: ${chyba.rada}`,
          chyba.nasa
            ? 'Sie müssen nichts tun. Sobald die Produkte geladen sind, schicken wir Ihnen eine E-Mail mit der Anleitung zur Einbindung.'
            : wp
              ? 'Wenn es behoben ist, klicken Sie in den Plugin-Einstellungen auf „Try again“. Auch ohne das versuchen wir es jede Nacht selbst. Sobald die Produkte geladen sind, schicken wir Ihnen eine E-Mail mit der Anleitung zur Einbindung.'
              : `Wenn es behoben ist, senden Sie das ${odkaz('Formular auf arling.sk (auf Englisch)', 'https://arling.sk/asistent/en/')} mit derselben E-Mail-Adresse erneut ab. Auch ohne das versuchen wir es jede Nacht selbst. Sobald die Produkte geladen sind, schicken wir Ihnen eine E-Mail mit der Anleitung zur Einbindung.`,
          chyba.nasa ? 'Bei Fragen antworten Sie einfach auf diese E-Mail.' : 'Wenn Sie nicht weiterwissen, antworten Sie auf diese E-Mail und schicken Sie uns die Feed-Adresse, wir sehen uns das an.',
          ...B,
          S.podpis,
        ],
      },
      E2: {
        predmet: `Der Assistent läuft jetzt auf ${d}`,
        telo: [
          S.pozdrav,
          `am ${p.kedy} haben wir festgestellt, dass eine Seite auf ${d} den Assistenten geladen hat. Ab sofort beantwortet er die Fragen Ihrer Kunden und kennt ${nS}. Falls Sie ihn nicht eingebunden haben, antworten Sie bitte auf diese E-Mail.`,
          ...B,
          h(S.tri), { ol: S.tipy(p) },
          { poznamka: S.otazky },
          S.podpis,
        ],
      },
      E3: {
        predmet: wp ? `Wird der Assistent auf ${d} angezeigt? Eine kurze Prüfung` : `Sollen wir Ihnen beim Einbinden auf ${d} helfen?`,
        telo: wp
          ? [
            S.pozdrav,
            `vor einigen Tagen haben Sie ${p.kde} einen Assistenten für ${d} erstellt. Bisher haben wir nicht festgestellt, dass Ihre Website ihn lädt, aber manche Websites teilen uns das nicht mit. Falls Sie das Chatfenster schon sehen, ignorieren Sie diese E-Mail gern.`,
            'Einfügen müssen Sie nichts, das Plugin schaltet den Assistenten selbst ein. Wenn Sie ihn nicht sehen, prüfen Sie in WordPress:',
            { ol: [
              'WooCommerce, ARLing Shopping Assistant: Der Assistent ist bereit und meldet keinen Fehler beim Laden der Produkte.',
              '„Show widget on“ steht dort nicht auf „Nowhere“. Bei „WooCommerce pages only“ erscheint das Chatfenster nur auf Shopseiten.',
              'Ein Plugin zur Beschleunigung liefert noch eine alte Version der Seite aus. Leeren Sie dessen Cache.',
            ] },
            'Wenn das nicht hilft, antworten Sie auf diese E-Mail mit der Adresse Ihres Shops. Wir sehen nach, was im Weg steht. Dies ist die einzige Erinnerung zur Einbindung.',
            S.podpis,
          ]
          : [
            S.pozdrav,
            `vor einigen Tagen haben Sie einen Assistenten für ${d} erstellt. Bisher haben wir nicht festgestellt, dass Ihre Website ihn lädt, aber manche Websites teilen uns das nicht mit. Falls Sie ihn schon eingebunden haben, ignorieren Sie diese E-Mail gern.`,
            ...B,
            h('Die Anleitung noch einmal:'),
            ...navod,
            h('Die häufigsten Hindernisse:'),
            { ol: [
              'Der Code steht in einer Theme-Vorschau, die noch nicht veröffentlicht ist.',
              'Die Website hat eine strenge Sicherheitseinstellung (Content-Security-Policy). Erlauben Sie arling-asistent.arling.workers.dev für Skripte und Verbindungen.',
              'Ein Plugin zur Beschleunigung liefert noch eine alte Version der Seite aus. Leeren Sie dessen Cache.',
            ] },
            'Wenn Sie möchten, antworten Sie mit der Adresse der Seite, auf der Sie den Code eingefügt haben. Wir sehen nach, was im Weg steht. Dies ist die einzige Erinnerung zur Einbindung.',
            S.podpis,
          ],
      },
      E4: {
        predmet: `Assistent auf ${d}: ${p.used} von ${p.quota} kostenlosen Gesprächen im ${mesiacVTvare(L, p.mesiac)}`,
        telo: [
          S.pozdrav,
          `der Assistent auf ${d} hatte diesen Monat ${p.used} von ${p.quota} kostenlosen Gesprächen; Ihre eigenen Tests zählen mit. Bei ${p.quota} verweist er Ihre Kunden bis zum Monatsende höflich auf Ihre Kontaktdaten, statt zu antworten, und ab dem ${p.dalsiMesiac} antwortet er wieder selbst. Es wird nichts automatisch berechnet.`,
          ...B,
          { plany: S.plany(L) },
          `Wenn Sie ein höheres Monatslimit möchten, können Sie auf Ihrer Kontoseite Starter für ${eur(L, CENY_EUR.starter)} im Monat (${cislo(L, ROZH.starter)} Gespräche) oder Pro für ${eur(L, CENY_EUR.pro)} im Monat (${cislo(L, ROZH.pro)}) einschalten. Bezahlt wird über Stripe, jederzeit kündbar. ${S.strop(L)}`,
          'Wenn Sie nichts ändern möchten, müssen Sie nichts tun. Diesen Hinweis senden wir nur einmal.',
          S.podpis,
        ],
      },
    },
  };
  const s = texty[L][kod];
  if (!s) return s;
  return { ...s, nadpis: D.nadpis(kod, { ...p, nS, wp, nasa: chyba.nasa }), preheader: D.preheader(kod, { ...p, wp, nasa: chyba.nasa }) };
}

function pata(kod, L, p) {
  const S = SPOLOCNE[L];
  const riadky = [];
  const zriadenie = kod === 'E0' || kod === 'E1' || kod === 'E1W';
  riadky.push(zriadenie ? S.precoZriadenie(p) : S.precoServis(p));
  if (p.stop) {
    const veta = kod === 'E1' ? S.dalsieE1 : kod === 'E0' ? S.dalsieE0 : kod === 'E1W' ? S.dalsieE1W : S.dalsieServis;
    riadky.push(veta + p.stop);
  } else {
    riadky.push(kod === 'E0' ? S.bezDalsichE0 : S.bezDalsichE1);
  }
  // Zmazanie a zásady v jednom riadku (kratšia päta na telefóne, brána Z-42 nález 4).
  riadky.push(`${S.zmazat} ${S.zasady}`, S.firma);
  if (p.anglickaVeta && L !== 'en') riadky.push(ANGLICKA_VETA);
  return riadky;
}

// ---------------------------------------------------------------------------
// Vykreslenie: čistý text a HTML (obal v zivotny-cyklus-html.js)
// ---------------------------------------------------------------------------

/**
 * Hotový e-mail: {predmet, text, html}. `kod` je E0, E1, E1W, E2, E3 alebo E4,
 * `jazyk` sk, cs, en alebo de (čokoľvek iné = en). Parametre `p`:
 *   domena, tenantId, pocet, platforma, zdroj, datum (Date vytvorenia),
 *   kedy (Date zapojenia), feedHost (len hostiteľ feedu), chybaKod, used,
 *   quota, mesiac (1 až 12), dalsiMesiac (Date), ucet, skusit, stop (odkaz
 *   alebo null), volitelne (či ešte môžu prísť voliteľné správy; texty ho od
 *   Z-42 pokusu 2 nepoužívajú, päta to rieši cez stop), anglickaVeta,
 *   maxOtazok (voliteľné: relacia.js maxOtazok(env); bez neho definícia
 *   rozhovoru strop otázok neuvádza).
 */
export function vytvorEmail(kod, jazyk, p) {
  const L = JAZYKY_EMAILOV.includes(jazyk) ? jazyk : 'en';
  const S = SPOLOCNE[L];
  let feedHost = p.feedHost || '';
  if (!feedHost && p.feedUrl) {
    try {
      feedHost = new URL(p.feedUrl).hostname;
    } catch (e) {
      feedHost = '';
    }
  }
  const params = {
    ...p,
    feedHost,
    datum: formatDatum(L, p.datum instanceof Date ? p.datum : new Date(p.datum || 0)),
    kedy: formatKedy(L, p.kedy instanceof Date ? p.kedy : new Date(p.kedy || 0)),
    dalsiMesiac: formatDatum(L, p.dalsiMesiac instanceof Date ? p.dalsiMesiac : new Date(p.dalsiMesiac || 0)),
    kde: S.kde(p.zdroj),
    platforma: PLATFORMY.includes(p.platforma) ? p.platforma : 'vseobecne',
  };
  delete params.feedUrl;
  const s = sablona(kod, L, params);
  if (!s) throw new Error(`neznamy e-mail ${kod}`);
  const paticka = pata(kod, L, params);
  const text = `${s.telo.map(blokText).filter(Boolean).join('\n\n')}\n\n--\n${paticka.map(textOdkazov).join('\n')}\n`;
  const html = zabalHtml({
    jazyk: L,
    predmet: s.predmet,
    preheader: s.preheader,
    znacka: S.znacka,
    nadpis: s.nadpis,
    telo: s.telo,
    pata: paticka,
    stop: params.stop,
    stopPopis: S.stopPopis,
  });
  return { predmet: s.predmet, preheader: s.preheader, nadpis: s.nadpis, text, html };
}

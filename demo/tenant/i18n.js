// i18n.js (tenant page): SK/EN dictionary and the same tiny rendering engine
// the demo landing page uses (../i18n.js), trimmed to what this page needs.
// index.html marks translatable elements with data-i18n* attributes and
// applyI18n() fills them in; tenant.js uses t()/tf() for the runtime strings
// (usage bar, dates, plan labels).
//
// Pure helpers (t, tf, langFromLocale, langFromQueryString,
// findIncompleteEntries) never touch the DOM; the DOM code at the bottom is
// guarded so importing this file under Node (tests) is side-effect-free.

export const LANGS = ['sk', 'en'];
export const DEFAULT_LANG = 'en';
export const STORAGE_KEY = 'arling_lang';

export const DICT = {
  // header / nav
  'skip': { sk: 'Skočiť na obsah', en: 'Skip to content' },
  'brand.sub': { sk: 'nástroj ARLing', en: 'an ARLing tool' },
  'nav.back': { sk: 'ARLing Asistent', en: 'ARLing Asistent' },
  'nav.pricing': { sk: 'Cenník', en: 'Pricing' },
  'nav.faq': { sk: 'Otázky', en: 'FAQ' },
  'lang.switch.aria': { sk: 'Jazyk stránky', en: 'Page language' },
  'lang.sk.aria': { sk: 'Slovenčina', en: 'Slovak' },
  'lang.en.aria': { sk: 'English', en: 'English' },

  // hero
  'hero.kicker': { sk: 'Váš účet', en: 'Your account' },
  'hero.h1': { sk: 'Používanie a predplatné', en: 'Usage and subscription' },
  'hero.lead': {
    sk: 'Prehľad účtu ARLing Asistenta pre váš e-shop: koľko rozhovorov ste tento mesiac použili, embed kód a prechod na platený plán. Stránka ukazuje len počítadlá, žiadne osobné údaje ani obsah rozhovorov.',
    en: 'An overview of your ARLing Asistent account: conversations used this month, the embed code, and the upgrade to a paid plan. The page shows counters only, no personal data and no conversation content.',
  },
  'hero.tip': {
    sk: 'Odkaz na túto stránku si uložte: obsahuje id vášho účtu a nikde inde ho nezobrazujeme.',
    en: 'Bookmark this page: the link carries your account id and we do not show it anywhere else.',
  },

  // states
  'state.loading': { sk: 'Načítavam údaje účtu.', en: 'Loading account data.' },
  'state.missing': {
    sk: 'V odkaze chýba id účtu (parameter t). Otvorte túto stránku z odkazu, ktorý ste dostali po vytvorení účtu, alebo si vytvorte nový účet na',
    en: 'The link has no account id (the t parameter). Open this page from the link you got when the account was created, or create a new account at',
  },
  'state.notfound': {
    sk: 'Účet s týmto id sme nenašli. Skontrolujte odkaz, alebo si vytvorte nový účet na',
    en: 'We could not find an account with this id. Check the link, or create a new account at',
  },
  'state.network': {
    sk: 'Údaje o používaní sa teraz nepodarilo načítať. Skúste obnoviť stránku o chvíľu. Embed kód a prechod na platený plán nižšie fungujú aj tak.',
    en: 'Usage data could not be loaded right now. Try refreshing the page in a moment. The embed code and the upgrade below work anyway.',
  },
  'state.link': { sk: 'arling.sk/asistent', en: 'arling.sk/asistent' },

  // section 01: usage
  's1.h2': { sk: 'Používanie tento mesiac', en: 'Usage this month' },
  'usage.domain': { sk: 'E-shop', en: 'Shop' },
  'usage.plan': { sk: 'Plán', en: 'Plan' },
  'usage.status': { sk: 'Stav', en: 'Status' },
  'usage.conversations': { sk: 'Rozhovory', en: 'Conversations' },
  'usage.bar': {
    sk: '{used} z {quota} rozhovorov tento mesiac ({percent} %)',
    en: '{used} of {quota} conversations this month ({percent} %)',
  },
  'usage.periodEnd': { sk: 'Počítadlo sa vynuluje', en: 'Counter resets on' },
  'usage.products': { sk: 'Produkty v indexe', en: 'Products indexed' },
  'usage.lastIngest': { sk: 'Posledné obnovenie feedu', en: 'Last feed refresh' },
  'usage.validUntil': { sk: 'Plán platí do', en: 'Plan valid until' },
  'usage.na': { sk: 'n/a', en: 'n/a' },
  'usage.note': {
    sk: 'Rozhovor je jedna relácia widgetu (jeden návštevník, jedno otvorenie chatu), nie jedna správa. Počítadlo sa vynuluje prvý deň každého mesiaca (UTC). Feed sa obnovuje automaticky raz denne.',
    en: 'A conversation is one widget session (one visitor, one chat), not one message. The counter resets on the first day of every month (UTC). The feed refreshes automatically once a day.',
  },
  'status.ready': { sk: 'pripravený', en: 'ready' },
  'status.pending': { sk: 'feed sa spracúva', en: 'processing the feed' },
  'status.error': { sk: 'feed sa nepodarilo spracovať', en: 'the feed could not be processed' },
  'plan.free': { sk: 'Free', en: 'Free' },
  'plan.starter': { sk: 'Starter', en: 'Starter' },
  'plan.pro': { sk: 'Pro', en: 'Pro' },
  'plan.trial': { sk: 'Skúšobný', en: 'Trial' },

  // section 02: embed code
  's2.h2': { sk: 'Embed kód', en: 'Embed code' },
  's2.sub': {
    sk: 'Vložte pred </body> vo vašej šablóne, alebo použite WooCommerce plugin. Rovnaký kód funguje na každom e-shope.',
    en: 'Paste before </body> in your theme, or use the WooCommerce plugin. The same code works on any e-shop.',
  },
  'embed.idLabel': { sk: 'ID účtu', en: 'Account ID' },
  'embed.snippetLabel': { sk: 'Kód na vloženie do stránky', en: 'Code to paste into your page' },
  'embed.copy': { sk: 'Kopírovať', en: 'Copy' },
  'embed.copied': { sk: 'Skopírované', en: 'Copied' },
  'embed.livedemo': { sk: 'Vyskúšať asistenta na živej ukážke', en: 'Try the assistant on the live demo page' },

  // section 03: paid plan
  's3.h2': { sk: 'Platený plán', en: 'Paid plan' },
  's3.sub': {
    sk: 'Zadarmo do 100 rozhovorov mesačne. Nad tento limit si vyberiete plán nižšie: platba kartou cez Stripe, potvrdenie a faktúru pošle Stripe e-mailom, zrušiť sa dá kedykoľvek.',
    en: 'Free up to 100 conversations a month. Above that, pick a plan below: card payment through Stripe, Stripe e-mails the receipt and invoice, cancel any time.',
  },
  's3.th.plan': { sk: 'Plán', en: 'Plan' },
  's3.th.price': { sk: 'Cena', en: 'Price' },
  's3.th.conversations': { sk: 'Rozhovory / mesiac', en: 'Conversations / month' },
  'price.perMonth': { sk: '/ mesiac', en: '/ month' },
  'limit.starter': { sk: 'do 1 000', en: 'up to 1,000' },
  'limit.pro': { sk: 'do 5 000', en: 'up to 5,000' },
  'cta.starter': { sk: 'Prejsť na Starter', en: 'Upgrade to Starter' },
  'cta.pro': { sk: 'Prejsť na Pro', en: 'Upgrade to Pro' },
  'plan.current': { sk: 'Váš aktuálny plán', en: 'Your current plan' },
  'plan.lower': { sk: 'nižší plán, zmena cez Stripe', en: 'lower plan, change through Stripe' },
  'upgrade.note': {
    sk: 'Tlačidlo otvorí Stripe Checkout s id vášho účtu. Plán sa zvýši automaticky po zaplatení, zvyčajne do minúty. Ročné predplatné zatiaľ nie je v ponuke.',
    en: 'The button opens Stripe Checkout with your account id. The plan is raised automatically after payment, usually within a minute. No annual plan yet.',
  },
  'manage.title': { sk: 'Správa predplatného', en: 'Manage subscription' },
  'manage.body': {
    sk: 'Predplatné spravujete cez odkaz v e-maile s potvrdením platby od Stripe: zmena karty, faktúry aj zrušenie. Po zrušení sa účet po skončení zaplateného obdobia vráti na plán Free. Ak e-mail nenájdete, napíšte na andrej@arling.sk.',
    en: 'Manage your subscription through the link in the payment receipt e-mail from Stripe: card change, invoices and cancellation. After cancelling, the account returns to the Free plan when the paid period ends. If you cannot find the e-mail, write to andrej@arling.sk.',
  },

  // footer
  'footer.tool': { sk: 'nástroj', en: 'a tool by' },
  'footer.regIds': { sk: 'IČO 56583486 · IČ DPH SK2122352100', en: 'Company ID (IČO) 56583486 · VAT ID (IČ DPH) SK2122352100' },
  'footer.sourceCode': { sk: 'Zdrojový kód (GitHub)', en: 'Source code (GitHub)' },
  'footer.dpa': { sk: 'DPA (GDPR čl. 28)', en: 'DPA (GDPR Art. 28)' },
  'footer.note': { sk: 'Návštevnosť meriame vlastným, cookie-free nástrojom Umami. Neukladá cookies ani odtlačok prehliadača.', en: 'We measure traffic with our own cookie-free tool, Umami. It stores no cookies and no browser fingerprint.' },

  // meta
  'meta.title': { sk: 'Používanie a predplatné: ARLing Asistent', en: 'Usage and subscription: ARLing Asistent' },
  'meta.description': {
    sk: 'Stránka účtu ARLing Asistenta: rozhovory použité tento mesiac, embed kód a prechod na plán Starter alebo Pro cez Stripe.',
    en: 'ARLing Asistent account page: conversations used this month, the embed code, and the upgrade to Starter or Pro through Stripe.',
  },
};

// pure helpers

let currentLang = DEFAULT_LANG;

export function getLang() {
  return currentLang;
}

function resolveLang(lang) {
  return LANGS.includes(lang) ? lang : currentLang;
}

/** "sk-SK" / "cs-CZ" -> sk, everything else -> en (same rule as the demo page). */
export function langFromLocale(tag) {
  const s = String(tag || '').toLowerCase();
  if (s.startsWith('sk') || s.startsWith('cs')) return 'sk';
  return DEFAULT_LANG;
}

/** Translates one key; an unknown key returns the key itself so a gap is visible, never blank. */
export function t(key, lang) {
  const l = resolveLang(lang);
  const entry = DICT[key];
  if (!entry) return key;
  return entry[l] || entry.en || entry.sk || key;
}

/** Same lookup with {placeholders} filled in from `vars`. */
export function tf(key, vars, lang) {
  let s = t(key, lang);
  if (vars) {
    Object.keys(vars).forEach((k) => {
      s = s.split('{' + k + '}').join(String(vars[k]));
    });
  }
  return s;
}

/** Keys that lack a non-empty string for any LANGS member (tests assert this is empty). */
export function findIncompleteEntries() {
  const bad = [];
  Object.keys(DICT).forEach((key) => {
    LANGS.forEach((l) => {
      if (typeof DICT[key][l] !== 'string' || !DICT[key][l].trim()) bad.push(key + '.' + l);
    });
  });
  return bad;
}

export function langFromQueryString(search) {
  try {
    const q = (new URLSearchParams(search || '').get('lang') || '').toLowerCase();
    return LANGS.includes(q) ? q : null;
  } catch (e) {
    return null;
  }
}

export function ogLocaleForLang(lang) {
  return resolveLang(lang) === 'sk' ? 'sk_SK' : 'en_US';
}

// DOM engine (browser only)

function readStoredLang() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    const v = localStorage.getItem(STORAGE_KEY);
    return LANGS.includes(v) ? v : null;
  } catch (e) {
    return null;
  }
}

/** ?lang= wins, then localStorage (arling_lang), then navigator.language, then en. */
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

function setMeta(selector, value) {
  const el = document.querySelector(selector);
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

export function applyI18n(lang) {
  if (typeof document === 'undefined') return;
  const l = LANGS.includes(lang) ? lang : currentLang;
  currentLang = l;
  document.documentElement.setAttribute('lang', l);
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n'), l); });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html'), l); });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'), l)); });
  document.title = t('meta.title', l);
  setMeta('meta[name="description"]', t('meta.description', l));
  setMeta('meta[property="og:title"]', t('meta.title', l));
  setMeta('meta[property="og:description"]', t('meta.description', l));
  setMeta('meta[property="og:locale"]', ogLocaleForLang(l));
  document.querySelectorAll('[data-set-lang]').forEach((btn) => {
    const active = btn.getAttribute('data-set-lang') === l;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.classList.toggle('lang-active', active);
  });
  try { document.dispatchEvent(new CustomEvent('arling:langchange', { detail: { lang: l } })); } catch (e) {}
}

export function setLang(lang) {
  if (!LANGS.includes(lang)) return;
  currentLang = lang;
  try { if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
  applyI18n(lang);
  updateUrlLang(lang);
}

if (typeof document !== 'undefined') {
  const boot = () => {
    document.querySelectorAll('[data-set-lang]').forEach((btn) => {
      btn.addEventListener('click', () => setLang(btn.getAttribute('data-set-lang')));
    });
    setLang(detectLang());
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

/*
 * widget.js v2 (ops/asistent/v2/SPEC.md): ARLing Asistent for any e-shop, one
 * file, no dependencies. <script src=".../widget.js" data-tenant="ID" defer>
 * Attributes (SPEC 8.5): data-tenant, data-lang, data-answer-lang, data-rezim
 * (or the old data-color), data-farba, data-pismo, data-position, data-endpoint,
 * data-title, data-greeting, data-questions, data-obchod, data-logo, data-meno,
 * data-gift, data-mount, data-upoutavka(-text, -oneskorenie), data-volby,
 * data-kategorie, data-doprava, data-kontakt, data-odsadenie.
 * API: window.ArlingAsistent = {open, close, ask}; events arling-asistent:ready,
 * :odpoved, :chyba. Privacy: no cookies, no localStorage; sessionStorage only
 * for the tab's session id, the signed token "relacia" and the teaser flag.
 * Shadow DOM, no inline style attribute (CSSOM only). boot() runs last.
 */

(() => {
	'use strict';

	if (window.__arlingAsistentInit) return;
	window.__arlingAsistentInit = true;

	// == i18n

	var STRINGS = {
		sk: {
			openLabel: 'Otvoriť chat s asistentom',
			closeLabel: 'Zavrieť chat',
			title: 'Asistent obchodu',
			placeholder: 'Napíšte otázku...',
			send: 'Odoslať',
			thinking: 'Asistent píše odpoveď…',
			greeting: 'Dobrý deň, ako vám môžem pomôcť s výberom?',
			networkError: 'Odpoveď sa nepodarilo načítať. Skúste to prosím znova.',
			rateLimited: 'Príliš veľa správ naraz. Skúste to o chvíľu.',
			quotaExceeded: 'Asistent si dnes oddychuje. Použite prosím kontaktnú stránku obchodu.',
			poweredBy: 'Napájané ARLing Asistentom',
			subtitle: 'Odpovedá z produktov obchodu',
			preparedNote: 'Vopred skontrolovaná odpoveď',
			preparedFailed: 'Pripravenú odpoveď sa nepodarilo načítať.',
			retry: 'Skúsiť znova',
			relatedProducts: 'Súvisiace produkty',
			giftButton: 'Nájsť darček',
			giftOpenLabel: 'Otvoriť hľadač darčekov',
			giftTitle: 'Hľadač darčekov',
			giftRecipientQuestion: 'Pre koho hľadáte darček?',
			giftRecipients: ['Partner/ka', 'Mama', 'Otec', 'Dieťa', 'Kolega', 'Kamarát/ka', 'Sebe'],
			giftRecipientPlaceholder: 'Alebo napíšte pre koho (napr. babka)',
			giftBudgetQuestion: 'Aký je rozpočet?',
			giftBudgetLabels: ['do 20 €', 'do 50 €', 'do 100 €', 'nad 100 €'],
			giftInterestsQuestion: 'Čo má rád/rada?',
			giftInterestsPlaceholder: 'Napríklad záhrada, káva, knihy...',
			giftNext: 'Ďalej',
			giftBack: 'Späť',
			giftSubmit: 'Nájsť darčeky',
			giftThinking: 'Hľadám vhodné darčeky…',
			giftShowMore: 'Ukázať ďalšie',
			giftAskElse: 'Opýtať sa na niečo iné',
			giftWidenedNote: 'Pri tomto rozpočte sme nenašli dosť darčekov, tak sme ho mierne rozšírili.',
			giftFewNote: 'Pre tento výber sme našli len niekoľko vhodných darčekov.',
			giftEmptyNote: 'Pre tento výber sme nenašli vhodný darček. Skúste iný rozpočet alebo záujmy.',
			aiPoradca: 'Odpovedá AI',
			teaserAria: 'Ponuka pomoci',
			teaserProdukt: 'Máte otázku k tomuto produktu?',
			teaserIna: 'Poradiť vám s výberom?',
			teaserInaRiadok: 'Odpovedám z produktov tohto obchodu.',
			teaserClose: 'Zavrieť ponuku',
			newChat: 'Začať nový rozhovor',
			privacyLine: 'Odpovedám len z produktov tohto obchodu. Rozhovor sa neukladá.',
			quickLabel: 'Rýchle voľby',
			categoriesLabel: 'Kategórie',
			questionsLabel: 'Môžete sa opýtať napríklad',
			tileCompare: 'Porovnať produkty',
			tileProduct: 'Opýtať sa na tento produkt',
			tileShipping: 'Doprava a vrátenie',
			tileContact: 'Kontakt na obchod',
			newWindow: '(otvorí sa v novom okne)',
			productQuestion: 'Čo treba vedieť o produkte {nazov} pred kúpou?',
			categoryQuestion: 'Čo mi odporučíte z kategórie {nazov}?',
			comparePrefill: 'Porovnajte mi ',
			compareHint: 'Napíšte, ktoré dva produkty chcete porovnať, a ukážem ich vedľa seba.',
			compareSend: 'Porovnajte mi {a} a {b}.',
			compareFirstTwo: 'Porovnať prvé dva',
			comparison: 'Porovnanie',
			view: 'Pozrieť',
			inStock: 'Skladom',
			inDays: 'Do {n} dní',
			inDay1: 'Do 1 dňa',
			fromDate: 'Dostupné od {datum}',
			soldOut: 'Vypredané',
			productsCount: 'Produkty v odpovedi: {n}.',
			slowWait: 'Hľadám v produktoch obchodu…',
			prevProducts: 'Predchádzajúce produkty',
			nextProducts: 'Ďalšie produkty',
			giftStep: 'Krok {n} z 3',
			categoriesQuestion: 'Čo hľadáte?',
			giftTip: 'Po troch otázkach vyberiem darčeky z ponuky tohto obchodu.',
			giftChange: 'Zmeniť',
			tileShort: ['Porovnať', 'Doprava', 'Kontakt', 'Tento produkt'],
			giftFor: 'Pre: {n}',
			cheaperBy: 'o {n} lacnejší',
		},
		cs: {
			openLabel: 'Otevřít chat s asistentem',
			closeLabel: 'Zavřít chat',
			title: 'Asistent obchodu',
			placeholder: 'Napište otázku...',
			send: 'Odeslat',
			thinking: 'Asistent píše odpověď…',
			greeting: 'Dobrý den, jak vám mohu pomoci s výběrem?',
			networkError: 'Odpověď se nepodařilo načíst. Zkuste to prosím znovu.',
			rateLimited: 'Příliš mnoho zpráv najednou. Zkuste to za chvíli.',
			quotaExceeded: 'Asistent si dnes odpočívá. Použijte prosím kontaktní stránku obchodu.',
			poweredBy: 'Poháněno ARLing Asistentem',
			subtitle: 'Odpovídá z produktů obchodu',
			preparedNote: 'Předem zkontrolovaná odpověď',
			preparedFailed: 'Připravenou odpověď se nepodařilo načíst.',
			retry: 'Zkusit znovu',
			relatedProducts: 'Související produkty',
			giftButton: 'Najít dárek',
			giftOpenLabel: 'Otevřít hledač dárků',
			giftTitle: 'Hledač dárků',
			giftRecipientQuestion: 'Pro koho hledáte dárek?',
			giftRecipients: ['Partner/ka', 'Máma', 'Táta', 'Dítě', 'Kolega', 'Kamarád/ka', 'Sobě'],
			giftRecipientPlaceholder: 'Nebo napište pro koho (např. babička)',
			giftBudgetQuestion: 'Jaký je rozpočet?',
			giftBudgetLabels: ['do 20 Kč', 'do 50 Kč', 'do 100 Kč', 'nad 100 Kč'],
			giftInterestsQuestion: 'Co má rád/ráda?',
			giftInterestsPlaceholder: 'Například zahrada, káva, knihy...',
			giftNext: 'Další',
			giftBack: 'Zpět',
			giftSubmit: 'Najít dárky',
			giftThinking: 'Hledám vhodné dárky…',
			giftShowMore: 'Zobrazit další',
			giftAskElse: 'Zeptat se na něco jiného',
			giftWidenedNote: 'Pro tento rozpočet jsme nenašli dost dárků, tak jsme ho mírně rozšířili.',
			giftFewNote: 'Pro tento výběr jsme našli jen několik vhodných dárků.',
			giftEmptyNote: 'Pro tento výběr jsme nenašli vhodný dárek. Zkuste jiný rozpočet nebo zájmy.',
			aiPoradca: 'Odpovídá AI',
			teaserAria: 'Nabídka pomoci',
			teaserProdukt: 'Máte dotaz k tomuto produktu?',
			teaserIna: 'Poradit vám s výběrem?',
			teaserInaRiadok: 'Odpovídám z produktů tohoto obchodu.',
			teaserClose: 'Zavřít nabídku',
			newChat: 'Začít nový rozhovor',
			privacyLine: 'Odpovídám jen z produktů tohoto obchodu. Rozhovor se neukládá.',
			quickLabel: 'Rychlá volba',
			categoriesLabel: 'Kategorie',
			questionsLabel: 'Můžete se zeptat třeba',
			tileCompare: 'Porovnat produkty',
			tileProduct: 'Zeptat se na tento produkt',
			tileShipping: 'Doprava a vrácení',
			tileContact: 'Kontakt na obchod',
			newWindow: '(otevře se v novém okně)',
			productQuestion: 'Co je dobré vědět o produktu {nazov} před koupí?',
			categoryQuestion: 'Co mi doporučíte z kategorie {nazov}?',
			comparePrefill: 'Porovnejte mi ',
			compareHint: 'Napište, které dva produkty chcete porovnat, a ukážu je vedle sebe.',
			compareSend: 'Porovnejte mi {a} a {b}.',
			compareFirstTwo: 'Porovnat první dva',
			comparison: 'Srovnání',
			view: 'Zobrazit',
			inStock: 'Skladem',
			inDays: 'Do {n} dnů',
			inDay1: 'Do 1 dne',
			fromDate: 'Dostupné od {datum}',
			soldOut: 'Vyprodáno',
			productsCount: 'Produkty v odpovědi: {n}.',
			slowWait: 'Hledám v produktech obchodu…',
			prevProducts: 'Předchozí produkty',
			nextProducts: 'Další produkty',
			giftStep: 'Krok {n} ze 3',
			categoriesQuestion: 'Co hledáte?',
			giftTip: 'Po třech otázkách vyberu dárky z nabídky tohoto obchodu.',
			giftChange: 'Změnit',
			tileShort: ['Porovnat', 'Doprava', 'Kontakt', 'Tento produkt'],
			giftFor: 'Pro: {n}',
			cheaperBy: 'o {n} levnější',
		},
		en: {
			openLabel: 'Open shop assistant chat',
			closeLabel: 'Close chat',
			title: 'Shop assistant',
			placeholder: 'Type your question...',
			send: 'Send',
			thinking: 'The assistant is typing…',
			greeting: 'Hello, how can I help you choose?',
			networkError: 'Could not load a reply. Please try again.',
			rateLimited: 'Too many messages at once. Please try again shortly.',
			quotaExceeded: 'The assistant is resting today. Please use the shop\'s contact page.',
			poweredBy: 'Powered by ARLing Shopping Assistant',
			subtitle: 'Answers from the shop\'s products',
			preparedNote: 'Answer checked in advance',
			preparedFailed: 'The prepared answer could not be loaded.',
			retry: 'Try again',
			relatedProducts: 'Related products',
			giftButton: 'Find a gift',
			giftOpenLabel: 'Open gift finder',
			giftTitle: 'Gift finder',
			giftRecipientQuestion: 'Who is the gift for?',
			giftRecipients: ['Partner', 'Mum', 'Dad', 'Child', 'Colleague', 'Friend', 'Myself'],
			giftRecipientPlaceholder: 'Or type who it is for (e.g. grandma)',
			giftBudgetQuestion: 'What is the budget?',
			giftBudgetLabels: ['up to €20', 'up to €50', 'up to €100', 'over €100'],
			giftInterestsQuestion: 'What do they like?',
			giftInterestsPlaceholder: 'For example gardening, coffee, books...',
			giftNext: 'Next',
			giftBack: 'Back',
			giftSubmit: 'Find gifts',
			giftThinking: 'Looking for good gifts…',
			giftShowMore: 'Show more',
			giftAskElse: 'Ask something else',
			giftWidenedNote: 'We did not find enough gifts at this budget, so we widened it slightly.',
			giftFewNote: 'We only found a few gifts that fit this search.',
			giftEmptyNote: 'We could not find a matching gift. Try a different budget or interests.',
			aiPoradca: 'AI answers',
			teaserAria: 'Offer of help',
			teaserProdukt: 'Questions about this product?',
			teaserIna: 'Need help choosing?',
			teaserInaRiadok: 'I answer from this shop\'s products.',
			teaserClose: 'Dismiss',
			newChat: 'Start a new conversation',
			privacyLine: 'I only answer from this shop\'s products. The conversation is not stored.',
			quickLabel: 'Quick options',
			categoriesLabel: 'Categories',
			questionsLabel: 'You could ask',
			tileCompare: 'Compare products',
			tileProduct: 'Ask about this product',
			tileShipping: 'Shipping and returns',
			tileContact: 'Contact the shop',
			newWindow: '(opens in a new window)',
			productQuestion: 'What should I know about {nazov} before buying?',
			categoryQuestion: 'What do you recommend from {nazov}?',
			comparePrefill: 'Compare ',
			compareHint: 'Tell me which two products to compare and I will show them side by side.',
			compareSend: 'Compare {a} and {b} for me.',
			compareFirstTwo: 'Compare the first two',
			comparison: 'Comparison',
			view: 'View',
			inStock: 'In stock',
			inDays: 'Within {n} days',
			inDay1: 'Within 1 day',
			fromDate: 'Available from {datum}',
			soldOut: 'Sold out',
			productsCount: 'Products in the answer: {n}.',
			slowWait: 'Searching the shop\'s products…',
			prevProducts: 'Previous products',
			nextProducts: 'More products',
			giftStep: 'Step {n} of 3',
			categoriesQuestion: 'What are you looking for?',
			giftTip: 'After three questions I pick gifts from this shop\'s range.',
			giftChange: 'Change',
			tileShort: ['Compare', 'Shipping', 'Contact', 'This product'],
			giftFor: 'For: {n}',
			cheaperBy: '{n} cheaper',
		},
		de: {
			openLabel: 'Chat mit dem Assistenten öffnen',
			closeLabel: 'Chat schließen',
			title: 'Shop-Assistent',
			placeholder: 'Frage eingeben...',
			send: 'Senden',
			thinking: 'Der Assistent schreibt…',
			greeting: 'Hallo, wie kann ich Ihnen bei der Auswahl helfen?',
			networkError: 'Antwort konnte nicht geladen werden. Bitte erneut versuchen.',
			rateLimited: 'Zu viele Nachrichten auf einmal. Bitte in Kürze erneut versuchen.',
			quotaExceeded: 'Der Assistent macht heute Pause. Bitte nutzen Sie die Kontaktseite des Shops.',
			poweredBy: 'Bereitgestellt von ARLing Shopping Assistant',
			subtitle: 'Antwortet aus den Produkten des Shops',
			preparedNote: 'Vorab geprüfte Antwort',
			preparedFailed: 'Die vorbereitete Antwort konnte nicht geladen werden.',
			retry: 'Erneut versuchen',
			relatedProducts: 'Passende Produkte',
			giftButton: 'Geschenk finden',
			giftOpenLabel: 'Geschenkfinder öffnen',
			giftTitle: 'Geschenkfinder',
			giftRecipientQuestion: 'Für wen ist das Geschenk?',
			giftRecipients: ['Partner/in', 'Mama', 'Papa', 'Kind', 'Kollege/in', 'Freund/in', 'Mich selbst'],
			giftRecipientPlaceholder: 'Oder schreiben Sie für wen (z. B. Oma)',
			giftBudgetQuestion: 'Wie hoch ist das Budget?',
			giftBudgetLabels: ['bis 20 €', 'bis 50 €', 'bis 100 €', 'über 100 €'],
			giftInterestsQuestion: 'Was mag die Person?',
			giftInterestsPlaceholder: 'Zum Beispiel Garten, Kaffee, Bücher...',
			giftNext: 'Weiter',
			giftBack: 'Zurück',
			giftSubmit: 'Geschenke finden',
			giftThinking: 'Suche passende Geschenke…',
			giftShowMore: 'Mehr anzeigen',
			giftAskElse: 'Etwas anderes fragen',
			giftWidenedNote: 'Bei diesem Budget haben wir zu wenige Geschenke gefunden, daher haben wir es leicht erweitert.',
			giftFewNote: 'Für diese Auswahl haben wir nur wenige passende Geschenke gefunden.',
			giftEmptyNote: 'Wir haben kein passendes Geschenk gefunden. Versuchen Sie ein anderes Budget oder andere Interessen.',
			aiPoradca: 'KI antwortet',
			teaserAria: 'Hilfeangebot',
			teaserProdukt: 'Fragen zu diesem Produkt?',
			teaserIna: 'Hilfe bei der Auswahl?',
			teaserInaRiadok: 'Ich antworte aus den Produkten dieses Shops.',
			teaserClose: 'Hinweis schließen',
			newChat: 'Neues Gespräch beginnen',
			privacyLine: 'Ich antworte nur aus den Produkten dieses Shops. Das Gespräch wird nicht gespeichert.',
			quickLabel: 'Schnellauswahl',
			categoriesLabel: 'Kategorien',
			questionsLabel: 'Sie können zum Beispiel fragen',
			tileCompare: 'Produkte vergleichen',
			tileProduct: 'Zu diesem Produkt fragen',
			tileShipping: 'Versand und Rückgabe',
			tileContact: 'Shop kontaktieren',
			newWindow: '(öffnet in neuem Fenster)',
			productQuestion: 'Was sollte ich vor dem Kauf über {nazov} wissen?',
			categoryQuestion: 'Was empfehlen Sie aus der Kategorie {nazov}?',
			comparePrefill: 'Vergleichen Sie bitte ',
			compareHint: 'Schreiben Sie, welche zwei Produkte Sie vergleichen möchten, dann zeige ich sie nebeneinander.',
			compareSend: 'Vergleichen Sie bitte {a} und {b}.',
			compareFirstTwo: 'Die ersten zwei vergleichen',
			comparison: 'Vergleich',
			view: 'Ansehen',
			inStock: 'Auf Lager',
			inDays: 'In {n} Tagen',
			inDay1: 'In 1 Tag',
			fromDate: 'Verfügbar ab {datum}',
			soldOut: 'Ausverkauft',
			productsCount: 'Produkte in der Antwort: {n}.',
			slowWait: 'Ich suche in den Produkten des Shops…',
			prevProducts: 'Vorherige Produkte',
			nextProducts: 'Weitere Produkte',
			giftStep: 'Schritt {n} von 3',
			categoriesQuestion: 'Was suchen Sie?',
			giftTip: 'Nach drei Fragen wähle ich Geschenke aus dem Sortiment dieses Shops aus.',
			giftChange: 'Ändern',
			tileShort: ['Vergleichen', 'Versand', 'Kontakt', 'Zu diesem Produkt'],
			giftFor: 'Für: {n}',
			cheaperBy: '{n} günstiger',
		},
	};

	var LOCALES = { sk: 'sk-SK', cs: 'cs-CZ', en: 'en-GB', de: 'de-DE' };

	function skus(f, zaloha) {
		try {
			return f();
		} catch (e) {
			return zaloha;
		}
	}

	// English fallback: the plugin is in the worldwide WordPress directory.
	function normaliseLang(lang) {
		var l = String(lang || '').toLowerCase().slice(0, 2);
		return STRINGS[l] ? l : 'en';
	}

	function resolveAutoLang() {
		var nav = window.navigator || {};
		return normaliseLang(nav.language || (nav.languages && nav.languages[0]) || '');
	}

	function scriptOrigin(el) {
		return skus(() => new URL(el.src).origin, '');
	}

	function vlozit(sablona, hodnoty) {
		return String(sablona).replace(/\{(\w+)\}/g, (m, k) => {
			return hodnoty && hodnoty[k] != null ? String(hodnoty[k]) : m;
		});
	}

	var POWERED_BY_URL = 'https://arling.sk/asistent/?utm_source=widget&utm_medium=referral';

	var GIFT_BUDGET_RANGES = [{ min: 0, max: 20 }, { min: 0, max: 50 }, { min: 0, max: 100 }, { min: 100, max: null }];

	/** Only when the page has Umami; never customer text. */
	function trackUmami(event, data) {
		skus(() => {
			if (window.umami && typeof window.umami.track === 'function') window.umami.track(event, data || {});
		});
	}

	// == Session id, the signed conversation token "relacia" and the teaser flag

	var SESSION_STORAGE_KEY = 'arling_asistent_session';
	var SESSION_ID_RE = /^[0-9a-f]{16}$/;
	var RELACIA_STORAGE_KEY = 'arling_asistent_relacia';
	var RELACIA_RE = /^r1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
	var UPOUTAVKA_KEY = 'arling_asistent_upoutavka';
	var MAX_SENT_MESSAGES = 6;
	var MAX_QUESTION_CHARS = 500;
	var MAX_GIFT_FIELD_CHARS = 200;
	var relaciaMemory = null;

	function citaj(key) {
		return skus(() => window.sessionStorage ? window.sessionStorage.getItem(key) : null, null);
	}

	function zapis(key, value) {
		skus(() => { if (window.sessionStorage) window.sessionStorage.setItem(key, value); });
	}

	function randomSessionId() {
		var c = window.crypto || (typeof crypto !== 'undefined' ? crypto : null);
		var bytes = skus(() => c.getRandomValues(new Uint8Array(8)), null);
		var out = '';
		for (var i = 0; i < 8; i++) {
			var b = bytes ? bytes[i] : Math.floor(Math.random() * 256);
			out += (b < 16 ? '0' : '') + b.toString(16);
		}
		return out;
	}

	function getSessionId() {
		var existing = citaj(SESSION_STORAGE_KEY);
		if (existing && SESSION_ID_RE.test(existing)) return existing;
		var fresh = randomSessionId();
		zapis(SESSION_STORAGE_KEY, fresh);
		return fresh;
	}

	function readRelacia() {
		var stored = citaj(RELACIA_STORAGE_KEY);
		return stored && RELACIA_RE.test(stored) ? stored : relaciaMemory;
	}

	function saveRelacia(token) {
		if (typeof token !== 'string' || !RELACIA_RE.test(token) || token.length > 600) return;
		relaciaMemory = token;
		zapis(RELACIA_STORAGE_KEY, token);
	}

	// == Rendering helpers

	function escapeHtml(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	/** http(s) only; "undefined" and "null" are no address (finding 3). */
	function safeUrl(url) {
		var raw = url == null ? '' : String(url).trim();
		if (!raw || raw === 'undefined' || raw === 'null') return '';
		return skus(() => {
			var parsed = new URL(raw, window.location.href);
			return /^https?:$/.test(parsed.protocol) ? parsed.href : '';
		}, '');
	}

	function formatPrice(p) {
		if (p.price == null) return '';
		var amount = Number(p.price);
		return (Number.isFinite(amount) ? amount.toFixed(2) : String(p.price)) + ' ' + (p.currency || '');
	}

	// == Colours (T3): one shop colour, five shades with WCAG AA contrast

	var FARBA_ZALOHA = '#B23A1D';
	var POZADIA = { svetly: { pozadie: '#F7F7F5', povrch: '#FFFFFF' }, tmavy: { pozadie: '#121214', povrch: '#1B1B1F' } };

	function hexNaRgb(h) {
		h = String(h).replace('#', '');
		if (h.length === 3) h = h.replace(/./g, '$&$&');
		return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	}

	function rgbNaHex(c) {
		return '#' + c.map((v) => (v < 16 ? '0' : '') + v.toString(16)).join('').toUpperCase();
	}

	function normalizujHex(v) {
		var s = String(v == null ? '' : v).trim();
		return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? rgbNaHex(hexNaRgb(s)) : '';
	}

	function jas(hex) {
		var c = hexNaRgb(hex).map((v) => {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
		});
		return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
	}

	function kontrast(a, b) {
		var x = jas(a);
		var y = jas(b);
		return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
	}

	function mix(a, b, t) {
		var B = hexNaRgb(b);
		return rgbNaHex(hexNaRgb(a).map((v, i) => Math.round(v + (B[i] - v) * t)));
	}

	function najdi(z, k, pozadia, ciel) {
		for (var i = 0; i <= 50; i++) {
			var c = mix(z, k, i / 50);
			if (pozadia.every((p) => kontrast(c, p) >= ciel)) return c;
		}
		return normalizujHex(k);
	}

	function odtiene(zadana, tmavy) {
		var z = normalizujHex(zadana) || FARBA_ZALOHA;
		var P = tmavy ? POZADIA.tmavy : POZADIA.svetly;
		var plna = z;
		var naFarbe = '#FFFFFF';
		var sBielou = kontrast(z, '#FFFFFF');
		if (sBielou < 4.5) {
			if (sBielou < 3 && kontrast(z, '#111113') >= 4.5) naFarbe = '#111113';
			else plna = najdi(z, '#000000', ['#FFFFFF'], 4.5);
		}
		if (tmavy && kontrast(plna, P.pozadie) < 3) {
			plna = najdi(z, '#FFFFFF', [P.pozadie], 3);
			naFarbe = kontrast(plna, '#FFFFFF') >= kontrast(plna, '#111113') ? '#FFFFFF' : '#111113';
		}
		var jemna = tmavy ? mix(z, P.povrch, 0.82) : mix(z, '#FFFFFF', 0.9);
		var k = tmavy ? '#FFFFFF' : '#000000';
		var poz = [P.pozadie, P.povrch, jemna];
		return { plna: plna, naFarbe: naFarbe, jemna: jemna, text: najdi(z, k, poz, 4.5), ikona: najdi(z, k, poz, 3) };
	}

	/** theme-color only as a real colour (HSL s >= .25, l .15 to .85). */
	function farbaPouzitelna(hex) {
		var n = normalizujHex(hex);
		if (!n) return false;
		var c = hexNaRgb(n).map((v) => v / 255);
		var max = Math.max.apply(null, c);
		var min = Math.min.apply(null, c);
		var l = (max + min) / 2;
		var s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
		return s >= 0.25 && l >= 0.15 && l <= 0.85;
	}

	// == Icons (appendix C): one stroke, one family

	var IKONY = {
		zavriet: '<path d="M6 6l12 12M18 6L6 18"/>',
		obnovit: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4.5H8"/>',
		odoslat: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
		spat: '<path d="m14.5 6-6 6 6 6"/>',
		dalej: '<path d="m9.5 6 6 6-6 6"/>',
		darcek: '<path d="M4 11h16v9H4z"/><path d="M3 7.5h18V11H3z"/><path d="M12 7.5V20"/><path d="M12 7.5c-1.5-3-5-3.5-5-1.2 0 1.2 2 1.2 5 1.2zm0 0c1.5-3 5-3.5 5-1.2 0 1.2-2 1.2-5 1.2z"/>',
		porovnat: '<path d="M7.5 7H19m0 0-3-3m3 3-3 3"/><path d="M16.5 17H5m0 0 3-3m-3 3 3 3"/>',
		doprava: '<path d="M3 6.5h11v9H3z"/><path d="M14 9.5h3.5l3 3v3H14"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
		otazka: '<path d="M4 5.5h16v11H10l-4.5 3.5v-3.5H4z"/><path d="M10 9.3a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4"/><path d="M12 14.2h.01"/>',
		kontakt: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
		odkaz: '<path d="M8 16 16 8"/><path d="M9 8h7v7"/>',
		zamok: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
		fajka: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
		upozornenie: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5"/><path d="M12 16h.01"/>',
		// v2.2: a missing photo is a bag outline.
		taska: '<path d="M5.5 8.5h13l-1 11h-11z"/><path d="M9 8.5V7a3 3 0 0 1 6 0v1.5"/>',
	};

	function ikona(meno, trieda, hrubka) {
		return '<svg' + (trieda ? ' class="' + trieda + '"' : '') + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (hrubka || 1.75) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + IKONY[meno] + '</svg>';
	}

	// c.inline (data-mount): a region in the page, no launcher, teaser or close.
	function buildMarkup(strings, c) {
		var h = (k) => escapeHtml(strings[k]);
		var ikonoveTlacidlo = (id, trieda, popis, ik) => {
			return '<button id="' + id + '" class="' + trieda + '" type="button" aria-label="' + popis + '"><span>' + ikona(ik) + '</span></button>';
		};
		return (
			'<button id="toggle" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="panel" aria-label="' + escapeHtml(c.toggleLabel) + '">' +
			// v2.2: a speech bubble, not the AI sparkle.
			'<span class="iskra">' + ikona('otazka', '', 2) + '</span><span class="spustac-text">' + escapeHtml(c.meno) + '</span></button>' +
			(c.inline ? '' :
				'<aside id="teaser" aria-label="' + h('teaserAria') + '" hidden>' +
				'<button id="teaser-open" type="button"><span class="u-stitok">' + h('aiPoradca') + '</span>' +
				'<span id="teaser-otazka" class="u-otazka"></span><span id="teaser-riadok" class="u-riadok"></span></button>' +
				ikonoveTlacidlo('teaser-close', 'u-zavriet', h('teaserClose'), 'zavriet') +
				'</aside><div id="scrim" hidden></div>') +
			(c.inline
				? '<div id="panel" role="region" aria-label="' + escapeHtml(c.panelTitle) + '" hidden>'
				: '<div id="panel" role="dialog" aria-modal="true" aria-labelledby="panel-title" tabindex="-1" hidden>') +
			'<div id="uchytka" class="uchytka" aria-hidden="true"><i></i></div>' +
			'<div id="hlavicka" class="hlavicka"><span id="panel-title" class="sr-only">' + escapeHtml(c.panelTitle) + '</span>' +
			'<div class="h-obchod">' +
			// Dark mode: data-logo-tmave, else the shop name as text.
			(c.logo
				? '<img class="h-logo" src="' + escapeHtml(c.logo) + '" alt="' + escapeHtml(c.obchod || c.panelTitle) + '">' +
					(c.logoTmave ? '<img class="h-logo-tmave" src="' + escapeHtml(c.logoTmave) + '" alt="' + escapeHtml(c.obchod || c.panelTitle) + '">' : '<span class="h-meno h-meno-tmave">' + escapeHtml(c.menoHlavicky) + '</span>')
				: '<span class="h-meno">' + escapeHtml(c.menoHlavicky) + '</span>') +
			'<span class="h-stitok"><i></i>' + h('aiPoradca') + '</span></div>' +
			ikonoveTlacidlo('reset-btn', 'h-btn', h('newChat'), 'obnovit') +
			ikonoveTlacidlo('close-btn', 'h-btn', h('closeLabel'), 'zavriet') +
			// tabindex -1: Firefox would put the scroll box itself into the Tab order.
			'</div><div class="telo"><div id="messages" class="messages" aria-live="off" tabindex="-1"></div>' +
			(c.gift ? buildGiftMarkup(h, ikonoveTlacidlo) : '') +
			'</div><div id="live" class="sr-only" aria-live="polite"></div>' +
			'<form id="form" class="composer"><div class="pole"><label class="sr-only" for="input">' + h('placeholder') + '</label>' +
			// Shift+Enter = newline; maxlength = the server's cut.
			'<textarea id="input" rows="1" autocomplete="off" maxlength="' + MAX_QUESTION_CHARS + '" placeholder="' + h('placeholder') + '"></textarea>' +
			'<button id="send-btn" type="submit" data-prazdne="" aria-label="' + h('send') + '"><span>' + ikona('odoslat') + '</span></button></div></form>' +
			'<div class="footer"><a href="' + POWERED_BY_URL + '" target="_blank" rel="noopener">' + h('poweredBy') + '</a></div>' +
			'</div>' +
			// The gift tile, until the intro moves it.
			(c.gift ? '<div id="uvod-zdroj" hidden><button id="gift-toggle" type="button" class="dlazdica" aria-controls="gift-panel" aria-expanded="false"><span class="dl-ikona">' + ikona('darcek') + '</span><span class="dl-text">' + h('giftButton') + '</span></button></div>' : '')
		);
	}

	/** Gift Finder view inside the panel (data-gift="1"). */
	function buildGiftMarkup(h, ikonoveTlacidlo) {
		var krok = (id, skryty, obsah) => {
			return '<div id="gift-step-' + id + '" class="gift-step"' + (skryty ? ' hidden' : '') + '>' + obsah + '</div>';
		};
		var tlacidlo = (id, trieda, k, skryty) => {
			return '<button type="button" id="' + id + '" class="' + trieda + '"' + (skryty ? ' hidden' : '') + '>' + h(k) + '</button>';
		};
		var otazka = (k) => '<p class="gift-question">' + h(k) + '</p>';
		return (
			'<div id="gift-panel" class="darcek" role="group" aria-labelledby="gift-title" hidden>' +
			'<div class="d-hlavicka">' + ikonoveTlacidlo('gift-close-btn', 'h-btn', h('giftBack'), 'spat') +
			'<span id="gift-title" class="d-nazov">' + h('giftTitle') + '</span><span id="gift-krok" class="d-krok"></span></div>' +
			'<div id="gift-postup" class="d-postup" data-krok="1" aria-hidden="true"><i></i><i></i><i></i></div>' +
			'<div id="gift-live" class="sr-only" aria-live="polite"></div><div id="gift-body" class="gift-body" tabindex="-1">' +
						'<p id="gift-kontext" class="d-kontext" hidden></p>' +
			// v2.2: back is the arrow; hidden text buttons keep the ids (8.9).
			krok('recipient', false, otazka('giftRecipientQuestion') + '<p class="d-tip">' + h('giftTip') + '</p>' +
				'<div id="gift-recipient-chips" class="gift-chips" role="group" aria-label="' + h('giftRecipientQuestion') + '"></div>' +
				'<label class="sr-only" for="gift-recipient-input">' + h('giftRecipientPlaceholder') + '</label>' +
				'<input id="gift-recipient-input" class="d-pole" type="text" autocomplete="off" maxlength="' + MAX_GIFT_FIELD_CHARS + '" placeholder="' + h('giftRecipientPlaceholder') + '">' +
				'<div class="gift-actions">' + tlacidlo('gift-recipient-next', 'gift-btn-primary', 'giftNext') + '</div>') +
			krok('budget', true, otazka('giftBudgetQuestion') +
				'<div id="gift-budget-chips" class="gift-chips d-rozpocet" role="group" aria-label="' + h('giftBudgetQuestion') + '"></div>' +
				tlacidlo('gift-budget-back', 'gift-btn-secondary', 'giftBack', true)) +
			krok('interests', true, otazka('giftInterestsQuestion') +
				'<label class="sr-only" for="gift-interests-input">' + h('giftInterestsPlaceholder') + '</label>' +
				'<input id="gift-interests-input" class="d-pole" type="text" autocomplete="off" maxlength="' + MAX_GIFT_FIELD_CHARS + '" placeholder="' + h('giftInterestsPlaceholder') + '">' +
				'<div id="gift-interests-chips" class="gift-chips"></div>' +
				'<div class="gift-actions">' + tlacidlo('gift-interests-back', 'gift-btn-secondary', 'giftBack', true) + tlacidlo('gift-submit-btn', 'gift-btn-primary', 'giftSubmit') + '</div>') +
			krok('results', true, '<p id="gift-zhrnutie" class="d-zhrnutie" hidden><span id="gift-vyber"></span><button type="button" id="gift-zmenit" class="gift-btn-secondary">' + h('giftChange') + '</button></p>' +
				'<p id="gift-note" class="gift-note" hidden></p>' +
				'<div id="gift-results-list" class="gift-results" role="list" aria-label="' + h('giftTitle') + '"></div>' +
				'<div class="gift-actions">' + tlacidlo('gift-show-more', 'gift-btn-secondary obrys', 'giftShowMore', true) + tlacidlo('gift-ask-else', 'gift-btn-secondary obrys', 'giftAskElse') + '</div>') +
			'</div></div>'
		);
	}

	// == Style: tokens T1 and T2, springs from ops/video/pohyb (the same curves as paper.css)

	var SVETLY = '--a-pozadie:#F7F7F5;--a-povrch:#FFFFFF;--a-povrch-2:#F0EFEC;--a-text:#18181B;--a-text-2:#3F3F46;--a-jemny:#65656E;--a-ciara:#E6E4DF;--a-ciara-pole:#8C8981;--a-bodka:#15803D;--a-ok:#15803D;--a-caka:#B45309;--a-nie:#B42318;--a-tacka:#F4F3F0;--a-prstenec:rgba(16,16,20,.07);--a-clona:rgba(16,16,20,.36);--a-clona-mobil:rgba(16,16,20,.5);--a-tien-1:0 1px 2px rgba(16,16,20,.06),0 1px 1px rgba(16,16,20,.04);--a-tien-2:0 12px 32px -12px rgba(16,16,20,.22),0 2px 6px rgba(16,16,20,.06);--a-tien-panel:0 24px 64px -16px rgba(16,16,20,.30),0 0 0 1px rgba(16,16,20,.06);--a-farba-plna:#B23A1D;--a-na-farbe:#FFFFFF;--a-farba-jemna:#F7EBE8;--a-farba-text:#B23A1D;--a-farba-ikona:#B23A1D;';
	var TMAVY = '--a-pozadie:#121214;--a-povrch:#1B1B1F;--a-povrch-2:#26262B;--a-text:#F4F4F5;--a-text-2:#D4D4D8;--a-jemny:#A1A1AA;--a-ciara:#2C2C32;--a-ciara-pole:#74747D;--a-bodka:#22C55E;--a-ok:#4ADE80;--a-caka:#FBBF24;--a-nie:#F97066;--a-tacka:#FFFFFF;--a-prstenec:rgba(255,255,255,.1);--a-clona:rgba(0,0,0,.55);--a-clona-mobil:rgba(0,0,0,.62);--a-tien-1:0 1px 2px rgba(0,0,0,.4);--a-tien-2:0 16px 40px -12px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.06);--a-tien-panel:0 28px 72px -16px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.07);--a-farba-plna:#B23A1D;--a-na-farbe:#FFFFFF;--a-farba-jemna:#36211F;--a-farba-text:#CB7965;--a-farba-ikona:#BA4E34;';
	var PISMO_SYSTEM = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
	var PRUZINY = '--a-stlac:linear(0, 0.0166 2.3%, 0.0736 5.2%, 0.1985 9.5%, 0.4972 18.8%, 0.6445 24.3%, 0.7583 29.75%, 0.8473 35.6%, 0.9149 42.3%, 0.9629 50.6%, 0.9919 62.35%, 1.0015 88.1%, 1);' +
		'--a-pust:linear(0, 0.0164 2.25%, 0.0716 5%, 0.1861 8.8%, 0.5397 18.95%, 0.6883 24.05%, 0.8013 29%, 0.8882 34.25%, 0.952 40.15%, 0.9939 47.3%, 1.0139 57.35%, 1);' +
		'--a-rychla:linear(0, 0.0167 2.2%, 0.0723 4.9%, 0.1917 8.8%, 0.5127 18.1%, 0.6611 23.25%, 0.7747 28.3%, 0.863 33.7%, 0.9291 39.85%, 0.9746 47.4%, 0.9999 58.1%, 1.0028 86.15%, 1);' +
		'--a-tvar:var(--a-pust);' +
		'--a-vstup:linear(0, 0.0166 2.3%, 0.0733 5.2%, 0.1978 9.5%, 0.4973 18.85%, 0.6442 24.35%, 0.7579 29.8%, 0.8468 35.65%, 0.9145 42.35%, 0.9626 50.65%, 0.9917 62.4%, 1.0015 87.9%, 1);' +
		'--a-odchod:linear(0, 0.0165 2.1%, 0.0735 4.8%, 0.2092 9.2%, 0.4669 17.05%, 0.6111 22.35%, 0.7245 27.7%, 0.8151 33.55%, 0.8866 40.4%, 0.9399 48.95%, 0.9762 60.95%, 0.9958 82.6%, 1);' +
		'--a-mekka:cubic-bezier(.2,.7,.2,1);';

	// $token = var(--a-token), $p = var(--a-pismo); expanded once at the end.
	function buildCss() {
		var M = '@media (max-width:599.98px)';
		return [
			':host{all:initial;' + SVETLY + PRUZINY + '--a-pismo:' + PISMO_SYSTEM + ';--a-odsadenie:0px;font-family:$p}',
			'@supports not (transition-timing-function:linear(0,1)){:host{--a-stlac:cubic-bezier(.2,.7,.2,1);--a-rychla:cubic-bezier(.2,.7,.2,1);--a-pust:cubic-bezier(.16,1,.3,1);--a-tvar:cubic-bezier(.16,1,.3,1);--a-vstup:cubic-bezier(.16,1,.3,1);--a-odchod:cubic-bezier(.4,0,1,1)}}',
			':host(.rezim-tmavy){' + TMAVY + 'color-scheme:dark}',
			'*{box-sizing:border-box}svg{display:block}button,input,textarea{margin:0;font-family:inherit}[hidden]{display:none!important}',
			'.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
			'button:focus-visible,a:focus-visible{outline:2px solid $farba-ikona;outline-offset:2px}.messages:focus,.gift-body:focus,.products:focus{outline:none}',
			'.suggestion,.dlazdica,.kategoria,.product-card,.gift-chip,.gift-btn-primary,#send-btn span,.por-pozriet,.gift-btn-secondary{transition:background-color .12s linear,border-color .12s linear,color .12s linear,transform .459s $pust}',
			'.suggestion:active,.dlazdica:active,.kategoria:active,.gift-chip:active,.gift-btn-primary:active{transform:scale(.98)}#toggle:active,a.product-card:active,#send-btn:active span,.suggestion:active,.dlazdica:active,.kategoria:active,.gift-chip:active,.gift-btn-primary:active{transition:transform .214s $stlac}',
			'.spustac-text,.u-riadok,.h-meno,.d-nazov{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.u-otazka,.dl-text,.kat-nazov,.product-title,.por-nazov{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}',
			'.uvod-stitok,.pas-stitok,.por-stitok{font:600 13.5px/1.3 $p;color:$text-2}',
			'.h-btn,.u-zavriet,.pas-sipka{flex:none;width:44px;height:44px;padding:0;border:0;background:transparent;display:grid;place-items:center;cursor:pointer;color:$text-2}',
			'.h-btn span,.u-zavriet span,.pas-sipka span{display:grid;place-items:center;transition:background-color .12s linear}',
			'#toggle{position:fixed;z-index:2147483000;right:24px;bottom:calc(24px + $odsadenie);height:52px;max-width:calc(100vw - 48px);display:inline-flex;align-items:center;gap:8px;padding:0 18px 0 14px;border:0;border-radius:999px;background:$farba-plna;color:$na-farbe;font:600 15px/1 $p;letter-spacing:-.005em;box-shadow:$tien-2;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .459s $pust,opacity .15s linear}',
			':host(.position-left) #toggle{right:auto;left:24px}',
			'#toggle .iskra{flex:none;width:20px;height:20px;opacity:.9;animation:a-dych 2.8s ease-in-out 1.2s 3}#toggle .iskra svg{width:100%;height:100%}#toggle.dych .iskra{animation:a-dych2 2.8s ease-in-out}',
			'#toggle .spustac-text{max-width:200px;line-height:1.2}',
			'#toggle:active{transform:scale(.96)}#toggle:focus-visible{outline:3px solid $farba-ikona;outline-offset:3px}',
			'#toggle[aria-expanded="true"]{opacity:0;transform:scale(.9);pointer-events:none;transition:opacity .15s linear,transform .15s $mekka}',
			'@keyframes a-dych{50%{transform:scale(1.1);opacity:1}}@keyframes a-dych2{50%{transform:scale(1.1);opacity:1}}',
			'#teaser{position:fixed;z-index:2147483000;right:24px;bottom:calc(88px + $odsadenie);width:296px;background:$povrch;color:$text;border:1px solid $ciara;border-radius:16px;box-shadow:$tien-2;transform-origin:100% 100%;opacity:0;transform:translateY(8px) scale(.98);transition:opacity .294s $odchod,transform .294s $odchod}',
			':host(.position-left) #teaser{right:auto;left:24px;transform-origin:0 100%}#teaser.produkt{width:256px}',
			'#teaser[data-stav="otvoreny"]{opacity:1;transform:none;transition:opacity .507s $vstup,transform .507s $vstup}#teaser[data-stav="zatvara"]{opacity:0;transform:translateY(4px)}',
			'#teaser-open{display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:100%;padding:14px 40px 16px 16px;border:0;border-radius:16px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}',
			'.u-stitok{font:700 11.5px/1.2 $p;letter-spacing:.08em;text-transform:uppercase;color:$farba-text}.u-otazka{font:650 16px/1.3 $p;letter-spacing:-.01em;color:$text}',
			'.u-riadok{max-width:calc(100% + 24px);margin-right:-24px;font:500 13.5px/1.45 $p;color:$jemny}',
			'.u-zavriet{position:absolute;top:2px;right:2px;border-radius:50%;color:$jemny}.u-zavriet span{width:28px;height:28px;border-radius:50%}.u-zavriet svg{width:16px;height:16px}',
			'#scrim{position:fixed;inset:0;z-index:2147483001;background:$clona;opacity:0;touch-action:none;transition:opacity .2s $mekka}#scrim[data-stav="otvoreny"]{opacity:1;transition:opacity .24s $mekka}',
			'#panel{position:fixed;z-index:2147483002;top:12px;right:12px;bottom:12px;width:min(460px,calc(100vw - 24px));display:flex;flex-direction:column;overflow:hidden;background:$pozadie;color:$text;border-radius:20px;box-shadow:$tien-panel;font:400 15px/1.55 $p;outline:none;transform:translateX(calc(100% + 12px));opacity:0;transition:transform .294s $odchod,opacity .12s linear .174s}',
			'#panel[data-stav="otvoreny"]{transform:none;opacity:1;transition:transform .507s $vstup,opacity .16s $mekka}#panel.pohyb{will-change:transform}',
			// Closed panel stays laid out, only invisible (Firefox).
			'#panel[hidden]{display:none}:host(:not(.inline)) #panel[hidden]{display:flex!important;visibility:hidden;pointer-events:none}',
			':host(.position-left) #panel{right:auto;left:12px;transform:translateX(calc(-100% - 12px))}:host(.position-left) #panel[data-stav="otvoreny"]{transform:none}',
			'#panel:focus-visible{outline:none}.uchytka{display:none}',
			// v2.2: one 64 px row, logo and tag side by side.
			'.hlavicka{flex:none;min-height:64px;display:flex;align-items:center;gap:2px;padding:0 8px 0 20px;border-bottom:1px solid transparent;transition:border-color .12s linear;container-type:inline-size}.hlavicka.posunute{border-bottom-color:$ciara}',
			'.h-obchod{flex:1;min-width:0;display:flex;align-items:center;gap:10px}.h-logo,.h-logo-tmave{display:block;flex:0 1 auto;min-width:0;height:28px;width:auto;max-width:156px;object-fit:contain;object-position:left center}',
			'.h-logo-tmave,.h-meno-tmave,:host(.rezim-tmavy) .h-logo{display:none}:host(.rezim-tmavy) .h-logo-tmave,:host(.rezim-tmavy) .h-meno-tmave{display:block}',
			'.h-meno{flex:0 1 auto;min-width:0;font:650 16px/1.3 $p;letter-spacing:-.01em;color:$text}',
			'.h-stitok{flex:none;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px 0 8px;border-radius:999px;background:$povrch-2;color:$text-2;font:600 12.5px/1 $p;white-space:nowrap}.h-stitok i{width:7px;height:7px;border-radius:50%;background:$bodka}',
			'@container (max-width:339px){.h-obchod{flex-direction:column;align-items:flex-start;gap:4px;padding-block:12px}.h-meno{font-size:15px}}',
			'.h-btn{border-radius:10px}.h-btn span{width:36px;height:36px;border-radius:10px}.h-btn svg{width:20px;height:20px}',
			// v2.2: content under the composer fades out, never cut through letters.
			'.telo{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}.telo::after{content:"";position:absolute;left:0;right:0;bottom:0;height:28px;background:linear-gradient(transparent,$pozadie);pointer-events:none;opacity:0;transition:opacity .12s linear}.telo.pod-obsahom::after{opacity:1}',
			'.messages{position:relative;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px 20px 24px;scroll-padding-top:16px;display:flex;flex-direction:column;gap:16px;scrollbar-width:thin;scrollbar-color:$ciara-pole transparent}',
			'.msg{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-width:0}.msg-assistant{align-self:stretch}',
			'.msg-user{align-self:flex-end;align-items:flex-end;max-width:82%;transform-origin:100% 100%;animation:a-sprava .447s $rychla both}',
			'.bubble{max-width:100%;overflow-wrap:anywhere;white-space:pre-wrap}',
			'.msg-assistant .bubble{background:$povrch;border:1px solid $ciara;border-radius:16px 16px 16px 6px;padding:12px 16px;font:400 15px/1.55 $p;color:$text;animation:a-odsek .507s $vstup both}.msg-assistant .bubble.odseky{animation:none}',
			'.bubble p{margin:0;white-space:pre-wrap;animation:a-odsek .507s $vstup both}.bubble p+p{margin-top:8px}',
			'.msg-user .bubble{background:$farba-plna;color:$na-farbe;font:500 15px/1.5 $p;border-radius:16px 16px 6px 16px;padding:10px 14px}',
			'.msg-error .bubble{display:flex;gap:10px}.chyba-ik{flex:none;color:$nie;margin-top:3px}.chyba-ik svg{width:16px;height:16px}',
			'.bubble.thinking{display:inline-flex;align-items:center;gap:10px;height:36px;padding:0 14px;border-radius:999px;white-space:nowrap;animation:none}',
			'.dots{display:inline-flex;gap:5px}.dots i{width:7px;height:7px;border-radius:50%;background:$jemny;opacity:.35;animation:a-bodka 1.2s $pust infinite}.dots i:nth-child(2){animation-delay:.14s}.dots i:nth-child(3){animation-delay:.28s}',
			'.pomaly{font:500 13.5px/1.2 $p;color:$jemny;opacity:0;visibility:hidden;animation:a-ukaz .2s linear 3s forwards}',
			'.note{order:-1;display:inline-flex;align-items:center;gap:6px;font:500 12.5px/1.4 $p;color:$jemny}.note svg{width:14px;height:14px;color:$ok;flex:none}',
			'.suggestions{display:flex;flex-wrap:wrap;gap:8px;width:100%}.suggestions:not(:has(.suggestion:not([hidden]))){display:none}',
			'.suggestion{display:inline-flex;align-items:center;gap:8px;min-height:44px;max-width:100%;padding:10px 14px;border:1px solid $ciara-pole;border-radius:999px;background:$povrch;color:$text;font:500 14px/1.35 $p;text-align:left;cursor:pointer}',
			'.suggestion:disabled{opacity:.55;cursor:default}.suggestion[hidden],.suggestion .dalej{display:none}',
			// Intro (part 4)
			'.msg-uvod{gap:10px}.msg-assistant .bubble.uvitanie{width:100%;white-space:normal;border-bottom:0;border-radius:16px 16px 0 0;padding:18px 18px 6px;box-shadow:$tien-1}',
			'.uvitanie.jedna,.uv-nadpis{font:650 17px/1.35 $p;letter-spacing:-.01em;color:$text}.uv-nadpis,.uv-telo{display:block}.uv-telo{margin-top:6px;font:400 15px/1.55 $p;color:$text-2}',
			'.sukromie{position:relative;z-index:1;width:100%;margin-top:-11px;display:flex;align-items:flex-start;gap:6px;padding:8px 18px 16px;background:$povrch;border:1px solid $ciara;border-top:0;border-radius:0 0 16px 16px;box-shadow:$tien-1;font:500 12.5px/1.4 $p;color:$jemny;animation:a-odsek .507s $vstup both}.sukromie svg{flex:none;width:14px;height:14px;margin-top:2px}',
			'.uvod-stitok{margin-top:14px}.uvod-nadpis{font:650 15px/1.3 $p;letter-spacing:-.01em;color:$text}',
			'.dlazdice{width:100%;margin-top:14px;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}',
			// v2.2: line icon without a tinted square, one short line.
			'.dlazdica{grid-column:span 2;display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0;min-height:76px;padding:14px 16px;border:1px solid $ciara;border-radius:14px;background:$povrch;box-shadow:$tien-1;color:$text;font:600 14.5px/1.3 $p;text-align:left;text-decoration:none;text-wrap:balance;cursor:pointer}',
			'.dlazdica.pol{grid-column:span 3}',
			'.dl-ikona{flex:none;display:block;color:$farba-ikona}.dl-ikona svg{width:22px;height:22px}',
			'.kategorie{width:100%;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
			'.kategoria{display:flex;flex-direction:column;padding:0;border:1px solid $ciara;border-radius:14px;overflow:hidden;background:$povrch;box-shadow:$tien-1;color:$text;text-align:left;cursor:pointer;font:inherit}',
			'.kat-obr,.kat-ph{display:block;width:100%;height:auto;aspect-ratio:1;object-fit:cover;background:$povrch-2}.kat-ph{display:grid;place-items:center;color:$jemny;font-size:0}.kat-ph svg{width:28px;height:28px}.kat-nazov{min-height:calc(2.6em + 18px);padding:8px 10px 10px;font:600 13.5px/1.3 $p}',
			'.msg-uvod .suggestions{flex-direction:column;flex-wrap:nowrap;gap:0;background:$povrch;border:1px solid $ciara;border-radius:14px;overflow:hidden;box-shadow:$tien-1}',
			'.msg-uvod .suggestion{display:flex;justify-content:space-between;width:100%;max-width:none;min-height:48px;padding:12px 14px;border:0;border-radius:0;background:transparent;color:$text;font:500 14.5px/1.4 $p}',
			'.msg-uvod .suggestion:not([hidden])~.suggestion{border-top:1px solid $ciara}.msg-uvod .suggestion:focus-visible{outline-offset:-2px}.msg-uvod .suggestion .dalej{display:block;flex:none;width:16px;height:16px;color:$jemny}',
			'.vstup :is(.dlazdica,.kategoria,.suggestion){animation:a-hore .507s $vstup both}',
			// Answers: strip of cards (K6 to K8), comparison (K9)
			'.pas-hlavicka{width:100%;min-height:32px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px}.pas-sipky{display:flex;margin:-6px 0}',
			'.pas-sipka{border-radius:50%}.pas-sipka span{width:32px;height:32px;border:1px solid $ciara-pole;border-radius:50%;background:$povrch}.pas-sipka svg{width:16px;height:16px}.pas-sipka:disabled{opacity:.35;cursor:default}',
			'@media not all and (hover:hover) and (pointer:fine){.pas-sipky{display:none}}',
			'.products{width:calc(100% + 40px);display:flex;gap:12px;margin:0 -20px;padding:2px 20px 10px;overflow-x:auto;scroll-snap-type:x mandatory;overscroll-behavior-x:contain;scroll-padding-inline:20px;scrollbar-width:none}.products::-webkit-scrollbar{display:none}',
			'.product-item{flex:none;width:172px;display:flex;scroll-snap-align:start;animation:a-karta .507s $vstup both}',
			'.product-card{width:100%;display:flex;flex-direction:column;background:$povrch;border:1px solid $ciara;border-radius:14px;overflow:hidden;box-shadow:$tien-1;color:$text;text-decoration:none}a.product-card:active{transform:scale(.985)}',
			'.product-tacka{flex:none;display:block;aspect-ratio:1;overflow:hidden;background:$tacka}:host(.rezim-tmavy) .product-tacka{opacity:.92}.product-tacka.nacitane{background:#FFFFFF}.product-tacka:has(.product-ph){background:$povrch-2;opacity:1}',
			// v2.2: the photo to the card's edges; contain keeps odd formats whole.
			'.product-img{display:block;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .18s linear,transform .447s $rychla}.nacitane .product-img{opacity:1}',
			'.product-ph{display:grid;place-items:center;width:100%;height:100%;color:$jemny;font-size:0}.product-ph svg{width:28px;height:28px}',
			'.product-body{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;padding:10px 12px 12px}.product-title{font:500 14px/1.35 $p;color:$text}',
			'.product-price,.por-cena{margin-top:6px;font:700 16px/1.2 $p;color:$text}',
			'.product-dost{margin-top:4px;display:inline-flex;align-items:center;gap:6px;font:500 12.5px/1.4 $p}.product-dost::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}.dost-ok{color:$ok}.dost-caka{color:$caka}.dost-nie{color:$nie}',
			'.product-view{display:inline-flex;align-items:center;gap:2px;margin-top:auto;padding-top:10px;font:600 13.5px/1.3 $p;color:$farba-text}.product-view svg{width:14px;height:14px}',
			// v2.2: the same "Pozrieť ›" as in the strip.
			'.por-pozriet{display:inline-flex;align-items:center;align-self:start;justify-self:start;gap:2px;min-height:44px;font:600 13.5px/1.3 $p;color:$farba-text;text-decoration:none}.por-pozriet svg{width:14px;height:14px}',
			'.products[data-jeden]{width:100%;margin:0;padding:0;overflow:visible}.products[data-jeden] .product-item{width:100%}.products[data-jeden] .product-card{display:grid;grid-template-columns:104px minmax(0,1fr);align-items:center}',
			'.products[data-jeden] .product-tacka{width:104px;height:104px}.products[data-jeden] .product-body{padding:10px 14px}.pas-akcie{display:flex}',
			'.porovnanie{width:100%;padding:14px;background:$povrch;border:1px solid $ciara;border-radius:16px;box-shadow:$tien-1;animation:a-karta .507s $vstup 80ms both}.por-stitok{margin:0 0 10px}',
			'.por-mriezka{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(5,auto);column-gap:12px}.por-stlpec{grid-row:1/span 5;display:grid;grid-template-rows:subgrid;row-gap:6px;min-width:0}.por-stlpec .product-tacka{border-radius:10px;border:1px solid $ciara}',
			'.por-nazov{font:500 14px/1.35 $p;-webkit-line-clamp:3}.por-cena-riadok{align-self:start;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}.por-cena{margin:0}.por-dost{font:500 12.5px/1.4 $p}',
			// v2.2: the cheaper column carries the difference.
			'.por-lacnejsi{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:999px;background:$farba-jemna;color:$farba-text;font:600 12.5px/1 $p;white-space:nowrap}',
			'.por-param{margin-top:12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:10px;row-gap:2px}.por-param-nazov{grid-column:1/-1;margin-top:6px;font:500 12.5px/1.4 $p;color:$jemny}.por-param-hodnota{font:400 14px/1.4 $p;overflow-wrap:anywhere}',
			// Composer (P9, P10): in the flow, never covered
			'.composer{flex:none;display:flex;margin:0;padding:12px 16px;background:$pozadie;border-top:1px solid $ciara}',
			'.pole{flex:1;min-width:0;display:flex;align-items:flex-end;border:1px solid $ciara-pole;border-radius:16px;background:$povrch;transition:border-color .12s linear}',
			// v2.2: neutral focus, not an error look.
			'.pole:focus-within{border-color:$jemny;box-shadow:0 0 0 3px $prstenec}',
			'#input,.d-pole{border:1px solid $ciara-pole;background:$povrch;color:$text;font:400 16px/1.4 $p;transition:border-color .12s linear}#input::placeholder,.d-pole::placeholder{color:$jemny;opacity:1}',
			'.d-pole:focus,.d-pole:focus-visible{outline:none;border-color:$jemny;box-shadow:0 0 0 3px $prstenec}',
			'#input{flex:1;min-width:0;height:48px;min-height:48px;max-height:128px;padding:13px 4px 13px 16px;line-height:22px;border:0;border-radius:16px;background:transparent;resize:none;overflow-y:auto;overscroll-behavior:contain;outline:none}',
			'#send-btn{flex:none;width:48px;height:48px;padding:0;border:0;border-radius:14px;display:grid;place-items:center;background:transparent;color:$na-farbe;cursor:pointer}#send-btn span{width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:$farba-plna;animation:a-pop .459s $pust}',
			// v2.2: empty Send is grey, the first character brings the shop colour.
			'#send-btn[data-prazdne] span{background:$povrch-2;color:$jemny;animation:none}',
			'#send-btn:active span{transform:scale(.94)}#send-btn:disabled{cursor:default}#send-btn:disabled span{opacity:.6}#send-btn svg{width:20px;height:20px}#send-btn:focus-visible{outline-offset:-2px}',
			'.footer{flex:none;height:44px;display:flex;align-items:center;justify-content:center;background:$pozadie}.footer a{display:inline-flex;align-items:center;min-height:44px;padding:0 10px;font:500 12.5px/1.4 $p;color:$jemny;text-decoration:none}',
			// Gift finder view (5.8)
			'.darcek{flex:1;min-height:0;display:flex;flex-direction:column}.d-hlavicka{flex:none;height:52px;display:flex;align-items:center;gap:4px;padding:0 20px 0 8px}',
			'.d-nazov{flex:1;min-width:0;font:600 14.5px/1.3 $p;color:$text-2}.d-krok{flex:none;font:500 13px/1 $p;color:$jemny}',
			'.d-postup{flex:none;display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:0 20px}.d-postup i{display:block;height:4px;border-radius:999px;background:$povrch-2;overflow:hidden}',
			'.d-postup i::after{content:"";display:block;height:100%;border-radius:999px;background:$farba-ikona;transform:scaleX(0);transform-origin:0 50%;transition:transform .756s $tvar}',
			'.d-postup[data-krok="1"] i:nth-child(1)::after,.d-postup[data-krok="2"] i:nth-child(-n+2)::after,.d-postup[data-krok="3"] i::after,.d-postup[data-krok="4"] i::after{transform:scaleX(1)}',
			'.gift-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:24px 20px;display:flex;flex-direction:column}',
			'.gift-step{display:flex;flex-direction:column;animation:a-krok .507s $vstup both}.gift-body.spat .gift-step{animation-name:a-krok-spat}',
			'.gift-question{margin:0 0 16px;font:650 20px/1.3 $p;letter-spacing:-.01em;color:$text}.gift-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.gift-chips:empty{display:none}',
			'.gift-chip{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:10px 16px;border:1px solid $ciara-pole;border-radius:999px;background:$povrch;color:$text;font:500 14.5px/1.2 $p;cursor:pointer}',
			'.gift-chip .fajka{display:none;width:16px;height:16px}.gift-chip[aria-pressed="true"]{background:$farba-jemna;border-color:$farba-ikona;color:$farba-text}.gift-chip[aria-pressed="true"] .fajka{display:block}',
			// v2.2: the budget as a 2 x 2 grid.
			'.d-rozpocet{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}',
			'.d-rozpocet .gift-chip{justify-content:flex-start;min-height:64px;padding:0 16px;border-color:$ciara;border-radius:14px;box-shadow:$tien-1;font:650 16px/1.2 $p;font-variant-numeric:tabular-nums}',
			'.d-pole{width:100%;height:48px;margin:0 0 16px;padding:0 14px;border-radius:12px}.gift-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
			'.gift-btn-primary{flex:1 1 160px;min-height:48px;padding:10px 18px;border:0;border-radius:12px;background:$farba-plna;color:$na-farbe;font:650 15px/1.2 $p;cursor:pointer}.gift-btn-primary:disabled{opacity:.6;cursor:default}',
			'.gift-btn-secondary{min-height:44px;padding:10px 14px;border:1px solid transparent;border-radius:12px;background:transparent;color:$text-2;font:600 14.5px/1.2 $p;cursor:pointer}.gift-actions .gift-btn-secondary:first-child:not(.obrys){margin-left:-14px}.gift-btn-secondary.obrys{border-color:$ciara-pole;background:$povrch}',
			'.d-tip{margin:-8px 0 20px;font:500 13.5px/1.45 $p;color:$jemny}',
			'.d-kontext{align-self:flex-start;display:inline-flex;align-items:center;min-height:28px;margin:0 0 14px;padding:4px 12px;border-radius:999px;background:$povrch-2;color:$text-2;font:500 13px/1.3 $p}',
			'.d-zhrnutie{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:-8px 0 12px;font:500 13.5px/1.4 $p;color:$text-2}.d-zhrnutie span{min-width:0;overflow-wrap:anywhere}.d-zhrnutie .gift-btn-secondary{flex:none;padding:10px 8px;color:$farba-text}',
			'.gift-note{margin:0 0 12px;padding:10px 12px;border-radius:12px;background:$farba-jemna;color:$text-2;font:400 13.5px/1.5 $p}.gift-results{display:flex;flex-direction:column;gap:10px}.gift-results .product-item{width:100%}.gift-results+.gift-actions{padding-top:12px}',
			'.product-card.gift-card{display:grid;grid-template-columns:80px minmax(0,1fr);align-items:start;gap:14px;padding:10px}.gift-card .product-tacka{width:80px;height:80px;border-radius:10px}.gift-card .product-body{padding:2px 0 0}.gift-card .product-view{display:none}',
			'.gift-why{margin-top:6px;font:400 13.5px/1.45 $p;color:$text-2}',
			// Hover only with a real pointer (no sticky hover on touch).
			'@media (hover:hover) and (pointer:fine){#toggle:hover{transform:translateY(-1px)}.u-zavriet:hover span,.h-btn:hover span,.pas-sipka:hover span,.msg-uvod .suggestion:hover,.gift-btn-secondary:hover{background:$povrch-2}.u-zavriet:hover span{color:$text}' +
			'.suggestion:hover{background:$farba-jemna;border-color:$farba-ikona}.dlazdica:hover,.kategoria:hover,a.product-card:hover{border-color:$ciara-pole}a.product-card:hover .product-img{transform:scale(1.03)}' +
			'.gift-chip:hover{border-color:$farba-ikona}.por-pozriet:hover,.footer a:hover{text-decoration:underline}.footer a:hover{color:$text}}',
			'@keyframes a-pop{from{transform:scale(.82)}}',
			'@keyframes a-sprava{from{opacity:0;transform:translateY(8px) scale(.98)}}@keyframes a-odsek{from{opacity:0;transform:translateY(6px)}}@keyframes a-karta{from{opacity:0;transform:translateX(12px)}}@keyframes a-hore{from{opacity:0;transform:translateY(8px)}}',
			'@keyframes a-krok{from{opacity:0;transform:translateX(16px)}}@keyframes a-krok-spat{from{opacity:0;transform:translateX(-16px)}}@keyframes a-ukaz{to{opacity:1;visibility:visible}}@keyframes a-fade{from{opacity:0}}',
			'@keyframes a-bodka{0%,100%{transform:translateY(0);opacity:.35}30%{transform:translateY(-4px);opacity:1}60%{transform:translateY(0);opacity:.6}}@keyframes a-bodka-rm{0%,100%{opacity:.35}30%{opacity:1}60%{opacity:.6}}',
			// Phone (S2, U2, P3)
			M + '{' +
			'#toggle{right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px) + $odsadenie);width:56px;height:56px;max-width:none;padding:0;justify-content:center;border-radius:50%}:host(.position-left) #toggle{right:auto;left:16px}#toggle .iskra{width:24px;height:24px}' +
			'#toggle .spustac-text{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0)}' +
			'#teaser{right:80px;bottom:calc(16px + env(safe-area-inset-bottom,0px) + $odsadenie);width:min(280px,calc(100vw - 96px));height:56px}:host(.position-left) #teaser{right:auto;left:80px}' +
			'#teaser-open{height:100%;justify-content:center;gap:3px;padding:0 40px 0 14px}.u-otazka{display:block;max-width:100%;font-size:14.5px;white-space:nowrap;text-overflow:ellipsis}.u-riadok{display:none}.u-zavriet{top:5px}' +
			// v2.2: only a 12 px dimmed strip above the sheet.
			'#scrim{background:$clona-mobil}#panel,:host(.position-left) #panel{top:auto;left:0;right:0;bottom:0;width:auto;height:calc(100vh - 12px);height:var(--a-vv,calc(100dvh - 12px));border-radius:20px 20px 0 0;opacity:1;transform:translateY(100%);transition:transform .294s $odchod}' +
			'#panel[data-stav="otvoreny"],:host(.position-left) #panel[data-stav="otvoreny"]{transform:none;transition:transform .507s $vstup}' +
			'.uchytka{flex:none;height:20px;display:flex;align-items:center;justify-content:center;touch-action:none}.uchytka i{width:36px;height:5px;border-radius:3px;background:$ciara-pole}' +
			'.hlavicka{min-height:56px;touch-action:none;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(8px,env(safe-area-inset-right,0px))}.h-logo,.h-logo-tmave{height:26px;max-width:140px}' +
			'.messages{padding:12px max(16px,env(safe-area-inset-right,0px)) 20px max(16px,env(safe-area-inset-left,0px))}' +
			'.products{width:calc(100% + 32px);margin:0 -16px;padding:2px 16px 10px;scroll-padding-inline:16px}' +
			'.composer{padding:10px max(12px,env(safe-area-inset-right,0px)) calc(10px + env(safe-area-inset-bottom,0px)) max(12px,env(safe-area-inset-left,0px))}' +
			'.dlazdica{min-height:72px;padding:12px;font-size:14px}.gift-body{padding:20px 16px}.d-postup{padding:0 16px}}',
			// Inline (data-mount)
			':host(.inline){display:block;width:100%;height:100%}',
			':host(.inline) #toggle, :host(.inline) #close-btn { display:none; }',
			':host(.inline) #panel{position:relative;inset:auto;z-index:auto;width:100%;max-width:none;height:100%;border-radius:inherit;box-shadow:none;transform:none;opacity:1;transition:none}:host(.inline) .uchytka{display:none}',
			// Reduced motion (M3): opacity only, nothing moves
			'@media (prefers-reduced-motion: reduce){' +
			'#panel,#panel[data-stav="otvoreny"],:host(.position-left) #panel,#teaser,#teaser[data-stav],#toggle,#toggle[aria-expanded="true"]{transform:none;transition:opacity .15s linear}' +
			'#panel:not([data-stav="otvoreny"]){opacity:0}#panel[data-stav="otvoreny"]{opacity:1}#toggle .iskra,#toggle.dych .iskra,.bubble.thinking,#send-btn span{animation:none}' +
			'.msg-user,.msg-assistant .bubble,.bubble p,.sukromie,.product-item,.porovnanie,.gift-step,.vstup :is(.dlazdica,.kategoria,.suggestion){animation:a-fade .15s linear both;animation-delay:0s}.dots i{animation-name:a-bodka-rm}' +
			'.suggestion,.dlazdica,.kategoria,.product-card,.product-img,#send-btn span,.gift-chip,.gift-btn-primary,.d-postup i::after{transition-property:opacity,background-color,border-color,color}' +
			'.suggestion:active,.dlazdica:active,.kategoria:active,a.product-card:active,#send-btn:active span,.gift-chip:active,.gift-btn-primary:active,a.product-card:hover .product-img,#toggle:hover,#toggle:active{transform:none}}',
		].join('\n').replace(/\$p\b/g, 'var(--a-pismo)').replace(/\$([a-z0-9-]+)/g, 'var(--a-$1)');
	}

	// == Page context (U4): a product page by JSON-LD (also @graph) or og:type

	function najdiProdukt(d, hlbka) {
		if (!d || typeof d !== 'object' || hlbka > 5) return '';
		if (Array.isArray(d)) {
			for (var i = 0; i < d.length; i++) {
				var r = najdiProdukt(d[i], hlbka + 1);
				if (r) return r;
			}
			return '';
		}
		var typ = d['@type'];
		var jeProdukt = typ === 'Product' || (Array.isArray(typ) && typ.indexOf('Product') !== -1);
		if (jeProdukt && typeof d.name === 'string' && d.name.trim()) return d.name.trim().slice(0, 60);
		return najdiProdukt(d['@graph'], hlbka + 1);
	}

	function kontextStranky() {
		return skus(() => {
			var skripty = document.querySelectorAll('script[type="application/ld+json"]');
			for (var i = 0; i < skripty.length && i < 10; i++) {
				var txt = String(skripty[i].textContent || '');
				var nazov = txt.length <= 100000 ? skus(() => najdiProdukt(JSON.parse(txt), 0), '') : '';
				if (nazov) return { typ: 'produkt', nazov: nazov };
			}
			var meta = (p) => {
				var m = document.querySelector('meta[property="' + p + '"]');
				return m ? String(m.getAttribute('content') || '').trim() : '';
			};
			var og = meta('og:type').toLowerCase();
			var ogNazov = og === 'product' || og === 'og:product' ? meta('og:title') : '';
			return ogNazov ? { typ: 'produkt', nazov: ogNazov.slice(0, 60) } : { typ: 'ina' };
		}, { typ: 'ina' });
	}

	// == DOM helpers (they also work on the test suite's shallow fake DOM)

	function triedu(el, c, zapnut) {
		if (!el) return;
		var s = ' ' + (el.className || '') + ' ';
		var ma = s.indexOf(' ' + c + ' ') !== -1;
		if (zapnut && !ma) el.className = (s + c).trim();
		else if (!zapnut && ma) el.className = s.replace(' ' + c + ' ', ' ').trim();
	}

	function vyprazdni(el) {
		if (el.firstChild !== undefined) while (el.firstChild) el.removeChild(el.firstChild);
		else if (Array.isArray(el.children)) el.children.length = 0;
	}

	function styl(el, prop, hodnota) {
		if (el && el.style && typeof el.style.setProperty === 'function') {
			if (hodnota == null) el.style.removeProperty(prop);
			else el.style.setProperty(prop, hodnota);
		}
	}

	function mm(q) {
		return skus(() => !!(window.matchMedia && window.matchMedia(q).matches), false);
	}

	function jsonAtribut(el, meno) {
		return skus(() => {
			var v = JSON.parse(el.getAttribute(meno) || 'null');
			return Array.isArray(v) ? v : null;
		}, null);
	}

	function textAtribut(el, meno, max) {
		return String(el.getAttribute(meno) || '').trim().slice(0, max);
	}

	function prvok(tag, trieda, text) {
		var e = document.createElement(tag);
		if (trieda) e.className = trieda;
		if (text != null) e.textContent = text;
		return e;
	}

	// == Boot: one widget instance for this page

	function boot() {
		var scriptEl = document.currentScript || (() => {
			var s = document.getElementsByTagName('script');
			for (var i = s.length - 1; i >= 0; i--) if (/widget\.js(\?|$)/.test(s[i].src)) return s[i];
			return null;
		})();
		if (!scriptEl) return;
		var atr = (n) => scriptEl.getAttribute(n);

		var TENANT = atr('data-tenant');
		var LANG_ATTR = atr('data-lang');
		// No or "auto" data-lang: texts follow the browser, answers are detected per message.
		var LANG_IS_AUTO = !LANG_ATTR || String(LANG_ATTR).trim().toLowerCase() === 'auto';
		var API_LANG = LANG_IS_AUTO || String(atr('data-answer-lang') || '').trim().toLowerCase() === 'auto' ? 'auto' : normaliseLang(LANG_ATTR);
		var LANG = LANG_IS_AUTO ? resolveAutoLang() : normaliseLang(LANG_ATTR);
		var POSITION = atr('data-position') === 'left' ? 'left' : 'right';
		var ENDPOINT = (atr('data-endpoint') || scriptOrigin(scriptEl)).replace(/\/$/, '');
		var GIFT_ENABLED = atr('data-gift') === '1';
		var MOUNT_ID = atr('data-mount');
		var mountEl = MOUNT_ID && typeof document.getElementById === 'function' ? document.getElementById(MOUNT_ID) : null;
		var INLINE = !!mountEl;
		var STARTERS = (jsonAtribut(scriptEl, 'data-questions') || []).map((q) => {
			return String(q == null ? '' : q).trim().slice(0, 300);
		}).filter(Boolean).slice(0, 6);
		var askedStarters = {};

		if (!TENANT) {
			console.error('[arling-asistent] widget.js: missing required data-tenant attribute, widget not started.');
			return;
		}

		var SESSION_ID = getSessionId();
		// The WordPress admin preview counts as setup, not usage.
		var SURFACE = skus(() => {
			var loc = window.location || {};
			var path = loc.pathname || (loc.href ? new URL(loc.href).pathname : '');
			return String(path || '').indexOf('/wp-admin/') !== -1 ? 'admin' : '';
		}, '');

		function withSurface(body) {
			if (SURFACE) body.surface = SURFACE;
			return body;
		}

		var t = Object.assign({}, STRINGS[LANG]);
		var titleAttr = String(atr('data-title') || '').trim();
		var greetingAttr = String(atr('data-greeting') || '').trim();
		if (titleAttr) t.title = titleAttr;
		if (greetingAttr) t.greeting = greetingAttr;

		var OBCHOD = textAtribut(scriptEl, 'data-obchod', 40);
		var MENO = textAtribut(scriptEl, 'data-meno', 24) || t.aiPoradca;
		var PANEL_TITLE = titleAttr ? t.title : OBCHOD ? OBCHOD + ': ' + t.aiPoradca : t.title;
		var REZIM = (() => {
			var r = String(atr('data-rezim') || '').trim().toLowerCase();
			var c = String(atr('data-color') || '').trim().toLowerCase();
			if (r === 'svetly' || r === 'tmavy' || r === 'auto') return r;
			return !r && c === 'dark' ? 'tmavy' : !r && c === 'auto' ? 'auto' : 'svetly';
		})();
		var FARBA = (() => {
			var f = String(atr('data-farba') || 'auto').trim();
			if (f.toLowerCase() !== 'auto') return normalizujHex(f) || FARBA_ZALOHA;
			return skus(() => {
				var metas = document.querySelectorAll('meta[name="theme-color"]');
				var m = Array.prototype.filter.call(metas, (x) => !x.getAttribute('media'))[0] || metas[0];
				var v = m ? String(m.getAttribute('content') || '').trim() : '';
				return farbaPouzitelna(v) ? normalizujHex(v) : FARBA_ZALOHA;
			}, FARBA_ZALOHA);
		})();
		var cislo = (n, max, zaloha) => {
			var v = String(atr(n) || '').trim();
			return /^\d{1,5}$/.test(v) && +v <= max ? +v : zaloha;
		};
		var ODSADENIE = cislo('data-odsadenie', 200, 0);
		var ONESKORENIE = cislo('data-upoutavka-oneskorenie', 60000, 5000);
		var UPOUTAVKA_ZAPNUTA = !INLINE && atr('data-upoutavka') !== '0';
		var UPOUTAVKA_TEXT = textAtribut(scriptEl, 'data-upoutavka-text', 80);

		// == DOM / Shadow root

		var host = document.createElement('div');
		host.setAttribute('data-arling-asistent', '');
		host.className = ((POSITION === 'left' ? 'position-left ' : '') + (INLINE ? 'inline' : '')).trim();
		(INLINE ? mountEl : document.body).appendChild(host);

		var root = host.attachShadow({ mode: 'open' });
		root.innerHTML = buildMarkup(t, {
			gift: GIFT_ENABLED,
			inline: INLINE,
			meno: MENO,
			obchod: OBCHOD,
			logo: safeUrl(atr('data-logo')),
			logoTmave: safeUrl(atr('data-logo-tmave')),
			panelTitle: PANEL_TITLE,
			menoHlavicky: OBCHOD || t.title,
			toggleLabel: t.openLabel + (MENO !== t.aiPoradca ? ': ' + MENO : ''),
		});
		// A constructed sheet is outside the shop's style-src CSP.
		var konstruovany = skus(() => {
			if (typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in root)) return false;
			var sheet = new CSSStyleSheet();
			sheet.replaceSync(buildCss());
			root.adoptedStyleSheets = [sheet];
			return true;
		}, false);
		if (!konstruovany) root.appendChild(prvok('style', null, buildCss()));

		var els = {};
		['toggle', 'panel', 'close-btn', 'reset-btn', 'messages', 'form', 'input', 'send-btn', 'live', 'scrim', 'teaser', 'teaser-open', 'teaser-close', 'teaser-otazka', 'teaser-riadok', 'hlavicka', 'uchytka'].forEach((id) => {
			els[id.replace(/-(\w)/g, (m, c) => c.toUpperCase())] = root.getElementById(id);
		});
		els.panel.setAttribute('lang', LANG);
		skus(() => { root.querySelector('.footer a').setAttribute('aria-label', t.poweredBy + ' ' + t.newWindow); });

		// T3, T4, T9, S3
		function pouziFarby() {
			var tmavy = REZIM === 'tmavy' || (REZIM === 'auto' && mm('(prefers-color-scheme: dark)'));
			triedu(host, 'rezim-tmavy', tmavy);
			var o = odtiene(FARBA, tmavy);
			var mapa = { 'farba-plna': o.plna, 'na-farbe': o.naFarbe, 'farba-jemna': o.jemna, 'farba-text': o.text, 'farba-ikona': o.ikona };
			Object.keys(mapa).forEach((k) => { styl(host, '--a-' + k, mapa[k]); });
		}
		pouziFarby();
		if (REZIM === 'auto') skus(() => { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', pouziFarby); });
		var pismo = atr('data-pismo') === 'system' ? '' : skus(() => window.getComputedStyle(document.body).fontFamily, '');
		var prve = String(pismo || '').split(',')[0].trim().replace(/["']/g, '').toLowerCase();
		styl(host, '--a-pismo', pismo && ['serif', 'times', 'times new roman'].indexOf(prve) === -1 ? pismo : PISMO_SYSTEM);
		if (ODSADENIE) styl(host, '--a-odsadenie', ODSADENIE + 'px');

		var conversation = []; // {role: 'user'|'assistant', content: string}
		var isOpen = false;
		var bolOtvoreny = false;
		var isSending = false;
		var isGiftOpen = false;
		var giftEls = {};
		var greeted = false;
		var uvodVstupil = false;
		var uvodRow = null;
		var uvodDlazdice = null;
		var uvodOtazky = null;
		var zobrazeneProdukty = [];
		var suggestionButtons = [];
		var focusAfterSend = !INLINE;

		var jeMobil = () => mm('(max-width: 599.98px)');
		var redukovany = () => mm('(prefers-reduced-motion: reduce)');
		var animujeme = () => typeof setTimeout === 'function' && typeof window.getComputedStyle === 'function';
		var ramec = (f) => { window.requestAnimationFrame(f); };

		// == Open / close (M1, M2: transitions on data-stav, interruptible)

		var cakanieNaSkrytie = null;
		var ulozenyScroll = null;

		function zamkniScroll(zamknut) {
			var html = document.documentElement;
			if (INLINE || !html || !html.style) return;
			if (zamknut && !ulozenyScroll) {
				ulozenyScroll = { o: html.style.overflow, p: html.style.paddingRight };
				var sirka = Math.max(0, (window.innerWidth || 0) - (html.clientWidth || 0));
				html.style.overflow = 'hidden';
				if (sirka) html.style.paddingRight = sirka + 'px';
			} else if (!zamknut && ulozenyScroll) {
				html.style.overflow = ulozenyScroll.o;
				html.style.paddingRight = ulozenyScroll.p;
				ulozenyScroll = null;
			}
		}

		function poPrechode(el, hotovo) {
			var raz = false;
			function koniec(e) {
				if ((e && e.target !== el) || raz) return;
				raz = true;
				el.removeEventListener('transitionend', koniec);
				hotovo();
			}
			el.addEventListener('transitionend', koniec);
			return setTimeout(koniec, 400);
		}

		function ukaz(el) {
			el.hidden = false;
			if (animujeme()) el.getBoundingClientRect();
			el.setAttribute('data-stav', 'otvoreny');
		}

		function openPanel(opts) {
			if (!isOpen) {
				isOpen = true;
				bolOtvoreny = true;
				if (cakanieNaSkrytie != null) clearTimeout(cakanieNaSkrytie);
				cakanieNaSkrytie = null;
				if (!INLINE) {
					skryUpoutavku('otvorene');
					ukaz(els.scrim);
					triedu(els.panel, 'pohyb', true);
					zamkniScroll(true);
					document.addEventListener('keydown', onKeydown, true);
					sledujViewport(true);
					ukaz(els.panel);
				} else {
					els.panel.hidden = false;
				}
				els.toggle.setAttribute('aria-expanded', 'true');
				if (opts && opts.zdroj) trackUmami('asistent_open', { zdroj: opts.zdroj });
			}
			if (!greeted) {
				greeted = true;
				appendUvod();
			} else if (!uvodVstupil && uvodRow) {
				// Built while idle (pripravUvod): the entrance runs now, on the first open.
				els.live.textContent = t.title + ': ' + t.greeting;
				vykresliDlazdice();
				if (!redukovany()) triedu(uvodRow, 'vstup', true);
			} else {
				triedu(uvodRow, 'vstup', false);
				vykresliDlazdice();
			}
			uvodVstupil = true;
			hranyNeskor();
			if (!(opts && opts.focus === false)) {
				ramec(() => {
					// A2: on a phone the panel gets focus, no keyboard.
					if (!INLINE && mm('(pointer: coarse)') && !mm('(pointer: fine)')) els.panel.focus();
					else els.input.focus();
				});
			}
		}

		function closePanel() {
			// Inline the conversation is part of the page and never closes.
			if (INLINE || !isOpen) return;
			isOpen = false;
			if (isGiftOpen) closeGiftPanel(false);
			els.toggle.setAttribute('aria-expanded', 'false');
			document.removeEventListener('keydown', onKeydown, true);
			sledujViewport(false);
			zamkniScroll(false);
			els.panel.setAttribute('data-stav', 'zatvara');
			els.scrim.setAttribute('data-stav', 'zatvara');
			els.toggle.focus();
			var skry = () => {
				if (isOpen) return;
				els.panel.hidden = true;
				els.scrim.hidden = true;
				triedu(els.panel, 'pohyb', false);
				cakanieNaSkrytie = null;
			};
			if (!animujeme()) return skry();
			triedu(els.panel, 'pohyb', true);
			cakanieNaSkrytie = poPrechode(els.panel, skry);
		}

		if (animujeme()) {
			els.panel.addEventListener('transitionend', (e) => {
				if (e.target === els.panel && isOpen) triedu(els.panel, 'pohyb', false);
			});
		}

		// A3, A4: Tab stays inside, Esc closes.
		function fokusovatelne() {
			if (typeof els.panel.querySelectorAll !== 'function') return [];
			return Array.prototype.filter.call(els.panel.querySelectorAll('button, a[href], textarea, input, [tabindex]:not([tabindex="-1"])'), (el) => {
				return !el.disabled && !el.hidden && !(typeof el.getClientRects === 'function' && !el.getClientRects().length);
			});
		}

		function onKeydown(evt) {
			if (!isOpen) return;
			if (evt.key === 'Escape') {
				evt.stopPropagation();
				return closePanel();
			}
			if (evt.key !== 'Tab') return;
			var zoznam = fokusovatelne();
			var n = zoznam.length;
			if (!n) return;
			var a = root.activeElement;
			var i = zoznam.indexOf(a);
			var ciel = evt.shiftKey && i === 0 ? zoznam[n - 1] : !evt.shiftKey && i === n - 1 ? zoznam[0] : null;
			if (i === -1) {
				// Focus on a scroll box (Firefox): go on by DOM position.
				var poloha = (el) => skus(() => a.compareDocumentPosition(el), 0);
				var za = a ? zoznam.filter((el) => poloha(el) & 4) : [];
				var pred = a ? zoznam.filter((el) => poloha(el) & 2) : [];
				ciel = evt.shiftKey ? pred[pred.length - 1] || zoznam[n - 1] : za[0] || zoznam[0];
			}
			if (ciel) {
				if (evt.preventDefault) evt.preventDefault();
				ciel.focus();
			}
		}

		els.toggle.addEventListener('click', () => {
			if (isOpen) closePanel();
			else openPanel({ zdroj: 'spustac' });
		});
		els.closeBtn.addEventListener('click', closePanel);
		if (els.scrim) els.scrim.addEventListener('click', closePanel);

		// M4: one read per frame on scroll.
		function priPosune(el, f) {
			var caka = false;
			el.addEventListener('scroll', () => {
				if (caka) return;
				caka = true;
				ramec(() => {
					caka = false;
					f();
				});
			}, { passive: true });
		}
		// v2.2: fade above the composer while more content waits below.
		var telo = skus(() => root.querySelector('.telo'), null);
		function hranyObsahu() {
			var m = els.messages;
			triedu(els.hlavicka, 'posunute', m.scrollTop > 0);
			triedu(telo, 'pod-obsahom', !isGiftOpen && m.scrollTop + m.clientHeight < m.scrollHeight - 2);
		}
		var hranyNeskor = () => { ramec(hranyObsahu); };
		priPosune(els.messages, hranyObsahu);

		// P5: the panel follows the visual viewport (phone keyboard).
		function prisposobViewport() {
			var vv = window.visualViewport;
			if (vv && jeMobil()) styl(host, '--a-vv', Math.round(Math.min((window.innerHeight || vv.height) - 12, vv.height - 8)) + 'px');
		}

		function sledujViewport(zapnut) {
			var vv = window.visualViewport;
			if (!vv || typeof vv.addEventListener !== 'function') return;
			['resize', 'scroll'].forEach((u) => { vv[zapnut ? 'addEventListener' : 'removeEventListener'](u, prisposobViewport); });
			if (zapnut) prisposobViewport();
		}

		// P4: drag down to close (touch only).
		var tah = null;

		function zacniTah(e) {
			if (INLINE || !isOpen || !jeMobil() || e.pointerType === 'mouse') return;
			if (e.target && e.target.closest && e.target.closest('button, a, input, textarea')) return;
			tah = { y0: e.clientY, posun: 0, vyska: els.panel.getBoundingClientRect().height || 600, body: [{ t: e.timeStamp, y: e.clientY }] };
			styl(els.panel, 'transition', 'none');
			styl(els.panel, 'will-change', 'transform');
			skus(() => { e.currentTarget.setPointerCapture(e.pointerId); });
		}

		function tahaj(e) {
			if (!tah) return;
			var dy = e.clientY - tah.y0;
			tah.posun = dy > 0 ? dy : Math.max(-24, dy * 0.2);
			tah.body.push({ t: e.timeStamp, y: e.clientY });
			while (tah.body.length > 2 && e.timeStamp - tah.body[0].t > 80) tah.body.shift();
			styl(els.panel, 'transform', 'translateY(' + tah.posun + 'px)');
		}

		function pustTah() {
			if (!tah) return;
			var a = tah.body[0];
			var b = tah.body[tah.body.length - 1];
			var rychlost = b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
			var zavriet = tah.posun > tah.vyska * 0.25 || rychlost > 0.6;
			tah = null;
			styl(els.panel, 'will-change', null);
			if (zavriet || redukovany()) {
				styl(els.panel, 'transition', null);
				els.panel.getBoundingClientRect();
				styl(els.panel, 'transform', null);
				if (zavriet) closePanel();
				return;
			}
			styl(els.panel, 'transition', 'transform .459s var(--a-pust)');
			styl(els.panel, 'transform', null);
			setTimeout(() => { if (!tah) styl(els.panel, 'transition', null); }, 480);
		}

		if (!INLINE && typeof window.PointerEvent === 'function') {
			[els.uchytka, els.hlavicka].forEach((z) => {
				z.addEventListener('pointerdown', zacniTah);
				z.addEventListener('pointermove', tahaj);
				z.addEventListener('pointerup', pustTah);
				z.addEventListener('pointercancel', pustTah);
			});
		}

		// == Teaser (U1 to U5): once per tab, dismissable, no numbers, no urgency

		var upoutavkaVPamati = false;
		var upoutavkaCasovac = null;
		var upoutavkaY = 0;

		function upoutavkaUzBola() {
			return upoutavkaVPamati || !!citaj(UPOUTAVKA_KEY);
		}

		function fokusVPoli() {
			var a = document.activeElement;
			if (!a || a === host) return false;
			var tag = String(a.tagName || '').toLowerCase();
			return tag === 'input' || tag === 'textarea' || a.isContentEditable === true;
		}

		function priPosuneStranky() {
			if (jeMobil() && Math.abs((window.scrollY || 0) - upoutavkaY) > 24) skryUpoutavku();
		}

		// v2.2: narrower card on a product page.
		function textUpoutavky(k) {
			els.teaserOtazka.textContent = k.typ === 'produkt' ? t.teaserProdukt : UPOUTAVKA_TEXT || t.teaserIna;
			els.teaserRiadok.textContent = k.typ === 'produkt' ? k.nazov : t.teaserInaRiadok;
			triedu(els.teaser, 'produkt', k.typ === 'produkt');
		}

		function ukazUpoutavku() {
			if (!els.teaser || bolOtvoreny) return;
			var k = kontextStranky();
			// Phone product page: it would cover the price.
			if (k.typ === 'produkt' && jeMobil()) return;
			upoutavkaVPamati = true;
			zapis(UPOUTAVKA_KEY, 'ukazana');
			textUpoutavky(k);
			ukaz(els.teaser);
			trackUmami('asistent_upoutavka', { kontext: k.typ });
			triedu(els.toggle, 'dych', true);
			upoutavkaY = window.scrollY || 0;
			if (window.addEventListener) window.addEventListener('scroll', priPosuneStranky, { passive: true });
			upoutavkaCasovac = setTimeout(() => { skryUpoutavku(); }, jeMobil() ? 8000 : 12000);
		}

		function skryUpoutavku(stav) {
			if (stav) {
				upoutavkaVPamati = true;
				zapis(UPOUTAVKA_KEY, stav);
			}
			if (!els.teaser || els.teaser.hidden !== false) return;
			if (upoutavkaCasovac != null) clearTimeout(upoutavkaCasovac);
			upoutavkaCasovac = null;
			if (window.removeEventListener) window.removeEventListener('scroll', priPosuneStranky);
			var malFokus = root.activeElement === els.teaserOpen || root.activeElement === els.teaserClose;
			els.teaser.setAttribute('data-stav', 'zatvara');
			if (animujeme()) poPrechode(els.teaser, () => { els.teaser.hidden = true; });
			else els.teaser.hidden = true;
			if (malFokus && !isOpen) els.toggle.focus();
		}

		if (els.teaser) {
			els.teaserOpen.addEventListener('click', () => { openPanel({ zdroj: 'upoutavka' }); });
			els.teaserClose.addEventListener('click', () => { skryUpoutavku('zatvorena'); });
			els.teaser.addEventListener('keydown', (e) => {
				if (e.key !== 'Escape') return;
				e.stopPropagation();
				skryUpoutavku('zatvorena');
			});
		}

		// U3: counts only while visible, never over a focused field.
		function naplanujUpoutavku() {
			if (!UPOUTAVKA_ZAPNUTA || !els.teaser || typeof setTimeout !== 'function' || upoutavkaUzBola()) return;
			var ubehlo = 0;
			(function tik() {
				setTimeout(() => {
					if (upoutavkaUzBola() || bolOtvoreny) return;
					var viditelna = !document.visibilityState || document.visibilityState === 'visible';
					if (viditelna) ubehlo += 250;
					if (viditelna && ubehlo >= ONESKORENIE && !fokusVPoli()) ukazUpoutavku();
					else tik();
				}, 250);
			})();
		}

		// == Gift Finder (data-gift="1" only): a view inside the panel

		var GIFT_KROKY = ['recipient', 'budget', 'interests', 'results'];
		var giftAktualny = 'recipient';
		var isGiftSending = false;
		var giftRecipientValue = '';
		var giftBudgetMin = null;
		var giftBudgetMax = null;
		var giftBudgetLabel = '';
		var giftRemainingCandidates = [];
		var giftCipy = [];

		function buildGiftChips(container, labels, onPick) {
			var tlacidla = labels.map((label) => {
				var btn = prvok('button', 'gift-chip');
				btn.type = 'button';
				btn.setAttribute('aria-pressed', 'false');
				var fajka = prvok('span');
				fajka.innerHTML = ikona('fajka', 'fajka');
				btn.appendChild(fajka);
				btn.appendChild(prvok('span', null, label));
				btn.addEventListener('click', () => {
					tlacidla.forEach((b) => { b.setAttribute('aria-pressed', String(b === btn)); });
					onPick(label);
				});
				container.appendChild(btn);
				return btn;
			});
			giftCipy = giftCipy.concat(tlacidla);
		}

		function firstGiftFocusTarget(name) {
			if (name === 'recipient') return giftEls.recipientInput;
			if (name === 'budget') return (giftEls.budgetChips.children && giftEls.budgetChips.children[0]) || giftEls.budgetBack;
			if (name === 'interests') return giftEls.interestsInput;
			return giftEls.askElse;
		}

		function showGiftStep(name) {
			triedu(giftEls.body, 'spat', GIFT_KROKY.indexOf(name) < GIFT_KROKY.indexOf(giftAktualny));
			giftAktualny = name;
			GIFT_KROKY.forEach((key) => { root.getElementById('gift-step-' + key).hidden = key !== name; });
			var n = GIFT_KROKY.indexOf(name) + 1;
			giftEls.postup.setAttribute('data-krok', String(n));
			giftEls.krok.textContent = n <= 3 ? vlozit(t.giftStep, { n: n }) : '';
			// v2.2: the choice so far above the question.
			var vybrate = name === 'budget' ? giftRecipientValue : name === 'interests' ? [giftRecipientValue, giftBudgetLabel].filter(Boolean).join(' · ') : '';
			if (giftEls.kontext) {
				giftEls.kontext.textContent = vybrate ? vlozit(t.giftFor, { n: vybrate }) : '';
				giftEls.kontext.hidden = !vybrate;
			}
			giftEls.body.scrollTop = 0;
			ramec(() => {
				var f = firstGiftFocusTarget(name);
				if (f && typeof f.focus === 'function') f.focus({ preventScroll: name === 'results' });
			});
		}

		function vycistiVysledky() {
			giftEls.resultsList.innerHTML = '';
			vyprazdni(giftEls.resultsList);
			giftEls.showMore.hidden = true;
		}

		function openGiftPanel() {
			if (!isOpen) openPanel({ focus: false, zdroj: 'spustac' });
			isGiftOpen = true;
			giftRecipientValue = '';
			giftBudgetMin = null;
			giftBudgetMax = null;
			giftBudgetLabel = '';
			if (giftEls.zhrnutie) giftEls.zhrnutie.hidden = true;
			giftRemainingCandidates = [];
			giftAktualny = 'recipient';
			giftEls.recipientInput.value = '';
			giftEls.interestsInput.value = '';
			giftEls.note.hidden = true;
			vycistiVysledky();
			giftCipy.forEach((b) => { b.setAttribute('aria-pressed', 'false'); });
			giftEls.panel.hidden = false;
			els.messages.hidden = true;
			giftEls.toggle.setAttribute('aria-expanded', 'true');
			hranyNeskor();
			showGiftStep('recipient');
			trackUmami('gift_open', {});
		}

		function closeGiftPanel(vratitFokus) {
			isGiftOpen = false;
			giftEls.panel.hidden = true;
			els.messages.hidden = false;
			giftEls.toggle.setAttribute('aria-expanded', 'false');
			hranyNeskor();
			if (vratitFokus !== false) giftEls.toggle.focus();
		}

		function showGiftNote(text) {
			giftEls.note.hidden = false;
			giftEls.note.textContent = text;
		}

		function appendGiftCard(item, withWhy) {
			giftEls.resultsList.appendChild(productCard(item, 'gift-card', withWhy && item.why ? item.why : '', () => {
				trackUmami('gift_product_click', {});
			}));
		}

		function renderGiftResults(data) {
			var picks = Array.isArray(data.picks) ? data.picks : [];
			var shownUrls = {};
			vycistiVysledky();
			picks.forEach((p) => {
				shownUrls[p.url] = true;
				appendGiftCard(p, true);
			});
			giftRemainingCandidates = (Array.isArray(data.candidates) ? data.candidates : []).filter((c) => !shownUrls[c.url]);
			giftEls.showMore.hidden = giftRemainingCandidates.length === 0;
			var note = !picks.length ? t.giftEmptyNote : data.widened ? t.giftWidenedNote : data.few ? t.giftFewNote : '';
			if (note) showGiftNote(note);
			else giftEls.note.hidden = true;
			giftEls.live.textContent = t.giftTitle + ': ' + picks.length;
		}

		function doGiftSubmit() {
			if (isGiftSending) return;
			isGiftSending = true;
			giftEls.submitBtn.disabled = true;
			showGiftStep('results');
			vycistiVysledky();
			// What the results are for, with a way back (overenie 1: results had no summary).
			var vyber = [giftRecipientValue, giftBudgetLabel, giftEls.interestsInput.value.trim()].filter(Boolean).join(' · ');
			if (giftEls.zhrnutie) {
				giftEls.vyber.textContent = vyber;
				giftEls.zhrnutie.hidden = !vyber;
			}
			showGiftNote(t.giftThinking);
			trackUmami('gift_submit', {});
			var chyba = (text) => {
				vycistiVysledky();
				showGiftNote(text);
			};
			fetch(ENDPOINT + '/v1/gift', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(withSurface({
					tenant: TENANT,
					// Darček: čipy aj celý formulár sú v jazyku rozhrania, dôvody majú byť v ňom (pri "auto" model z „Mama“ hádal angličtinu).
					lang: LANG,
					recipient: giftRecipientValue,
					budget_min: giftBudgetMin,
					budget_max: giftBudgetMax,
					interests: giftEls.interestsInput.value.trim(),
					session: SESSION_ID,
					relacia: readRelacia() || undefined,
				})),
			}).then((res) => {
				// 503 = Workers AI capacity: the calm quota words.
				if (res.status === 429 || res.status === 503) {
					return res.json().catch(() => { return {}; }).then((body) => {
						chyba(body && body.error === 'quota_exceeded' ? t.quotaExceeded : t.rateLimited);
					});
				}
				if (!res.ok) return chyba(t.networkError);
				return res.json().then((data) => {
					if (data && data.relacia) saveRelacia(data.relacia);
					renderGiftResults(data || {});
				});
			}).catch(() => {
				chyba(t.networkError);
			}).then(() => {
				isGiftSending = false;
				giftEls.submitBtn.disabled = false;
			});
		}

		if (GIFT_ENABLED) {
			['toggle', 'panel', 'close-btn', 'live', 'krok', 'postup', 'body', 'recipient-chips', 'recipient-input', 'recipient-next', 'budget-chips', 'budget-back', 'interests-input', 'interests-chips', 'interests-back', 'submit-btn', 'note', 'results-list', 'show-more', 'ask-else', 'zhrnutie', 'vyber', 'zmenit', 'kontext'].forEach((id) => {
				giftEls[id.replace(/-(\w)/g, (m, c) => c.toUpperCase())] = root.getElementById('gift-' + id);
			});
			buildGiftChips(giftEls.recipientChips, t.giftRecipients, (label) => {
				giftRecipientValue = label;
				giftEls.recipientInput.value = label;
				showGiftStep('budget');
			});
			buildGiftChips(giftEls.budgetChips, t.giftBudgetLabels, (label) => {
				var range = GIFT_BUDGET_RANGES[t.giftBudgetLabels.indexOf(label)];
				giftBudgetLabel = label;
				giftBudgetMin = range.min;
				giftBudgetMax = range.max;
				showGiftStep('interests');
			});
			giftEls.toggle.addEventListener('click', () => {
				if (isGiftOpen) closeGiftPanel();
				else openGiftPanel();
			});
			// v2.2: the arrow goes one step back, from step 1 to the chat.
			giftEls.closeBtn.addEventListener('click', () => {
				var i = GIFT_KROKY.indexOf(giftAktualny);
				if (i > 0) showGiftStep(GIFT_KROKY[i - 1]);
				else closeGiftPanel();
			});
			giftEls.recipientNext.addEventListener('click', () => {
				var val = giftEls.recipientInput.value.trim();
				if (val) giftRecipientValue = val;
				showGiftStep('budget');
			});
			giftEls.budgetBack.addEventListener('click', () => { showGiftStep('recipient'); });
			if (giftEls.zmenit) giftEls.zmenit.addEventListener('click', () => { showGiftStep('recipient'); });
			giftEls.interestsBack.addEventListener('click', () => { showGiftStep('budget'); });
			giftEls.showMore.addEventListener('click', () => {
				giftRemainingCandidates.forEach((c) => { appendGiftCard(c, false); });
				giftEls.showMore.hidden = true;
			});
			giftEls.askElse.addEventListener('click', () => {
				closeGiftPanel(false);
				openPanel();
			});
			giftEls.submitBtn.addEventListener('click', doGiftSubmit);
		}

		// == Messages and product cards (K1 to K10)

		function disableAskedSuggestions(text) {
			suggestionButtons.forEach((b) => {
				if (b._arlingQuestion === text) {
					// A hidden button would drop focus to the page body, outside the dialog.
					if (root.activeElement === b) skus(() => { els.messages.focus({ preventScroll: true }); });
					b.disabled = true;
					b.hidden = true;
				}
			});
			stitokOtazok();
		}

		function stitokOtazok() {
			if (uvodOtazky) uvodOtazky.stitok.hidden = !uvodOtazky.tlacidla.some((b) => !b.hidden);
		}

		function remainingStarters() {
			return STARTERS.filter((q) => !askedStarters[q]);
		}

		function cenaText(p) {
			if (!p || p.price == null || p.price === '') return '';
			var n = Number(p.price);
			var mena = String(p.currency || '').trim().toUpperCase();
			var intl = Number.isFinite(n) && /^[A-Z]{3}$/.test(mena) && skus(() => {
				return new Intl.NumberFormat(LOCALES[LANG], { style: 'currency', currency: mena }).format(n);
			}, '');
			return intl || formatPrice(p).trim();
		}

		/** Availability only when the API sends it (W-1); never invented. */
		function dostupnost(p) {
			var a = String((p && p.availability) || '').trim();
			var m = /^available_in_(\d{1,3})_days$/.exec(a);
			var d = /^available_from_(\d{4})-(\d{2})-(\d{2})$/.exec(a);
			if (a === 'in_stock') return { text: t.inStock, trieda: 'dost-ok' };
			if (a === 'out_of_stock') return { text: t.soldOut, trieda: 'dost-nie' };
			if (m) return { text: +m[1] === 1 ? t.inDay1 : vlozit(t.inDays, { n: +m[1] }), trieda: 'dost-caka' };
			if (!d) return null;
			var datum = LANG === 'en' ? +d[3] + '/' + +d[2] + '/' + d[1] : [+d[3], +d[2], d[1]].join(LANG === 'de' ? '.' : '. ');
			return { text: vlozit(t.fromDate, { datum: datum }), trieda: 'dost-caka' };
		}

		/** A quiet stand-in: a bag outline on grey; the letter stays in the text only (finding 3, overenie 2). */
		function nahradnyObrazok(trieda, nazov) {
			var ph = prvok('span', trieda, String(nazov || '').trim().charAt(0).toUpperCase() || '•');
			var ik = prvok('span');
			ik.innerHTML = ikona('taska');
			ph.appendChild(ik);
			return ph;
		}

		/** T8 tray with the photo, or the stand-in. */
		function productThumb(p) {
			var tacka = prvok('span', 'product-tacka');
			tacka.setAttribute('aria-hidden', 'true');
			var placeholder = () => nahradnyObrazok('product-ph', p && p.title);
			var imageUrl = safeUrl(p && p.image);
			if (!imageUrl) {
				tacka.appendChild(placeholder());
				return tacka;
			}
			var img = obrazok(imageUrl, 'product-img', 172, placeholder);
			img.addEventListener('load', () => { triedu(tacka, 'nacitane', true); });
			tacka.appendChild(img);
			return tacka;
		}

		// alt="" on purpose: the name is right next to it in the same control (K7, WCAG H2).
		function obrazok(src, trieda, rozmer, nahrada) {
			var img = prvok('img', trieda);
			img.alt = '';
			img.loading = 'lazy';
			img.decoding = 'async';
			img.setAttribute('width', rozmer);
			img.setAttribute('height', rozmer);
			img.addEventListener('error', () => {
				var parent = img.parentNode;
				if (parent && typeof parent.replaceChild === 'function') parent.replaceChild(nahrada(), img);
			});
			img.src = src;
			return img;
		}

		/** K6: a list item with one link; without a URL no link (never href="#"). */
		function productCard(p, extraClass, why, onClick) {
			p = p || {};
			var productUrl = safeUrl(p.url);
			var nazov = String(p.title || '');
			var obal = prvok('div', 'product-item');
			obal.setAttribute('role', 'listitem');
			var card = prvok(productUrl ? 'a' : 'div', 'product-card' + (extraClass ? ' ' + extraClass : ''));
			card.appendChild(productThumb(p));
			var body = prvok('span', 'product-body');
			body.appendChild(prvok('span', 'product-title', nazov));
			var cena = cenaText(p);
			if (cena) body.appendChild(prvok('span', 'product-price', cena));
			var dost = dostupnost(p);
			if (dost) body.appendChild(prvok('span', 'product-dost ' + dost.trieda, dost.text));
			// v2.2: the reason as plain text, no sparkle bullet.
			if (why) body.appendChild(prvok('span', 'gift-why', why));
			if (productUrl) {
				var pozriet = prvok('span', 'product-view', t.view);
				var sip = prvok('span');
				sip.innerHTML = ikona('dalej');
				pozriet.appendChild(sip);
				body.appendChild(pozriet);
				card.href = productUrl;
				card.target = '_blank';
				card.rel = 'noopener';
				card.setAttribute('title', nazov);
				card.setAttribute('aria-label', [nazov, cena, dost && dost.text, why, t.view].filter(Boolean).join(', ') + ' ' + t.newWindow);
			}
			card.appendChild(body);
			if (onClick) card.addEventListener('click', onClick);
			obal.appendChild(card);
			return obal;
		}

		// M1 stagger, none with reduced motion.
		function oneskor(el, i, krok, zaciatok) {
			if (!redukovany()) styl(el, 'animation-delay', (zaciatok || 0) + Math.min(i, 5) * krok + 'ms');
		}

		/** Shows the start of the question, not only the last card. */
		// v2.2: offsetTop ignores the entrance transform (was 3 to 5 px under the header).
		function revealRow(row) {
			var box = els.messages;
			var top = typeof row.offsetTop === 'number' ? row.offsetTop
				: typeof row.getBoundingClientRect === 'function' && typeof box.getBoundingClientRect === 'function'
					? row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
					: NaN;
			var alignTop = Number.isFinite(top) && box.scrollHeight - top > Number(box.clientHeight) - 24;
			var target = alignTop ? Math.max(0, top - (jeMobil() ? 12 : 16)) : box.scrollHeight;
			if (typeof box.scrollTo === 'function') box.scrollTo({ top: target, behavior: redukovany() ? 'auto' : 'smooth' });
			else box.scrollTop = target;
		}

		/** Short name: up to the first comma, at most ~30 characters on a word boundary, no dangling "1 l z". */
		// v2.2: the variant stays when a shown twin shares the base name.
		function kratkeMeno(x, vsetky) {
			var casti = x.split(/,\s+/);
			var zaklad = casti[0].trim();
			var s = zaklad;
			if (s.length > 32) {
				var slova = s.slice(0, 31).split(/\s+/).slice(0, -1);
				while (slova.length > 1 && /^(\S{1,2}|\d+\S*)$/.test(slova[slova.length - 1])) slova.pop();
				s = slova.join(' ') || s.slice(0, 32);
			}
			var varianta = String(casti[1] || '').trim();
			var dvojnik = varianta && varianta.length <= 16 && (vsetky || []).some((y) => y !== x && y.split(',')[0].trim() === zaklad);
			return dvojnik ? s + ', ' + varianta : s;
		}

		// Short names, unless two variants would then read the same.
		function posliPorovnanie(a, b) {
			var n = [a, b].map((p) => String(p.title || '').trim());
			var vsetky = zobrazeneProdukty.concat([a, b]).map((p) => String((p && p.title) || '').trim());
			var k = n.map((x) => kratkeMeno(x, vsetky));
			if (isSending) return;
			if (k[0] === k[1]) k = n.map((x) => x.slice(0, 40));
			trackUmami('asistent_porovnanie', {});
			if (isGiftOpen) closeGiftPanel(false);
			sendMessage(vlozit(t.compareSend, { a: k[0], b: k[1] }), { porovnanie: true });
		}

		var POROVNANIE_RE = /porovn|rozdiel|rozdíl|srovn|compare|difference|versus| vs |vergleich|unterschied/i;

		function ikonovy(trieda, popis, ik) {
			var b = prvok('button', trieda);
			b.type = 'button';
			b.setAttribute('aria-label', popis);
			var s = prvok('span');
			s.innerHTML = ikona(ik);
			b.appendChild(s);
			return b;
		}

		/** K8: a strip, or one wide card. */
		function vykresliPas(row, products) {
			var viac = products.length > 1;
			var list = prvok('div', 'products');
			list.setAttribute('tabindex', '-1');
			list.setAttribute('role', 'list');
			list.setAttribute('aria-label', t.relatedProducts);
			if (!viac) list.setAttribute('data-jeden', '');
			products.forEach((p, i) => {
				var karta = productCard(p, '', '', () => { trackUmami('asistent_karta', {}); });
				oneskor(karta, Math.min(i, 3), 50, 80);
				list.appendChild(karta);
			});
			if (!viac) return row.appendChild(list);
			var hlava = prvok('div', 'pas-hlavicka');
			hlava.appendChild(prvok('span', 'pas-stitok', t.relatedProducts + ' (' + products.length + ')'));
			var sipky = prvok('div', 'pas-sipky');
			var prev = ikonovy('pas-sipka', t.prevProducts, 'spat');
			var next = ikonovy('pas-sipka', t.nextProducts, 'dalej');
			sipky.hidden = true;
			sipky.appendChild(prev);
			sipky.appendChild(next);
			hlava.appendChild(sipky);
			row.appendChild(hlava);
			row.appendChild(list);
			var posun = (smer) => {
				if (list.scrollBy) list.scrollBy({ left: smer * 348, behavior: redukovany() ? 'auto' : 'smooth' });
			};
			prev.addEventListener('click', () => { posun(-1); });
			next.addEventListener('click', () => { posun(1); });
			var sipkyStav = () => {
				sipky.hidden = !(list.scrollWidth > list.clientWidth + 1);
				prev.disabled = list.scrollLeft <= 1;
				next.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
			};
			if (typeof list.getBoundingClientRect === 'function') {
				priPosune(list, sipkyStav);
				ramec(sipkyStav);
			}
			var akcie = prvok('div', 'pas-akcie');
			var cip = prvok('button', 'suggestion', t.compareFirstTwo);
			cip.type = 'button';
			cip.addEventListener('click', () => { posliPorovnanie(products[0], products[1]); });
			akcie.appendChild(cip);
			row.appendChild(akcie);
		}

		/** K9: two products side by side, nothing invented. */
		function vykresliPorovnanie(row, a, b) {
			var box = prvok('div', 'porovnanie');
			box.appendChild(prvok('p', 'por-stitok', t.comparison));
			var mriezka = prvok('div', 'por-mriezka');
			mriezka.setAttribute('role', 'list');
			mriezka.setAttribute('aria-label', t.comparison);
			var ca = Number(a.price);
			var cb = Number(b.price);
			var mena = String(a.currency || '').toUpperCase();
			// K9: two different numeric prices, one currency.
			var rozdiel = a.price != null && b.price != null && Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb && mena && mena === String(b.currency || '').toUpperCase();
			[a, b].forEach((p, i) => {
				var s = prvok('div', 'por-stlpec');
				var d = dostupnost(p);
				var url = safeUrl(p.url);
				s.setAttribute('role', 'listitem');
				s.appendChild(productThumb(p));
				s.appendChild(prvok('span', 'por-nazov', String(p.title || '')));
				var riadok = prvok('span', 'por-cena-riadok');
				riadok.appendChild(prvok('span', 'por-cena', cenaText(p)));
				if (rozdiel && (i === 0 ? ca < cb : cb < ca)) riadok.appendChild(prvok('span', 'por-lacnejsi', vlozit(t.cheaperBy, { n: cenaText({ price: Math.abs(ca - cb), currency: mena }) })));
				s.appendChild(riadok);
				s.appendChild(prvok('span', 'por-dost' + (d ? ' ' + d.trieda : ''), d ? d.text : ''));
				var odkaz = prvok(url ? 'a' : 'span', url ? 'por-pozriet' : '', url ? t.view : '');
				if (url) {
					var sip = prvok('span');
					sip.innerHTML = ikona('dalej');
					odkaz.appendChild(sip);
					odkaz.href = url;
					odkaz.target = '_blank';
					odkaz.rel = 'noopener';
					odkaz.setAttribute('aria-label', t.view + ': ' + String(p.title || '') + ' ' + t.newWindow);
					odkaz.addEventListener('click', () => { trackUmami('asistent_karta', {}); });
				}
				s.appendChild(odkaz);
				mriezka.appendChild(s);
			});
			box.appendChild(mriezka);
			var pb = Array.isArray(b.params) ? b.params : [];
			var riadky = (Array.isArray(a.params) ? a.params : []).slice(0, 8).map((x) => {
				var y = x && x.nazov && pb.filter((q) => q && q.nazov === x.nazov)[0];
				return y ? [x.nazov, x.hodnota, y.hodnota] : null;
			}).filter(Boolean);
			if (riadky.length) {
				var tab = prvok('div', 'por-param');
				riadky.forEach((r) => {
					tab.appendChild(prvok('span', 'por-param-nazov', String(r[0])));
					tab.appendChild(prvok('span', 'por-param-hodnota', String(r[1] == null ? '' : r[1])));
					tab.appendChild(prvok('span', 'por-param-hodnota', String(r[2] == null ? '' : r[2])));
				});
				box.appendChild(tab);
			}
			row.appendChild(box);
		}

		function tlacidloOtazky(qText) {
			var b = prvok('button', 'suggestion', qText);
			b.type = 'button';
			var sip = prvok('span');
			sip.innerHTML = ikona('dalej', 'dalej');
			b.appendChild(sip);
			b._arlingQuestion = qText;
			b.addEventListener('click', () => { askQuestion(qText); });
			suggestionButtons.push(b);
			return b;
		}

		function appendMessage(role, text, products, suggestions, opts) {
			opts = opts || {};
			var row = prvok('div', 'msg msg-' + role);
			var bubble = prvok('div', 'bubble');
			// K1: paragraphs only at blank lines, no fake typing.
			var odseky = String(text == null ? '' : text).split(/\n{2,}/).filter((o) => o.trim());
			if (odseky.length > 1) {
				triedu(bubble, 'odseky', true);
				odseky.forEach((o, i) => {
					var p = prvok('p', null, o);
					oneskor(p, Math.min(i, 4), 60);
					bubble.appendChild(p);
				});
			} else {
				bubble.textContent = text;
			}
			row.appendChild(bubble);

			// A stored, pre-checked answer says so (findings E and 5).
			if (opts.overene) {
				var note = prvok('span', 'note');
				note.innerHTML = ikona('fajka');
				note.appendChild(prvok('span', null, t.preparedNote));
				row.appendChild(note);
			}

			if (products && products.length) {
				if ((opts.porovnanie && products.length >= 2) || (products.length === 2 && POROVNANIE_RE.test(' ' + (opts.otazka || '') + ' '))) {
					vykresliPorovnanie(row, products[0], products[1]);
					if (products.length > 2) vykresliPas(row, products.slice(2));
				} else {
					vykresliPas(row, products);
				}
				zobrazeneProdukty = zobrazeneProdukty.concat(products);
			}

			if (suggestions && suggestions.length) {
				var box = prvok('div', 'suggestions');
				suggestions.forEach((q) => {
					var qText = String(q == null ? '' : q).trim();
					if (!qText) return;
					suggestionButtons.forEach((o) => { if (o._arlingQuestion === qText) o.hidden = true; });
					box.appendChild(tlacidloOtazky(qText));
				});
				row.appendChild(box);
				stitokOtazok();
			}

			els.messages.appendChild(row);
			if (role === 'assistant' && opts.after) revealRow(opts.after);
			else els.messages.scrollTop = els.messages.scrollHeight;
			hranyNeskor();
			els.live.textContent = (role === 'assistant' ? t.title + ': ' : '') + text + (products && products.length ? ' ' + vlozit(t.productsCount, { n: products.length }) : '');
			return row;
		}

		// == Intro (part 4): welcome card, quick tiles, categories, questions

		var TYPY_VOLIEB = ['darcek', 'porovnat', 'produkt', 'doprava', 'kontakt', 'odkaz', 'otazka'];

		function odkazVolby(typ, url) {
			var s = String(url == null ? '' : url).trim();
			if (/^#[A-Za-z][\w-]{0,80}$/.test(s)) return s;
			if (typ === 'kontakt' && /^(mailto|tel):[^\s<>"']{3,200}$/i.test(s)) return s;
			return s ? safeUrl(s) : '';
		}

		var VOLBY = jsonAtribut(scriptEl, 'data-volby');
		var DOPRAVA = odkazVolby('doprava', atr('data-doprava'));
		var KONTAKT = odkazVolby('kontakt', atr('data-kontakt'));
		var KATEGORIE = (jsonAtribut(scriptEl, 'data-kategorie') || []).slice(0, 3).map((k) => {
			var nazov = k && typeof k === 'object' ? String(k.nazov == null ? '' : k.nazov).trim().slice(0, 40) : '';
			return nazov ? { nazov: nazov, obrazok: safeUrl(k.obrazok), otazka: String(k.otazka == null ? '' : k.otazka).trim().slice(0, 300) } : null;
		}).filter(Boolean);
		if (KATEGORIE.length < 3) KATEGORIE = [];

		if (GIFT_ENABLED) {
			KATEGORIE.forEach((k) => {
				var c = prvok('button', 'gift-chip', k.nazov);
				c.type = 'button';
				c.addEventListener('click', () => {
					var v = String(giftEls.interestsInput.value || '').trim().replace(/,\s*$/, '');
					if ((', ' + v + ',').indexOf(', ' + k.nazov + ',') === -1) giftEls.interestsInput.value = v ? v + ', ' + k.nazov : k.nazov;
				});
				giftEls.interestsChips.appendChild(c);
			});
		}

		function volbyStranky() {
			var kontext = kontextStranky();
			var zoznam = VOLBY ? VOLBY.slice(0, 6).map((v) => {
				if (!v || typeof v !== 'object' || TYPY_VOLIEB.indexOf(v.typ) === -1) return null;
				var ik = typeof v.ikona === 'string' && IKONY[v.ikona] ? v.ikona : '';
				var text = String(v.text == null ? '' : v.text).trim().slice(0, 40);
				if (v.typ === 'odkaz') {
					var u = odkazVolby('odkaz', v.url);
					return text && u ? { typ: 'odkaz', text: text, url: u, ikona: ik || 'odkaz' } : null;
				}
				if (v.typ === 'otazka') {
					var o = String(v.otazka == null ? text : v.otazka).trim().slice(0, 300);
					return text && o ? { typ: 'otazka', text: text, otazka: o, ikona: ik || 'otazka' } : null;
				}
				return { typ: v.typ, ikona: ik };
			}) : ['darcek', 'porovnat', 'produkt', 'doprava', 'kontakt'].map((typ) => { return { typ: typ }; });
			return zoznam.filter((v) => {
				if (!v) return false;
				if (v.typ === 'produkt') v.nazov = kontext.nazov;
				return v.typ === 'darcek' ? GIFT_ENABLED : v.typ === 'produkt' ? kontext.typ === 'produkt' : v.typ === 'doprava' ? !!DOPRAVA : v.typ === 'kontakt' ? !!KONTAKT : true;
			}).slice(0, 6);
		}

		function dlazdica(v) {
			if (v.typ === 'darcek') return giftEls.toggle;
			var text = v.text || { porovnat: t.tileCompare, produkt: t.tileProduct, doprava: t.tileShipping, kontakt: t.tileContact }[v.typ];
			// v2.2: short text on the tile, full words for screen readers.
			var kratko = v.text || t.tileShort[['porovnat', 'doprava', 'kontakt', 'produkt'].indexOf(v.typ)] || text;
			var url = v.typ === 'doprava' ? DOPRAVA : v.typ === 'kontakt' ? KONTAKT : v.url;
			var el = prvok(url ? 'a' : 'button', 'dlazdica');
			if (url) {
				el.href = url;
				// Other origin: new tab; #anchor: the panel closes.
				if (skus(() => /^https?:/i.test(url) && new URL(url).origin !== new URL(window.location.href).origin, false)) {
					el.target = '_blank';
					el.rel = 'noopener';
					text += ' ' + t.newWindow;
				}
			} else {
				el.type = 'button';
			}
			if (text !== kratko) el.setAttribute('aria-label', text);
			el.addEventListener('click', () => {
				trackUmami('asistent_volba', { typ: v.typ });
				if (url) {
					if (url.charAt(0) === '#') closePanel();
				} else if (v.typ === 'porovnat' && zobrazeneProdukty.length >= 2) {
					posliPorovnanie(zobrazeneProdukty[zobrazeneProdukty.length - 2], zobrazeneProdukty[zobrazeneProdukty.length - 1]);
				} else if (v.typ === 'porovnat') {
					els.input.value = t.comparePrefill;
					zmenaPola();
					els.input.focus();
					if (els.input.setSelectionRange) els.input.setSelectionRange(els.input.value.length, els.input.value.length);
					appendMessage('assistant', t.compareHint, []);
				} else {
					askQuestion(v.typ === 'produkt' ? vlozit(t.productQuestion, { nazov: v.nazov }) : v.otazka);
				}
			});
			var ik = prvok('span', 'dl-ikona');
			ik.innerHTML = ikona(v.ikona || { porovnat: 'porovnat', produkt: 'otazka', doprava: 'doprava', kontakt: 'kontakt' }[v.typ] || 'otazka');
			el.appendChild(ik);
			el.appendChild(prvok('span', 'dl-text', kratko));
			return el;
		}

		/** Checked on every open: a product page gets its tile (U4); unchanged tiles are not rebuilt. */
		function vykresliDlazdice() {
			if (!uvodDlazdice) return;
			var volby = volbyStranky();
			var kluc = volby.map((v) => v.typ + (v.nazov || '') + (v.text || '')).join('|');
			if (kluc === uvodDlazdice.kluc) return;
			uvodDlazdice.kluc = kluc;
			var dost = volby.length >= 2;
			vyprazdni(uvodDlazdice.grid);
			uvodDlazdice.grid.hidden = !dost;
			if (!dost) return;
			// 6 columns: 3 in a row, 2 or 4 as halves, of 5 the last two halves.
			var n = volby.length;
			volby.forEach((v, i) => {
				var el = dlazdica(v);
				triedu(el, 'pol', n === 2 || n === 4 || (n === 5 && i >= 3));
				oneskor(el, i, 30);
				uvodDlazdice.grid.appendChild(el);
			});
		}

		function kategoriaDlazdica(k, i) {
			var b = prvok('button', 'kategoria');
			var pismeno = () => nahradnyObrazok('kat-ph', k.nazov);
			b.type = 'button';
			oneskor(b, i, 30);
			b.appendChild(k.obrazok ? obrazok(k.obrazok, 'kat-obr', 120, pismeno) : pismeno());
			b.appendChild(prvok('span', 'kat-nazov', k.nazov));
			b.addEventListener('click', () => {
				trackUmami('asistent_kategoria', {});
				askQuestion(k.otazka || vlozit(t.categoryQuestion, { nazov: k.nazov }));
			});
			return b;
		}

		function appendUvod(bezVstupu) {
			var row = uvodRow = prvok('div', 'msg msg-assistant msg-uvod' + (redukovany() || bezVstupu ? '' : ' vstup'));
			// 4.1: the first sentence is the heading.
			var bubble = prvok('div', 'bubble uvitanie');
			var g = String(t.greeting);
			var m = /^(.+?[.?!])\s+(\S[\s\S]*)$/.exec(g);
			if (m) {
				bubble.appendChild(prvok('span', 'uv-nadpis', m[1] + ' '));
				bubble.appendChild(prvok('span', 'uv-telo', m[2]));
			} else {
				bubble.className += ' jedna';
				bubble.textContent = g;
			}
			row.appendChild(bubble);
			var sukromie = prvok('div', 'sukromie');
			var zamok = prvok('span');
			zamok.innerHTML = ikona('zamok');
			sukromie.appendChild(zamok);
			sukromie.appendChild(prvok('span', null, t.privacyLine));
			row.appendChild(sukromie);

			// Tiles under the welcome; the group name is for screen readers.
			uvodDlazdice = { grid: prvok('div', 'dlazdice') };
			uvodDlazdice.grid.setAttribute('role', 'group');
			uvodDlazdice.grid.setAttribute('aria-label', t.quickLabel);
			row.appendChild(uvodDlazdice.grid);
			vykresliDlazdice();

			if (KATEGORIE.length === 3) {
				var kat = prvok('div', 'kategorie');
				kat.setAttribute('role', 'group');
				kat.setAttribute('aria-label', t.categoriesLabel);
				row.appendChild(prvok('div', 'uvod-stitok uvod-nadpis', t.categoriesQuestion));
				KATEGORIE.forEach((k, i) => { kat.appendChild(kategoriaDlazdica(k, i)); });
				row.appendChild(kat);
			}

			// Up to 3 questions in the intro, the rest come as chips after an answer.
			var otazky = remainingStarters().slice(0, 3);
			if (otazky.length) {
				var box = prvok('div', 'suggestions');
				uvodOtazky = { stitok: prvok('div', 'uvod-stitok', t.questionsLabel), tlacidla: [] };
				otazky.forEach((q, i) => {
					var b = tlacidloOtazky(q);
					oneskor(b, i, 30);
					uvodOtazky.tlacidla.push(b);
					box.appendChild(b);
				});
				row.appendChild(uvodOtazky.stitok);
				row.appendChild(box);
			}
			els.messages.appendChild(row);
			els.live.textContent = t.title + ': ' + g;
		}

		/** P7: the intro, session and relacia stay. A pending request is cancelled and can no longer touch the new chat. */
		var gen = 0, aktivny = null;
		function resetRozhovor() {
			gen++;
			if (aktivny) aktivny.zrus();
			setSending(false);
			Array.prototype.slice.call(els.messages.children).forEach((r) => {
				if (r !== uvodRow) r.remove();
			});
			thinkingRow = null;
			conversation = [];
			askedStarters = {};
			zobrazeneProdukty = [];
			suggestionButtons = uvodOtazky ? uvodOtazky.tlacidla.slice() : [];
			suggestionButtons.forEach((b) => {
				b.disabled = false;
				b.hidden = false;
			});
			stitokOtazok();
			if (isGiftOpen) closeGiftPanel(false);
			els.messages.scrollTop = 0;
			hranyNeskor();
			els.live.textContent = t.newChat;
		}

		els.resetBtn.addEventListener('click', resetRozhovor);

		var thinkingRow = null;

		function appendThinking() {
			var row = prvok('div', 'msg msg-assistant');
			var bubble = prvok('div', 'bubble thinking');
			var dots = prvok('span', 'dots');
			row.id = 'thinking-row';
			dots.setAttribute('aria-hidden', 'true');
			dots.innerHTML = '<i></i><i></i><i></i>';
			bubble.appendChild(prvok('span', 'sr-only', t.thinking));
			bubble.appendChild(dots);
			// K3: CSS shows it after 3 s, no timer.
			bubble.appendChild(prvok('span', 'pomaly', t.slowWait));
			row.appendChild(bubble);
			els.messages.appendChild(row);
			els.messages.scrollTop = els.messages.scrollHeight;
			thinkingRow = row;
		}

		function removeThinking() {
			var row = thinkingRow || root.getElementById('thinking-row');
			thinkingRow = null;
			if (row) row.remove();
		}

		// readOnly, not disabled: focus stays.
		function setSending(sending, quiet) {
			isSending = sending;
			els.input.readOnly = sending && !quiet;
			els.sendBtn.disabled = sending;
			if (!sending && focusAfterSend) ramec(() => { els.input.focus(); });
		}

		function announce(name, detail) {
			skus(() => { document.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); });
		}

		// == Networking

		// W3: 8 s for a stored answer, 45 s for a live one.
		var WAIT_PREPARED_MS = 8000;
		var WAIT_REPLY_MS = 45000;

		function timeLimit(ms) {
			var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
			var timer = null;
			var expired = new Promise((resolve, reject) => {
				if (typeof setTimeout !== 'function') return;
				timer = setTimeout(() => {
					skus(() => { ctrl.abort(); });
					var err = new Error('timeout');
					err.name = 'TimeoutError';
					reject(err);
				}, ms);
			});
			expired.catch(() => {});
			return {
				signal: ctrl ? ctrl.signal : undefined,
				race: (p) => Promise.race([p, expired]),
				clear: () => { if (timer != null) clearTimeout(timer); },
				zrus: () => { skus(() => { ctrl.abort(); }); },
			};
		}

		function restoreSuggestion(text) {
			delete askedStarters[text];
			suggestionButtons.forEach((b) => {
				if (b._arlingQuestion === text) {
					b.disabled = false;
					b.hidden = false;
				}
			});
			stitokOtazok();
		}

		/** "Try again" repeats exactly the failed request. */
		function appendRetry(message, text, opts) {
			var row = appendMessage('assistant', message, []);
			var box = prvok('div', 'suggestions');
			var b = prvok('button', 'suggestion retry', t.retry);
			var bublina = row.children[0];
			var ik = prvok('span', 'chyba-ik');
			ik.innerHTML = ikona('upozornenie');
			if (bublina && bublina.insertBefore) bublina.insertBefore(ik, bublina.firstChild);
			row.className += ' msg-error';
			b.type = 'button';
			b.addEventListener('click', () => {
				if (isSending) return;
				row.remove();
				askQuestion(text, opts);
			});
			box.appendChild(b);
			row.appendChild(box);
			els.messages.scrollTop = els.messages.scrollHeight;
			return row;
		}

		function forgetUnanswered(text) {
			var last = conversation[conversation.length - 1];
			if (last && last.role === 'user' && last.content === text) conversation.pop();
		}

		// lenPripravene: a stored answer only, or nothing; porovnanie: K9.
		async function sendMessage(text, opts) {
			var quiet = !!(opts && opts.lenPripravene);
			var porovnanie = !!(opts && opts.porovnanie);
			var znova = porovnanie ? { porovnanie: true } : null;
			if (STARTERS.indexOf(text) !== -1) askedStarters[text] = true;
			disableAskedSuggestions(text);
			var userRow = null;
			if (!quiet) {
				conversation.push({ role: 'user', content: text });
				userRow = appendMessage('user', text, []);
			}
			appendThinking();
			setSending(true, quiet);
			var limit = timeLimit(quiet ? WAIT_PREPARED_MS : WAIT_REPLY_MS), moj = gen;
			aktivny = limit;

			try {
				var payload = {
					tenant: TENANT,
					messages: quiet ? [{ role: 'user', content: text }] : conversation.slice(-MAX_SENT_MESSAGES),
					lang: API_LANG,
					session: SESSION_ID,
					relacia: readRelacia() || undefined,
				};
				if (quiet) payload.lenPripravene = true;
				var init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withSurface(payload)) };
				if (limit.signal) init.signal = limit.signal;
				var res = await limit.race(fetch(ENDPOINT + '/v1/chat', init));
				if (moj !== gen) return;

				if (quiet) {
					var q = res.ok ? await limit.race(res.json()).catch((e) => {
						if (e && e.name === 'TimeoutError') throw e;
						return null;
					}) : null;
					if (moj !== gen) return;
					removeThinking();
					restoreSuggestion(text);
					if (q && !q.answer) return;
					if (!q) {
						appendRetry(t.preparedFailed, text, { lenPripravene: true });
						return announce('arling-asistent:chyba', { pripravena: true });
					}
					disableAskedSuggestions(text);
					askedStarters[text] = true;
					conversation.push({ role: 'user', content: text });
					userRow = appendMessage('user', text, []);
					conversation.push({ role: 'assistant', content: q.answer });
					appendMessage('assistant', q.answer, Array.isArray(q.products) ? q.products : [], remainingStarters().slice(0, 2), { overene: !!(q.meta && q.meta.overene), after: userRow, otazka: text });
					return announce('arling-asistent:odpoved', { overene: !!(q.meta && q.meta.overene), produkty: Array.isArray(q.products) ? q.products.length : 0 });
				}

				// 503 = Workers AI capacity: the calm quota words.
				if (res.status === 429 || res.status === 503) {
					var body = await limit.race(res.json()).catch(() => { return {}; });
					if (moj !== gen) return;
					removeThinking();
					appendMessage('assistant', body && body.error === 'quota_exceeded' ? t.quotaExceeded : t.rateLimited, []);
					return;
				}
				if (!res.ok) {
					removeThinking();
					forgetUnanswered(text);
					appendRetry(t.networkError, text, znova);
					return announce('arling-asistent:chyba', { pripravena: false });
				}

				var data = await limit.race(res.json());
				if (moj !== gen) return;
				removeThinking();
				if (data && data.relacia) saveRelacia(data.relacia);
				conversation.push({ role: 'assistant', content: data.answer });
				var overene = !!(data.meta && data.meta.overene);
				var produkty = Array.isArray(data.products) ? data.products : [];
				appendMessage('assistant', data.answer, produkty, Array.isArray(data.navrhy) && data.navrhy.length ? data.navrhy.slice(0, 6) : remainingStarters().slice(0, 2), { overene: overene, after: userRow, porovnanie: porovnanie, otazka: text });
				announce('arling-asistent:odpoved', { overene: overene, produkty: produkty.length });
			} catch (err) {
				// W3: never stays locked. A reset already unlocked it and owns the new chat.
				if (moj !== gen) return;
				removeThinking();
				if (quiet) {
					restoreSuggestion(text);
					appendRetry(t.preparedFailed, text, { lenPripravene: true });
				} else {
					forgetUnanswered(text);
					appendRetry(t.networkError, text, znova);
				}
				announce('arling-asistent:chyba', { pripravena: quiet, casovyLimit: !!(err && err.name === 'TimeoutError') });
			} finally {
				limit.clear();
				if (moj === gen) { aktivny = null; setSending(false); }
			}
		}

		function zmenaPola() {
			if (String(els.input.value || '').trim()) els.sendBtn.removeAttribute('data-prazdne');
			else els.sendBtn.setAttribute('data-prazdne', '');
			if (typeof els.input.scrollHeight === 'number') {
				styl(els.input, 'height', '48px');
				styl(els.input, 'height', Math.min(128, Math.max(48, els.input.scrollHeight + 2)) + 'px');
			}
		}

		els.input.addEventListener('input', zmenaPola);

		function trySend() {
			if (isSending) return;
			var text = els.input.value.trim();
			if (!text) return;
			els.input.value = '';
			zmenaPola();
			focusAfterSend = true;
			if (isGiftOpen) closeGiftPanel(false);
			sendMessage(text);
			els.input.focus();
		}

		els.form.addEventListener('submit', (evt) => {
			evt.preventDefault();
			trySend();
		});

		els.input.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter' && !evt.shiftKey) {
				evt.preventDefault();
				trySend();
			}
		});

		// == Public API: window.ArlingAsistent

		function askQuestion(text, opts) {
			var clean = String(text == null ? '' : text).trim().slice(0, 2000);
			if (!isOpen) openPanel({ focus: !INLINE, zdroj: 'api' });
			if (!clean || isSending) return false;
			els.input.value = '';
			zmenaPola();
			if (INLINE || mm('(pointer: coarse)')) focusAfterSend = false;
			if (isGiftOpen) closeGiftPanel(false);
			// "Try again" after a failed comparison keeps the comparison flag (overenie 1).
			sendMessage(clean, opts && (opts.lenPripravene || opts.porovnanie) ? { lenPripravene: !!opts.lenPripravene, porovnanie: !!opts.porovnanie } : null);
			return true;
		}

		window.ArlingAsistent = {
			open: () => {
				openPanel({ zdroj: 'api' });
				if (INLINE) focusAfterSend = true;
			},
			close: closePanel,
			ask: askQuestion,
		};

		if (window.addEventListener) {
			['hashchange', 'popstate'].forEach((u) => {
				window.addEventListener(u, () => {
					if (isOpen) return vykresliDlazdice();
					// U4: a visible teaser follows the page.
					if (!els.teaser || els.teaser.hidden !== false || els.teaser.getAttribute('data-stav') !== 'otvoreny') return;
					var k = kontextStranky();
					if (k.typ === 'produkt' && jeMobil()) skryUpoutavku();
					else textUpoutavky(k);
				});
			});
		}

		// The intro is built while idle, the first open only animates (Firefox).
		if (!INLINE && typeof window.requestIdleCallback === 'function') {
			window.requestIdleCallback(() => {
				if (greeted) return;
				greeted = true;
				appendUvod(true);
			}, { timeout: 4000 });
		}
		if (INLINE) openPanel({ focus: false });
		else naplanujUpoutavku();
		announce('arling-asistent:ready', { inline: INLINE });
	}

	boot();
})();

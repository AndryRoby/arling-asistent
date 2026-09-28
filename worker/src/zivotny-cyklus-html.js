/*
 * zivotny-cyklus-html.js
 *
 * HTML obal e-mailov životného cyklu Asistenta (Z-42, 28. 9. 2026). Texty sú
 * v zivotny-cyklus-texty.js, tu je len vzhľad: papierový systém ARLing
 * (ops/design/paper/paper.css), tabuľkové rozloženie 600 px pre Gmail,
 * Outlook a Apple Mail, tmavý režim, jedno tlačidlo.
 *
 * Pravidlá, ktoré tento súbor drží:
 *   - Žiadne obrázky, žiadne sledovacie pixely, žiadne prepisované odkazy.
 *     Odkaz vzniká len na povoleného hostiteľa (POVOLENE_ODKAZY), aj tlačidlo.
 *   - Nadpis v písme ARLing Draw Text (arling.sk/asistent/pismo/), kde ho
 *     klient načíta (Apple Mail, iOS, Thunderbird). Gmail a Outlook písmo
 *     z webu ignorujú a použijú záložné bezpätkové. Súbor je rovnaký pre
 *     všetkých, bez parametra v adrese, preto z neho otvorenie nezistíme.
 *   - Tmavý režim: prefers-color-scheme (Apple Mail, iOS, Outlook pre Mac)
 *     a [data-ogsc] (Outlook.com). Gmail v aplikácii prefarbuje sám.
 *   - Šírka: hybridná tabuľka (100 %, najviac 600 px) plus pevná tabuľka
 *     600 px len pre Outlook pre Windows, takže úzky displej nepreteká ani
 *     tam, kde klient nepozná @media.
 *   - Nič tu nesmie obsahovať dlhú ani strednú pomlčku (U+2014, U+2013).
 */

/** Hostitelia, z ktorých adries smie HTML e-mailu urobiť odkaz. Všetko ostatné ostane obyčajným textom. */
export const POVOLENE_ODKAZY = ['arling.sk', 'arling-asistent.arling.workers.dev'];

export const PISMO_NADPISU = 'https://arling.sk/asistent/pismo/ARLingDrawText-VF.woff2';

// Farby z ops/design/paper/paper.css (svetlé) a ich tmavé zrkadlo.
const F = {
  paper: '#faf9f5',
  papierHlboky: '#f0eee6',
  karta: '#ffffff',
  ink: '#141413',
  text: '#3d3d3a',
  tlmene: '#5e5d59',
  linka: '#e4e2d8',
  akcent: '#b23a1d',
};

const SANS = "'ARLing Sans',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DRAW = "'ARLing Draw Text',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";
const MONO = 'Consolas,Menlo,Monaco,monospace';

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Odkaz len na povoleného hostiteľa (arling.sk a jeho subdomény, worker), len https. */
export function jePovolenyOdkaz(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return POVOLENE_ODKAZY.some((h) => host === h || host.endsWith(`.${h}`));
  } catch (e) {
    return false;
  }
}

const URL_RE = /https?:\/\/[^\s<>"()]+/g;

/**
 * Pomenovaný odkaz v texte: {{názov|https://…}}. V HTML je z neho odkaz s
 * názvom (žiadna zalamovaná adresa na telefóne), v čistom texte „názov
 * (adresa)“, aby sa dal otvoriť aj bez HTML. Pokyn z brány Z-42, nález 4.
 */
const ZNACKA_RE = /\{\{([^{}|]+)\|(https?:\/\/[^\s{}]+)\}\}/g;

/** Pomenovaný odkaz ako značka do textu e-mailu (pozri ZNACKA_RE). */
export const odkaz = (nazov, url) => `{{${nazov}|${url}}}`;

/** Čistý text bez značiek odkazov: „názov (adresa)“. */
export function textOdkazov(s) {
  return String(s).replace(ZNACKA_RE, (m, nazov, url) => `${nazov} (${url})`);
}

/** Viditeľný text holej adresy: hostiteľ a cesta bez parametrov (?t=… by sa na telefóne lámal cez tri riadky); celá adresa ostáva v href. */
function popisOdkazu(url) {
  const u = new URL(url);
  return `${u.hostname}${u.pathname}${u.hash}`;
}

/**
 * Text do HTML: escapovaný, pomenované odkazy {{názov|adresa}} a holé
 * povolené adresy ako obyčajné odkazy (nič sa neprepisuje ani nesleduje).
 * Cudzia adresa ostane textom.
 */
export function odsekHtml(text, farba = F.akcent, trieda = 'odkaz') {
  const s = String(text);
  let out = '';
  let posledny = 0;
  for (const m of s.matchAll(ZNACKA_RE)) {
    out += holeAdresyHtml(s.slice(posledny, m.index), farba, trieda);
    const [, nazov, url] = m;
    out += jePovolenyOdkaz(url)
      ? `<a href="${escapeHtml(url)}" class="${trieda}" style="color:${farba};text-decoration:underline">${escapeHtml(nazov)}</a>`
      : `${escapeHtml(nazov)} (${escapeHtml(url)})`;
    posledny = m.index + m[0].length;
  }
  return out + holeAdresyHtml(s.slice(posledny), farba, trieda);
}

function holeAdresyHtml(s, farba, trieda) {
  let out = '';
  let posledny = 0;
  for (const m of s.matchAll(URL_RE)) {
    let url = m[0];
    const koniec = url.match(/[.,;:!?]+$/);
    if (koniec) url = url.slice(0, -koniec[0].length);
    out += escapeHtml(s.slice(posledny, m.index));
    out += jePovolenyOdkaz(url)
      ? `<a href="${escapeHtml(url)}" class="${trieda}" style="color:${farba};text-decoration:underline;word-break:break-all">${escapeHtml(popisOdkazu(url))}</a>`
      : escapeHtml(url);
    posledny = m.index + url.length;
  }
  out += escapeHtml(s.slice(posledny));
  return out;
}

// ---------------------------------------------------------------------------
// Bloky tela. Blok je reťazec (odsek), {h} nadpis kroku, {pre} kód, {ol}
// číslovaný zoznam, {tlmene} menej dôležitý odsek (podmienky plánu),
// {poznamka} odsek s linkou vľavo, {tlacidlo: {text, url}}, {plany: {...}}.
// ---------------------------------------------------------------------------

const P = `margin:0 0 16px;font-family:${SERIF};font-size:17px;line-height:1.6;color:${F.text}`;

function tlacidloHtml(t) {
  if (!t || !t.url || !jePovolenyOdkaz(t.url)) return '';
  const url = escapeHtml(t.url);
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 28px"><tr>'
    + `<td class="tlacidlo" bgcolor="${F.akcent}" style="background:${F.akcent};border-radius:10px;mso-padding-alt:14px 24px">`
    + `<a href="${url}" class="tlacidlo-a" style="display:inline-block;padding:14px 24px;font-family:${SANS};font-size:16px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:10px">${escapeHtml(t.text)}</a>`
    + '</td></tr></table>';
}

function planyHtml(b) {
  const { hlavicka, riadky } = b.plany;
  const bunka = (x, i, tucne) => `<td class="${i === 0 ? 'ink' : 'text'} linka" style="padding:10px 12px 10px ${i === 0 ? '0' : '12px'};border-bottom:1px solid ${F.linka};font-family:${SANS};font-size:15px;line-height:1.4;color:${i === 0 ? F.ink : F.text};${tucne ? 'font-weight:600;' : ''}${i > 0 ? 'text-align:right;white-space:nowrap' : ''}">${escapeHtml(x)}</td>`;
  const hl = hlavicka.map((x, i) => `<th class="tlmene linka" style="padding:0 12px 8px ${i === 0 ? '0' : '12px'};border-bottom:1px solid ${F.linka};font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${F.tlmene};text-align:${i === 0 ? 'left' : 'right'}">${escapeHtml(x)}</th>`).join('');
  const rows = riadky.map((r) => `<tr>${r.bunky.map((x, i) => bunka(x, i, r.aktualny)).join('')}</tr>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:4px 0 20px;border-collapse:collapse"><tr>${hl}</tr>${rows}</table>`;
}

export function blokHtml(b) {
  if (typeof b === 'string') return `<p class="text" style="${P}">${odsekHtml(b)}</p>`;
  if (b.h) return `<p class="ink krok" style="margin:26px 0 10px;font-family:${SANS};font-size:16px;line-height:1.4;color:${F.ink}"><strong>${escapeHtml(b.h)}</strong></p>`;
  if (b.pre) {
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:0 0 16px"><tr>'
      + `<td class="kod" bgcolor="${F.papierHlboky}" style="background:${F.papierHlboky};border:1px solid ${F.linka};border-radius:10px;padding:14px 16px;font-family:${MONO};font-size:13px;line-height:1.55;color:${F.ink};word-break:break-all">${escapeHtml(b.pre)}</td>`
      + '</tr></table>';
  }
  if (b.ol) {
    const riadky = b.ol.map((x, i) => '<tr>'
      + `<td valign="top" class="akcent" style="width:28px;padding:1px 0 12px;font-family:${SANS};font-size:15px;font-weight:600;line-height:1.6;color:${F.akcent}">${i + 1}.</td>`
      + `<td valign="top" class="text" style="padding:0 0 12px;font-family:${SERIF};font-size:17px;line-height:1.55;color:${F.text}">${odsekHtml(x)}</td>`
      + '</tr>').join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:0 0 8px">${riadky}</table>`;
  }
  if (b.tlmene) return `<p class="tlmene" style="margin:0 0 12px;font-family:${SANS};font-size:14px;line-height:1.6;color:${F.tlmene}">${odsekHtml(b.tlmene, F.tlmene, 'tlmene')}</p>`;
  if (b.poznamka) {
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:4px 0 20px"><tr>'
      + `<td class="akcent-bg" bgcolor="${F.akcent}" style="width:3px;background:${F.akcent};font-size:0;line-height:0">&nbsp;</td>`
      + `<td class="text" style="padding:2px 0 2px 16px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.6;color:${F.text}">${odsekHtml(b.poznamka)}</td>`
      + '</tr></table>';
  }
  if (b.tlacidlo) return tlacidloHtml(b.tlacidlo);
  if (b.plany) return planyHtml(b);
  return '';
}

/**
 * Čistý text bloku. Tlačidlo je v texte názov a úplná adresa (rovnaký cieľ ako
 * v HTML, brána Z-42 pokus 2, nález 1). Tabuľka plánov v texte nie je, jej
 * obsah nesie susedný odsek.
 */
export function blokText(b) {
  if (typeof b === 'string') return textOdkazov(b);
  if (b.h) return b.h;
  if (b.pre) return b.pre;
  if (b.ol) return b.ol.map((x, i) => `${i + 1}. ${textOdkazov(x)}`).join('\n');
  if (b.tlmene) return textOdkazov(b.tlmene);
  if (b.poznamka) return textOdkazov(b.poznamka);
  if (b.tlacidlo) return b.tlacidlo.url && jePovolenyOdkaz(b.tlacidlo.url) ? `${b.tlacidlo.text}: ${b.tlacidlo.url}` : '';
  return '';
}

// ---------------------------------------------------------------------------
// Celý e-mail
// ---------------------------------------------------------------------------

const STYL = `
@font-face{font-family:'ARLing Draw Text';src:url(${PISMO_NADPISU}) format('woff2');font-weight:100 900;font-style:normal}
body,table,td{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table{border-collapse:collapse}
a{color:${F.akcent}}
@media screen and (max-width:620px){
  .obal-td{padding:14px 8px 16px !important}
  .karta-td{padding:24px 18px 8px !important}
  .nadpis{font-size:26px !important;line-height:1.18 !important;margin-bottom:14px !important}
  .ciara{margin-bottom:18px !important}
  .kod{padding:10px 12px !important;font-size:12px !important}
  .karta-td .text{font-size:16px !important;line-height:1.5 !important}
  .karta-td .krok{margin-top:20px !important}
  .pata-td{padding:16px 10px 0 !important}
}
@media (prefers-color-scheme:dark){
  .bg{background:#151412 !important}
  .karta{background:#1f1e1b !important;border-color:#36342f !important}
  .ink{color:#f4f2ea !important}
  .text{color:#d6d3c8 !important}
  .tlmene{color:#a3a097 !important}
  .linka{border-color:#36342f !important}
  .kod{background:#151412 !important;border-color:#36342f !important;color:#f4f2ea !important}
  .akcent{color:#ec8a64 !important}
  .akcent-bg{background:#ec8a64 !important}
  .odkaz{color:#ec8a64 !important}
  .tlacidlo{background:#ec8a64 !important}
  .tlacidlo-a{color:#141413 !important}
}
[data-ogsc] .ink{color:#f4f2ea !important}
[data-ogsc] .text{color:#d6d3c8 !important}
[data-ogsc] .tlmene{color:#a3a097 !important}
[data-ogsc] .akcent,[data-ogsc] .odkaz{color:#ec8a64 !important}
[data-ogsc] .tlacidlo-a{color:#141413 !important}
[data-ogsb] .bg{background:#151412 !important}
[data-ogsb] .karta{background:#1f1e1b !important}
[data-ogsb] .kod{background:#151412 !important}
[data-ogsb] .tlacidlo,[data-ogsb] .akcent-bg{background:#ec8a64 !important}
`.replace(/\n\s*/g, '');

// Neviditeľná výplň za preheaderom, aby klient do náhľadu nevytiahol začiatok tela.
const VYPLN = '&#847;&zwnj;&nbsp;'.repeat(60);

/**
 * Hotové HTML. `pata` je zoznam riadkov päty; riadok, ktorý končí odkazom
 * `stop`, dostane krátky popis odkazu (`stopPopis`) namiesto dlhej adresy.
 */
export function zabalHtml({ jazyk, predmet, preheader, znacka, nadpis, telo, pata, stop, stopPopis }) {
  const hlavicka = '<!doctype html>'
    + `<html lang="${escapeHtml(jazyk)}" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">`
    + '<head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="x-apple-disable-message-reformatting">'
    + '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">'
    + '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">'
    + `<title>${escapeHtml(predmet)}</title>`
    + `<style>${STYL}</style>`
    + `<!--[if mso]><style>.nadpis,.sans{font-family:Arial,sans-serif !important}td,p{font-family:Georgia,serif}</style><![endif]-->`
    + '</head>';

  const riadkyPaty = pata.map((r) => {
    if (stop && r.endsWith(stop)) {
      const uvod = r.slice(0, -stop.length).replace(/[:\s]+$/, '');
      return `${escapeHtml(uvod)}: <a href="${escapeHtml(stop)}"><span class="tlmene" style="color:${F.tlmene};text-decoration:underline">${escapeHtml(stopPopis)}</span></a>`;
    }
    // Odkazy v päte ostávajú tlmené aj v tmavom režime, ako stop odkaz (trieda tlmene, nie odkaz).
    return odsekHtml(r, F.tlmene, 'tlmene');
  }).map((h) => `<p class="tlmene" style="margin:0 0 6px;font-family:${SANS};font-size:13px;line-height:1.55;color:${F.tlmene}">${h}</p>`).join('');

  const telo_ = telo.map(blokHtml).join('');

  return hlavicka
    + `<body class="bg" style="margin:0;padding:0;background:${F.paper};word-spacing:normal">`
    + `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${F.paper}">${escapeHtml(preheader)}${VYPLN}</div>`
    + `<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${F.paper}" style="width:100%;background:${F.paper}"><tr>`
    + '<td align="center" class="obal-td" style="padding:36px 16px 48px">'
    + '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:600px">'
    // Značka nad kartou
    + `<tr><td class="tlmene sans" style="padding:0 4px 16px;font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:${F.tlmene}">`
    + `<span class="akcent" style="color:${F.akcent}">&#9632;</span>&nbsp; ${escapeHtml(znacka)}</td></tr>`
    // Karta
    + `<tr><td class="karta" bgcolor="${F.karta}" style="background:${F.karta};border:1px solid ${F.linka};border-radius:14px">`
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%"><tr>'
    + '<td class="karta-td" style="padding:40px 44px 32px">'
    + `<h1 class="nadpis ink" style="margin:0 0 18px;font-family:${DRAW};font-size:32px;font-weight:650;line-height:1.15;letter-spacing:-.01em;color:${F.ink}">${escapeHtml(nadpis)}</h1>`
    + `<table role="presentation" class="ciara" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px"><tr><td class="akcent-bg" bgcolor="${F.akcent}" style="width:44px;height:3px;background:${F.akcent};font-size:0;line-height:0">&nbsp;</td></tr></table>`
    + telo_
    + '</td></tr></table>'
    + '</td></tr>'
    // Päta
    + '<tr><td class="pata-td" style="padding:22px 8px 0">'
    + riadkyPaty
    + '</td></tr>'
    + '</table>'
    + '<!--[if mso]></td></tr></table><![endif]-->'
    + '</td></tr></table>'
    + '</body></html>';
}

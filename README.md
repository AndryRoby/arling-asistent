# ARLing Asistent

AI predajný asistent pre e-shopy. Nastaví sa z produktového feedu (Google Shopping XML, Shopify, WooCommerce, alebo bežný XML), beží na Cloudflare Workers, a neukladá obsah rozhovorov, len denné súhrnné počítadlá.

Demo a landing stránka: `demo/index.html` (naživo na https://arling.sk/asistent/ po nasadení).

## Ako to funguje

1. E-shop vloží URL feedu produktov a e-mail (`POST /v1/tenants`).
2. Worker feed stiahne, znormalizuje, rozdelí na časti a uloží ako embeddings do Cloudflare Vectorize (`@cf/baai/bge-m3`). Feed sa obnovuje automaticky raz denne (cron).
3. E-shop vloží jeden `<script>` tag, buď na `widget/widget.js` (GitHub Pages), alebo priamo na `GET /widget.js` z Workera (rovnaký súbor, worker ho servíruje zo svojej vlastnej domény, viď nižšie).
4. Zákazník sa opýta widgetu na niečo; otázka sa zabedduje, nájde sa 8 najbližších produktov daného e-shopu vo Vectorize, a model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) odpovie výhradne z týchto produktov a kontaktných údajov obchodu, v jazyku zákazníka, do 120 slov, s najviac 3 odkazmi na produkty.

Súbory:

- `worker/`: Cloudflare Worker (wrangler, plain JavaScript ES modules, žiadny build krok pri nasadení).
- `widget/widget.js`: vkladateľný chat widget (jeden súbor, Shadow DOM, bez závislostí). Toto je jediný zdroj pravdy pre widget; `worker/src/widget-src.js` a `demo/widget.js` sú z neho generované, viď "Widget: úprava a build" nižšie.
- `demo/`: landing stránka a živé demo (statické súbory pre GitHub Pages).
- `scripts/build-widget.mjs`: kopíruje `widget/widget.js` do `worker/src/widget-src.js` a `demo/widget.js` (`npm run build:widget`).
- `legal/dpa-sk.md`: vzorová zmluva o spracúvaní osobných údajov (čl. 28 GDPR).
- `tests/`: `node --test`, mocky pre AI/Vectorize/D1/KV, žiadna sieť.

## Testovanie lokálne (bez Cloudflare účtu)

Vlastník ešte nemá účet na Cloudflare: všetko nižšie beží a testuje sa lokálne s mockami, nasadenie príde neskôr.

```bash
cd products/arling-asistent
npm test          # node --test tests/*.test.mjs, žiadna sieť, žiadny účet
```

Na kontrolu syntaxe worker kódu a widgetu bez inštalácie čohokoľvek:

```bash
node --check widget/widget.js
node --check demo/widget.js
for f in worker/src/*.js; do node --check "$f"; done
```

### Widget: úprava a build

`widget/widget.js` je jediný zdroj pravdy. Worker (plain ES modules, žiadny bundler) nevie priamo `import`-núť `.js` súbor ako text, a `demo/` má byť nezávislá statická kópia pre GitHub Pages, preto po každej úprave `widget/widget.js` treba spustiť:

```bash
npm run build:widget
```

Tento skript (`scripts/build-widget.mjs`) prepíše dva generované súbory:

- `worker/src/widget-src.js` — `export default \`...\`;` s obsahom widgetu, servírovaný priamo Workerom na `GET /widget.js` (content-type `application/javascript`, `cache-control: public, max-age=3600`, CORS `*`, keďže ide o statický, tenant-neutrálny kód nahrávaný z `<script src>` z ľubovoľnej domény e-shopu).
- `demo/widget.js` — presná kópia pre GitHub Pages demo stránku.

Oba generované súbory sa commitujú ako bežný zdrojový kód (nasadenie samotné žiadny build krok nepotrebuje); skript treba spustiť len lokálne po úprave `widget/widget.js`, nie pri každom `wrangler deploy`.

Na lokálne vyskúšanie samotného Workera (vyžaduje len `npx`, nie účet, `wrangler dev` beží úplne offline s lokálnym D1/KV/Vectorize emulátorom):

```bash
cd worker
npx wrangler dev
```

Na lokálne prezretie demo stránky stačí otvoriť `demo/index.html` v prehliadači, alebo spustiť statický server (`npx serve demo`). Skúšobný formulár na stránke volá worker na adrese nastavenej v `?endpoint=` parametri URL (predvolene placeholder `https://arling-asistent.arling.workers.dev`, ktorý treba nahradiť po nasadení); pri lokálnom teste pridajte `?endpoint=http://localhost:8787` a dočasne uvoľnite `connect-src` v CSP meta tagu v `demo/index.html`.

## Nasadenie (až keď bude účet na Cloudflare)

```bash
npm install -g wrangler
wrangler login

# D1 databáza (tenants + counters)
wrangler d1 create asistent
# skopírovať vrátené database_id do worker/wrangler.toml ([[d1_databases]])
wrangler d1 execute asistent --file=worker/schema.sql --remote

# Vectorize index (produktové embeddingy, 1024 dimenzií pre bge-m3, cosine)
wrangler vectorize create asistent-products --dimensions=1024 --metric=cosine

# KV namespace (rate-limit počítadlá)
wrangler kv namespace create ASISTENT_CACHE
# skopírovať vrátené id do worker/wrangler.toml ([[kv_namespaces]])

# Metadata index na Vectorize (nutné, inak filtrovaný dotaz podľa tenanta
# vždy vráti 0 výsledkov; worker sa bez neho degraduje na pomalší
# nefiltrovaný fallback, viď "Ak retrieval vracia 0 produktov" nižšie, ale
# treba ho vytvoriť čo najskôr):
wrangler vectorize create-metadata-index asistent-products --property-name=tenant --type=string

# Admin token pre POST /v1/tenants/:id/reingest (ľubovoľný náhodný reťazec,
# napr. `openssl rand -hex 32`); bez neho endpoint odmietne úplne všetky
# požiadavky, nikdy nepovolí re-ingest bez neho:
wrangler secret put ADMIN_TOKEN

cd worker
wrangler deploy
```

Widget (`widget/widget.js`) a demo stránku (`demo/`) treba nasadiť ako statické súbory (napríklad GitHub Pages pod `arling.sk/asistent/`, tak ako ostatné nástroje ARLing) — alebo namiesto toho použiť `<script src="https://VASA-DOMENA-WORKERA/widget.js">`, keďže worker po nasadení servíruje presne ten istý súbor priamo (viď "Vloženie widgetu na e-shop" nižšie), čo je jednoduchšie ako spravovať druhý statický hosting. Po nasadení Workera nahraďte placeholder `https://arling-asistent.arling.workers.dev` skutočnou doménou Workera v `demo/app.js` a `demo/index.html` (CSP `connect-src`).

### Ak retrieval vracia 0 produktov (chýbajúci metadata index)

Ak bol tenant vytvorený predtým, než existoval metadata index na property `tenant` (`wrangler vectorize create-metadata-index` vyššie), jeho pôvodné vektory vo Vectorize môžu byť v poriadku, ale `chat.js` sa degraduje na pomalší nefiltrovaný fallback dotaz (`retrieveCandidates` v `worker/src/chat.js`) namiesto zlyhania nahlas. Po vytvorení indexu stačí dotknutého tenanta manuálne pre-embednúť:

```bash
curl -X POST "https://VASA-DOMENA-WORKERA/v1/tenants/TENANT_ID/reingest" \
  -H "X-Admin-Token: $ADMIN_TOKEN"
```

Ten istý `ingestFeedForTenant()` beží aj v dennom crone (`worker/src/cron.js`), takže toto je len manuálne spustenie tej istej funkcie mimo poradia.

## Vloženie widgetu na e-shop

```html
<script src="https://arling-asistent.arling.workers.dev/widget.js"
        data-tenant="TENANT_ID"
        data-lang="sk"
        data-color="auto"
        defer></script>
```

`GET /widget.js` servíruje worker sám (rovnaký obsah ako `widget/widget.js`, viď "Widget: úprava a build" vyššie), takže e-shop nepotrebuje žiadny druhý hosting pre samotný skript.

- `data-tenant` (povinné): id vrátené z `POST /v1/tenants`.
- `data-lang`: `sk`, `cs`, `en` alebo `de`, predvolené `sk`.
- `data-color`: `auto` (podľa systému návštevníka, predvolené), `light` alebo `dark`.
- `data-endpoint`: voliteľná adresa Workera, ak sa líši od domény, z ktorej sa `widget.js` načítal.

## Náklady na bezplatnej úrovni Cloudflare (zdroj: `opportunities/asistent-research.md`, stav 09/2026)

| Služba | Bezplatný limit | Poznámka |
|---|---|---|
| Workers | 100 000 requestov/deň, 10 ms CPU/request | Pri prekročení CPU limitu treba platený plán (5 USD/mesiac, 30M CPU-ms) |
| Workers AI | 10 000 "neuronov"/deň (embeddingy aj chat model spolu) | Po prekročení treba platený Workers plán, doplatok 0,011 USD/1000 neuronov |
| Workers AI, bge-m3 embeddings | 0,012 USD/milión tokenov (platený plán) | Najlacnejší a viacjazyčný embedding model na Workers AI |
| Vectorize | 5M uložených dimenzií, 30M query-dimenzií/mesiac; max 100 indexov, max 1536 dimenzií/vektor, max 20 000 vektorov/batch | Mal by stačiť na katalógy malých e-shopov (limit 5000 produktov/tenant v tomto kóde) |
| D1 | 5M riadkov čítaných/deň, 100 000 zapísaných/deň, 5 GB úložisko | Ukladá len tenants + denné počítadlá, žiadne rozhovory |
| Workers KV | 100 000 čítaní/deň, 1 000 zápisov/deň, 1 GB úložisko | Len rate-limit počítadlá s krátkou expiráciou |

Najtesnejší limit je 10 000 Workers AI neuronov/deň (embeddingy pri onboardingu/dennom obnovení feedu aj chatový model zdieľajú tento limit): pri viacerých aktívnych e-shopoch treba počítať s prechodom na platený Workers plán čoskoro po prvých platiacich zákazníkoch, presne ako predpokladá ADR-04.

## Čo ešte nie je hotové

- **Platby.** Stripe (mesačné predplatné, 14-dňová skúšobná verzia, licencia podľa domény) nie je zapojený. `POST /v1/tenants` dnes vytvorí `trial` tenanta s pevnou kvótou, bez platby.
- **Kvóta na rozhovor, nie na správu.** MVP zjednodušenie: každé volanie `POST /v1/chat` sa počíta ako jeden rozhovor voči mesačnej kvóte (pozri komentár v `worker/src/tenants.js`). Presnejšie počítanie raz za reláciu (podľa in-memory session id na strane widgetu) je budúce rozšírenie.
- **Shoptet doplnok.** Vyžaduje partnerské schválenie (Shoptet reaguje do 4 týždňov, pozri `opportunities/asistent-research.md`), nie je súčasťou tohto MVP. Skript tag funguje na Shoptete aj bez doplnku.
- **WooCommerce plugin a Shopify aplikácia** (inštalácia na klik z ich obchodov s doplnkami). Feed formáty oboch platforiem worker už vie spracovať (`worker/src/feed.js`), chýba len samotný distribučný balík.
- **Načítanie stránok o doprave a obchodných podmienkach.** ADR-04 spomína aj načítanie týchto stránok pri onboardingu; MVP spracúva len produktový feed, obchodné fakty (napríklad kontaktný e-mail) sa zatiaľ zadávajú len cez tenant záznam.
- **EU-only garancia spracovania.** Cloudflare verejne negarantuje, že Workers AI beží výlučne v EÚ (pozri `legal/dpa-sk.md`, článok 7). Zmluva preto stojí na štandardných zmluvných doložkách (SCC) a certifikácii EU Cloud Code of Conduct, nie na technickej záruke.
- **Mazanie vektorov pri zmene feedu.** `embed.js` vie vektory zmazať (`deleteTenantVectors`), ale `cron.js` dnes len prepíše (upsert) existujúce produkty; produkt, ktorý úplne zmizne z feedu, ostáva vo Vectorize ako zastaraný záznam. Čistenie osirotených vektorov je budúce rozšírenie.
- **Admin rozhranie.** Žiadny prehľad tenantov, počítadiel ani logov mimo priameho dotazu do D1.

## Testy

`npm test` (`node --test tests/*.test.mjs`), Node 20+, bez siete. 105 testov, 335 volaní `assert.*`, pokrývajúcich: parsovanie všetkých 4 formátov feedu a normalizáciu, chunkovanie a embedding pipeline, CORS allowlist (vrátane hlavičky na skutočných JSON odpovediach `POST /v1/tenants` a `GET /v1/tenants/:id/status`, nielen na OPTIONS preflighte), rate limiting a jeho fail-open správanie pri chybe KV, limity veľkosti vstupu a ich mapovanie na 413/400 namiesto 500, ochranu proti prompt injection (vrátane popisu produktu s textom "ignore previous instructions"), retrieval z Vectorize vrátane degradovaného nefiltrovaného fallbacku pri chýbajúcom metadata indexe, admin re-ingest endpoint (`POST /v1/tenants/:id/reingest`), validáciu a vytvorenie tenanta, mesačnú kvótu a počítadlá, stavbu groundovaného promptu, spracovanie odpovede modelu a celý chat flow s mockovaným modelom vracajúcim JSON, `widget/widget.js` samotný (načítanie cez `node:vm` s minimálnym fake DOM, bez jsdom), a napokon aj wiring na úrovni HTTP routera (`worker/src/index.js`) so skutočnými `Request`/`Response` objektmi.

## Kontakt

ARLing s. r. o. (Bratislava, Slovensko). andrej@arling.sk

# ARLing Asistent

**In English:** ARLing Asistent is an AI sales assistant for online shops (Shoptet, Upgates, WooCommerce, Shopify or any shop with a product feed) that answers customers from the shop's real product feed, in their language, with links to specific products, without storing conversations. It is free up to 100 conversations a month with no card; above that the shop upgrades from its account page to Starter for 19 EUR a month (up to 1,000 conversations) or Pro for 39 EUR a month (up to 3,000), VAT included, at https://arling.sk/asistent/en/.

Paid plans are monthly Stripe subscriptions sold through Stripe Managed Payments: the merchant of record is Link (Sold through Link, LLC), which sends the receipt and the invoice, and ARLing s. r. o. delivers the service. Cancel or change a plan at any time in the Stripe customer portal (https://billing.stripe.com/p/login/3cIaER9M63hNeFcg8B4ko00); it stays active until the end of the paid period, and ARLing refunds a subscription payment on request within 14 days of purchase without you giving a reason (support@arling.sk). Terms: https://arling.sk/podmienky/en/. The rest of this README is technical documentation in Slovak.

AI predajný asistent pre e-shopy. Nastaví sa z produktového feedu (Heureka/Zboží.cz XML, ktorý exportuje napríklad Shoptet alebo Upgates, Google Shopping XML, Shopify, WooCommerce, alebo bežný XML), beží na Cloudflare Workers, a neukladá obsah rozhovorov, len denné súhrnné počítadlá.

Demo a landing stránka: `demo/index.html` (naživo na https://arling.sk/asistent/ po nasadení).

## Ako to funguje

1. E-shop vloží URL feedu produktov a e-mail (`POST /v1/tenants`).
2. Worker feed stiahne, znormalizuje, rozdelí na časti a uloží ako embeddings do Cloudflare Vectorize (`@cf/baai/bge-m3`). Feed sa obnovuje automaticky raz denne (cron).
3. E-shop vloží jeden `<script>` tag, buď na `widget/widget.js` (GitHub Pages), alebo priamo na `GET /widget.js` z Workera (rovnaký súbor, worker ho servíruje zo svojej vlastnej domény, viď nižšie).
4. Zákazník sa opýta widgetu na niečo; otázka sa zabedduje, nájde sa 8 najbližších produktov daného e-shopu vo Vectorize, a model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, teplota 0,2) odpovie výhradne z týchto produktov a kontaktných údajov obchodu, v jazyku zákazníka, do 120 slov, s najviac 3 odkazmi na produkty. Model vidí názov, cenu (na dve desatinné miesta, ako na kartách), dostupnosť, kategóriu aj popis produktu (popis je uložený v metadátach vektora, `worker/src/embed.js`). Keď v produktoch nič relevantné nie je, model vráti prázdnu odpoveď a worker zobrazí vlastnú správu s kontaktom obchodu (`FALLBACK_BY_LANG` v `worker/src/chat.js`), takže odmietnutie je vždy v správnej slovenčine alebo češtine; ostatné odpovede prejdú cez `polishAnswer` (ceny s dvoma desatinnými miestami, tabuľka známych preklepov modelu ako „neznám“ namiesto „neviem“).

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

- `worker/src/widget-src.js`: `export default \`...\`;` s obsahom widgetu, servírovaný priamo Workerom na `GET /widget.js` (content-type `application/javascript`, `cache-control: public, max-age=3600`, CORS `*`, keďže ide o statický, tenant-neutrálny kód nahrávaný z `<script src>` z ľubovoľnej domény e-shopu).
- `demo/widget.js`: presná kópia pre GitHub Pages demo stránku.

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

# Admin token pre POST /v1/tenants/:id/reingest a PATCH/POST
# /v1/tenants/:id/plan (ľubovoľný náhodný reťazec, napr. `openssl rand -hex
# 32`); bez neho oba endpointy odmietnu úplne všetky požiadavky, nikdy
# nepovolia re-ingest ani zmenu plánu bez neho. Rovnaká hodnota ide aj do
# products/licence-service ako ASISTENT_ADMIN_TOKEN, pozri "Platby cez
# Stripe" vyššie:
wrangler secret put ADMIN_TOKEN

cd worker
wrangler deploy
```

Widget (`widget/widget.js`) a demo stránku (`demo/`) treba nasadiť ako statické súbory (napríklad GitHub Pages pod `arling.sk/asistent/`, tak ako ostatné nástroje ARLing), alebo namiesto toho použiť `<script src="https://VASA-DOMENA-WORKERA/widget.js">`, keďže worker po nasadení servíruje presne ten istý súbor priamo (viď "Vloženie widgetu na e-shop" nižšie), čo je jednoduchšie ako spravovať druhý statický hosting. Po nasadení Workera nahraďte placeholder `https://arling-asistent.arling.workers.dev` skutočnou doménou Workera v `demo/app.js` a `demo/index.html` (CSP `connect-src`).

### Ak retrieval vracia 0 produktov (chýbajúci metadata index)

Ak bol tenant vytvorený predtým, než existoval metadata index na property `tenant` (`wrangler vectorize create-metadata-index` vyššie), jeho pôvodné vektory vo Vectorize môžu byť v poriadku, ale `chat.js` sa degraduje na pomalší nefiltrovaný fallback dotaz (`retrieveCandidates` v `worker/src/chat.js`) namiesto zlyhania nahlas. Po vytvorení indexu stačí dotknutého tenanta manuálne pre-embednúť:

```bash
curl -X POST "https://VASA-DOMENA-WORKERA/v1/tenants/TENANT_ID/reingest" \
  -H "X-Admin-Token: $ADMIN_TOKEN"
```

Ten istý `ingestFeedForTenant()` beží aj v dennom crone (`worker/src/cron.js`), takže toto je len manuálne spustenie tej istej funkcie mimo poradia.

### Opakované `POST /v1/tenants` na tú istú doménu

`domain` má v `tenants` UNIQUE obmedzenie, takže opakované odoslanie onboardingového formulára pre doménu, ktorá už tenanta má (napríklad majiteľ obchodu formulár omylom odošle dvakrát), nevráti chybu: vráti `200` s existujúcim tenantom (`{..., "existing": true}` namiesto `201`), nikdy nie e-mail pôvodného tenanta. Ak sa odoslaná `feed_url` líši od uloženej, alebo posledné úspešné spracovanie feedu je staršie ako 24 hodín (alebo sa nikdy nepodarilo, tenant je v stave `error`), spustí sa na pozadí (`ctx.waitUntil`) rovnaké `ingestFeedForTenant()` ako pri crone. Akýkoľvek iný konflikt v D1 (nie kolízia domény) sa mapuje na `409 {"error":"conflict"}`, nikdy nie na `500`.

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
- `data-lang`: `sk`, `cs`, `en`, `de`, alebo `auto` (predvolené, aj keď atribút úplne chýba). Pri `auto` sa vzhľad widgetu (tlačidlá, placeholder, pozdrav) riadi jazykom prehliadača návštevníka (s pádom na slovenčinu, ak ten nie je jeden zo štyroch podporovaných), a hodnota `"auto"` sa pošle aj na server v `POST /v1/chat`, ktorý potom jazyk odpovede odhaduje z každej správy zákazníka zvlášť (pozri `worker/src/chat.js`).
- `data-answer-lang="auto"`: rovnaké automatické rozpoznanie jazyka odpovede ako vyššie, ale nezávisle od pevného `data-lang`; vzhľad widgetu (tlačidlá, placeholder, pozdrav, titulok) zostane v pevnom jazyku (napríklad slovenský ukážkový obchod), no asistent aj tak odpovie zákazníkovi v jazyku, v akom sa sám opýtal. Bez vplyvu, ak `data-lang` chýba alebo je už `auto`.
- `data-color`: `auto` (podľa systému návštevníka, predvolené), `light` alebo `dark`.
- `data-position`: `right` (predvolené) alebo `left`, na ktorej spodnej strane stránky sedí tlačidlo aj panel chatu.
- `data-greeting`: vlastný text prvej správy asistenta (nahradí predvolený pozdrav pre daný jazyk).
- `data-title`: vlastný názov panelu (zobrazí sa v hlavičke aj ako accessible name dialógu, nahradí predvolený názov pre daný jazyk).
- `data-endpoint`: voliteľná adresa Workera, ak sa líši od domény, z ktorej sa `widget.js` načítal.

Po nabootovaní widget nastaví `window.ArlingAsistent = { open(), close(), ask(text) }`. `ask(text)` otvorí panel a pošle text presne tak, ako keby ho návštevník napísal (orezaný, najviac 2000 znakov); vráti `true`, ak sa otázka odoslala, `false`, ak bol text prázdny alebo ešte beží predchádzajúca odpoveď (vtedy len otvorí panel). Používa to napríklad slovenský ukážkový obchod (`demo/ukazka/`) na tlačidlá s navrhovanými otázkami; e-shop si takto môže spraviť vlastné tlačidlo "Opýtať sa asistenta".

## Plány

`POST /v1/tenants` dnes vytvorí tenanta na pláne `free` bez platby.

**Rozhovor = podpísaná relácia, najviac 24 hodín a 10 otázok (od kroku 1 plánu `ops/asistent/genialny-plan.md`).** Keď je nastavené `UCET_TAJOMSTVO` (na živom workeri áno), vydáva reláciu server: každá úspešná odpoveď `POST /v1/chat` a `POST /v1/gift` nesie pole `relacia` (token `r1.<telo>.<HMAC>`, `worker/src/relacia.js`, kľúč odvodený z `UCET_TAJOMSTVO` s predponou `asistent-relacia:`), widget ho uloží do `sessionStorage` (`arling_asistent_relacia`) a pošle s ďalšou otázkou. Chýbajúci, podvrhnutý, cudzí, starší ako 24 hodín alebo plný token znamená nový započítaný rozhovor, nikdy chybu. Počet otázok v rozhovore nastavuje `ASISTENT_MAX_OTAZOK` (predvolene 10, vo `wrangler.toml` zatiaľ 1000, kým Andrej neschváli bod 3.2/1 plánu a nezmenia sa verejné texty „however many questions“ v plugine a na stránkach porovnania). Opakovanie staršieho tokenu (server už vydal vyššie `n`) je nový rozhovor: najvyššie `n` relácie sa pamätá v KV `relacia-n:<odtlačok>` na 25 hodín (odtlačok z tajomstva, obchodu a id, nie id relácie). KV nie je atomické, súbežné opakovanie prejde, ale zastavia ho denné stropy nižšie. Samotné `session` bez tokenu sa už ako pokračovanie neberie. Widget posiela len posledných 6 správ.

**Ochrana a počítanie (krok 1 a oprava nálezov jeho kontroly).** Hlavička `Origin` len filtruje neúmyselných klientov: skript ju pridá jedným parametrom. Bez nej odpoveď `403 {"error":"origin_required"}` (okrem nášho testu s `X-Arling-Test`). Skutočnú ochranu dávajú limity v `worker/src/ochrana.js`, ktoré sa rezervujú atomicky v D1 PRED volaním modelu (tabuľka `asistent_pocty`, `worker/src/pocty.js`, jedna veta `INSERT ... ON CONFLICT DO UPDATE ... WHERE hodnota + ? <= limit RETURNING`), takže ich neobíde ani súbežná dávka požiadaviek; pri chybe modelu sa všetko vráti. Poradie: minútový limit (30, KV, približný, kľúč s odtlačkom siete), mesačná kvóta pre nový rozhovor (vyčerpaná = `429 quota_exceeded`), pri 150 % spoločného stropu `AI_DAILY_NEURON_BUDGET` `503 quota_exceeded`, 60 otázok za deň na (obchod, sieť IP) (nad tým `429 rate_limited`). Odpoveď modelom dostane otázka, len keď sa zmestí všetko naraz: spoločný strop (horný odhad 150 alebo 200 neurónov, po odpovedi sa doúčtuje skutočnosť v tisícinách), denný strop obchodu v otázkach (free 60, starter 400, pro 1200) aj v neurónoch (podiel spoločného stropu: free 10 %, starter 35 %, pro 70 %), otázky s modelom na (obchod, sieť) (free 10, platené 30) a na sieť cez všetky obchody (30); pri novom rozhovore aj 5 na (obchod, sieť), denný strop nových rozhovorov obchodu (3-násobok denného priemeru kvóty, aspoň 10) a jeden rozhovor z mesačnej kvóty. Inak odpovedá kód bez modelu (3 najbližšie produkty a veta „Tieto produkty najlepšie zodpovedajú vašej otázke.“, `meta.bezAi`), rovnako bezplatné obchody a ukážka pri 80 % a všetci pri 100 % spoločného stropu. Odpovede bez modelu majú vlastný denný strop obchodu (free 300, starter 2000, pro 6000, potom `429`) a nový rozhovor bez modelu sa do mesačnej kvóty nezapočíta ani nedostane token. Sieť IP = IPv4 celá, IPv6 prvé 4 skupiny (/64); do D1 ide len číslo koša 0 až 65 535 z odtlačku siete s dňom a tajomstvom, nikdy IP. Otázka sa na serveri skráti na 500 znakov, polia darčeka na 200 (widget má ten istý `maxlength`). Náklad každej odpovede (otázky, tokeny z poľa `usage` alebo odhad znaky / 3,5, neuróny podľa cenníka, odpovede bez modelu) sa zapíše do D1 `counters` (stĺpce z `worker/migrations/0003_genialny.sql`), nikdy text otázky, id relácie ani IP. Načítanie feedov má vlastný rozpočet `AI_DAILY_OBNOVA_BUDGET` (skutočné neuróny bge-m3), chat ho nečíta; nočný cron obnovuje denne len obchody s rozhovorom alebo založené za 30 dní, ostatné v nedeľu. Výstrahy pre Fable `naklady_den`, `obchod_marza`, `zneuzitie`, `ai_vypadok` (počítadlo chýb modelu v D1, výstraha od 10 chýb raz za hodinu) idú cez ten istý ping ako `quota_80`, len keď `ASISTENT_NTFY_OCHRANA = "zapnute"`. Naše meranie kvality obchádza denné limity IP hlavičkou `X-Arling-Meranie` s vlastným tajomstvom `MERANIE_TOKEN` (nie `ADMIN_TOKEN`).

**Bez `UCET_TAJOMSTVO` (lokálny vývoj) platí pôvodné počítanie podľa `session`:** Widget si pri prvom otvorení vygeneruje náhodné session id (16 hex znakov, `sessionStorage`, teda na dobu života karty prehliadača) a posiela ho ako `session` v tele každého `POST /v1/chat`. Worker (`worker/src/ochrana.js`, zápis cez `potvrdRozhovor` v `worker/src/tenants.js`) započíta rozhovor voči mesačnej kvóte len raz na dvojicu (tenant, session) za 24 hodín: kľúč `conv:{tenant}:{session}` v KV `ASISTENT_CACHE` s TTL 86400 s, zapísaný až po skutočnom započítaní. Ďalšie správy v tej istej relácii kvótu nemenia a prejdú aj vtedy, keď sa kvóta medzitým naplnila (zákazníka nikdy neodstrihneme uprostred rozhovoru). Pri chybe KV sa request započíta (fail open, rovnako ako rate limit). Staršie embedy bez `session` sa počítajú na request, ako doteraz. Zdrojom pravdy pre mesiac ostáva počítadlo v D1 (`used_this_month`), KV je len deduplikácia.

Po vyčerpaní kvóty vráti worker `429 {"error":"quota_exceeded"}` a widget zobrazí pokojnú správu v jazyku widgetu ("Asistent si dnes oddychuje. Použite prosím kontaktnú stránku obchodu.", sk/cs/en/de), nikdy nič o platbách.

**Upozornenie majiteľovi pri 80 % a 100 %.** Vo chvíli, keď využitie prekročí 80 % a potom 100 % `monthly_quota` (prvýkrát v danom mesiaci, pamätané v KV kľúči `quota-notified:{tenant}:{YYYY-MM}:{80|100}`), worker zavolá `GET https://homelab.tailbf8f27.ts.net/subscribe/api/ping?e=quota_80|quota_100&t={tenantId}&p={usage_percent}` (udalosti `quota_80`/`quota_100` v `PING_EVENTS` v `products/subscribe-service/app.py`, z čoho vznikne ntfy riadok). Volanie beží cez `ctx.waitUntil`, takže odpoveď zákazníkovi nečaká; každá chyba sa len zaloguje (`worker/src/notify.js`). Premenná `QUOTA_PING_URL` (prázdna hodnota vypne pingy) je voliteľná, predvolená je adresa vyššie. E-mail tenantovi zatiaľ nie je.

### `GET /v1/tenants/:id/status` (verejný kontrakt)

Tenant id je v embed skripte každej stránky obchodu, takže je verejné. Odpoveď preto obsahuje len to, čo potrebuje dashboard obchodu, a nikdy `contact_email` ani `billing_ref` (Stripe subscription id):

```json
{ "id": "...", "domain": "shop.sk", "plan": "free", "status": "ready", "monthly_quota": 100,
  "conversations_used": 37, "usage_percent": 37, "period_start": "2026-09-01", "period_end": "2026-10-01",
  "product_count": 294, "valid_until": null, "last_ingest": "2026-09-05T08:00:05.564Z", "last_error": null }
```

- `last_error` (od 24. 9. 2026) je stabilný kód, prečo sa katalóg nenačítal, len kým je `status` `error`, inak `null`: `no_products`, `feed_http_NNN` (napr. `feed_http_403` pri firewalle), `feed_not_readable` (HTML namiesto feedu, napr. coming soon alebo prihlasovanie), `feed_unreachable`, `feed_url_private_host` / `feed_url_scheme` / `feed_url_invalid` / `feed_too_many_redirects`, `ai_budget_exhausted`, `internal`. Uložený je v KV `ingest-error:{tenant}` (30 dní), úspešné načítanie ho zmaže. WordPress plugin 0.3.0 ho prekladá na vetu s návodom. Nový obchod s prázdnym feedom končí v `error` / `no_products` (nie `ready`); už bežiaci obchod sa pri dennej obnove kvôli jednej prázdnej odpovedi nevypína. Opakované `POST /v1/tenants` od majiteľa (zhodný e-mail) prepne obchod v `error` hneď na `pending`.

- `plan` je vždy `free`, `starter` alebo `pro` (staršie riadky s hodnotou `trial` sa hlásia ako `free`, uložená hodnota sa nemení).
- `conversations_used` je počet rozhovorov v aktuálnom kalendárnom mesiaci (UTC); po prelome mesiaca bez jediného chatu je 0, aj keď riadok v D1 ešte drží minulomesačné číslo.
- `usage_percent` je celé číslo 0 až 100, zaokrúhlené nadol.
- `used_this_month` a `last_ingested_at` sú ponechané ako aliasy `conversations_used`/`last_ingest` pre WordPress plugin a Shopify admin stránku, ktoré čítajú staré názvy.
- `billing_ref` vracia len admin odpoveď `PATCH /v1/tenants/:id/plan` (s `X-Admin-Token`).

Tlačidlo na prechod na platený plán vedie na Stripe Payment Link (Starter `https://buy.stripe.com/5kQcMZ1fA6tZaoWaOh4ko03`, Pro `https://buy.stripe.com/14AdR30bw05BgNk3lP4ko04`) s doplneným `?client_reference_id={tenantId}`, aby webhook v `products/licence-service` vedel, komu plán zmeniť.

| Plán | Cena | Mesačná kvóta (predvolená) |
|---|---|---|
| `free` | zadarmo | 100 rozhovorov |
| `starter` | 19 EUR/mesiac | 1 000 rozhovorov |
| `pro` | 39 EUR/mesiac | 3 000 rozhovorov |

### Zmena plánu (PATCH alebo POST `/v1/tenants/:id/plan`)

Toto je miesto, kde platený plán skutočne zmení, čo tenant smie používať (predtým `POST /v1/tenants` vytvoril vždy len `free` tenanta a nič ho z toho nikdy nedostalo, aj keď zaplatil). Chránené rovnako ako `POST /v1/tenants/:id/reingest`: hlavička `X-Admin-Token` musí sedieť s `ADMIN_TOKEN` secretom, inak `401` (a bez nastaveného `ADMIN_TOKEN` endpoint odmietne úplne všetko).

Telo požiadavky:

```json
{ "plan": "starter", "monthly_quota": 1000, "billing_ref": "sub_...", "valid_until": "2026-11-05" }
```

- `plan` (povinné): `"free"`, `"starter"` alebo `"pro"`, inak `400 validation_failed`.
- `monthly_quota` (voliteľné): kladné celé číslo. Bez neho sa použije predvolená kvóta daného plánu (tabuľka vyššie, `DEFAULT_QUOTAS` v `worker/src/tenants.js`).
- `billing_ref` (voliteľné): ľubovoľný reťazec (napr. Stripe subscription id), uložený tak ako je. Bez neho sa nastaví na `null`.
- `valid_until` (voliteľné): dátum/čas ako reťazec (ISO, napr. `"2026-11-05"`), dokedy plán platí. Bez neho sa nastaví na `null`. Vynucovanie expirácie (downgrade na `free` po `valid_until`) nerobí tento worker sám od seba, robí ho `expire_asistent_plans()` v `products/licence-service/app.py`, volaním tohto istého endpointu s `plan: "free"`, pozri README toho projektu.

`billing_ref` a `valid_until` sú nové nullable stĺpce (`billing_ref TEXT`, `valid_until TEXT`), pridané rovnako ako `product_count`: guardovaným runtime `ALTER TABLE` (`ensureBillingColumns` v `worker/src/tenants.js`), takže existujúca nasadená databáza ich dostane automaticky pri prvom volaní tohto endpointu, bez potreby ručne spúšťať `schema.sql` znova. Verejný `GET /v1/tenants/:id/status` vracia z nich len `valid_until` (`null`, kým nie je nastavené); `billing_ref` dostane iba admin odpoveď tohto endpointu (pozri kontrakt vyššie).

Toto je presne to, čo volá Stripe webhook v `products/licence-service/app.py` (vlastný `ASISTENT_ADMIN_TOKEN`, ktorý sa musí zhodovať s týmto `ADMIN_TOKEN`) po úspešnej platbe alebo obnove predplatného za plán `asistent-starter`/`asistent-pro`, pozri "Platby cez Stripe" nižšie a README `products/licence-service`.

## Platby cez Stripe

Samotné platenie beží v `products/licence-service` (homelab), nie v tomto Cloudflare Workeri: ten webhook prijme Stripe udalosť a zavolá späť sem, na `PATCH /v1/tenants/:id/plan` vyššie. Aby to fungovalo end-to-end, treba dve veci: nastaviť dva `.env` kľúče na homelabe (`products/licence-service`), a vyplniť dva placeholdery na strane frontendu (táto demo stránka, jej kópia v `arling-sk/asistent/`, a WordPress plugin).

### `.env` kľúče na homelabe (`products/licence-service/.env` vedľa `compose.yaml`)

| Kľúč | Hodnota |
|---|---|
| `ASISTENT_ADMIN_TOKEN` | Rovnaká hodnota ako `ADMIN_TOKEN` secret tohto Workera (`wrangler secret put ADMIN_TOKEN` vyššie): jeden zdieľaný token, dve mená v dvoch službách. |
| `ASISTENT_API_BASE` | `https://arling-asistent.arling.workers.dev` (predvolené, netreba nastavovať, ak sa doména Workera nezmenila). |
| `PLANS_JSON` | Doplniť o dva záznamy, jeden na cenu (pozri presný JSON nižšie). |

Presný `PLANS_JSON` snippet na doplnenie (zlúčiť s existujúcimi záznamami pre ostatné nástroje ARLing, nie nahradiť celý súbor):

```json
{
  "price_asistent_starter": {"plan": "asistent-starter", "days": 35},
  "price_asistent_pro": {"plan": "asistent-pro", "days": 35}
}
```

(`price_asistent_starter`/`price_asistent_pro` sú placeholder názvy, nahraďte skutočnými Stripe price id z kroku 2 nižšie. `days: 35` namiesto 30/31 zámerne: pár dní rezervy, aby oneskorené `invoice.paid` doručenie nikdy nestihlo tenanta downgradnúť skôr, než v skutočnosti prestal platiť.)

### Kroky pre vlastníka v Stripe Dashboard

1. **Products** → nový produkt "ARLing Asistent".
2. Na ňom dve **recurring** ceny: 19 EUR/mesiac a 39 EUR/mesiac, obe **s DPH** (tax inclusive), tax code `txcd_10000000` (SaaS/softvér).
3. Pre každú cenu **Payment Link** (Dashboard → Payment links → New): v pokročilých nastaveniach zapnúť **"Collect a client reference ID"** (client reference ID passthrough), bez toho `?client_reference_id=...` z tlačidla nižšie do Stripe Checkout Session vôbec nedorazí, a webhook potom nevie, ktorému tenantovi kvótu zdvihnúť. Success URL: `https://arling.sk/asistent/?upgraded=1`.
4. Skopírovať obe Payment Link URL do `STRIPE_LINKS` v `demo/tenant/tenant.js` (stránka účtu `arling.sk/asistent/tenant/?t=TENANT_ID`, ktorá k odkazu pridá `?client_reference_id=TENANT_ID`; demo stránka na ňu odkazuje z bloku "Váš embed kód" hneď po vytvorení účtu, tlačidlá v cenníku na demo stránke vedú len na skúšobný formulár, lebo bez id tenanta Stripe odkaz nemá zmysel) a do `arling_asistent_stripe_link_starter` / `arling_asistent_stripe_link_pro` filtrov (alebo priamo do `ARLING_ASISTENT_DEFAULT_STRIPE_LINK_STARTER`/`_PRO` konštánt v `wordpress-plugin/arling-asistent/arling-asistent.php`) pre WordPress plugin. Obe URL sú už vyplnené (Starter 19 EUR, Pro 39 EUR, Stripe Managed Payments).
5. Doplniť skutočné price id do `PLANS_JSON` (krok vyššie) a reštartovať `licence` službu (`docker compose up -d --build` alebo `restart`).

Po tomto: zákazník klikne na tlačidlo s vlastným `tenant_id` v `client_reference_id`, zaplatí cez Stripe, `checkout.session.completed` dorazí do `licence-service`, ten zavolá `PATCH /v1/tenants/:id/plan` sem, a tenant má hneď zvýšenú kvótu, bez ručného zásahu.

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

## Demo tenanti

Tenanti vytvorené pre verejné ukážky (obe na pláne `pro`, kvóta 3 000 rozhovorov mesačne, aby demo nikdy nenarazilo na kvótu; nastavené cez `PATCH /v1/tenants/:id/plan`). Tenant id je verejné (je v embed skripte stránky).

| Tenant id | Doména | Ukážka | Feed |
|---|---|---|---|
| `8d9a6783-7ef9-4790-a63b-c52752face6b` | `arling.sk` | https://arling.sk/asistent/ (skúšobný widget po vytvorení účtu, Allbirds, 294 produktov, EN) | Shopify `products.json` |
| `ce535d37-f297-4b43-89dd-30aa7b6301dd` | `ukazka.arling.sk` | https://arling.sk/asistent/ukazka/ (Dobrá domácnosť, fiktívny slovenský obchod, 64 výrobkov v 6 kategóriách, widget `data-lang="sk"` `data-answer-lang="auto"`) | https://arling.sk/asistent/ukazka/feed.xml (Heureka XML) |

Doména `ukazka.arling.sk` neexistuje ako web: `domain` musí byť v D1 unikátna a `arling.sk` už má tenant Allbirds, a stránky na `https://arling.sk` smú volať chat pre ľubovoľného tenanta, lebo `arling.sk` je v `ALLOWED_ORIGINS` (`worker/wrangler.toml`, pozri `isOriginAllowed` v `worker/src/chat.js`). Feed ukážky generuje skript v ops scratch (`gen-ukazka.mjs`, katalóg je v ňom napevno); po zmene feedu stačí pushnúť hub a zavolať `POST /v1/tenants/ce535d37-f297-4b43-89dd-30aa7b6301dd/reingest` s `X-Admin-Token`.

## Životný cyklus (udalosti, e-maily majiteľom, zapojenie na webe)

Návrh: `ops/asistent/zivotny-cyklus.md`. Kód: `worker/src/zivotny-cyklus.js` (udalosti, pravidlá, cron, admin cesty) a `worker/src/zivotny-cyklus-texty.js` (e-maily sk, cs, en, de; čeština a nemčina sú preklad agenta, pred ostrým spustením ich má prečítať Fable). Testy: `tests/zivotny-cyklus.test.mjs`.

**Udalosti** (D1 `tenant_udalosti`, `UNIQUE (tenant_id, kluc)`, zapisujú sa vždy, nič neodchádza von): `vytvoreny`, `ready`, `chyba`, `zapojeny` (Referer pri `GET /widget.js` alebo Origin chatu na doméne obchodu; arling.sk, demo obchody a lokálne adresy nikdy), `prva_otazka`, `aktivny` (aspoň 10 rozhovorov z webu obchodu v aspoň 3 dňoch za 14 dní), `limit_80:RRRR-MM`, `limit_100:RRRR-MM`, `plan:<plan>:<billing_ref>`, `zruseny:<billing_ref>`, `email:E0` až `email:E4`, `emaily_stop`. Nové stĺpce: `tenants.jazyk`, `tenants.zdroj`, `tenants.emaily_stop_at`, `counters.web_conversations`. Worker ich pridá sám (strážený `ALTER TABLE`), ručne `worker/migrations/0001_zivotny_cyklus.sql`.

**E-maily** (najviac 4 za život účtu, `ARLing Asistent <asistent@mail.arling.sk>`, odpovede na `andrej@arling.sk`, Resend s `Idempotency-Key`, bez obrázkov a sledovania):

| Kód | Kedy | Zastaviteľný |
|---|---|---|
| E0 chyba katalógu | 10 minút po prvej chybe, ak obchod nikdy nebol ready; **len adresa overená kódom** | áno |
| E1 pripravené a návod | hneď po prvom ready (alebo hneď po overení adresy); WordPress až po 15 minútach; **len overená adresa alebo zhoda domén** | áno |
| E1W (E1 + E2 naraz) | ready a zapojenie prišli skoro naraz (typicky WordPress plugin); rovnaké overenie ako E1 | áno |
| E2 beží na vašom webe | prvé zapojenie po E1 | áno |
| E3 pomoc so zapojením | 72 h po E1 bez zapojenia, pracovný deň 9:00 až 17:00 Bratislava, nie po E0 | áno |
| E4 80 % limitu | prvé prekročenie 80 % v živote účtu, len plán free | áno |

**Kto dostane automatický e-mail** (adverzárna kontrola 25. 9. 2026, formulár aj API dovolili zadať cudziu adresu): adresa overená 6-miestnym kódom (formulár na arling.sk pošle kód cez `POST /v1/ucet/kod`, po `POST /v1/ucet/over` volá `POST /v1/tenants/:id/overenie` s `Authorization: Bearer`, alebo pošle Bearer rovno pri `POST /v1/tenants`), alebo pri E1 zhoda domén: doména e-mailu aj hostiteľ feedu patria doméne obchodu a nejde o verejnú poštovú doménu (`domenaSedi`). Neoverené účty bez zhody (typicky WordPress plugin s gmail adresou) nedostanú nič automaticky, Andrej ich vidí v CRM a v pingu a môže poslať ručné `uvitaci-email`.

**Stropy:** 4 e-maily za život účtu; 3 e-maily E0/E1 na adresu za deň (KV `email-den:`); globálne `ASISTENT_DENNY_STROP` (predvolene 30) automatických e-mailov za UTC deň, atomicky v D1 `asistent_strop`, nad ním jeden ping `asistent_strop`. Pingy `asistent_novy` za neoverené účty najviac 20 za deň.

**Zastavenie** (`/emaily/stop`) zastaví všetky ďalšie e-maily vrátane E1. Druhé tlačidlo „Tohto Asistenta som nevytváral“ zapíše hash adresy do `asistent_potlacene` (nikdy žiadny e-mail k žiadnemu účtu, ani ručný) a pingne `asistent_odmietnuty`.

Jazyk: `lang` z formulára alebo pluginu (sk, cs, en, de, iné = en); bez neho koncovka domény (.sk, .cz, .de a .at), inak en. Automaticky len účty vytvorené po nasadení (udalosť `vytvoreny` bez `spatne`); staré účty len ručne cez `uvitaci-email`. E2 až E4 len po odoslanom E1 a len s `UCET_TAJOMSTVO` (podpis odkazu na zastavenie). Adresy `@arling.sk` len ak sú v `TEST_EMAILS`. E0 uvádza len hostiteľa feedu; HTML robí odkazy len na `arling.sk` a worker (`POVOLENE_ODKAZY`). Resend 409 `concurrent_idempotent_requests` sa opakuje, 409 `invalid_idempotent_request` je stav `overit` s pingom `asistent_email_overit`; počet produktov a čas zapojenia sa pri prvom pokuse zmrazia, opakovanie posiela to isté telo.

**Vypínače** (`worker/wrangler.toml` `[vars]`, všetky `"vypnute"`): `ASISTENT_EMAILY` (e-maily), `ASISTENT_NTFY` (pingy `asistent_*` na subscribe-service), `ASISTENT_MAZANIE` (automatické zmazanie bezplatného účtu bez rozhovoru za 12 mesiacov). Voliteľná premenná `ASISTENT_VEREJNA_URL` (predvolene `https://arling-asistent.arling.workers.dev`) je základ odkazu na zastavenie.

**Tajomstvá:** existujúce `RESEND_API_KEY`, `UCET_TAJOMSTVO`, `ADMIN_TOKEN`, `TEST_EMAILS`, voliteľne `PING_TOKEN`; **nové** `ASISTENT_ADMIN_ZAPIS` (povinné pre DELETE, doplnit, uvitaci-email; bez neho 503) a voliteľné `ASISTENT_ADMIN_CITANIE` (len čítanie udalostí pre CRM).

**Cron:** `"0 3 * * *"` obnova feedov a denná údržba (mazanie udalostí starších ako 24 mesiacov, starých riadkov stropu, `aktivny` pre dávnejšie zapojené obchody), `"*/10 * * * *"` dobeh: len účty s udalosťou za 11 dní alebo s e-mailom na opakovanie (jeden dopyt `TENANTY_S_PRACOU`), s počítadlom dopytov D1 a zastavením pred limitom (800 z 1000 na spustenie, https://developers.cloudflare.com/d1/platform/limits/). Pozor: samotná nočná obnova feedov (`cron.js refreshAllFeeds`) počítadlo nemá, pri stovkách obchodov narazí na ten istý limit (NEOVERENÉ proti ostrému D1, mimo rozsahu tejto opravy).

**Výmaz:** pred zmazaním sa zapíše `tenant_zmazane` (id, čas). Vektory sa mažú podľa zoznamu id v KV `vektory:<tenant>` (zapisuje ho každé načítanie) a záchranným dopytom, ktorý skončí, keď vráti už zmazané id. `ops/crm/asistent.mjs` podľa `zmazane` zmaže v Twenty časovú os, príležitosť a osobu.

**Cesty:**

| Cesta | Ochrana | Účel |
|---|---|---|
| `GET /v1/admin/asistent/udalosti?po=<id>&limit=<1..500>` | `X-Admin-Token` = `ADMIN_TOKEN` alebo `ASISTENT_ADMIN_CITANIE` | zdroj pre Twenty a brief; vracia `udalosti`, `tenanti` (aj `contact_email`, `domena_sedi`), `zmazane`, `dalsi`, `posledne_id`; demo obchody chýbajú |
| `POST /v1/admin/asistent/doplnit?po=<n>&limit=<1..300>` | `X-Admin-Token` = `ASISTENT_ADMIN_ZAPIS` | jednorazovo `vytvoreny` a `ready` pre staré účty s pôvodnými časmi, bez e-mailov a pingov; po dávkach, `dalsi` je ďalšie `po` |
| `POST /v1/tenants/:id/overenie` | `Authorization: Bearer` z `/v1/ucet/over`, adresa = `contact_email` | overenie adresy z formulára; ak sú produkty načítané, hneď E1 |
| `POST /v1/admin/asistent/uvitaci-email` `{tenant_id, jazyk?, anglicka_veta?, platforma?, rucne_odoslany?}` | `X-Admin-Token` = `ASISTENT_ADMIN_ZAPIS` | ručné E1 (alebo E0) starému účtu, raz; `platforma`: wordpress, woocommerce, shopify, shoptet, eshoprychle, heureka, vseobecne. S `rucne_odoslany: {odoslane_at, resend_id?, poznamka?}` nič neposiela, len zapíše `email:E1` ako odoslaný (uvítanie išlo ručne); po ručnom uvítaní nepríde E3, E2 a E4 áno |
| `POST /v1/tenants/:id/udalost` `{typ:"zruseny", billing_ref, plati_do}` | `X-Admin-Token` | licence-service hlási zrušené predplatné |
| `DELETE /v1/tenants/:id?potvrd=<doména>` | `X-Admin-Token` = `ASISTENT_ADMIN_ZAPIS` | výmaz účtu (riadok, udalosti, počítadlá, vektory, kód chyby a zoznam vektorov v KV), záznam do `tenant_zmazane` |
| `GET`/`POST /v1/tenants/:id/emaily/stop?k=<HMAC>` | podpis | GET ukáže dve tlačidlá, POST (aj RFC 8058 z poštového klienta) zastaví všetky ďalšie e-maily; `akcia=nevytvaral` navyše potlačí adresu |

### Postup nasadenia (robí Fable, v tomto poradí)

Všetky príkazy z `products/arling-asistent/worker`. Hodnoty tokenov nikde nevypisovať; nižšie sú v premenných `ASISTENT_ZAPIS` (nové tajomstvo `ASISTENT_ADMIN_ZAPIS`) a `ASISTENT_CITANIE` (nové `ASISTENT_ADMIN_CITANIE`). `ADMIN_TOKEN` ostáva len pre licence-service (plán, zrušenie, reingest).

1. Testy: `cd .. && npm test && cd worker` (musí byť 0 fail) a `node --test ../../../ops/crm/` (0 fail).
2. Migrácia D1 pred nasadením: `npx wrangler d1 execute asistent --remote --file=migrations/0001_zivotny_cyklus.sql` (ak skončí na „duplicate column name“, zvyšné riadky jednotlivo cez `--command`), potom `npx wrangler d1 execute asistent --remote --file=migrations/0002_overenie_strop_vymaz.sql` (len `CREATE TABLE IF NOT EXISTS`, dá sa spustiť opakovane). Overiť: `npx wrangler d1 execute asistent --remote --command="SELECT name FROM sqlite_master WHERE type='table'"` ukáže `tenant_udalosti`, `asistent_strop`, `asistent_potlacene`, `tenant_zmazane`.
3. Nové tajomstvá (vygenerovať napríklad `openssl rand -base64 32`, uložiť do `C:/Users/User/.secrets/asistent-zapis.txt` a `asistent-citanie.txt`, nikam inam): `npx wrangler secret put ASISTENT_ADMIN_ZAPIS` a `npx wrangler secret put ASISTENT_ADMIN_CITANIE`. Bez `ASISTENT_ADMIN_ZAPIS` odpovedá DELETE, doplnit a uvitaci-email 503.
4. Nasadenie s vypnutými vypínačmi (nič sa neposiela, len sa zapisujú udalosti): `npx wrangler deploy`. Overiť: `curl -s https://arling-asistent.arling.workers.dev/health`, v Cloudflare dashboarde dva Cron Triggers a pri workeri Observability bez invocation logs (`[observability.logs] invocation_logs = false`).
5. Spätné doplnenie udalostí po dávkach: `curl -s -X POST -H "X-Admin-Token: $ASISTENT_ZAPIS" "https://arling-asistent.arling.workers.dev/v1/admin/asistent/doplnit?limit=200"`; kým odpoveď má `"dalsi": N`, opakovať s `&po=N`. Potom `curl -s -H "X-Admin-Token: $ASISTENT_CITANIE" "https://arling-asistent.arling.workers.dev/v1/admin/asistent/udalosti?limit=50"` (tu je aj tenant id ľudovky, doména `www.ludovka.eu`).
6. Ľudovka: uvítací e-mail už dostala ručne 25. 9. 2026 okolo 13:12 (Resend id 01a0d844-aec4-77ba-8fb4-507ef11cbd38, `ops/ai/rozhodnutia.md` riadok 591), E1 sa jej NEPOSIELA. Len zapísať zámok (ešte pred zapnutím `ASISTENT_EMAILY`): `curl -s -X POST -H "X-Admin-Token: $ASISTENT_ZAPIS" -H "Content-Type: application/json" -d '{"tenant_id":"<id z kroku 5>","jazyk":"sk","rucne_odoslany":{"odoslane_at":"2026-09-25T11:12:00Z","resend_id":"01a0d844-aec4-77ba-8fb4-507ef11cbd38","poznamka":"rucne, navod Eshop rychlo"}}' https://arling-asistent.arling.workers.dev/v1/admin/asistent/uvitaci-email`. Očakávané `{"zapisane":true,"poslane":false}`. Ďalší starý účet, ktorému nikto nepísal: rovnaká cesta bez `rucne_odoslany`, v pracovný deň 9:00 až 17:00, s `platforma` podľa webu.
7. Hub: skopírovať `demo/widget.js` do `products/arling-sk/asistent/widget.js` (zmena je pole `surface`) a nasadiť hub so zmenami formulára a zásad (`asistent/app.js` s overením kódom, `asistent/i18n.js`, `asistent/index.html`, `asistent/en/index.html` vygenerovaný cez `node build-i18n.mjs`) podľa skillu arling-deploy, vrátane vizuálnej kontroly poľa na kód na 390 px (ops/design/kontrola-vzhladu.md).
8. CRM: `ops/crm/asistent.mjs` číta `C:/Users/User/.secrets/asistent-citanie.txt` (ak chýba, starý `asistent.txt`); na homelabe v `~/.asistent_admin` nahradiť ADMIN_TOKEN čítacím tokenom. Ak bol `ops/crm/asistent-stav.json` už v gite: `git rm --cached ops/crm/asistent-stav.json` (nový `ops/crm/.gitignore` ho odteraz vynecháva). `node ops/crm/asistent.mjs --dry` musí prejsť bez chyby.
9. Subscribe-service (`products/subscribe-service/app.py`): udalosti a titulky z `NTFY_TITULKY` v `worker/src/zivotny-cyklus.js` (nové: `asistent_strop`, `asistent_odmietnuty`, `asistent_email_overit`) do `PING_EVENTS`, `PING_TITLES`, `PING_TAGS` a `PRIVILEGED_PING_EVENTS`; pre `asistent_*` povoliť v `t` aj bodku a 64 znakov a zobraziť parameter `d`; titulky `quota_80` a `quota_100` na „(nie platba)“. Po nasadení na homelabe v `wrangler.toml` `ASISTENT_NTFY = "zapnute"` a `npx wrangler deploy`.
10. Pred e-mailmi: zápis do `ops/ai/rozhodnutia.md` (text v odpovedi workflowu), hub s novou časťou `#privacy` nasadený (krok 7), v Resende overiť, že `mail.arling.sk` má vypnuté sledovanie otvorení a klikov (NEOVERENÉ). Potom `ASISTENT_EMAILY = "zapnute"` a `npx wrangler deploy`.
11. Prvé ostré overenie (ešte v ten deň, keď je Andrej pri telefóne):
    a) Na `https://arling.sk/asistent/` vytvoriť účet s adresou z `TEST_EMAILS` a verejným feedom testovacej domény. Očakávať e-mail s kódom, po zadaní kódu E1 do minúty. Skontrolovať v ňom: odkaz na zásady `https://arling.sk/asistent/#privacy`, pätu „zastavíte ich tu“, nezlomené „19 €“.
    b) Na stránke zastavenia z toho e-mailu kliknúť „Tohto Asistenta som nevytváral“: príde ntfy „Asistent: niekto odmietol účet, ktorý nevytvoril (nie platba)“.
    c) Druhý účet s tou istou adresou a feedom, ktorý vráti 404, bez kódu: do 20 minút nesmie prísť nič (adresa je potlačená a neoverená).
    d) Zmazať testovacie účty: `curl -s -X DELETE -H "X-Admin-Token: $ASISTENT_ZAPIS" "https://arling-asistent.arling.workers.dev/v1/tenants/<id>?potvrd=<doména>"`, potom `node ops/crm/asistent.mjs` a overiť, že v Twenty zmizla príležitosť, časová os aj osoba (či Twenty REST DELETE maže natrvalo, alebo do koša: NEOVERENÉ).
    e) Pozrieť `wrangler tail` počas jedného 10-minútového cronu: žiadna chyba D1, v logu nie je e-mail ani IP.
12. licence-service: v `handle_subscription_deleted` volať `POST /v1/tenants/{id}/udalost` s `{"typ":"zruseny","billing_ref":...,"plati_do":...}` (ADMIN_TOKEN, záloha už funguje cez `PATCH /plan` na free).
13. WordPress plugin 0.4.0 (`wordpress-plugin/arling-asistent`, posiela `lang` a `zdroj`, text súhlasu hovorí, že návod ide len na adresu na doméne webu): publikovanie cez svn robí Fable; `languages/arling-asistent.pot` nie je pregenerovaný.

Návrat: vypínače späť na `"vypnute"` a `npx wrangler deploy`. Tabuľky a stĺpce môžu ostať, nikomu neprekážajú.

## Čo ešte nie je hotové

- **Platby: zapojené end-to-end, bez portálu na správu predplatného.** `PATCH/POST /v1/tenants/:id/plan` (pozri "Plány" vyššie), Stripe webhook v `products/licence-service` (checkout/renewal pre `asistent-starter`/`asistent-pro`, denný `expire_asistent_plans()` cron) a Stripe Payment Links na stránke účtu `demo/tenant/` (`arling.sk/asistent/tenant/?t=TENANT_ID`, pozri "Platby cez Stripe" nižšie) sú hotové. Zmenu karty a zrušenie robí zákazník v zákazníckom portáli Stripe (https://billing.stripe.com/p/login/3cIaER9M63hNeFcg8B4ko00, prihlásenie e-mailom, ktorým platil), na ktorý odkazuje stránka účtu aj podmienky; worker sám portál nevolá. `POST /v1/tenants` naďalej vytvorí `free` tenanta s pevnou kvótou bez platby.
- **E-mail tenantovi pri 80 % kvóty ide len raz za život účtu** (E4, pozri „Životný cyklus“). Pri 100 % a v ďalších mesiacoch ide len ntfy majiteľovi ARLing a upozornenie v plugine; mesačný e-mail by prekročil strop 4 e-mailov, to je rozhodnutie Andreja.
- **Synchronizácia do Twenty CRM** je v `ops/crm/asistent.mjs` (aj výmaz podľa `zmazane`); beh na homelabe pozri `ops/crm/README.md`.
- **Skúšobný chat na stránke účtu.** E1 preto odkazuje na `arling.sk/asistent/live/?t=...&shop=...`, ktorá chat pre ľubovoľný účet už má.
- **Shoptet doplnok.** Vyžaduje partnerské schválenie (Shoptet reaguje do 4 týždňov, pozri `opportunities/asistent-research.md`), nie je súčasťou tohto MVP. Skript tag funguje na Shoptete aj bez doplnku.
- **WooCommerce plugin a Shopify aplikácia** (inštalácia na klik z ich obchodov s doplnkami). Feed formáty oboch platforiem worker už vie spracovať (`worker/src/feed.js`), chýba len samotný distribučný balík.
- **Načítanie stránok o doprave a obchodných podmienkach.** ADR-04 spomína aj načítanie týchto stránok pri onboardingu; MVP spracúva len produktový feed, obchodné fakty (napríklad kontaktný e-mail) sa zatiaľ zadávajú len cez tenant záznam.
- **EU-only garancia spracovania.** Cloudflare verejne negarantuje, že Workers AI beží výlučne v EÚ (pozri `legal/dpa-sk.md`, článok 7). Zmluva preto stojí na štandardných zmluvných doložkách (SCC) a certifikácii EU Cloud Code of Conduct, nie na technickej záruke.
- **Mazanie vektorov pri zmene feedu.** `embed.js` vie vektory zmazať (`deleteTenantVectors`), ale `cron.js` dnes len prepíše (upsert) existujúce produkty; produkt, ktorý úplne zmizne z feedu, ostáva vo Vectorize ako zastaraný záznam. Čistenie osirotených vektorov je budúce rozšírenie.
- **Admin rozhranie.** Žiadny prehľad tenantov, počítadiel ani logov mimo priameho dotazu do D1.

## Testy

`npm test` (`node --test tests/*.test.mjs`), Node 20+, bez siete. 601 testov (stav 25. 9. 2026), pokrývajúcich okrem životného cyklu (`tests/zivotny-cyklus.test.mjs`): parsovanie všetkých 5 formátov feedu a normalizáciu (Heureka/Zboží.cz XML: detekcia podľa `SHOP` + `SHOPITEM`, CDATA a entity, cena s desatinnou čiarkou, `DELIVERY_DATE` 0/N/prázdne ako `in_stock`/`available_in_N_days`/`unknown`, `PARAM` bloky zložené do popisu po jeho limit, `ITEMGROUP_ID`, `MANUFACTURER`, `EAN`, mena EUR predvolene, CZK pre `.cz` URL, Zboží.cz namespace alebo `CURRENCY`; fixture `tests/fixtures/heureka-sk.xml`), chunkovanie a embedding pipeline, počítanie rozhovorov na reláciu widgetu (rovnaká `session` dvakrát = 1 rozhovor, iná relácia = ďalší, chyba KV = započítať, chýbajúca alebo nevalidná `session` = na request, KV kľúč `conv:{tenant}:{session}` s TTL 86400, odmietnutá kvóta reláciu nezapíše, už započítaná relácia prejde aj po naplnení kvóty), verejný kontrakt `GET /v1/tenants/:id/status` (`conversations_used`, `usage_percent`, `period_start`/`period_end`, `last_ingest`, `trial` hlásený ako `free`, nula po prelome mesiaca, nikdy `billing_ref` ani `contact_email`), upozornenia pri 80 % a 100 % (`worker/src/notify.js`: presná URL pingu, raz za mesiac na tenanta a prah, oba prahy pri skoku, nový mesiac znova, chyba pingu alebo KV nikdy nezhodí chat, `QUOTA_PING_URL=""` vypne), CORS allowlist (vrátane hlavičky na skutočných JSON odpovediach `POST /v1/tenants` a `GET /v1/tenants/:id/status`, nielen na OPTIONS preflighte), rate limiting a jeho fail-open správanie pri chybe KV, limity veľkosti vstupu a ich mapovanie na 413/400 namiesto 500, ochranu proti prompt injection (vrátane popisu produktu s textom "ignore previous instructions"), retrieval z Vectorize vrátane degradovaného nefiltrovaného fallbacku pri chýbajúcom metadata indexe, admin re-ingest endpoint (`POST /v1/tenants/:id/reingest`), admin set-plan endpoint (`PATCH`/`POST /v1/tenants/:id/plan`: autorizáciu, validáciu plánu, predvolené aj vlastné `monthly_quota`, ukladanie a čistenie `billing_ref`/`valid_until`, alias `POST`), validáciu a vytvorenie tenanta (vrátane predvoleného plánu `free` a jeho kvóty), idempotentné `POST /v1/tenants` pri opakovanej doméne (existujúci tenant, obnovenie feedu pri zmene URL alebo starnutí nad 24h, mapovanie iného D1 konfliktu na 409), `product_count` a `billing_ref`/`valid_until` vrátane guardovaného runtime `ALTER TABLE` pre existujúcu D1 databázu (`ensureProductCountColumn`/`setProductCount`, `ensureBillingColumns`/`setTenantPlan` v `worker/src/tenants.js`), mesačnú kvótu a počítadlá, stavbu groundovaného promptu, jazyk `auto` (heuristika `detectLangFromText` a systémový prompt, ktorý necháva model rozpoznať jazyk zákazníka), spracovanie odpovede modelu a celý chat flow s mockovaným modelom vracajúcim JSON, `widget/widget.js` samotný (načítanie cez `node:vm` s minimálnym fake DOM, bez jsdom, vrátane `data-position`, `data-title`, `data-greeting` a `data-lang="auto"` podľa `navigator.language`), a napokon aj wiring na úrovni HTTP routera (`worker/src/index.js`) so skutočnými `Request`/`Response` objektmi.

## Kontakt

ARLing s. r. o. (Bratislava, Slovensko). support@arling.sk

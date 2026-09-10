# arling-asistent worker

Cloudflare Worker (wrangler, plain JavaScript ES modules, žiadny build krok). Nastavenie, chat, onboarding tenantov, widget a cron sú popísané v `../README.md`. Tento súbor popisuje len cesty platenej kontroly súboru (`src/upload.js`), ktoré tu pribudli 10. 9. 2026.

Testy: `cd products/arling-asistent && npm test` (`tests/upload.test.mjs`, všetko cez mock Stripe a mock KV, žiadna sieť).

## Kontrola súboru: verejné cesty

Volá ich len stránka https://arling.sk/kontrola-suboru/nahrat/ (a jej `de/`, `en/` verzie). CORS: len domény z `ALLOWED_ORIGINS`, žiadna hviezdička; preflight pre `/v1/kontrola/*` je prísny (pozri `handleOptions` v `src/index.js`).

| Cesta | Čo robí |
|---|---|
| `POST /v1/kontrola/upload?session_id=cs_...` | Telo je surové XML (max 5 MB). Overí Checkout Session u Stripu (fail-closed: 503 pri výpadku, 404 neznáma session, 402 nezaplatené), uloží do KV `kontrola/<session>/<ISO>-<nonce>.xml` + `.meta.json` s TTL 30 dní. `consent=1` v adrese sa zapíše k súboru. |
| `GET /v1/kontrola/status?session_id=cs_...` | `{paid, uploaded, email_masked, delivered, delivered_at}`; keď `delivered` je `true`, aj `download_xml` a `download_report` (relatívne cesty `/v1/kontrola/download?session_id=...&what=xml|report`). |
| `GET /v1/kontrola/download?session_id=cs_...&what=xml|report` | Dodaný súbor ako príloha (`opraveny-pain001.xml`, `sprava.md`). Rovnaké overenie u Stripu ako nahratie (402 / 404 / 503), 404 `not_delivered` kým dodávka nie je, 400 `bad_what` pre iné `what`. |

Všetky tri zdieľajú limit na IP so `/v1/chat` (každé volanie stojí jeden dopyt na Stripe).

## Kontrola súboru: admin cesty

Hlavička `X-Admin-Token` musí sedieť so secretom `ADMIN_TOKEN` (`wrangler secret put ADMIN_TOKEN`, ten istý ako pre `/v1/tenants/:id/plan`); bez nej, s inou hodnotou, alebo bez nastaveného secretu je odpoveď 401. Volá ich iba `ops/kontrola/zakazka.mjs` z PC, nikdy stránka. Nevolajú Stripe.

| Cesta | Čo robí |
|---|---|
| `GET /v1/kontrola/admin/uploads` | `{uploads: [{session_id, key, uploaded_at, size, consent, email_masked}]}`, najnovšie prvé. Všetko z metadát KV listu (zapisujú sa pri nahratí); staršie nahratia bez metadát majú `size` a `email_masked` `null`. Dodané súbory (`dodanie.xml`) sa v zozname neobjavujú. |
| `GET /v1/kontrola/admin/upload?key=kontrola/cs_.../....xml` | Surový obsah jedného kľúča (`application/xml`, pre `.json` `application/json`). 400 `bad_key` pre kľúč mimo `kontrola/<session>/<názov>`, 404 keď nie je. |
| `PUT /v1/kontrola/admin/deliver?session_id=cs_...` | Telo JSON `{xml, report_md, lang: 'sk'\|'de'\|'en'}`. Uloží `kontrola/<session>/dodanie.xml`, `dodanie.md`, `dodanie.meta.json` (`{delivered_at, lang}`) s TTL 30 dní; meta ide posledný, takže stránka vidí dodávku až keď sú oba súbory na mieste. 400 `missing_fields` s menami chýbajúcich polí, 400 `not_xml`, 413 nad 5 MB. Druhé volanie prepíše prvé. |

## Kľúče v KV `KONTROLA`

```
kontrola/<session_id>/<ISO čas>-<nonce>.xml          nahratý súbor
kontrola/<session_id>/<ISO čas>-<nonce>.meta.json    záznam o nahratí (plný e-mail len tu)
kontrola/<session_id>/dodanie.xml                     opravený súbor
kontrola/<session_id>/dodanie.md                      správa
kontrola/<session_id>/dodanie.meta.json               {session_id, delivered_at, lang, xml_size}
```

`isUploadKey()` v `src/upload.js` odlišuje nahratia od dodávky; `dodanie.xml` sa nikdy nepočíta do limitu 5 nahratí na session.

## Čo worker nerobí

Neposiela e-mail, neparsuje ani neopravuje XML. Analýza beží na PC (`ops/kontrola/zakazka.mjs`, motor `products/sepa-pain001-doctor/doctor-pain001.js`), výsledok sa sem vracia cez `deliver` a zákazník si ho stiahne na stránke, kde súbor nahral. E-mail s odkazom posiela homelab mailer.

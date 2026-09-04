# Zmluva o spracúvaní osobných údajov (čl. 28 GDPR)

Táto zmluva upravuje spracúvanie osobných údajov podľa článku 28 nariadenia (EÚ) 2016/679 (GDPR) medzi prevádzkovateľom a sprostredkovateľom pri používaní služby ARLing Asistent. Je to vzorový dokument: e-shop si doplní svoje identifikačné údaje pri objednaní služby, zvyšný text platí bez zmeny.

## Zmluvné strany

**Prevádzkovateľ:** [názov e-shopu], IČO [doplniť], so sídlom [doplniť adresu] (ďalej len "prevádzkovateľ").

**Sprostredkovateľ:** ARLing s. r. o., IČO 56583486, IČ DPH SK2122352100, so sídlom Ivanská cesta 19112/32E, 821 04 Bratislava, Slovenská republika, e-mail andrej@arling.sk (ďalej len "sprostredkovateľ").

## 1. Predmet zmluvy

Sprostredkovateľ pre prevádzkovateľa prevádzkuje chatový widget ARLing Asistent, ktorý na webovej stránke e-shopu prevádzkovateľa odpovedá návštevníkom na otázky o produktoch. Táto zmluva upravuje podmienky, za ktorých sprostredkovateľ pri tejto činnosti spracúva osobné údaje v mene prevádzkovateľa.

## 2. Doba trvania

Zmluva platí od aktivácie widgetu na webovej stránke prevádzkovateľa (dokončenie nastavenia z produktového feedu) do zániku zmluvného vzťahu o používaní služby ARLing Asistent, bez ohľadu na spôsob jeho ukončenia.

## 3. Povaha a účel spracúvania

Sprostredkovateľ spracúva osobné údaje výhradne na účel poskytovania funkcie chatového asistenta: prijatie otázky návštevníka, vyhľadanie relevantných produktov z feedu prevádzkovateľa a vygenerovanie odpovede. Spracúvanie prebieha automatizovane, bez ľudského zásahu sprostredkovateľa do jednotlivých rozhovorov.

## 4. Kategórie osobných údajov a dotknutých osôb

Dotknuté osoby sú návštevníci webovej stránky prevádzkovateľa, ktorí použijú chatový widget.

Spracúvané kategórie údajov:

- **Obsah správ v chate**, ak návštevník do otázky uvedie osobný údaj (napríklad meno alebo kontakt). Tento obsah sa spracúva len počas vybavenia jednej otázky a **sa nikde neukladá**: ani sprostredkovateľ, ani žiadny jeho subdodávateľ neuchováva históriu ani obsah rozhovorov.
- **Technické údaje** nutné na prevádzku a bezpečnosť widgetu: IP adresa návštevníka (krátkodobo, na ochranu proti zneužitiu, pozri článok 6), jazyk widgetu a doména, z ktorej prišla požiadavka.
- **Súhrnné počítadlá** bez väzby na konkrétnu osobu: počet rozhovorov a počet kliknutí na produkt za deň, na účely fakturácie mesačného limitu.

Sprostredkovateľ neuchováva žiadnu databázu rozhovorov ani profily návštevníkov.

## 5. Povinnosti sprostredkovateľa

Sprostredkovateľ sa zaväzuje:

1. spracúvať osobné údaje len na základe zdokumentovaných pokynov prevádzkovateľa a na účel uvedený v článku 1,
2. zaručiť, že osoby oprávnené spracúvať osobné údaje sú viazané mlčanlivosťou,
3. prijať primerané technické a organizačné opatrenia podľa článku 32 GDPR (článok 6 tejto zmluvy),
4. dodržať podmienky pre zapojenie ďalšieho sprostredkovateľa podľa článku 7 tejto zmluvy,
5. v rámci možností pomôcť prevádzkovateľovi splniť jeho povinnosť reagovať na žiadosti dotknutých osôb o výkon ich práv,
6. pomôcť prevádzkovateľovi zabezpečiť súlad s povinnosťami podľa článkov 32 až 36 GDPR (zabezpečenie, ohlasovanie incidentov, posúdenie vplyvu),
7. po skončení poskytovania služby vymazať alebo vrátiť všetky osobné údaje podľa článku 8 tejto zmluvy,
8. sprístupniť prevádzkovateľovi informácie potrebné na preukázanie súladu s touto zmluvou a umožniť audity podľa článku 9.

## 6. Bezpečnostné opatrenia

Prevádzka beží na infraštruktúre Cloudflare (Workers, Vectorize, D1): šifrovaný prenos (TLS) medzi widgetom, sprostredkovateľom a subdodávateľom, oddelenie dát jednotlivých prevádzkovateľov podľa identifikátora e-shopu, obmedzenie prístupu k administrácii len na sprostredkovateľa a žiadne trvalé úložisko pre obsah rozhovorov. IP adresa návštevníka sa používa krátkodobo len na ochranu proti nadmernému počtu požiadaviek (rate limiting) a nie je súčasťou žiadnej trvalej databázy.

## 7. Subdodávatelia (ďalší sprostredkovatelia)

Prevádzkovateľ súhlasí so zapojením týchto subdodávateľov:

- **Cloudflare, Inc.** (a jej pridružené spoločnosti v EÚ), poskytovateľ infraštruktúry (Workers, Workers AI, Vectorize, D1, KV), na ktorej celá služba beží. Cloudflare so svojimi zákazníkmi uzatvára vlastnú zmluvu o spracúvaní údajov so štandardnými zmluvnými doložkami (SCC) a je certifikovaný podľa EU Cloud Code of Conduct. Presná geografická lokalita spracovania (výlučne EÚ) nie je zo strany Cloudflare verejne garantovaná, prenos mimo EÚ je preto krytý štandardnými zmluvnými doložkami.

Sprostredkovateľ informuje prevádzkovateľa o každej zamýšľanej zmene subdodávateľov aspoň 30 dní vopred na e-mail uvedený pri objednaní služby; prevádzkovateľ môže v tejto lehote vzniesť námietku.

## 8. Vymazanie a vrátenie údajov

Keďže obsah rozhovorov sa priebežne neukladá, po skončení zmluvného vzťahu sprostredkovateľ vymaže do 30 dní: záznam o e-shope prevádzkovateľa (doména, URL feedu, kontaktný e-mail), uložené embeddingy produktov a súhrnné denné počítadlá. Na žiadosť prevádzkovateľa poskytne sprostredkovateľ pred vymazaním export súhrnných počítadlov.

## 9. Audit a kontrola

Sprostredkovateľ poskytne prevádzkovateľovi na požiadanie informácie potrebné na preukázanie súladu s touto zmluvou (napríklad opis technických opatrení podľa článku 6). Prevádzkovateľ môže raz ročne, po predchádzajúcom oznámení aspoň 14 dní vopred, požiadať o primeranú súčinnosť pri overení súladu, spôsobom, ktorý neohrozí bezpečnosť ani prevádzku služby pre ostatných zákazníkov sprostredkovateľa.

## 10. Oznamovanie incidentov

Sprostredkovateľ oznámi prevádzkovateľovi bez zbytočného odkladu, najneskôr do 48 hodín od zistenia, akýkoľvek bezpečnostný incident, ktorý mohol mať vplyv na osobné údaje spracúvané podľa tejto zmluvy, spolu s dostupnými informáciami o jeho povahe a rozsahu.

## 11. Kontakt

Vo veciach tejto zmluvy a ochrany osobných údajov kontaktujte sprostredkovateľa na andrej@arling.sk.

---

Verzia 1.0, platná od 4. septembra 2026. ARLing s. r. o. môže znenie tejto zmluvy upraviť; o zmene informuje prevádzkovateľa aspoň 30 dní vopred na kontaktný e-mail.

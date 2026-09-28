"""Regresia cenovej kontroly ops/oslovenia/predohrej-ukazky.py.

Pokus 3 brány (28. 9. 2026, nález B): „€3.90“ a „1 005.00 EUR“ prešli. Krok 1 asistenta (28. 9., nález W2 posudku
ops/ai/kontrola/2026-09-28-ukazka-pokus3.md): „1  004.50 EUR“ (dve medzery), „-4.50 EUR“ a „€4.50.99“ stále prešli,
lebo výraz hľadal platný podreťazec. Poučenie (ops/ai/POUCENIA.md 28. 9.): test na celú triedu vstupov, nie len na
príklady z posudku. Preto tabuľka TRIEDA nižšie: každý riadok je zápis ceny a buď presná hodnota, alebo chyba.
Pokrýva medzery (počet, druh, poloha), znamienka, desatinné časti, oddeľovače tisícov, meny pred a za číslom,
slovné tvary eura, iné meny a symboly, čísla bez meny, interpunkciu vety okolo ceny.

Každý chybný zápis musí v skutočnom main() s --nahraj zastaviť celú dávku: kód 1 a nula PUT.

Spúšťa tests/ukazka-pokus3.test.mjs (node --test), alebo priamo: python products/arling-asistent/tests/predohrej_ceny_test.py
"""
import importlib.util
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

KOREN = Path(__file__).resolve().parents[3]
OSLOVENIA = KOREN / "ops" / "oslovenia"
sys.path.insert(0, str(OSLOVENIA))
_spec = importlib.util.spec_from_file_location("predohrej", OSLOVENIA / "predohrej-ukazky.py")
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

FRONTA = OSLOVENIA / "fronta" / "dnes-2026-09-28.json"
DOPLNOK = json.loads((OSLOVENIA / "overene-doplnok.json").read_text(encoding="utf-8"))
DOMENY = ["slovenskegranule.sk", "praziarenjolka.sk"]

NB, NN, TH = " ", " ", " "          # nezlomiteľná, úzka nezlomiteľná, úzka medzera
MINUS, EN, EM = "−", "–", "—"       # mínus a dve pomlčky (v tomto súbore len ako escape)

# (text, očakávané hodnoty cien) pre správne zápisy; None = aspoň jedna chyba.
TRIEDA = [
    # základ, mena za číslom aj pred ním, s medzerou aj bez
    ("4.50 EUR", [4.5]), ("4,50 EUR", [4.5]), ("4.50EUR", [4.5]), ("4 EUR", [4.0]), ("4.5 EUR", [4.5]),
    ("€3.90", [3.9]), ("€ 3.90", [3.9]), ("EUR 3,90", [3.9]), ("EUR3,90", [3.9]), ("3,90 €", [3.9]), ("3,90€", [3.9]),
    ("eur 3.90", [3.9]), ("12 eurá", [12.0]), ("12 euro", [12.0]), ("5 eur", [5.0]), ("za 20 eurách", [20.0]),
    (f"4,50{NB}€", [4.5]), (f"€{NB}4.50", [4.5]),
    # tisíce
    ("1 004.50 EUR", [1004.5]), ("1 004,50 €", [1004.5]), (f"1{NB}004,50{NB}€", [1004.5]), (f"1{NN}004.50 EUR", [1004.5]),
    ("1 234 567.89 EUR", [1234567.89]), ("1.004,50 €", [1004.5]), ("1,004.50 EUR", [1004.5]), ("1004.50 EUR", [1004.5]),
    ("€1 004.50", [1004.5]),
    # interpunkcia vety okolo ceny
    ("Stojí €4.50.", [4.5]), ("Stojí 4.50 EUR.", [4.5]), ("(4.50 EUR)", [4.5]), ("za 4.50 EUR, druhá 5.00 EUR", [4.5, 5.0]),
    ("4.50 EUR, 5.00 EUR", [4.5, 5.0]), ("cena: 4.50 EUR;", [4.5]), ("„4.50 EUR“", [4.5]), ("€4.50 EUR", [4.5]),
    # dátum a mená s číslom neprekážajú
    ("28.09.2026 za 4.50 EUR", [4.5]), ("Adult 600 g za 4.50 EUR", [4.5]), ("Európska kvalita", []), ("balenie 2 kg", []),
    # medzery: počet, zmiešané, poloha
    ("1  004.50 EUR", None), (f"1 {NB}004.50 EUR", None), (f"1 004{NB}500.00 EUR", None), ("1 04.50 EUR", None),
    ("12 004 5.00 EUR", None), ("4. 50 EUR", None), ("4 .50 EUR", None), ("€  4.50", None), ("4.50  EUR", None),
    ("€4.50 2", None),
    # znamienka a rozsahy
    ("-4.50 EUR", None), (f"{MINUS}4.50 EUR", None), (f"{EN}4.50 EUR", None), (f"{EM}4.50 EUR", None), ("+4.50 EUR", None),
    ("-€4.50", None), ("€-4.50", None), ("€ -4.50", None), ("- 4.50 EUR", None), ("3-4.50 EUR", None), (f"3{EN}4.50 EUR", None),
    ("€4.50-5.00", None), ("EUR -3,90", None),
    # desatinné časti
    ("€4.50.99", None), ("4.50.99 EUR", None), ("4,50,99 €", None), ("4.505 EUR", None), ("4,5050 €", None), ("4.50,5 EUR", None),
    (".50 EUR", None), (",50 €", None),
    # oddeľovače tisícov nejednoznačné alebo zlé
    ("1,500 EUR", None), ("1.500 €", None), ("1.500.000 EUR", None), ("1,004,50 EUR", None), ("1.0045,50 €", None),
    ("1'004.50 EUR", None), ("1’004.50 EUR", None), ("10,04.50 EUR", None),
    # mena bez čísla, iné meny a symboly
    ("len v EUR", None), ("platba v €", None), ("cena 5 USD", None), ("4.50 USD", None), ("za 9 Kč", None), ("$12", None),
    ("£4.50", None), ("¥500", None), ("12 CHF", None), ("50 zł", None), ("100 Ft", None), ("4 koruny", None), ("10 dolárov", None),
    # číslo, ktoré vyzerá ako cena, ale bez meny
    ("za 3,90", None), ("stojí 4.50", None),
    # krok 1 pokus 2 (nález W2 posudku 2026-09-28-asistent-krok1.md): iné biele, neviditeľné a spojovacie znaky
    # medzi číselnými časťami, pri mene za číslom aj pred ním
    ("1\t004.50 EUR", None), ("1\n004.50 EUR", None), ("1 004.50 EUR", None), ("1\r\n004.50 EUR", None),
    ("1​004.50 EUR", None), ("1⁠004.50 EUR", None), ("1­004.50 EUR", None), ("1　004.50 EUR", None),
    ("1_004.50 EUR", None), ("1·004.50 EUR", None), ("1/004.50 EUR", None), ("1:004.50 EUR", None),
    ("1\t\t\t\t\t004.50 EUR", None), ("4.50\t EUR", None), ("€4\t004.50", None), ("EUR 4\n004", None),
    ("4\t.50 EUR", None), ("€4.50 – 12", None), ("٤.50 EUR", None), ("４.50 EUR", None), ("4² EUR", None),
    # tie isté znaky mimo čísla platnú cenu nepokazia
    ("Cena:\t4.50 EUR", [4.5]), ("Balenie 250 g\n4.50 EUR", [4.5]), ("4.50 EUR\n2 balenia", [4.5]),
    ("Prvé 5.00 EUR,\tdruhé 55.90 EUR", [5.0, 55.9]), ("(€4.50)", [4.5]), ("Stojí €4.50. Ďalšie", [4.5]),
    ("Cena 4.50 EUR, 2 ks za 8.00 EUR", [4.5, 8.0]),
    # vedomá prísnosť: číslo oddelené od ceny len interpunkciou je súčasť výrazu (autor vetu prepíše slovom)
    ("Rok 2026: 4.50 EUR", None), ("3× 4.50 EUR", None),
]

# Trieda oddeľovačov (nález W2): každý medzi dvomi číselnými časťami ceny musí zastaviť dávku, pri mene pred aj za
# číslom a na rôznych pozíciách (tisíce, pred desatinnou bodkou, za ňou, v desatinnej časti).
ZLE_ODDELOVACE = ["\t", "\n", "\r", "\v", "\f", " ", " ", " ", " ", "　", " ", " ",
                  "​", "⁠", "﻿", "­", "  ", "  ", "_", "·", "/", "\t\t\t\t\t\t"]
VZORY = ["1{o}004.50 EUR", "€1{o}004.50", "EUR 1{o}004.50", "4{o}.50 EUR", "4.{o}50 EUR", "€4.5{o}0", "1 004{o}.50 €",
         "1{o}004,50{o}€"]


class _Vystup(io.StringIO):
    def reconfigure(self, **_):
        pass


_VIRTUALNY = Path("virtualny-test-predohrej")
_citaj = Path.read_text


def spusti(doplnok: list) -> tuple:
    """main() s --nahraj nad skutočnou frontou a feedmi, PUT a token nahradené. Vracia (kód, PUT, výpis).

    Nič nepíše na disk (posudok krok 1: prostredie hodnotiteľa nevedelo vytvoriť dočasný adresár): doplnok sa číta
    z pamäte cez virtuálnu cestu, výstupné JSON idú do slovníka. Fronta a feedy sú skutočné súbory."""
    puty, zapisane = [], {}
    obsah = json.dumps(doplnok, ensure_ascii=False)
    cesta = _VIRTUALNY / "doplnok.json"

    def citaj(self, *a, **k):
        return obsah if self == cesta else _citaj(self, *a, **k)

    argv = ["predohrej-ukazky.py", str(FRONTA), "--domeny", *DOMENY, "--doplnok", str(cesta), "--out", str(_VIRTUALNY / "out"), "--nahraj"]
    vystup = _Vystup()
    with mock.patch.object(sys, "argv", argv), \
         mock.patch.object(Path, "read_text", citaj), \
         mock.patch.object(Path, "mkdir", lambda self, *a, **k: None), \
         mock.patch.object(Path, "write_text", lambda self, t, *a, **k: zapisane.__setitem__(str(self), t)), \
         mock.patch.object(P.tajomstva, "admin_zapis", return_value="token-z-testu"), \
         mock.patch.object(P, "nahraj", side_effect=lambda t, telo, tok: puty.append(t) or "200 {\"ok\":true}"), \
         redirect_stdout(vystup):
        kod = P.main()
    return kod, puty, vystup.getvalue()


def s_cenou(stara: str, nova: str) -> list:
    d = json.loads(json.dumps(DOPLNOK))
    for h in d:
        if stara in h["odpoved"]:
            h["odpoved"] = h["odpoved"].replace(stara, nova, 1)
            return d
    raise AssertionError(f"v doplnku nie je {stara}")


class CenyVTexte(unittest.TestCase):
    def test_cela_trieda_zapisov(self):
        self.assertGreaterEqual(len(TRIEDA), 90)
        for text, ocakavane in TRIEDA:
            with self.subTest(text=text.encode("unicode_escape").decode()):
                ceny, chyby = P.ceny_v_texte(text)
                if ocakavane is None:
                    self.assertTrue(chyby, f"prešlo: {ceny}")
                else:
                    self.assertEqual(chyby, [])
                    self.assertEqual([c[3] for c in ceny], ocakavane)

    def test_zapis_ceny_je_cely_vyraz_nie_podretazec(self):
        # Cena sa nesmie zachrániť orezaním: pri chybe nie je v zozname cien ani jej platná časť.
        for text in ["1  004.50 EUR", "-4.50 EUR", "€4.50.99", "3-4.50 EUR"]:
            ceny, chyby = P.ceny_v_texte(text)
            self.assertEqual(ceny, [], text)
            self.assertTrue(chyby, text)

    def test_viaz_ceny_1005_pri_karte_za_5_je_chyba(self):
        karty = [{"title": "Kava Alfa", "price": 5.0}]
        self.assertTrue(P.viaz_ceny("Kava Alfa za 1 005.00 EUR", karty))
        self.assertEqual(P.viaz_ceny("Kava Alfa za 5.00 EUR", karty), [])
        self.assertEqual(P.viaz_ceny("Kava Alfa za €5.", karty), [])
        for zle in ["Kava Alfa za -5.00 EUR", "Kava Alfa za €5.00.99", "Kava Alfa za 0  005.00 EUR"]:
            self.assertTrue(P.viaz_ceny(zle, karty), zle)


class NahratieZastavi(unittest.TestCase):
    def test_skutocny_doplnok_prejde_a_posle_dva_put(self):
        kod, puty, vystup = spusti(DOPLNOK)
        self.assertEqual(kod, 0, vystup)
        self.assertEqual(len(puty), 2)

    def test_sonda_astry_w2_zastavi_celu_davku(self):
        # Presne tri prípady z posudku W2 a ich príbuzní: kód 1 a nula PUT pre celú dávku.
        for nova in ["1  004.50 EUR", "-4.50 EUR", "€4.50.99", f"{MINUS}4.50 EUR", "€-4.50", "4.50.99 EUR", f"1{NB} 004.50 EUR", "3-4.50 EUR"]:
            with self.subTest(nova=nova.encode("unicode_escape").decode()):
                kod, puty, vystup = spusti(s_cenou("4.50 EUR", nova))
                self.assertEqual(kod, 1, vystup)
                self.assertEqual(puty, [])
                self.assertIn("ZASTAVENÉ", vystup)

    def test_sonda_astry_b_mena_pred_cislom_zastavi_celu_davku(self):
        for nova in ["€3.90", "3.90 EUR", "EUR 3,90", "3,90 €"]:
            kod, puty, vystup = spusti(s_cenou("4.50 EUR", nova))
            self.assertEqual(kod, 1, f"{nova}: {vystup}")
            self.assertEqual(puty, [], nova)
            self.assertIn("ZASTAVENÉ", vystup)

    def test_tisice_nejednoznacna_cena_a_ina_mena_zastavia_celu_davku(self):
        for nova in ["1 004.50 EUR", "4,500 EUR", "4.50 USD", "4.50 $", "4,50"]:
            kod, puty, vystup = spusti(s_cenou("4.50 EUR", nova))
            self.assertEqual(kod, 1, f"{nova}: {vystup}")
            self.assertEqual(puty, [], nova)

    def test_w2_pokus2_trieda_oddelovacov_v_texte(self):
        for o in ZLE_ODDELOVACE:
            for vzor in VZORY:
                nova = vzor.format(o=o)
                with self.subTest(nova=nova.encode("unicode_escape").decode()):
                    ceny, chyby = P.ceny_v_texte(nova)
                    self.assertTrue(chyby, f"prešlo: {ceny}")
                    self.assertEqual(ceny, [], "platná časť poškodenej ceny sa nesmie zachrániť")

    def test_w2_pokus2_sonda_astry_cez_main_zastavi_celu_davku(self):
        # Presne tri zápisy zo sondy posudku (predtým kód 0 a dva PUT), potom celá trieda × pozície × poloha meny.
        sonda = ["1\t004.50 EUR", "1\n004.50 EUR", "1 004.50 EUR"]
        trieda = [v.format(o=o) for o in ZLE_ODDELOVACE for v in ["1{o}004.50 EUR", "€1{o}004.50", "4{o}.50 EUR", "4.5{o}0 EUR"]]
        for nova in sonda + trieda:
            with self.subTest(main=nova.encode("unicode_escape").decode()):
                kod, puty, vystup = spusti(s_cenou("4.50 EUR", nova))
                self.assertEqual(kod, 1, vystup)
                self.assertEqual(puty, [])
                self.assertIn("ZASTAVENÉ", vystup)

    def test_rovnaka_cena_v_inom_platnom_zapise_prejde(self):
        # Kontrola nesmie byť len prísna: ten istý údaj v inom platnom zápise dávku nezastaví.
        for nova in ["4,50 EUR", "€4.50", "EUR 4,50", "4,50 €", "4.50 €"]:
            kod, puty, vystup = spusti(s_cenou("4.50 EUR", nova))
            self.assertEqual(kod, 0, f"{nova}: {vystup}")
            self.assertEqual(len(puty), 2, nova)


class Normalizacia(unittest.TestCase):
    def test_zaporne_znamienko_nalez_d(self):
        self.assertEqual(P.normalizuj("Funguje pri -5 °C?"), "funguje pri -5 c")
        self.assertNotEqual(P.normalizuj("Funguje pri -5 °C?"), P.normalizuj("Funguje pri 5 °C?"))
        self.assertEqual(P.normalizuj(f"Funguje pri {MINUS}10 °C?"), "funguje pri -10 c")
        self.assertEqual(P.normalizuj("Model X-5"), "model x 5")


if __name__ == "__main__":
    unittest.main(verbosity=1)

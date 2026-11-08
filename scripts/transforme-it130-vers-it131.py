#!/usr/bin/env python3
"""Transforme les scripts it.130 en scripts it.131 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.130) :
  - identifiants PascalCase IT130 → IT131 (remplacement séparé de it130) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it130.bin) — restauration
    explicite après la cascade it130→it131 ;
  - fenêtre courante d'abord (764/0 → 784/8), PUIS référence historique
    (744/284 → 764/0) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.129, avant gravure it.131 »
    → « d'it.130, avant gravure it.131 » (la fenêtre précédente est it.130) ;
  - RÉFÉRENCES HISTORIQUES PROTÉGÉES (nouveau piège it.131) : « FLEURS
    fr_fr/validation ÉPUISÉ depuis it.129 » est un FAIT HISTORIQUE qui doit
    SURVIVRE aux renommages génériques (it.129 → it.130 corromprait la
    chronologie) — ces occurrences sont blindées par des marqueurs ⟪H129⟫
    substitués en fin de cascade ; même mécanisme pour « offset 0 »
    (⟪O0⟫, début de la fenêtre MLS d'it.130) et pour la fenêtre précédente
    (⟪PREV⟫ = it.130) dans les blocs réécrits ;
  - PAS de changement de source cette fenêtre : MLS french/dev CONTINUE
    (offset 8 après l'offset 0 d'it.130, 2416 lignes disponibles) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it130 + sha130 + titre) ;
  - km130_ → km131_ (préfixe indépendant des identifiants IT).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it130.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it131.py"
GENERE_IN = "scripts/genere-module-multimodal-it130.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it131.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it130.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it131.ts"
TEST_IN = "lib/neural/generation/multimodal-it130.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it131.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it130.py"
DEDUP_OUT = "scripts/verifie-dedup-it131.py"

PREV = "⟪PREV⟫"   # substitué par « it.130 » en fin de cascade
H129 = "⟪H129⟫"   # substitué par « it.129 » en fin de cascade (fait historique)
O0 = "⟪O0⟫"       # substitué par « offset 0 » en fin de cascade (historique MLS)
O764 = "⟪O764⟫"   # substitué par « offset 764 » en fin de cascade (fenêtre
# image précédente — blindage contre le renommage générique 764→784)


def substituer_marqueurs(t: str) -> str:
    return (t.replace(PREV, "it.130").replace(H129, "it.129")
             .replace(O0, "offset 0").replace(O764, "offset 764"))


def transformer_ts(src: str, blocs: list[tuple[str, str]]) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 0. BLOCS SPÉCIFIQUES (réécrits en premier, texte final, marqueurs) —
    #    les marqueurs survivent aux renommages génériques qui suivent.
    for ancien, nouveau in blocs:
        assert ancien in t, f"bloc introuvable : {ancien[:80]!r}…"
        t = t.replace(ancien, nouveau)
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 764", "offset 784")  # fenêtre courante images
    t = t.replace("offset 744", "offset 764")  # référence fenêtre précédente
    # 2. global it.130 → it.131 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.130", "it.131")
    # 3. fenêtre précédente it.129 → it.130 (formes documentées restantes ;
    #    les « ÉPUISÉ depuis it.129 » historiques sont déjà ⟪H129⟫)
    t = t.replace("d'it.129", f"d'{PREV}")
    t = t.replace("(it.129)", f"({PREV})")
    t = t.replace("cumulatif it.129", f"cumulatif {PREV}")
    t = t.replace("après it.129", f"après {PREV}")
    t = t.replace("celle d'it.129", f"celle d'{PREV}")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT130", "IT131")
    t = t.replace("it130", "it131")
    t = t.replace("km130_", "km131_")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.130 était it129.bin ; pour it.131 elle devient it130.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it129.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it130.bin"',
    )
    # 5. substitution finale des marqueurs
    return substituer_marqueurs(t)


# ─── Blocs du générateur de module ────────────────────────────────────────
BLOCS_GENERE = [
    # a. docstring d'en-tête (fenêtre décrite)
    (
        """ * du 08 nov 2026 : 20 images COCO-2017 offset 764 + 8 audios Multilingual
 * LibriSpeech french/dev offset 0 — FLEURS fr_fr/validation ÉPUISÉ depuis
 * it.129 — + fenêtre vidéo UCF101 ÉPUISÉE — preuve du zéro) et émet""",
        f""" * du 08 nov 2026 : 20 images COCO-2017 offset 784 + 8 audios Multilingual
 * LibriSpeech french/dev offset 8 — suite MLS (bascule documentée à
 * {PREV}) : FLEURS fr_fr/validation ÉPUISÉ depuis {H129} — + fenêtre vidéo
 * UCF101 ÉPUISÉE — preuve du zéro) et émet""",
    ),
    # b. puce audio de l'en-tête du module généré
    (
        """ *     Multilingual LibriSpeech (french, dev, fenêtre offset 0 — FLEURS
 *     fr_fr/validation ÉPUISÉ depuis it.129 : 284+5=289 lignes consommées,
 *     splits train/test au-delà de la limite de scan du serveur) avec""",
        f""" *     Multilingual LibriSpeech (french, dev, fenêtre offset 8 — suite MLS
 *     après l'{O0} d'{PREV} ; FLEURS fr_fr/validation ÉPUISÉ depuis {H129} :
 *     284+5=289 lignes consommées, splits train/test au-delà de la limite
 *     de scan du serveur) avec""",
    ),
]

# ─── Blocs de l'entraînement ──────────────────────────────────────────────
BLOCS_ENTRAINEMENT = [
    # a. docstring d'en-tête (fenêtre décrite)
    (
        """ *   - 20 images COCO-2017 (rafaelpadilla/coco2017, val, offset 764,
 *     après l'offset 744 d'it.129) — annotations officielles ;
 *   - 8 audios Multilingual LibriSpeech (french, dev, offset 0 — FLEURS
 *     fr_fr/validation ÉPUISÉ depuis it.129 : 284+5=289 = taille officielle,
 *     splits train/test au-delà de la limite de scan du serveur) —
 *     transcriptions officielles ;""",
        f""" *   - 20 images COCO-2017 (rafaelpadilla/coco2017, val, offset 784,
 *     après l'{O764} d'{PREV}) — annotations officielles ;
 *   - 8 audios Multilingual LibriSpeech (french, dev, offset 8 — suite MLS
 *     après l'{O0} d'{PREV} ; FLEURS fr_fr/validation ÉPUISÉ depuis {H129} :
 *     284+5=289 = taille officielle, splits train/test au-delà de la limite
 *     de scan du serveur) — transcriptions officielles ;""",
    ),
    # b. fenêtres du rapport d'entraînement (audio)
    (
        '''        audio: "facebook/multilingual_librispeech#french/dev offset 0 (8 — FLEURS fr_fr/validation ÉPUISÉ depuis it.129 : 284+5=289 = taille officielle du split ; splits train/test FLEURS dépassent la limite de scan du serveur de datasets — source basculée sur MLS french dev, 2416 lignes disponibles) — après offset 284 (it.129)",''',
        f'''        audio: "facebook/multilingual_librispeech#french/dev offset 8 (8 — suite MLS ; FLEURS fr_fr/validation ÉPUISÉ depuis {H129} : 284+5=289 = taille officielle du split ; splits train/test FLEURS dépassent la limite de scan du serveur de datasets — bascule MLS documentée à {PREV}, 2416 lignes disponibles) — après {O0} ({PREV})",''',
    ),
]


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 0. BLOC EN-TÊTE IMAGES — fenêtre suivante documentée
    t = t.replace(
        """  - IMAGES : rafaelpadilla/coco2017 (val) — fenêtre SUIVANTE après it.129
    (offset 744) — 20 images photoréalistes + annotations d'objets RÉELLES.""",
        f"""  - IMAGES : rafaelpadilla/coco2017 (val) — fenêtre SUIVANTE après {PREV}
    ({O764}) — 20 images photoréalistes + annotations d'objets RÉELLES.""",
    )
    # 1. BLOC EN-TÊTE AUDIO — continuité MLS documentée (PAS de changement
    #    de source : la bascule FLEURS→MLS a été faite à it.130)
    t = t.replace(
        """  - AUDIO  : facebook/multilingual_librispeech (french, dev) — fenêtre
    SUIVANTE (offset 0) — 8 clips de parole française naturelle RÉELLE
    (livres audio du domaine public) + transcriptions officielles —
    CHANGEMENT DE SOURCE : FLEURS fr_fr/validation ÉPUISÉ depuis it.129
    (284+5=289 = taille officielle) ; splits train/test FLEURS au-delà de
    la limite de scan du serveur de datasets (731/445 Mo > 300 Mo).""",
        f"""  - AUDIO  : facebook/multilingual_librispeech (french, dev) — fenêtre
    SUIVANTE (offset 8) — 8 clips de parole française naturelle RÉELLE
    (livres audio du domaine public) + transcriptions officielles —
    suite MLS (bascule documentée à {PREV}) : FLEURS fr_fr/validation
    ÉPUISÉ depuis {H129} (284+5=289 = taille officielle) ; splits
    train/test FLEURS au-delà de la limite de scan du serveur de
    datasets (731/445 Mo > 300 Mo).""",
    )
    # 2. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 764', '"offset": 784')
    t = t.replace('"offset": 0', '"offset": 8')
    t = t.replace("offset 744", "offset 764")   # prose header historique
    # 3. globals
    t = t.replace("it.130", "it.131")
    t = t.replace("it.129", "it.130")
    t = t.replace("it130", "it131")   # chemins + user-agent
    t = t.replace("km130_", "km131_")  # ids de paires
    return substituer_marqueurs(t)


def transformer_test(src: str) -> str:
    t = src
    # 0. BLOCS SPÉCIFIQUES it.131 (avant renommages — texte final, marqueurs)
    #    a. en-tête
    t = t.replace(
        """ * GARDE it.130 — ASSETS MULTIMODAUX RÉELS (fenêtre COCO offset 764 +
 * MLS french/dev offset 0 — FLEURS fr_fr/validation épuisé depuis it.129) :""",
        f""" * GARDE it.131 — ASSETS MULTIMODAUX RÉELS (fenêtre COCO offset 784 +
 * MLS french/dev offset 8 — suite MLS après l'{O0} d'{PREV} ; FLEURS
 * fr_fr/validation épuisé depuis {H129}) :""",
    )
    #    b. titre du test audio : épuisement → continuité MLS documentée
    t = t.replace(
        '  it("changement de source audio documenté : FLEURS fr_fr/validation ÉPUISÉ (289/289) depuis it.129 — fenêtre MLS french/dev offset 0", () => {',
        f'''  it("continuité MLS french/dev : fenêtre offset 8 après {O0} ({PREV}) — FLEURS reste ÉPUISÉ (289/289, depuis {H129})", () => {{''',
    )
    #    c. titre du test des fenêtres suivantes
    t = t.replace(
        '  it("les fenêtres sont les SUIVANTES (COCO offset 764, MLS offset 0 — après it.129 : 744/284)", () => {',
        f'  it("les fenêtres sont les SUIVANTES (COCO offset 784, MLS offset 8 — après {PREV} : 764/0)", () => {{',
    )
    # 1. globals
    t = t.replace("it.130", "it.131")
    t = t.replace("IT130", "IT131")
    t = t.replace("it130", "it131")
    t = t.replace("km130_", "km131_")
    t = t.replace("offset 764", "offset 784")
    t = t.replace("offset 744", "offset 764")
    # 2. titre du test de déduplication : la générique a produit
    #    « … it.129 (744/284) et it.131 (764/0) » — on réinsère la fenêtre
    #    précédente it.130 (764/0) et on corrige la nouvelle fenêtre
    #    it.131 (784/8)
    t = t.replace(
        'it.129 (744/284) et it.131 (764/0)", () => {',
        'it.129 (744/284), it.130 (764/0) et it.131 (784/8)", () => {',
    )
    # 3. ré-import dédié pour la déduplication contre it.130
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT131, PAIRES_MULTIMODAL_IT131 } from "./multimodal-it131";',
        'import { ASSETS_MULTIMODAL_IT130 } from "./multimodal-it130";\nimport { ASSETS_MULTIMODAL_IT131, PAIRES_MULTIMODAL_IT131 } from "./multimodal-it131";',
    )
    # 4. ensembles et attentes de déduplication (ajout sha130)
    t = t.replace(
        "const sha129 = new Set(ASSETS_MULTIMODAL_IT129.map((a) => a.sha256));",
        "const sha129 = new Set(ASSETS_MULTIMODAL_IT129.map((a) => a.sha256));\n    const sha130 = new Set(ASSETS_MULTIMODAL_IT130.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha129.has(a.sha256), `doublon de contenu it.129 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha129.has(a.sha256), `doublon de contenu it.129 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha130.has(a.sha256), `doublon de contenu it.130 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 5. substitution finale des marqueurs
    return substituer_marqueurs(t)


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it.128", "it130", "km130_",
                 '"offset": 764', '"offset": 0', "offset 744",
                 "CHANGEMENT DE SOURCE"]
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it131 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 784', '"offset": 8', "km131_",
                    "multimodal-it131", "offset 764", "après it.130",
                    "suite MLS (bascule documentée à it.130)",
                    "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read(), BLOCS_GENERE)
    # it.129 légitime exactement 2× (faits historiques FLEURS : docstring +
    # puce audio) ; IT130/it130/km130_ interdits (renommages complets).
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    interdits = ["it.128", "IT130", "km130_", "it130", "offset 744",
                 "offset 276", "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it131 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it131/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it131.ts", sortie)',
        "fenêtre offset 784",
        "fenêtre offset 8",
        "celle d'it.130 — offset 764",
        "fenêtre offset 8 — suite MLS",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it130 (identifiant) légitime exactement dans
    #    SNAPSHOT_SOURCE (le point de départ cumulatif)
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read(), BLOCS_ENTRAINEMENT)
    # it.129 légitime exactement 2× (faits historiques FLEURS : docstring +
    # rapport audio) ; it130 (identifiant) légitime exactement dans
    # SNAPSHOT_SOURCE ; IT130/km130_ interdits.
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it130.bin"', "")
    residus = [x for x in ["IT130", "km130_", "it130", "offset 744",
                           "offset 276", "CHANGEMENT DE SOURCE"] if x in t3_sans]
    print(f"entrainement-it131 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it130.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it131.bin"',
        'from "../lib/neural/generation/multimodal-it131"',
        "ASSETS_MULTIMODAL_IT131",
        "PAIRES_MULTIMODAL_IT131",
        "offset 784",
        "offset 8",
        "après l'offset 764 d'it.130",
        "après offset 764 (it.130)",
        "état hérité d'it.130, avant gravure it.131",
        "après offset 0 (it.130)",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128 légitime exactement 2× (import dédup + sha128),
    #    IT129 légitime exactement 2× (import dédup + sha129), IT130
    #    légitime exactement 2× (import dédup + sha130)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT128") == 2, f"IT128 × {t4.count('IT128')} (attendu 2)"
    assert t4.count("it128") == 1, f"it128 × {t4.count('it128')} (attendu 1)"
    assert t4.count("IT129") == 2, f"IT129 × {t4.count('IT129')} (attendu 2)"
    assert t4.count("it129") == 1, f"it129 × {t4.count('it129')} (attendu 1)"
    assert t4.count("IT130") == 2, f"IT130 × {t4.count('IT130')} (attendu 2)"
    assert t4.count("it130") == 1, f"it130 × {t4.count('it130')} (attendu 1)"
    ligne128 = [l for l in t4.splitlines() if "IT128" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT128 } from "./multimodal-it128";' in ligne128
    ligne130 = [l for l in t4.splitlines() if "IT130" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT130 } from "./multimodal-it130";' in ligne130
    for attendu in [
        "km131_",
        "sha130",
        "it.123 (624/236), it.124 (644/244), it.125 (664/252), it.126 (684/260), it.127 (704/268), it.128 (724/276), it.129 (744/284), it.130 (764/0) et it.131 (784/8)",
        "COCO offset 784, MLS offset 8 — après it.130 : 764/0",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km128_", "km129_", "km130_"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it131 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.130", "it.131")
    t5 = t5.replace("it130", "it131")
    interdits = ["it.130", "it130"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it131 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it131/assets.json", "fenêtre it.131"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

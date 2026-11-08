#!/usr/bin/env python3
"""Transforme les scripts it.137 en scripts it.138 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.138) :
  - identifiants PascalCase IT137 → IT138 (remplacement séparé de it137) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it137.bin) — restauration
    explicite après la cascade it137→it138 ;
  - fenêtre courante d'abord (904/56 → 924/64), PUIS références historiques
    (884/48 → 904/56) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (leçon it.133, plan à MARQUEURS ⟪P⟫/⟪Q⟫
    reconduit) : « offset 56 » serait recréé par « offset 48 »→« offset 56 »
    et « offset 924 »... plan verrouillé :
      1. offset 904 → offset ⟪P⟫   (coco courant, protégé)
      2. offset 56  → offset ⟪Q⟫   (mls courant, protégé)
      3. offset 48  → offset 56    (mls précédent — plus aucun 56 vivant)
      4. offset 884 → offset 904   (coco précédent — plus aucun 904 vivant)
      5. offset ⟪P⟫ → offset 924   (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 64    (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure (les ⟪…⟫ sont retirés en fin de plan) ; contrôles de
    sous-chaîne mesurés sur pièce (inventaire « offset N » des 6 fichiers
    it.137 : seuls 4, 48, 56, 884, 904 vivent) : « offset 56 » n'est PAS une
    sous-chaîne vivante d'un autre offset, « offset 4 » (UCF101, preuve du
    zéro) n'est jamais remplacé et « offset 64 » créé en dernier ne matche
    aucune étape ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) »… ne matchent ni les
    globales (it.137→it.138, it.136→it.137 appliquée par FORMES
    documentées d'it.136 / (it.136) / cumulatif it.136 / après it.136)
    ni les renommages d'offsets — vérifié par asserts ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (prose = fenêtre précédente coco + fenêtre courante mls uniquement,
    constaté sur pièce it.137) ;
  - le test de déduplication s'allonge (ajout import it137 + sha137 + titre) ;
  - l'IMPORT dédié it137 est inséré ENTRE les lignes it136 (précédente) et
    it138 (nouvelle courante combinée) — la générique seule laisserait un
    doublon d'identifiant ASSETS_…IT138 ;
  - km137_ → km138_ (préfixe indépendant des identifiants IT).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it137.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it138.py"
GENERE_IN = "scripts/genere-module-multimodal-it137.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it138.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it137.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it138.ts"
TEST_IN = "lib/neural/generation/multimodal-it137.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it138.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it137.py"
DEDUP_OUT = "scripts/verifie-dedup-it138.py"
EVAL_IN = "scripts/evaluation-navigateur-it137.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it138.ts"

P = "⟪P⟫"  # offset coco courant protégé (904 → 924)
Q = "⟪Q⟫"  # offset mls courant protégé (56 → 64)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 904", f"offset {P}"),
    ("offset 56", f"offset {Q}"),
    ("offset 48", "offset 56"),
    ("offset 884", "offset 904"),
    (f"offset {P}", "offset 924"),
    (f"offset {Q}", "offset 64"),
]
# JSON — indépendants (formats « "offset": N » jamais préfixes l'un de
# l'autre dans les fichiers it.137 : 904, 56, 4 — « "offset": 4 » (UCF101)
# n'est JAMAIS remplacé).
OFFSETS_JSON = [
    ('"offset": 904', '"offset": 924'),
    ('"offset": 56', '"offset": 64'),
]


def appliquer_marques(t: str) -> str:
    for ancien, nouveau in OFFSETS_PROSE_MARQUES:
        t = t.replace(ancien, nouveau)
    assert P not in t and Q not in t, "marqueurs ⟪P⟫/⟪Q⟫ résiduels"
    return t


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — plan à marqueurs (voir docstring)
    t = appliquer_marques(t)
    # 2. fenêtre courante it.137 → it.138
    t = t.replace("it.137", "it.138")
    # 3. fenêtre précédente it.136 → it.137 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.136", "d'it.137")
    t = t.replace("(it.136)", "(it.137)")
    t = t.replace("cumulatif it.136", "cumulatif it.137")
    t = t.replace("après it.136", "après it.137")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT137", "IT138")
    t = t.replace("it137", "it138")
    t = t.replace("km137_", "km138_")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.137 était it136.bin — forme inchangée par les règles
    # ci-dessus : « it136 » nu n'est jamais renommé dans les .ts ; pour
    # it.138 la source devient it137.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it136.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it137.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 884", "offset 904")
    t = t.replace("offset 56", "offset 64")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.136 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.137", "it.138")
    t = t.replace("it.136", "it.137")
    t = t.replace("it137", "it138")   # chemins + user-agent
    t = t.replace("km137_", "km138_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals fenêtre courante
    t = t.replace("it.137", "it.138")
    t = t.replace("IT137", "IT138")
    t = t.replace("it137", "it138")
    t = t.replace("km137_", "km138_")
    # 2. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 3. fenêtre précédente — formes documentées (le titre de dédup
    #    « it.136 (884/48) » ne matche pas : pas de forme parenthésée)
    t = t.replace("d'it.136", "d'it.137")
    t = t.replace("(it.136)", "(it.137)")
    t = t.replace("après it.136", "après it.137")
    # 4. titre de déduplication : la générique a produit « … it.136 (884/48)
    #    et it.138 (904/56) » — on réinsère it.137 (904/56) et on corrige la
    #    nouvelle fenêtre it.138 (924/64)
    t = t.replace(
        'it.136 (884/48) et it.138 (904/56)", () => {',
        'it.136 (884/48), it.137 (904/56) et it.138 (924/64)", () => {',
    )
    # 5. titre des fenêtres suivantes : résumé de la fenêtre précédente
    #    (it.137 = 904/56) — la générique a laissé « 884/48 »
    t = t.replace('après it.137 : 884/48)"', 'après it.137 : 904/56)"')
    # 6. import dédié it137 inséré entre it136 (précédente) et it138
    #    (courante combinée)
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT136 } from "./multimodal-it136";\nimport { ASSETS_MULTIMODAL_IT138, PAIRES_MULTIMODAL_IT138 } from "./multimodal-it138";',
        'import { ASSETS_MULTIMODAL_IT136 } from "./multimodal-it136";\nimport { ASSETS_MULTIMODAL_IT137 } from "./multimodal-it137";\nimport { ASSETS_MULTIMODAL_IT138, PAIRES_MULTIMODAL_IT138 } from "./multimodal-it138";',
    )
    # 7. ensembles et attentes de déduplication (ajout sha137)
    t = t.replace(
        "const sha136 = new Set(ASSETS_MULTIMODAL_IT136.map((a) => a.sha256));",
        "const sha136 = new Set(ASSETS_MULTIMODAL_IT136.map((a) => a.sha256));\n    const sha137 = new Set(ASSETS_MULTIMODAL_IT137.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha136.has(a.sha256), `doublon de contenu it.136 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha136.has(a.sha256), `doublon de contenu it.136 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha137.has(a.sha256), `doublon de contenu it.137 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    return t


def transformer_eval(src: str) -> str:
    t = src
    t = t.replace("it.137", "it.138")
    t = t.replace("IT137", "IT138")
    t = t.replace("it137", "it138")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it136", "km137_",
                 '"offset": 904', '"offset": 56', "offset 884", "offset 56"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it138 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.137") == 1, f"it.137 × {t.count('it.137')} (attendu 1 — après it.137)"
    assert t.count("it.138") == 2, f"it.138 × {t.count('it.138')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 924', '"offset": 64', '"offset": 4', "km138_",
                    "multimodal-it138", "(offset 904)", "après it.137",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.137 légitime 3×
    #    (fenêtre précédente : celle d'it.137 + après l'offset 904 d'it.137 +
    #    après l'offset 56 d'it.137)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.137") == 3, f"it.137 × {t2.count('it.137')} (attendu 3 — fenêtre précédente)"
    assert t2.count("it.138") == 3, f"it.138 × {t2.count('it.138')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.136", "IT137", "km137_", "it137", "offset 884",
                 "offset 48", "⟪", "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it138 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it138/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it138.ts", sortie)',
        "fenêtre offset 924",
        "fenêtre offset 64",
        "celle d'it.137 — offset 904",
        "après l'offset 56 d'it.137",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it137 (identifiant) légitime exactement dans
    #    SNAPSHOT_SOURCE ; it.130 légitime 1× ; it.129 légitime 2×
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it137.bin"', "")
    residus = [x for x in ["IT137", "km137_", "it137", "offset 884",
                           "offset 48", "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it138 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it137.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it138.bin"',
        'from "../lib/neural/generation/multimodal-it138"',
        "ASSETS_MULTIMODAL_IT138",
        "PAIRES_MULTIMODAL_IT138",
        "offset 924",
        "offset 64",
        "après l'offset 904 d'it.137",
        "après l'offset 56 d'it.137",
        "celle d'it.137",
        "cumulatif it.137",
        "après offset 904 (it.137)",
        "après offset 56 (it.137)",
        "état hérité d'it.137, avant gravure it.138",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128/…/IT137 légitimes exactement 2× chacun (import dédup
    #    + shaNNN) ; IT138 = fenêtre courante
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT128", "IT129", "IT130", "IT131", "IT132", "IT133", "IT134", "IT135", "IT136", "IT137"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert t4.count("IT138") >= 10, f"IT138 × {t4.count('IT138')} (attendu >= 10 — fenêtre courante)"
    for ident, attendu_n in [("it128", 1), ("it129", 1), ("it130", 1),
                             ("it131", 1), ("it132", 1), ("it133", 1), ("it134", 1),
                             ("it135", 1), ("it136", 1), ("it137", 1), ("it138", 2)]:
        n = t4.count(ident)
        assert n == attendu_n, f"{ident} × {n} (attendu {attendu_n})"
    ligne137 = [l for l in t4.splitlines() if "IT137" in l and "import" in l]
    assert ligne137 == ['import { ASSETS_MULTIMODAL_IT137 } from "./multimodal-it137";'], ligne137
    for attendu in [
        "km138_",
        "sha137",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40), it.136 (884/48), it.137 (904/56) et it.138 (924/64)",
        "COCO offset 924, MLS offset 64 — après it.137 : 904/56",
        "fenêtre offset 64 après offset 56 (it.137)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.137",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km137_", "km136_", "km135_", "km134_", "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it138 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.137)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.137", "it.138")
    t5 = t5.replace("it137", "it138")
    t5 = t5.replace("it.90→it.136", "it.90→it.137")
    # le seul « it.137 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.137") == 1, f"it.137 × {t5.count('it.137')} (attendu 1 — borne du lot historique)"
    interdits = ["it137"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it138 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it138/assets.json", "fenêtre it.138",
                    'multimodal-it138.ts")', "it.90→it.137"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.137", "IT137", "it137"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it138 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it138"',
        "ASSETS_MULTIMODAL_IT138",
        "PAIRES_MULTIMODAL_IT138",
        '"var/evaluation-navigateur-it138.json"',
        "FENÊTRE it.138",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.137 → it.138 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

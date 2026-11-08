#!/usr/bin/env python3
"""Transforme les scripts it.133 en scripts it.134 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.134) :
  - identifiants PascalCase IT133 → IT134 (remplacement séparé de it133) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it133.bin) — restauration
    explicite après la cascade it133→it134 ;
  - fenêtre courante d'abord (824/24 → 844/32), PUIS références historiques
    (804/16 → 824/24) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (leçon it.133, plan à MARQUEURS ⟪P⟫/⟪Q⟫
    reconduit) : « offset 24 » serait recréé par « offset 16 »→« offset 24 »
    et « offset 824 » recréé par « offset 804 »→« offset 824 » — aucun ordre
    purement séquentiel ne convient — plan verrouillé :
      1. offset 824 → offset ⟪P⟫   (coco courant, protégé)
      2. offset 24  → offset ⟪Q⟫   (mls courant, protégé)
      3. offset 16  → offset 24    (mls précédent — plus aucun 16 vivant)
      4. offset 804 → offset 824   (coco précédent — plus aucun 824 vivant)
      5. offset ⟪P⟫ → offset 844   (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 32    (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure (les ⟪…⟫ sont retirés en fin de plan) ; contrôles de
    sous-chaîne : « offset 24 » n'est PAS une sous-chaîne de « offset 824 »
    (espace suivi de 8) et « offset 8 » n'apparaît plus dans aucun plan ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) »… ne matchent ni les
    globales (it.133→it.134, it.132→it.133 appliquée par FORMES
    documentées d'it.132 / (it.132) / cumulatif it.132 / après it.132)
    ni les renommages d'offsets — vérifié par asserts ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (prose = fenêtre précédente coco + fenêtre courante mls uniquement,
    constaté sur pièce it.133) ;
  - le test de déduplication s'allonge (ajout import it133 + sha133 + titre) ;
  - km133_ → km134_ (préfixe indépendant des identifiants IT).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it133.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it134.py"
GENERE_IN = "scripts/genere-module-multimodal-it133.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it134.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it133.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it134.ts"
TEST_IN = "lib/neural/generation/multimodal-it133.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it134.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it133.py"
DEDUP_OUT = "scripts/verifie-dedup-it134.py"
EVAL_IN = "scripts/evaluation-navigateur-it133.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it134.ts"

P = "⟪P⟫"  # offset coco courant protégé (824 → 844)
Q = "⟪Q⟫"  # offset mls courant protégé (24 → 32)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 824", f"offset {P}"),
    ("offset 24", f"offset {Q}"),
    ("offset 16", "offset 24"),
    ("offset 804", "offset 824"),
    (f"offset {P}", "offset 844"),
    (f"offset {Q}", "offset 32"),
]
# JSON — indépendants (formats « "offset": N » jamais préfixes l'un de
# l'autre dans les fichiers it.133 : 824, 24, 4).
OFFSETS_JSON = [
    ('"offset": 824', '"offset": 844'),
    ('"offset": 24', '"offset": 32'),
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
    # 2. fenêtre courante it.133 → it.134
    t = t.replace("it.133", "it.134")
    # 3. fenêtre précédente it.132 → it.133 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.132", "d'it.133")
    t = t.replace("(it.132)", "(it.133)")
    t = t.replace("cumulatif it.132", "cumulatif it.133")
    t = t.replace("après it.132", "après it.133")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT133", "IT134")
    t = t.replace("it133", "it134")
    t = t.replace("km133_", "km134_")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.133 était it132.bin ; pour it.134 elle devient it133.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it132.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it133.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 804", "offset 824")
    t = t.replace("offset 24", "offset 32")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.132 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.133", "it.134")
    t = t.replace("it.132", "it.133")
    t = t.replace("it133", "it134")   # chemins + user-agent
    t = t.replace("km133_", "km134_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals fenêtre courante
    t = t.replace("it.133", "it.134")
    t = t.replace("IT133", "IT134")
    t = t.replace("it133", "it134")
    t = t.replace("km133_", "km134_")
    # 2. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 3. fenêtre précédente — formes documentées (le titre de dédup
    #    « it.132 (804/16) » ne matche pas : pas de forme parenthésée)
    t = t.replace("d'it.132", "d'it.133")
    t = t.replace("(it.132)", "(it.133)")
    t = t.replace("après it.132", "après it.133")
    # 4. titre de déduplication : la générique a produit « … it.132 (804/16)
    #    et it.134 (824/24) » — on réinsère it.133 (824/24) et on corrige la
    #    nouvelle fenêtre it.134 (844/32)
    t = t.replace(
        'it.132 (804/16) et it.134 (824/24)", () => {',
        'it.132 (804/16), it.133 (824/24) et it.134 (844/32)", () => {',
    )
    # 5. titre des fenêtres suivantes : résumé de la fenêtre précédente
    #    (it.133 = 824/24) — la générique a laissé « 804/16 »
    t = t.replace('après it.133 : 804/16)"', 'après it.133 : 824/24)"')
    # 6. ré-import dédié pour la déduplication contre it.133
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT134, PAIRES_MULTIMODAL_IT134 } from "./multimodal-it134";',
        'import { ASSETS_MULTIMODAL_IT133 } from "./multimodal-it133";\nimport { ASSETS_MULTIMODAL_IT134, PAIRES_MULTIMODAL_IT134 } from "./multimodal-it134";',
    )
    # 7. ensembles et attentes de déduplication (ajout sha133)
    t = t.replace(
        "const sha132 = new Set(ASSETS_MULTIMODAL_IT132.map((a) => a.sha256));",
        "const sha132 = new Set(ASSETS_MULTIMODAL_IT132.map((a) => a.sha256));\n    const sha133 = new Set(ASSETS_MULTIMODAL_IT133.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha132.has(a.sha256), `doublon de contenu it.132 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha132.has(a.sha256), `doublon de contenu it.132 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha133.has(a.sha256), `doublon de contenu it.133 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    return t


def transformer_eval(src: str) -> str:
    t = src
    t = t.replace("it.133", "it.134")
    t = t.replace("IT133", "IT134")
    t = t.replace("it133", "it134")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it.132", "it133", "km133_",
                 '"offset": 824', '"offset": 24', "offset 804"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it134 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.133") == 1, f"it.133 × {t.count('it.133')} (attendu 1 — après it.133)"
    assert t.count("it.134") == 2, f"it.134 × {t.count('it.134')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 844', '"offset": 32', '"offset": 4', "km134_",
                    "multimodal-it134", "(offset 824)", "après it.133",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.133 légitime 3×
    #    (fenêtre précédente : celle d'it.133 + après l'offset 824 d'it.133 +
    #    après l'offset 24 d'it.133)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.133") == 3, f"it.133 × {t2.count('it.133')} (attendu 3 — fenêtre précédente : celle d'it.133, après l'offset 824 d'it.133, après l'offset 24 d'it.133)"
    assert t2.count("it.134") == 3, f"it.134 × {t2.count('it.134')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.132", "IT133", "km133_", "it133", "offset 804",
                 "⟪", "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it134 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it134/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it134.ts", sortie)',
        "fenêtre offset 844",
        "fenêtre offset 32",
        "celle d'it.133 — offset 824",
        "après l'offset 24 d'it.133",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it133 (identifiant) légitime exactement dans
    #    SNAPSHOT_SOURCE ; it.130 légitime 1× (fait historique « bascule MLS
    #    documentée à it.130 ») ; it.129 légitime 2× (faits historiques)
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it133.bin"', "")
    residus = [x for x in ["IT133", "km133_", "it133", "offset 804",
                           "offset 16", "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it134 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it133.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it134.bin"',
        'from "../lib/neural/generation/multimodal-it134"',
        "ASSETS_MULTIMODAL_IT134",
        "PAIRES_MULTIMODAL_IT134",
        "offset 844",
        "offset 32",
        "après l'offset 824 d'it.133",
        "après l'offset 24 d'it.133",
        "celle d'it.133",
        "cumulatif it.133",
        "après offset 824 (it.133)",
        "après offset 24 (it.133)",
        "état hérité d'it.133, avant gravure it.134",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128/IT129/IT130/IT131/IT132/IT133 légitimes exactement
    #    2× chacun (import dédup + shaNNN) ; IT134 = fenêtre courante, très
    #    nombreuses références (comme IT133 dans l'entrée it.133)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT128", "IT129", "IT130", "IT131", "IT132", "IT133"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert t4.count("IT134") >= 10, f"IT134 × {t4.count('IT134')} (attendu >= 10 — fenêtre courante)"
    for ident, attendu_n in [("it128", 1), ("it129", 1), ("it130", 1),
                             ("it131", 1), ("it132", 1), ("it133", 1), ("it134", 2)]:
        n = t4.count(ident)
        assert n == attendu_n, f"{ident} × {n} (attendu {attendu_n})"
    ligne133 = [l for l in t4.splitlines() if "IT133" in l and "import" in l]
    assert ligne133 == ['import { ASSETS_MULTIMODAL_IT133 } from "./multimodal-it133";'], ligne133
    for attendu in [
        "km134_",
        "sha133",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24) et it.134 (844/32)",
        "COCO offset 844, MLS offset 32 — après it.133 : 824/24",
        "fenêtre offset 32 après offset 24 (it.133)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.133",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it134 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.133", "it.134")
    t5 = t5.replace("it133", "it134")
    interdits = ["it.133", "it133"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it134 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it134/assets.json", "fenêtre it.134"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.133", "IT133", "it133"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it134 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it134"',
        "ASSETS_MULTIMODAL_IT134",
        "PAIRES_MULTIMODAL_IT134",
        '"var/evaluation-navigateur-it134.json"',
        "FENÊTRE it.134",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.133 → it.134 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

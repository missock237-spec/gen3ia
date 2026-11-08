#!/usr/bin/env python3
"""Transforme les scripts it.132 en scripts it.133 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.133) :
  - identifiants PascalCase IT132 → IT133 (remplacement séparé de it132) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it132.bin) — restauration
    explicite après la cascade it132→it133 ;
  - fenêtre courante d'abord (804/16 → 824/24), PUIS références historiques
    (784/8 → 804/16) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (leçon it.133, NOUVEAU PIÈGE de préfixe
    cyclique) : « offset 8 » est un préfixe de « offset 804 » ET « offset
    824 » (créé par 804→824) ; « offset 16 » créé par 8→16 serait corrompu
    par 16→24. Aucun ordre purement séquentiel ne convient — plan à
    MARQUEURS verrouillé :
      1. offset 804 → offset ⟪P⟫   (coco courant, protégé)
      2. offset 16  → offset ⟪Q⟫   (mls courant, protégé)
      3. offset 8   → offset 16    (mls précédent — plus aucun 8xx vivant)
      4. offset 784 → offset 804   (coco précédent)
      5. offset ⟪P⟫ → offset 824   (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 24    (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure (les ⟪…⟫ sont retirés en fin de plan) ;
  - FAITS HISTORIQUES PROTÉGÉS (sans marqueur cette fois — la cascade ne
    renomme PAS it.130→it.131) : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) »… ne matchent ni les
    globales (it.132→it.133, it.131→it.132 appliquée par FORMES
    documentées d'it.131 / (it.131) / cumulatif it.131 / après it.131)
    ni les renommages d'offsets — vérifié par asserts ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it132 + sha132 + titre) ;
  - km132_ → km133_ (préfixe indépendant des identifiants IT).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it132.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it133.py"
GENERE_IN = "scripts/genere-module-multimodal-it132.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it133.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it132.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it133.ts"
TEST_IN = "lib/neural/generation/multimodal-it132.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it133.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it132.py"
DEDUP_OUT = "scripts/verifie-dedup-it133.py"
EVAL_IN = "scripts/evaluation-navigateur-it132.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it133.ts"

P = "⟪P⟫"  # offset coco courant protégé (804 → 824)
Q = "⟪Q⟫"  # offset mls courant protégé (16 → 24)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 804", f"offset {P}"),
    ("offset 16", f"offset {Q}"),
    ("offset 8", "offset 16"),
    ("offset 784", "offset 804"),
    (f"offset {P}", "offset 824"),
    (f"offset {Q}", "offset 24"),
]
# JSON — indépendants (formats « "offset": N » jamais préfixes l'un de
# l'autre dans les fichiers it.132 : 804, 16, 4).
OFFSETS_JSON = [
    ('"offset": 804', '"offset": 824'),
    ('"offset": 16', '"offset": 24'),
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
    # 2. fenêtre courante it.132 → it.133
    t = t.replace("it.132", "it.133")
    # 3. fenêtre précédente it.131 → it.132 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.131", "d'it.132")
    t = t.replace("(it.131)", "(it.132)")
    t = t.replace("cumulatif it.131", "cumulatif it.132")
    t = t.replace("après it.131", "après it.132")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT132", "IT133")
    t = t.replace("it132", "it133")
    t = t.replace("km132_", "km133_")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.132 était it131.bin ; pour it.133 elle devient it132.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it131.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it132.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 784", "offset 804")
    t = t.replace("offset 16", "offset 24")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.131 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.132", "it.133")
    t = t.replace("it.131", "it.132")
    t = t.replace("it132", "it133")   # chemins + user-agent
    t = t.replace("km132_", "km133_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals fenêtre courante
    t = t.replace("it.132", "it.133")
    t = t.replace("IT132", "IT133")
    t = t.replace("it132", "it133")
    t = t.replace("km132_", "km133_")
    # 2. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 3. fenêtre précédente — formes documentées (le titre de dédup
    #    « it.131 (784/8) » ne matche pas : virgule avant, pas de forme)
    t = t.replace("d'it.131", "d'it.132")
    t = t.replace("(it.131)", "(it.132)")
    t = t.replace("après it.131", "après it.132")
    # 4. titre de déduplication : la générique a produit « … it.131 (784/8)
    #    et it.133 (804/16) » — on réinsère it.132 (804/16) et on corrige la
    #    nouvelle fenêtre it.133 (824/24)
    t = t.replace(
        'it.131 (784/8) et it.133 (804/16)", () => {',
        'it.131 (784/8), it.132 (804/16) et it.133 (824/24)", () => {',
    )
    # 5. titre des fenêtres suivantes : résumé de la fenêtre précédente
    #    (it.132 = 804/16) — la générique a laissé « 784/8 »
    t = t.replace('après it.132 : 784/8)"', 'après it.132 : 804/16)"')
    # 6. ré-import dédié pour la déduplication contre it.132
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT133, PAIRES_MULTIMODAL_IT133 } from "./multimodal-it133";',
        'import { ASSETS_MULTIMODAL_IT132 } from "./multimodal-it132";\nimport { ASSETS_MULTIMODAL_IT133, PAIRES_MULTIMODAL_IT133 } from "./multimodal-it133";',
    )
    # 7. ensembles et attentes de déduplication (ajout sha132)
    t = t.replace(
        "const sha131 = new Set(ASSETS_MULTIMODAL_IT131.map((a) => a.sha256));",
        "const sha131 = new Set(ASSETS_MULTIMODAL_IT131.map((a) => a.sha256));\n    const sha132 = new Set(ASSETS_MULTIMODAL_IT132.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha131.has(a.sha256), `doublon de contenu it.131 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha131.has(a.sha256), `doublon de contenu it.131 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha132.has(a.sha256), `doublon de contenu it.132 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    return t


def transformer_eval(src: str) -> str:
    t = src
    t = t.replace("it.132", "it.133")
    t = t.replace("IT132", "IT133")
    t = t.replace("it132", "it133")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it.131", "it132", "km132_",
                 '"offset": 804', '"offset": 16', "offset 784"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it133 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.132") == 1, f"it.132 × {t.count('it.132')} (attendu 1 — après it.132)"
    assert t.count("it.133") == 2, f"it.133 × {t.count('it.133')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 824', '"offset": 24', '"offset": 4', "km133_",
                    "multimodal-it133", "(offset 804)", "après it.132",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.132 légitime 2×
    #    (fenêtre précédente : celle d'it.132 + après l'offset 16 d'it.132)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.132") == 3, f"it.132 × {t2.count('it.132')} (attendu 3 — fenêtre précédente : celle d'it.132, après l'offset 804 d'it.132, après l'offset 16 d'it.132)"
    assert t2.count("it.133") == 3, f"it.133 × {t2.count('it.133')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.131", "IT132", "km132_", "it132", "offset 784",
                 "⟪", "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it133 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it133/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it133.ts", sortie)',
        "fenêtre offset 824",
        "fenêtre offset 24",
        "celle d'it.132 — offset 804",
        "après l'offset 16 d'it.132",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it132 (identifiant) légitime exactement dans
    #    SNAPSHOT_SOURCE ; it.130 légitime 1× (fait historique « bascule MLS
    #    documentée à it.130 ») ; it.129 légitime 2× (faits historiques)
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it132.bin"', "")
    residus = [x for x in ["IT132", "km132_", "it132", "offset 784",
                           "offset 276", "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it133 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it132.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it133.bin"',
        'from "../lib/neural/generation/multimodal-it133"',
        "ASSETS_MULTIMODAL_IT133",
        "PAIRES_MULTIMODAL_IT133",
        "offset 824",
        "offset 24",
        "après l'offset 804 d'it.132",
        "après l'offset 16 d'it.132",
        "celle d'it.132",
        "cumulatif it.132",
        "après offset 804 (it.132)",
        "après offset 16 (it.132)",
        "état hérité d'it.132, avant gravure it.133",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128/IT129/IT130/IT131/IT132/IT133 légitimes exactement
    #    2× chacun (import dédup + shaNNN) ; IT133 = fenêtre courante, très
    #    nombreuses références (comme IT132 dans l'entrée it.132)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT128", "IT129", "IT130", "IT131", "IT132"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert t4.count("IT133") >= 10, f"IT133 × {t4.count('IT133')} (attendu >= 10 — fenêtre courante)"
    for ident, attendu_n in [("it128", 1), ("it129", 1), ("it130", 1),
                             ("it131", 1), ("it132", 1), ("it133", 2)]:
        n = t4.count(ident)
        assert n == attendu_n, f"{ident} × {n} (attendu {attendu_n})"
    ligne132 = [l for l in t4.splitlines() if "IT132" in l and "import" in l]
    assert ligne132 == ['import { ASSETS_MULTIMODAL_IT132 } from "./multimodal-it132";'], ligne132
    for attendu in [
        "km133_",
        "sha132",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16) et it.133 (824/24)",
        "COCO offset 824, MLS offset 24 — après it.132 : 804/16",
        "fenêtre offset 24 après offset 16 (it.132)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.132",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km132_", "km131_", "km130_", "km129_", "km128_", "⟪"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it133 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.132", "it.133")
    t5 = t5.replace("it132", "it133")
    interdits = ["it.132", "it132"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it133 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it133/assets.json", "fenêtre it.133"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.132", "IT132", "it132"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it133 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it133"',
        "ASSETS_MULTIMODAL_IT133",
        "PAIRES_MULTIMODAL_IT133",
        '"var/evaluation-navigateur-it133.json"',
        "FENÊTRE it.133",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.132 → it.133 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

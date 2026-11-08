#!/usr/bin/env python3
"""Transforme les scripts it.136 en scripts it.137 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.137) :
  - identifiants PascalCase IT136 → IT137 (remplacement séparé de it136) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it136.bin) — restauration
    explicite après la cascade it136→it137 ;
  - fenêtre courante d'abord (884/48 → 904/56), PUIS références historiques
    (864/40 → 884/48) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (leçon it.133, plan à MARQUEURS ⟪P⟫/⟪Q⟫
    reconduit) : « offset 48 » serait recréé par « offset 40 »→« offset 48 »
    et « offset 884 » recréé par « offset 864 »→« offset 884 » — aucun ordre
    purement séquentiel ne convient — plan verrouillé :
      1. offset 884 → offset ⟪P⟫   (coco courant, protégé)
      2. offset 48  → offset ⟪Q⟫   (mls courant, protégé)
      3. offset 40  → offset 48    (mls précédent — plus aucun 48 vivant)
      4. offset 864 → offset 884   (coco précédent — plus aucun 884 vivant)
      5. offset ⟪P⟫ → offset 904   (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 56    (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure (les ⟪…⟫ sont retirés en fin de plan) ; contrôles de
    sous-chaîne mesurés sur pièce (inventaire « offset N » des 6 fichiers
    it.136 : seuls 4, 40, 48, 864, 884 vivent — ni 32 d'it.134 ni 844
    d'it.134 présents) : « offset 48 » n'est PAS une sous-chaîne vivante
    d'un autre offset, « offset 4 » (UCF101, preuve du zéro) n'est jamais
    remplacé et « offset 56 » créé en dernier ne matche aucune étape ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) »… ne matchent ni les
    globales (it.136→it.137, it.135→it.136 appliquée par FORMES
    documentées d'it.135 / (it.135) / cumulatif it.135 / après it.135)
    ni les renommages d'offsets — vérifié par asserts ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (prose = fenêtre précédente coco + fenêtre courante mls uniquement,
    constaté sur pièce it.136) ;
  - le test de déduplication s'allonge (ajout import it136 + sha136 + titre) ;
  - l'IMPORT dédié it136 est inséré ENTRE les lignes it135 (ex-courante
    devenue précédente) et it137 (nouvelle courante combinée) — la
    générique seule créerait un doublon d'identifiant ASSETS_…IT137 ;
  - km136_ → km137_ (préfixe indépendant des identifiants IT).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it136.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it137.py"
GENERE_IN = "scripts/genere-module-multimodal-it136.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it137.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it136.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it137.ts"
TEST_IN = "lib/neural/generation/multimodal-it136.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it137.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it136.py"
DEDUP_OUT = "scripts/verifie-dedup-it137.py"
EVAL_IN = "scripts/evaluation-navigateur-it136.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it137.ts"

P = "⟪P⟫"  # offset coco courant protégé (884 → 904)
Q = "⟪Q⟫"  # offset mls courant protégé (48 → 56)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 884", f"offset {P}"),
    ("offset 48", f"offset {Q}"),
    ("offset 40", "offset 48"),
    ("offset 864", "offset 884"),
    (f"offset {P}", "offset 904"),
    (f"offset {Q}", "offset 56"),
]
# JSON — indépendants (formats « "offset": N » jamais préfixes l'un de
# l'autre dans les fichiers it.136 : 884, 48, 4 — « "offset": 4 » (UCF101)
# n'est JAMAIS remplacé et n'est pas préfixe remplacé).
OFFSETS_JSON = [
    ('"offset": 884', '"offset": 904'),
    ('"offset": 48', '"offset": 56'),
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
    # 2. fenêtre courante it.136 → it.137
    t = t.replace("it.136", "it.137")
    # 3. fenêtre précédente it.135 → it.136 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.135", "d'it.136")
    t = t.replace("(it.135)", "(it.136)")
    t = t.replace("cumulatif it.135", "cumulatif it.136")
    t = t.replace("après it.135", "après it.136")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT136", "IT137")
    t = t.replace("it136", "it137")
    t = t.replace("km136_", "km137_")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.136 était it135.bin — forme inchangée par les règles
    # ci-dessus : « it135 » nu n'est jamais renommé dans les .ts ; pour
    # it.137 la source devient it136.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it135.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it136.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 864", "offset 884")
    t = t.replace("offset 48", "offset 56")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.135 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.136", "it.137")
    t = t.replace("it.135", "it.136")
    t = t.replace("it136", "it137")   # chemins + user-agent
    t = t.replace("km136_", "km137_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals fenêtre courante
    t = t.replace("it.136", "it.137")
    t = t.replace("IT136", "IT137")
    t = t.replace("it136", "it137")
    t = t.replace("km136_", "km137_")
    # 2. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 3. fenêtre précédente — formes documentées (le titre de dédup
    #    « it.135 (864/40) » ne matche pas : pas de forme parenthésée)
    t = t.replace("d'it.135", "d'it.136")
    t = t.replace("(it.135)", "(it.136)")
    t = t.replace("après it.135", "après it.136")
    # 4. titre de déduplication : la générique a produit « … it.135 (864/40)
    #    et it.137 (884/48) » — on réinsère it.136 (884/48) et on corrige la
    #    nouvelle fenêtre it.137 (904/56)
    t = t.replace(
        'it.135 (864/40) et it.137 (884/48)", () => {',
        'it.135 (864/40), it.136 (884/48) et it.137 (904/56)", () => {',
    )
    # 5. titre des fenêtres suivantes : résumé de la fenêtre précédente
    #    (it.136 = 884/48) — la générique a laissé « 864/40 »
    t = t.replace('après it.136 : 864/40)"', 'après it.136 : 884/48)"')
    # 6. import dédié it136 inséré entre it135 (précédente) et it137
    #    (courante combinée) — la générique seule laisserait la ligne it135
    #    transformer en doublon d'identifiant ASSETS_MULTIMODAL_IT137
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT135 } from "./multimodal-it135";\nimport { ASSETS_MULTIMODAL_IT137, PAIRES_MULTIMODAL_IT137 } from "./multimodal-it137";',
        'import { ASSETS_MULTIMODAL_IT135 } from "./multimodal-it135";\nimport { ASSETS_MULTIMODAL_IT136 } from "./multimodal-it136";\nimport { ASSETS_MULTIMODAL_IT137, PAIRES_MULTIMODAL_IT137 } from "./multimodal-it137";',
    )
    # 7. ensembles et attentes de déduplication (ajout sha136)
    t = t.replace(
        "const sha135 = new Set(ASSETS_MULTIMODAL_IT135.map((a) => a.sha256));",
        "const sha135 = new Set(ASSETS_MULTIMODAL_IT135.map((a) => a.sha256));\n    const sha136 = new Set(ASSETS_MULTIMODAL_IT136.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha135.has(a.sha256), `doublon de contenu it.135 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha135.has(a.sha256), `doublon de contenu it.135 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha136.has(a.sha256), `doublon de contenu it.136 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    return t


def transformer_eval(src: str) -> str:
    t = src
    t = t.replace("it.136", "it.137")
    t = t.replace("IT136", "IT137")
    t = t.replace("it136", "it137")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it135", "km136_",
                 '"offset": 884', '"offset": 48', "offset 864", "offset 48"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it137 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.136") == 1, f"it.136 × {t.count('it.136')} (attendu 1 — après it.136)"
    assert t.count("it.137") == 2, f"it.137 × {t.count('it.137')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 904', '"offset": 56', '"offset": 4', "km137_",
                    "multimodal-it137", "(offset 884)", "après it.136",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.136 légitime 3×
    #    (fenêtre précédente : celle d'it.136 + après l'offset 884 d'it.136 +
    #    après l'offset 48 d'it.136)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.136") == 3, f"it.136 × {t2.count('it.136')} (attendu 3 — fenêtre précédente : celle d'it.136, après l'offset 884 d'it.136, après l'offset 48 d'it.136)"
    assert t2.count("it.137") == 3, f"it.137 × {t2.count('it.137')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.135", "IT136", "km136_", "it136", "offset 864",
                 "offset 40", "⟪", "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it137 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it137/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it137.ts", sortie)',
        "fenêtre offset 904",
        "fenêtre offset 56",
        "celle d'it.136 — offset 884",
        "après l'offset 48 d'it.136",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it136 (identifiant) légitime exactement dans
    #    SNAPSHOT_SOURCE ; it.130 légitime 1× (fait historique « bascule MLS
    #    documentée à it.130 ») ; it.129 légitime 2× (faits historiques)
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it136.bin"', "")
    residus = [x for x in ["IT136", "km136_", "it136", "offset 864",
                           "offset 40", "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it137 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it136.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it137.bin"',
        'from "../lib/neural/generation/multimodal-it137"',
        "ASSETS_MULTIMODAL_IT137",
        "PAIRES_MULTIMODAL_IT137",
        "offset 904",
        "offset 56",
        "après l'offset 884 d'it.136",
        "après l'offset 48 d'it.136",
        "celle d'it.136",
        "cumulatif it.136",
        "après offset 884 (it.136)",
        "après offset 48 (it.136)",
        "état hérité d'it.136, avant gravure it.137",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128/…/IT136 légitimes exactement 2× chacun (import dédup
    #    + shaNNN) ; IT137 = fenêtre courante, très nombreuses références
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT128", "IT129", "IT130", "IT131", "IT132", "IT133", "IT134", "IT135", "IT136"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert t4.count("IT137") >= 10, f"IT137 × {t4.count('IT137')} (attendu >= 10 — fenêtre courante)"
    for ident, attendu_n in [("it128", 1), ("it129", 1), ("it130", 1),
                             ("it131", 1), ("it132", 1), ("it133", 1), ("it134", 1),
                             ("it135", 1), ("it136", 1), ("it137", 2)]:
        n = t4.count(ident)
        assert n == attendu_n, f"{ident} × {n} (attendu {attendu_n})"
    ligne136 = [l for l in t4.splitlines() if "IT136" in l and "import" in l]
    assert ligne136 == ['import { ASSETS_MULTIMODAL_IT136 } from "./multimodal-it136";'], ligne136
    for attendu in [
        "km137_",
        "sha136",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40), it.136 (884/48) et it.137 (904/56)",
        "COCO offset 904, MLS offset 56 — après it.136 : 884/48",
        "fenêtre offset 56 après offset 48 (it.136)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.136",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km136_", "km135_", "km134_", "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it137 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.136)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.136", "it.137")
    t5 = t5.replace("it136", "it137")
    t5 = t5.replace("it.90→it.135", "it.90→it.136")
    # le seul « it.136 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.136") == 1, f"it.136 × {t5.count('it.136')} (attendu 1 — borne du lot historique)"
    interdits = ["it136"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it137 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it137/assets.json", "fenêtre it.137",
                    'multimodal-it137.ts")', "it.90→it.136"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.136", "IT136", "it136"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it137 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it137"',
        "ASSETS_MULTIMODAL_IT137",
        "PAIRES_MULTIMODAL_IT137",
        '"var/evaluation-navigateur-it137.json"',
        "FENÊTRE it.137",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.136 → it.137 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

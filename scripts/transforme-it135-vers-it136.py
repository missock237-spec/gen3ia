#!/usr/bin/env python3
"""Transforme les scripts it.135 en scripts it.136 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.136) :
  - identifiants PascalCase IT135 → IT136 (remplacement séparé de it135) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it135.bin) — restauration
    explicite après la cascade it135→it136 ;
  - fenêtre courante d'abord (864/40 → 884/48), PUIS références historiques
    (844/32 → 864/40) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (leçon it.133, plan à MARQUEURS ⟪P⟫/⟪Q⟫
    reconduit) : « offset 40 » serait recréé par « offset 32 »→« offset 40 »
    et « offset 864 » recréé par « offset 844 »→« offset 864 » — aucun ordre
    purement séquentiel ne convient — plan verrouillé :
      1. offset 864 → offset ⟪P⟫   (coco courant, protégé)
      2. offset 40  → offset ⟪Q⟫   (mls courant, protégé)
      3. offset 32  → offset 40    (mls précédent — plus aucun 40 vivant)
      4. offset 844 → offset 864   (coco précédent — plus aucun 864 vivant)
      5. offset ⟪P⟫ → offset 884   (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 48    (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure (les ⟪…⟫ sont retirés en fin de plan) ; contrôles de
    sous-chaîne mesurés sur pièce (inventaire « offset N » des 6 fichiers
    it.135 : seuls 4, 32, 40, 844, 864 vivent — ni 324 d'it.107 ni 244
    d'it.124 présents) : « offset 40 » n'est PAS une sous-chaîne vivante
    d'un autre offset, « offset 4 » (UCF101, preuve du zéro) n'est jamais
    remplacé et « offset 48 » créé en dernier ne matche aucune étape ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) »… ne matchent ni les
    globales (it.135→it.136, it.134→it.135 appliquée par FORMES
    documentées d'it.134 / (it.134) / cumulatif it.134 / après it.134)
    ni les renommages d'offsets — vérifié par asserts ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (prose = fenêtre précédente coco + fenêtre courante mls uniquement,
    constaté sur pièce it.135) ;
  - le test de déduplication s'allonge (ajout import it135 + sha135 + titre) ;
  - km135_ → km136_ (préfixe indépendant des identifiants IT).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it135.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it136.py"
GENERE_IN = "scripts/genere-module-multimodal-it135.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it136.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it135.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it136.ts"
TEST_IN = "lib/neural/generation/multimodal-it135.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it136.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it135.py"
DEDUP_OUT = "scripts/verifie-dedup-it136.py"
EVAL_IN = "scripts/evaluation-navigateur-it135.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it136.ts"

P = "⟪P⟫"  # offset coco courant protégé (864 → 884)
Q = "⟪Q⟫"  # offset mls courant protégé (40 → 48)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 864", f"offset {P}"),
    ("offset 40", f"offset {Q}"),
    ("offset 32", "offset 40"),
    ("offset 844", "offset 864"),
    (f"offset {P}", "offset 884"),
    (f"offset {Q}", "offset 48"),
]
# JSON — indépendants (formats « "offset": N » jamais préfixes l'un de
# l'autre dans les fichiers it.135 : 864, 40, 4).
OFFSETS_JSON = [
    ('"offset": 864', '"offset": 884'),
    ('"offset": 40', '"offset": 48'),
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
    # 2. fenêtre courante it.135 → it.136
    t = t.replace("it.135", "it.136")
    # 3. fenêtre précédente it.134 → it.135 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.134", "d'it.135")
    t = t.replace("(it.134)", "(it.135)")
    t = t.replace("cumulatif it.134", "cumulatif it.135")
    t = t.replace("après it.134", "après it.135")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT135", "IT136")
    t = t.replace("it135", "it136")
    t = t.replace("km135_", "km136_")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.135 était it134.bin ; pour it.136 elle devient it135.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it134.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it135.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 844", "offset 864")
    t = t.replace("offset 40", "offset 48")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.134 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.135", "it.136")
    t = t.replace("it.134", "it.135")
    t = t.replace("it135", "it136")   # chemins + user-agent
    t = t.replace("km135_", "km136_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals fenêtre courante
    t = t.replace("it.135", "it.136")
    t = t.replace("IT135", "IT136")
    t = t.replace("it135", "it136")
    t = t.replace("km135_", "km136_")
    # 2. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 3. fenêtre précédente — formes documentées (le titre de dédup
    #    « it.134 (844/32) » ne matche pas : pas de forme parenthésée)
    t = t.replace("d'it.134", "d'it.135")
    t = t.replace("(it.134)", "(it.135)")
    t = t.replace("après it.134", "après it.135")
    # 4. titre de déduplication : la générique a produit « … it.134 (844/32)
    #    et it.136 (864/40) » — on réinsère it.135 (864/40) et on corrige la
    #    nouvelle fenêtre it.136 (884/48)
    t = t.replace(
        'it.134 (844/32) et it.136 (864/40)", () => {',
        'it.134 (844/32), it.135 (864/40) et it.136 (884/48)", () => {',
    )
    # 5. titre des fenêtres suivantes : résumé de la fenêtre précédente
    #    (it.135 = 864/40) — la générique a laissé « 844/32 »
    t = t.replace('après it.135 : 844/32)"', 'après it.135 : 864/40)"')
    # 6. ré-import dédié pour la déduplication contre it.135
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT136, PAIRES_MULTIMODAL_IT136 } from "./multimodal-it136";',
        'import { ASSETS_MULTIMODAL_IT135 } from "./multimodal-it135";\nimport { ASSETS_MULTIMODAL_IT136, PAIRES_MULTIMODAL_IT136 } from "./multimodal-it136";',
    )
    # 7. ensembles et attentes de déduplication (ajout sha135)
    t = t.replace(
        "const sha134 = new Set(ASSETS_MULTIMODAL_IT134.map((a) => a.sha256));",
        "const sha134 = new Set(ASSETS_MULTIMODAL_IT134.map((a) => a.sha256));\n    const sha135 = new Set(ASSETS_MULTIMODAL_IT135.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha134.has(a.sha256), `doublon de contenu it.134 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha134.has(a.sha256), `doublon de contenu it.134 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha135.has(a.sha256), `doublon de contenu it.135 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    return t


def transformer_eval(src: str) -> str:
    t = src
    t = t.replace("it.135", "it.136")
    t = t.replace("IT135", "IT136")
    t = t.replace("it135", "it136")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it134", "km135_",
                 '"offset": 864', '"offset": 40', "offset 844", "offset 40"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it136 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.135") == 1, f"it.135 × {t.count('it.135')} (attendu 1 — après it.135)"
    assert t.count("it.136") == 2, f"it.136 × {t.count('it.136')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 884', '"offset": 48', '"offset": 4', "km136_",
                    "multimodal-it136", "(offset 864)", "après it.135",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.135 légitime 3×
    #    (fenêtre précédente : celle d'it.135 + après l'offset 864 d'it.135 +
    #    après l'offset 40 d'it.135)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.135") == 3, f"it.135 × {t2.count('it.135')} (attendu 3 — fenêtre précédente : celle d'it.135, après l'offset 864 d'it.135, après l'offset 40 d'it.135)"
    assert t2.count("it.136") == 3, f"it.136 × {t2.count('it.136')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.134", "IT135", "km135_", "it135", "offset 844",
                 "offset 32", "⟪", "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it136 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it136/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it136.ts", sortie)',
        "fenêtre offset 884",
        "fenêtre offset 48",
        "celle d'it.135 — offset 864",
        "après l'offset 40 d'it.135",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it135 (identifiant) légitime exactement dans
    #    SNAPSHOT_SOURCE ; it.130 légitime 1× (fait historique « bascule MLS
    #    documentée à it.130 ») ; it.129 légitime 2× (faits historiques)
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it135.bin"', "")
    residus = [x for x in ["IT135", "km135_", "it135", "offset 844",
                           "offset 32", "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it136 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it135.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it136.bin"',
        'from "../lib/neural/generation/multimodal-it136"',
        "ASSETS_MULTIMODAL_IT136",
        "PAIRES_MULTIMODAL_IT136",
        "offset 884",
        "offset 48",
        "après l'offset 864 d'it.135",
        "après l'offset 40 d'it.135",
        "celle d'it.135",
        "cumulatif it.135",
        "après offset 864 (it.135)",
        "après offset 40 (it.135)",
        "état hérité d'it.135, avant gravure it.136",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128/IT129/IT130/IT131/IT132/IT133/IT134/IT135 légitimes
    #    exactement 2× chacun (import dédup + shaNNN) ; IT136 = fenêtre
    #    courante, très nombreuses références (comme IT135 dans l'entrée it.135)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT128", "IT129", "IT130", "IT131", "IT132", "IT133", "IT134", "IT135"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert t4.count("IT136") >= 10, f"IT136 × {t4.count('IT136')} (attendu >= 10 — fenêtre courante)"
    for ident, attendu_n in [("it128", 1), ("it129", 1), ("it130", 1),
                             ("it131", 1), ("it132", 1), ("it133", 1), ("it134", 1), ("it135", 1), ("it136", 2)]:
        n = t4.count(ident)
        assert n == attendu_n, f"{ident} × {n} (attendu {attendu_n})"
    ligne135 = [l for l in t4.splitlines() if "IT135" in l and "import" in l]
    assert ligne135 == ['import { ASSETS_MULTIMODAL_IT135 } from "./multimodal-it135";'], ligne135
    for attendu in [
        "km136_",
        "sha135",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40) et it.136 (884/48)",
        "COCO offset 884, MLS offset 48 — après it.135 : 864/40",
        "fenêtre offset 48 après offset 40 (it.135)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.135",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km135_", "km134_", "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it136 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.135)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.135", "it.136")
    t5 = t5.replace("it134", "it136")
    t5 = t5.replace("it135", "it136")
    t5 = t5.replace("it.90→it.133", "it.90→it.135")
    # le seul « it.135 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.135") == 1, f"it.135 × {t5.count('it.135')} (attendu 1 — borne du lot historique)"
    interdits = ["it135"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it136 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it136/assets.json", "fenêtre it.136",
                    'multimodal-it136.ts")', "it.90→it.135"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.135", "IT135", "it135"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it136 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it136"',
        "ASSETS_MULTIMODAL_IT136",
        "PAIRES_MULTIMODAL_IT136",
        '"var/evaluation-navigateur-it136.json"',
        "FENÊTRE it.136",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.135 → it.136 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

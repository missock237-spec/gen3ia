#!/usr/bin/env python3
"""Transforme les scripts it.134 en scripts it.135 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.135) :
  - identifiants PascalCase IT134 → IT135 (remplacement séparé de it134) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it134.bin) — restauration
    explicite après la cascade it134→it135 ;
  - fenêtre courante d'abord (844/32 → 864/40), PUIS références historiques
    (824/24 → 844/32) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (leçon it.133, plan à MARQUEURS ⟪P⟫/⟪Q⟫
    reconduit) : « offset 32 » serait recréé par « offset 24 »→« offset 32 »
    et « offset 844 » recréé par « offset 824 »→« offset 844 » — aucun ordre
    purement séquentiel ne convient — plan verrouillé :
      1. offset 844 → offset ⟪P⟫   (coco courant, protégé)
      2. offset 32  → offset ⟪Q⟫   (mls courant, protégé)
      3. offset 24  → offset 32    (mls précédent — plus aucun 32 vivant)
      4. offset 824 → offset 844   (coco précédent — plus aucun 844 vivant)
      5. offset ⟪P⟫ → offset 864   (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 40    (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure (les ⟪…⟫ sont retirés en fin de plan) ; contrôles de
    sous-chaîne mesurés sur pièce (inventaire « offset N » des 6 fichiers
    it.134 : seuls 4, 24, 32, 824, 844 vivent — ni 324 d'it.107 ni 244
    d'it.124 présents) : « offset 32 » n'est PAS une sous-chaîne vivante
    d'un autre offset, « offset 4 » (UCF101, preuve du zéro) n'est jamais
    remplacé et « offset 40 » créé en dernier ne matche aucune étape ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) »… ne matchent ni les
    globales (it.134→it.135, it.133→it.134 appliquée par FORMES
    documentées d'it.133 / (it.133) / cumulatif it.133 / après it.133)
    ni les renommages d'offsets — vérifié par asserts ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (prose = fenêtre précédente coco + fenêtre courante mls uniquement,
    constaté sur pièce it.134) ;
  - le test de déduplication s'allonge (ajout import it134 + sha134 + titre) ;
  - km134_ → km135_ (préfixe indépendant des identifiants IT).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it134.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it135.py"
GENERE_IN = "scripts/genere-module-multimodal-it134.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it135.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it134.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it135.ts"
TEST_IN = "lib/neural/generation/multimodal-it134.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it135.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it134.py"
DEDUP_OUT = "scripts/verifie-dedup-it135.py"
EVAL_IN = "scripts/evaluation-navigateur-it134.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it135.ts"

P = "⟪P⟫"  # offset coco courant protégé (844 → 864)
Q = "⟪Q⟫"  # offset mls courant protégé (32 → 40)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 844", f"offset {P}"),
    ("offset 32", f"offset {Q}"),
    ("offset 24", "offset 32"),
    ("offset 824", "offset 844"),
    (f"offset {P}", "offset 864"),
    (f"offset {Q}", "offset 40"),
]
# JSON — indépendants (formats « "offset": N » jamais préfixes l'un de
# l'autre dans les fichiers it.134 : 844, 32, 4).
OFFSETS_JSON = [
    ('"offset": 844', '"offset": 864'),
    ('"offset": 32', '"offset": 40'),
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
    # 2. fenêtre courante it.134 → it.135
    t = t.replace("it.134", "it.135")
    # 3. fenêtre précédente it.133 → it.134 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.133", "d'it.134")
    t = t.replace("(it.133)", "(it.134)")
    t = t.replace("cumulatif it.133", "cumulatif it.134")
    t = t.replace("après it.133", "après it.134")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT134", "IT135")
    t = t.replace("it134", "it135")
    t = t.replace("km134_", "km135_")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.134 était it133.bin ; pour it.135 elle devient it134.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it133.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it134.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 824", "offset 844")
    t = t.replace("offset 32", "offset 40")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.133 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.134", "it.135")
    t = t.replace("it.133", "it.134")
    t = t.replace("it134", "it135")   # chemins + user-agent
    t = t.replace("km134_", "km135_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals fenêtre courante
    t = t.replace("it.134", "it.135")
    t = t.replace("IT134", "IT135")
    t = t.replace("it134", "it135")
    t = t.replace("km134_", "km135_")
    # 2. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 3. fenêtre précédente — formes documentées (le titre de dédup
    #    « it.133 (824/24) » ne matche pas : pas de forme parenthésée)
    t = t.replace("d'it.133", "d'it.134")
    t = t.replace("(it.133)", "(it.134)")
    t = t.replace("après it.133", "après it.134")
    # 4. titre de déduplication : la générique a produit « … it.133 (824/24)
    #    et it.135 (844/32) » — on réinsère it.134 (844/32) et on corrige la
    #    nouvelle fenêtre it.135 (864/40)
    t = t.replace(
        'it.133 (824/24) et it.135 (844/32)", () => {',
        'it.133 (824/24), it.134 (844/32) et it.135 (864/40)", () => {',
    )
    # 5. titre des fenêtres suivantes : résumé de la fenêtre précédente
    #    (it.134 = 844/32) — la générique a laissé « 824/24 »
    t = t.replace('après it.134 : 824/24)"', 'après it.134 : 844/32)"')
    # 6. ré-import dédié pour la déduplication contre it.134
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT135, PAIRES_MULTIMODAL_IT135 } from "./multimodal-it135";',
        'import { ASSETS_MULTIMODAL_IT134 } from "./multimodal-it134";\nimport { ASSETS_MULTIMODAL_IT135, PAIRES_MULTIMODAL_IT135 } from "./multimodal-it135";',
    )
    # 7. ensembles et attentes de déduplication (ajout sha134)
    t = t.replace(
        "const sha133 = new Set(ASSETS_MULTIMODAL_IT133.map((a) => a.sha256));",
        "const sha133 = new Set(ASSETS_MULTIMODAL_IT133.map((a) => a.sha256));\n    const sha134 = new Set(ASSETS_MULTIMODAL_IT134.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha133.has(a.sha256), `doublon de contenu it.133 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha133.has(a.sha256), `doublon de contenu it.133 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha134.has(a.sha256), `doublon de contenu it.134 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    return t


def transformer_eval(src: str) -> str:
    t = src
    t = t.replace("it.134", "it.135")
    t = t.replace("IT134", "IT135")
    t = t.replace("it134", "it135")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it.133", "it134", "km134_",
                 '"offset": 844', '"offset": 32', "offset 824"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it135 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.134") == 1, f"it.134 × {t.count('it.134')} (attendu 1 — après it.134)"
    assert t.count("it.135") == 2, f"it.135 × {t.count('it.135')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 864', '"offset": 40', '"offset": 4', "km135_",
                    "multimodal-it135", "(offset 844)", "après it.134",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.134 légitime 3×
    #    (fenêtre précédente : celle d'it.134 + après l'offset 844 d'it.134 +
    #    après l'offset 32 d'it.134)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.134") == 3, f"it.134 × {t2.count('it.134')} (attendu 3 — fenêtre précédente : celle d'it.134, après l'offset 844 d'it.134, après l'offset 32 d'it.134)"
    assert t2.count("it.135") == 3, f"it.135 × {t2.count('it.135')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.133", "IT134", "km134_", "it134", "offset 824",
                 "⟪", "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it135 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it135/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it135.ts", sortie)',
        "fenêtre offset 864",
        "fenêtre offset 40",
        "celle d'it.134 — offset 844",
        "après l'offset 32 d'it.134",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it134 (identifiant) légitime exactement dans
    #    SNAPSHOT_SOURCE ; it.130 légitime 1× (fait historique « bascule MLS
    #    documentée à it.130 ») ; it.129 légitime 2× (faits historiques)
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it134.bin"', "")
    residus = [x for x in ["IT134", "km134_", "it134", "offset 824",
                           "offset 24", "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it135 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it134.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it135.bin"',
        'from "../lib/neural/generation/multimodal-it135"',
        "ASSETS_MULTIMODAL_IT135",
        "PAIRES_MULTIMODAL_IT135",
        "offset 864",
        "offset 40",
        "après l'offset 844 d'it.134",
        "après l'offset 32 d'it.134",
        "celle d'it.134",
        "cumulatif it.134",
        "après offset 844 (it.134)",
        "après offset 32 (it.134)",
        "état hérité d'it.134, avant gravure it.135",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128/IT129/IT130/IT131/IT132/IT133/IT134 légitimes
    #    exactement 2× chacun (import dédup + shaNNN) ; IT135 = fenêtre
    #    courante, très nombreuses références (comme IT134 dans l'entrée it.134)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT128", "IT129", "IT130", "IT131", "IT132", "IT133", "IT134"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert t4.count("IT135") >= 10, f"IT135 × {t4.count('IT135')} (attendu >= 10 — fenêtre courante)"
    for ident, attendu_n in [("it128", 1), ("it129", 1), ("it130", 1),
                             ("it131", 1), ("it132", 1), ("it133", 1), ("it134", 1), ("it135", 2)]:
        n = t4.count(ident)
        assert n == attendu_n, f"{ident} × {n} (attendu {attendu_n})"
    ligne134 = [l for l in t4.splitlines() if "IT134" in l and "import" in l]
    assert ligne134 == ['import { ASSETS_MULTIMODAL_IT134 } from "./multimodal-it134";'], ligne134
    for attendu in [
        "km135_",
        "sha134",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32) et it.135 (864/40)",
        "COCO offset 864, MLS offset 40 — après it.134 : 844/32",
        "fenêtre offset 40 après offset 32 (it.134)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.134",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km134_", "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it135 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.134", "it.135")
    t5 = t5.replace("it134", "it135")
    interdits = ["it.134", "it134"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it135 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it135/assets.json", "fenêtre it.135"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt134/fenetreIt134 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.134", "IT134", "it134"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it135 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it135"',
        "ASSETS_MULTIMODAL_IT135",
        "PAIRES_MULTIMODAL_IT135",
        '"var/evaluation-navigateur-it135.json"',
        "FENÊTRE it.135",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.134 → it.135 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

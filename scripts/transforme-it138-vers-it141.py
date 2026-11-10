#!/usr/bin/env python3
"""Transforme les scripts it.138 en scripts it.141 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

CONTEXTE it.141 : les ticks it.139 (charte) et it.140 (voix naturelle + ASR)
n'ont PAS consommé de fenêtre de données — la fenêtre prévue it.140
(COCO offset 944 / MLS offset 72) se décale en it.141 (annoncé dans le
message feat it.140). La fenêtre PRÉCÉDENTE reste donc it.138 (924/64) ;
it.137 (904/56) devient la fenêtre ante-précédente référencée.

Pièges traités (leçons it.106→…→it.141) :
  - identifiants PascalCase IT138 → IT141 (remplacement séparé de it138) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it138.bin) — la cascade
    « it138→it141 puis it137→it138 » (courante d'abord, précédente ensuite)
    produit la source correcte SANS restauration explicite ;
  - fenêtre courante d'abord (924/64 → 944/72), PUIS références historiques
    (904/56 → 924/64) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (leçon it.133, plan à MARQUEURS ⟪P⟫/⟪Q⟫
    reconduit) : « offset 64 » serait recréé par « offset 56 »→« offset 64 »
    et « offset 924 »... plan verrouillé :
      1. offset 924 → offset ⟪P⟫   (coco courant, protégé)
      2. offset 64  → offset ⟪Q⟫   (mls courant, protégé)
      3. offset 56  → offset 64    (mls précédent — plus aucun 64 vivant)
      4. offset 904 → offset 924   (coco précédent — plus aucun 924 vivant)
      5. offset ⟪P⟫ → offset 944   (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 72    (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure (les ⟪…⟫ sont retirés en fin de plan) ; contrôles de
    sous-chaîne mesurés sur pièce (inventaire « offset N » des 6 fichiers
    it.138 : seuls 4, 56, 64, 904, 924 vivent) : « offset 4 » (UCF101,
    preuve du zéro) n'est jamais remplacé et « offset 72 » créé en dernier
    ne matche aucune étape ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) »… ne matchent ni les
    globales (it.138→it.141 ; formes documentées d'it.137 : d'it.137 /
    (it.137) / cumulatif it.137 / après it.137) ni les renommages
    d'offsets — vérifié par asserts ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (prose telecharge = fenêtre précédente coco + fenêtre courante mls
    uniquement, constaté sur pièce it.138) ;
  - le test de déduplication s'allonge (ajout import it138 + sha138 + titre) ;
  - l'IMPORT dédié it138 est inséré ENTRE les lignes it137 (précédente) et
    it141 (nouvelle courante combinée) — la générique seule laisserait un
    doublon d'identifiant ASSETS_…IT141 ;
  - PROTECTION SPÉCIFIQUE TEST : « it137 » (nu, sans point) ne vit dans le
    test it.138 QUE dans le chemin d'import de la fenêtre précédente
    ("./multimodal-it137" — mesuré : exactement 1 occurrence) — ce chemin
    NE DOIT PAS être renommé (le module it137 existe toujours) : aucune
    règle « it137 » n'est appliquée au test ;
  - km138_ → km141_ (préfixe indépendant des identifiants IT).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it138.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it141.py"
GENERE_IN = "scripts/genere-module-multimodal-it138.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it141.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it138.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it141.ts"
TEST_IN = "lib/neural/generation/multimodal-it138.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it141.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it138.py"
DEDUP_OUT = "scripts/verifie-dedup-it141.py"
EVAL_IN = "scripts/evaluation-navigateur-it138.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it141.ts"

P = "⟪P⟫"  # offset coco courant protégé (924 → 944)
Q = "⟪Q⟫"  # offset mls courant protégé (64 → 72)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 924", f"offset {P}"),
    ("offset 64", f"offset {Q}"),
    ("offset 56", "offset 64"),
    ("offset 904", "offset 924"),
    (f"offset {P}", "offset 944"),
    (f"offset {Q}", "offset 72"),
]
# JSON — indépendants (formats « "offset": N » jamais préfixes l'un de
# l'autre dans les fichiers it.138 : 924, 64, 4 — « "offset": 4 » (UCF101)
# n'est JAMAIS remplacé).
OFFSETS_JSON = [
    ('"offset": 924', '"offset": 944'),
    ('"offset": 64', '"offset": 72'),
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
    # 2. fenêtre courante it.138 → it.141
    t = t.replace("it.138", "it.141")
    # 3. fenêtre précédente it.137 → it.138 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.137", "d'it.138")
    t = t.replace("(it.137)", "(it.138)")
    t = t.replace("cumulatif it.137", "cumulatif it.138")
    t = t.replace("après it.137", "après it.138")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT138", "IT141")
    t = t.replace("it138", "it141")
    t = t.replace("km138_", "km141_")
    return t


def transformer_entrainement(src: str) -> str:
    """transformer_ts + règle « it137 »→« it138 » pour la SNAPSHOT_SOURCE
    (nu, sans point — la source d'it.141 est le snapshot cumulatif it138).

    ORDRE : « it138 »→« it141 » D'ABORD (la SORTIE it138.bin devient
    it141.bin), PUIS « it137 »→« it138 » (la SOURCE it137.bin devient
    it138.bin) — l'ordre inverse corromprait la source.
    """
    t = transformer_ts(src)
    # la règle générique transformer_ts a déjà traité it138→it141 ; la source
    # (chemin NU it137.bin, invisible des règles à points) devient it138.bin :
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it137.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it138.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose).

    AUCUN marqueur nécessaire (mesuré sur pièce it.138 : la prose ne contient
    NI « offset 924 » NI « offset 56 » — les règles prose et JSON sont
    indépendantes ; chaque remplacement crée une chaîne matchée par AUCUNE
    règle ultérieure)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 904", "offset 924")
    t = t.replace("offset 64", "offset 72")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.137 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.138", "it.141")
    t = t.replace("it.137", "it.138")
    t = t.replace("it138", "it141")   # chemins + user-agent
    t = t.replace("km138_", "km141_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    """Transformation du test de garde it.138 → it.141.

    PROTECTION : « it137 » (chemin d'import de la fenêtre précédente) n'est
    JAMAIS renommé — le module multimodal-it137.ts existe toujours."""
    t = src
    # 1. globals fenêtre courante (PAS de règle « it137 » — voir docstring)
    t = t.replace("it.138", "it.141")
    t = t.replace("IT138", "IT141")
    t = t.replace("it138", "it141")
    t = t.replace("km138_", "km141_")
    # 2. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 3. fenêtre précédente — formes documentées
    t = t.replace("d'it.137", "d'it.138")
    t = t.replace("(it.137)", "(it.138)")
    t = t.replace("après it.137", "après it.138")
    # 4. titre de déduplication : après les globales il dit « … it.137
    #    (904/56) et it.141 (924/64) » — on réinsère it.138 (924/64) et on
    #    corrige la nouvelle fenêtre it.141 (944/72)
    t = t.replace(
        'it.137 (904/56) et it.141 (924/64)", () => {',
        'it.137 (904/56), it.138 (924/64) et it.141 (944/72)", () => {',
    )
    # 5. titre des fenêtres suivantes : résumé de la fenêtre précédente
    #    (it.138 = 924/64) — la générique a laissé « 904/56 »
    t = t.replace('après it.138 : 904/56)"', 'après it.138 : 924/64)"')
    # 6. import dédié it138 inséré entre it137 (précédente) et it141
    #    (courante combinée)
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT137 } from "./multimodal-it137";\nimport { ASSETS_MULTIMODAL_IT141, PAIRES_MULTIMODAL_IT141 } from "./multimodal-it141";',
        'import { ASSETS_MULTIMODAL_IT137 } from "./multimodal-it137";\nimport { ASSETS_MULTIMODAL_IT138 } from "./multimodal-it138";\nimport { ASSETS_MULTIMODAL_IT141, PAIRES_MULTIMODAL_IT141 } from "./multimodal-it141";',
    )
    # 7. ensembles et attentes de déduplication (ajout sha138)
    t = t.replace(
        "const sha137 = new Set(ASSETS_MULTIMODAL_IT137.map((a) => a.sha256));",
        "const sha137 = new Set(ASSETS_MULTIMODAL_IT137.map((a) => a.sha256));\n    const sha138 = new Set(ASSETS_MULTIMODAL_IT138.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha137.has(a.sha256), `doublon de contenu it.137 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha137.has(a.sha256), `doublon de contenu it.137 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha138.has(a.sha256), `doublon de contenu it.138 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    return t


def transformer_eval(src: str) -> str:
    t = src
    t = t.replace("it.138", "it.141")
    t = t.replace("IT138", "IT141")
    t = t.replace("it138", "it141")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it137", "km138_",
                 '"offset": 924', '"offset": 64', "offset 884", "offset 904",
                 "offset 56", "offset 64"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it141 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.138") == 1, f"it.138 × {t.count('it.138')} (attendu 1 — après it.138)"
    assert t.count("it.141") == 2, f"it.141 × {t.count('it.141')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 944', '"offset": 72', '"offset": 4', "km141_",
                    "multimodal-it141", "offset 924", "offset 72", "offset 4",
                    "après it.138",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.138 légitime 3×
    #    (fenêtre précédente : celle d'it.138 + après l'offset 924 d'it.138 +
    #    après l'offset 64 d'it.138)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.138") == 3, f"it.138 × {t2.count('it.138')} (attendu 3 — fenêtre précédente)"
    assert t2.count("it.141") == 3, f"it.141 × {t2.count('it.141')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.137", "IT138", "km137_", "it137", "it138", "offset 884",
                 "offset 48", "offset 56", "offset 904", "⟪", "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it141 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it141/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it141.ts", sortie)',
        "fenêtre offset 944",
        "fenêtre offset 72",
        "celle d'it.138 — offset 924",
        "après l'offset 924 d'it.138",
        "après l'offset 64 d'it.138",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it138 (chemin NU de la SNAPSHOT_SOURCE) légitime
    #    exactement 1× ; it.130 légitime 1× ; it.129 légitime 2×
    t3 = transformer_entrainement(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it138.bin"', "")
    residus = [x for x in ["IT138", "km138_", "it137", "it138", "offset 884",
                           "offset 48", "offset 56", "offset 904",
                           "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it141 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it138.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it141.bin"',
        'from "../lib/neural/generation/multimodal-it141"',
        "ASSETS_MULTIMODAL_IT141",
        "PAIRES_MULTIMODAL_IT141",
        "offset 944",
        "offset 72",
        "après l'offset 924 d'it.138",
        "après l'offset 64 d'it.138",
        "celle d'it.138",
        "cumulatif it.138",
        "après offset 924 (it.138)",
        "après offset 64 (it.138)",
        "état hérité d'it.138, avant gravure it.141",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128/…/IT138 légitimes exactement 2× chacun (import dédup
    #    + shaNNN) ; IT141 = fenêtre courante ; « it137 » ×1 (chemin d'import
    #    protégé — voir docstring)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT128", "IT129", "IT130", "IT131", "IT132", "IT133",
                  "IT134", "IT135", "IT136", "IT137", "IT138"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert t4.count("IT141") >= 10, f"IT141 × {t4.count('IT141')} (attendu >= 10 — fenêtre courante)"
    for ident, attendu_n in [("it128", 1), ("it129", 1), ("it130", 1),
                             ("it131", 1), ("it132", 1), ("it133", 1), ("it134", 1),
                             ("it135", 1), ("it136", 1), ("it137", 1), ("it138", 1),
                             ("it141", 2)]:
        n = t4.count(ident)
        assert n == attendu_n, f"{ident} × {n} (attendu {attendu_n})"
    ligne137 = [l for l in t4.splitlines() if "IT137" in l and "import" in l]
    assert ligne137 == ['import { ASSETS_MULTIMODAL_IT137 } from "./multimodal-it137";'], ligne137
    ligne138 = [l for l in t4.splitlines() if "IT138" in l and "import" in l]
    assert ligne138 == ['import { ASSETS_MULTIMODAL_IT138 } from "./multimodal-it138";'], ligne138
    for attendu in [
        "km141_",
        "sha138",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40), it.136 (884/48), it.137 (904/56), it.138 (924/64) et it.141 (944/72)",
        "COCO offset 944, MLS offset 72 — après it.138 : 924/64",
        "fenêtre offset 72 après offset 64 (it.138)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.138",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km138_", "km137_", "km136_", "km135_", "km134_", "km133_", "km132_",
                 "km131_", "km130_", "km129_", "km128_", "⟪"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it141 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.138)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.138", "it.141")
    t5 = t5.replace("it138", "it141")
    t5 = t5.replace("it.90→it.137", "it.90→it.138")
    # le seul « it.138 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.138") == 1, f"it.138 × {t5.count('it.138')} (attendu 1 — borne du lot historique)"
    interdits = ["it137", "it.137"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it141 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it141/assets.json", "fenêtre it.141",
                    'multimodal-it141.ts")', "it.90→it.138"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.138", "IT138", "it138"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it141 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it141"',
        "ASSETS_MULTIMODAL_IT141",
        "PAIRES_MULTIMODAL_IT141",
        '"var/evaluation-navigateur-it141.json"',
        "FENÊTRE it.141",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.138 → it.141 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

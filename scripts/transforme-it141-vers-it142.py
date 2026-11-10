#!/usr/bin/env python3
"""Transforme les scripts it.141 en scripts it.142 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

CONTEXTE it.142 : it.141 a consommé la fenêtre COCO 944 / MLS 72 ; la
fenêtre SUIVANTE est COCO offset 964 / MLS offset 80. La fenêtre
PRÉCÉDENTE devient it.141 (944/72) ; it.138 (924/64) reste la fenêtre
ante-précédente référencée dans les titres de déduplication.

Pièges traités (leçons it.106→…→it.142) :
  - identifiants PascalCase IT141 → IT142 (remplacement séparé de it141) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it141.bin) — l'ordre
    « courant d'abord, précédente ensuite » produit la source correcte
    SANS restauration explicite (la règle générique renomme la SORTIE
    it141.bin → it142.bin ; la SOURCE it138.bin, chemin nu, est insensible
    aux règles à points puis restaurée explicitement vers it141.bin) ;
  - fenêtre courante d'abord (944/72 → 964/80), PUIS références historiques
    (924/64 → 944/72) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (plan à MARQUEURS ⟪P⟫/⟪Q⟫ reconduit) :
      1. offset 944 → offset ⟪P⟫   (coco courant, protégé)
      2. offset 72  → offset ⟪Q⟫   (mls courant, protégé)
      3. offset 64  → offset 72    (mls précédent — plus aucun 72 vivant)
      4. offset 924 → offset 944   (coco précédent — plus aucun 944 vivant)
      5. offset ⟪P⟫ → offset 964   (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 80    (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure ; « offset 4 » (UCF101, preuve du zéro) n'est JAMAIS
    remplacé et « offset 80 » créé en dernier ne matche aucune étape ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) », « doublon de contenu
    it.137 / it.138 » (les ensembles sha137/sha138 EXISTENT toujours dans
    le test) ne matchent ni les formes documentées (d'it.138 / (it.138) /
    cumulatif it.138 / après it.138) ni les renommages d'offsets ;
  - TITRE DU TEST DE DÉDUP : les segments « N/N » (924/64, 944/72) ne
    matchent AUCUN plan « offset N » — deux règles spéciales les mettent à
    jour APRÈS les renommages génériques ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (mesuré sur pièce it.141 : prose = 4, 72, 924 uniquement) ;
  - l'IMPORT dédié it141 est inséré ENTRE les lignes it138 (ante-précédente)
    et it142 (nouvelle courante combinée) — la générique seule laisserait un
    doublon d'identifiant ASSETS_…IT142 ;
  - PROTECTION SPÉCIFIQUE TEST : « it137 » (nu, chemin d'import de la
    fenêtre ante-précédente) n'est JAMAIS renommé ;
  - km141_ → km142_ (préfixe indépendant des identifiants IT).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it141.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it142.py"
GENERE_IN = "scripts/genere-module-multimodal-it141.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it142.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it141.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it142.ts"
TEST_IN = "lib/neural/generation/multimodal-it141.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it142.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it141.py"
DEDUP_OUT = "scripts/verifie-dedup-it142.py"
EVAL_IN = "scripts/evaluation-navigateur-it141.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it142.ts"

P = "⟪P⟫"  # offset coco courant protégé (944 → 964)
Q = "⟪Q⟫"  # offset mls courant protégé (72 → 80)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 944", f"offset {P}"),
    ("offset 72", f"offset {Q}"),
    ("offset 64", "offset 72"),
    ("offset 924", "offset 944"),
    (f"offset {P}", "offset 964"),
    (f"offset {Q}", "offset 80"),
]
# JSON — indépendants (« "offset": 4 » UCF101 n'est JAMAIS remplacé).
OFFSETS_JSON = [
    ('"offset": 944', '"offset": 964'),
    ('"offset": 72', '"offset": 80'),
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
    # 2. fenêtre courante it.141 → it.142
    t = t.replace("it.141", "it.142")
    # 3. fenêtre précédente it.138 → it.141 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.138", "d'it.141")
    t = t.replace("(it.138)", "(it.141)")
    t = t.replace("cumulatif it.138", "cumulatif it.141")
    t = t.replace("après it.138", "après it.141")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT141", "IT142")
    t = t.replace("it141", "it142")
    t = t.replace("km141_", "km142_")
    return t


def transformer_entrainement(src: str) -> str:
    """transformer_ts + règle SNAPSHOT_SOURCE (nu — la source d'it.142 est le
    snapshot cumulatif it141).

    ORDRE : « it141 »→« it142 » D'ABORD (la SORTIE it141.bin devient
    it142.bin), PUIS la SOURCE it138.bin (chemin nu, invisible des règles à
    points) est restaurée vers it141.bin — l'ordre inverse corromprait la
    source.
    """
    t = transformer_ts(src)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it138.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it141.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose).

    AUCUN marqueur nécessaire (mesuré sur pièce it.141 : la prose ne contient
    NI « offset 944 » NI « offset 64 » — les règles prose et JSON sont
    indépendantes ; chaque remplacement crée une chaîne matchée par AUCUNE
    règle ultérieure)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 924", "offset 944")
    t = t.replace("offset 72", "offset 80")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.138 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.141", "it.142")
    t = t.replace("(it.138)", "(it.141)")
    t = t.replace("après it.138", "après it.141")
    t = t.replace("it141", "it142")    # chemins + user-agent
    t = t.replace("km141_", "km142_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    """Transformation du test de garde it.141 → it.142.

    PROTECTIONS : « it137 » (chemin d'import de la fenêtre ante-précédente)
    n'est JAMAIS renommé — le module multimodal-it137.ts existe toujours ;
    « doublon de contenu it.137/it.138 » — les ensembles sha137/sha138
    EXISTENT toujours (les modules restent importés)."""
    t = src
    # 1. globals fenêtre courante (PAS de règle « it137 » — voir docstring)
    t = t.replace("it.141", "it.142")
    t = t.replace("IT141", "IT142")
    t = t.replace("it141", "it142")
    t = t.replace("km141_", "km142_")
    # 2. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 3. fenêtre précédente — formes documentées
    t = t.replace("d'it.138", "d'it.141")
    t = t.replace("(it.138)", "(it.141)")
    t = t.replace("après it.138", "après it.141")
    # 4. titre de déduplication : après les génériques + plan il dit
    #    « … it.138 (924/64) et it.142 (944/72) » — on réinsère it.141
    #    (944/72) et on corrige la nouvelle fenêtre it.142 (964/80)
    t = t.replace(
        'it.138 (924/64) et it.142 (944/72)", () => {',
        'it.138 (924/64), it.141 (944/72) et it.142 (964/80)", () => {',
    )
    # 5. résumé de la fenêtre précédente : la générique + plan ont laissé
    #    « après it.141 : 924/64 » — le couple N/N de la fenêtre précédente
    #    est désormais 944/72
    t = t.replace("après it.141 : 924/64", "après it.141 : 944/72")
    # 6. import dédié it141 inséré entre it138 (ante-précédente) et it142
    #    (courante combinée)
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT138 } from "./multimodal-it138";\nimport { ASSETS_MULTIMODAL_IT142, PAIRES_MULTIMODAL_IT142 } from "./multimodal-it142";',
        'import { ASSETS_MULTIMODAL_IT138 } from "./multimodal-it138";\nimport { ASSETS_MULTIMODAL_IT141 } from "./multimodal-it141";\nimport { ASSETS_MULTIMODAL_IT142, PAIRES_MULTIMODAL_IT142 } from "./multimodal-it142";',
    )
    # 7. ensembles et attentes de déduplication (ajout sha141)
    t = t.replace(
        "const sha138 = new Set(ASSETS_MULTIMODAL_IT138.map((a) => a.sha256));",
        "const sha138 = new Set(ASSETS_MULTIMODAL_IT138.map((a) => a.sha256));\n    const sha141 = new Set(ASSETS_MULTIMODAL_IT141.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha138.has(a.sha256), `doublon de contenu it.138 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha138.has(a.sha256), `doublon de contenu it.138 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha141.has(a.sha256), `doublon de contenu it.141 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    return t


def transformer_eval(src: str) -> str:
    t = src
    t = t.replace("it.141", "it.142")
    t = t.replace("IT141", "IT142")
    t = t.replace("it141", "it142")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it138", "km141_",
                 '"offset": 944', '"offset": 72', "offset 904", "offset 924",
                 "offset 64", "offset 72"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it142 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.141") == 1, f"it.141 × {t.count('it.141')} (attendu 1 — après it.141)"
    assert t.count("it.142") == 2, f"it.142 × {t.count('it.142')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 964', '"offset": 80', '"offset": 4', "km142_",
                    "multimodal-it142", "offset 944", "offset 80", "offset 4",
                    "après it.141",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.141 légitime 3×
    #    (fenêtre précédente : celle d'it.141 — offset 944 + après l'offset
    #    944 d'it.141 + après l'offset 72 d'it.141)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.141") == 3, f"it.141 × {t2.count('it.141')} (attendu 3 — fenêtre précédente)"
    assert t2.count("it.142") == 3, f"it.142 × {t2.count('it.142')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.138", "IT141", "km141_", "it137", "it138", "it141",
                 "offset 884", "offset 48", "offset 64", "offset 924", "⟪",
                 "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it142 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it142/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it142.ts", sortie)',
        "fenêtre offset 964",
        "fenêtre offset 80",
        "celle d'it.141 — offset 944",
        "après l'offset 944 d'it.141",
        "après l'offset 72 d'it.141",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it138 (chemin NU de la SNAPSHOT_SOURCE) disparu
    #    après restauration vers it141 ; it.130 légitime 1× ; it.129 ×2
    t3 = transformer_entrainement(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it141.bin"', "")
    residus = [x for x in ["IT141", "km141_", "it137", "it138", "it141",
                           "offset 884", "offset 48", "offset 64", "offset 924",
                           "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it142 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it141.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it142.bin"',
        'from "../lib/neural/generation/multimodal-it142"',
        "ASSETS_MULTIMODAL_IT142",
        "PAIRES_MULTIMODAL_IT142",
        "offset 964",
        "offset 80",
        "après l'offset 944 d'it.141",
        "après l'offset 72 d'it.141",
        "celle d'it.141",
        "cumulatif it.141",
        "après offset 944 (it.141)",
        "après offset 72 (it.141)",
        "état hérité d'it.141, avant gravure it.142",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT137/IT138/IT141 légitimes exactement 2× chacun (import
    #    dédup + shaNNN) ; IT142 = fenêtre courante ; « it137 » ×1 (chemin
    #    d'import protégé — voir docstring)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT128", "IT129", "IT130", "IT131", "IT132", "IT133",
                  "IT134", "IT135", "IT136", "IT137", "IT138", "IT141"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert t4.count("IT142") >= 10, f"IT142 × {t4.count('IT142')} (attendu >= 10 — fenêtre courante)"
    for ident, attendu_n in [("it128", 1), ("it129", 1), ("it130", 1),
                             ("it131", 1), ("it132", 1), ("it133", 1), ("it134", 1),
                             ("it135", 1), ("it136", 1), ("it137", 1), ("it138", 1),
                             ("it141", 1), ("it142", 2)]:
        n = t4.count(ident)
        assert n == attendu_n, f"{ident} × {n} (attendu {attendu_n})"
    ligne137 = [l for l in t4.splitlines() if "IT137" in l and "import" in l]
    assert ligne137 == ['import { ASSETS_MULTIMODAL_IT137 } from "./multimodal-it137";'], ligne137
    ligne138 = [l for l in t4.splitlines() if "IT138" in l and "import" in l]
    assert ligne138 == ['import { ASSETS_MULTIMODAL_IT138 } from "./multimodal-it138";'], ligne138
    ligne141 = [l for l in t4.splitlines() if "IT141" in l and "import" in l]
    assert ligne141 == ['import { ASSETS_MULTIMODAL_IT141 } from "./multimodal-it141";'], ligne141
    for attendu in [
        "km142_",
        "sha141",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40), it.136 (884/48), it.137 (904/56), it.138 (924/64), it.141 (944/72) et it.142 (964/80)",
        "COCO offset 964, MLS offset 80 — après it.141 : 944/72",
        "fenêtre offset 80 après offset 72 (it.141)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.141",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km141_", "km138_", "km137_", "km136_", "km135_", "km134_",
                 "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it142 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.141)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.141", "it.142")
    t5 = t5.replace("it141", "it142")
    t5 = t5.replace("it.90→it.138", "it.90→it.141")
    # le seul « it.141 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.141") == 1, f"it.141 × {t5.count('it.141')} (attendu 1 — borne du lot historique)"
    interdits = ["it138", "it.138"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it142 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it142/assets.json", "fenêtre it.142",
                    'multimodal-it142.ts")', "it.90→it.141"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.141", "IT141", "it141"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it142 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it142"',
        "ASSETS_MULTIMODAL_IT142",
        "PAIRES_MULTIMODAL_IT142",
        '"var/evaluation-navigateur-it142.json"',
        "FENÊTRE it.142",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.141 → it.142 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

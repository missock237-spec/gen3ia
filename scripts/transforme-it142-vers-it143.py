#!/usr/bin/env python3
"""Transforme les scripts it.142 en scripts it.143 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

CONTEXTE it.143 : it.142 a consommé la fenêtre COCO 964 / MLS 80 ; la
fenêtre SUIVANTE est COCO offset 984 / MLS offset 88. La fenêtre
PRÉCÉDENTE devient it.142 (964/80) ; it.138 (924/64) reste la fenêtre
ante-précédente référencée dans les titres de déduplication.

Pièges traités (leçons it.106→…→it.143) :
  - identifiants PascalCase IT142 → IT143 (remplacement séparé de it142) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it142.bin) — cette fois
    produit par l'ORDRE SEUL : la source it141.bin (chemin nu) est renommée
    it142.bin par la règle générique « it141 »→« it142 » exécutée APRÈS
    « it142 »→« it143 » (la SORTIE it142.bin part d'abord vers it143.bin,
    puis l'ancienne source devient la nouvelle source) — zéro restauration
    explicite nécessaire, l'ordre courant-d'abord suffit ;
  - fenêtre courante d'abord (964/80 → 984/88), PUIS références historiques
    (944/72 → 964/80) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (plan à MARQUEURS ⟪P⟫/⟪Q⟫ reconduit) :
      1. offset 964 → offset ⟪P⟫   (coco courant, protégé)
      2. offset 80  → offset ⟪Q⟫   (mls courant, protégé)
      3. offset 72  → offset 80    (mls précédent — plus aucun 80 vivant)
      4. offset 944 → offset 964   (coco précédent — plus aucun 964 vivant)
      5. offset ⟪P⟫ → offset 984   (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 88    (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure ; « offset 4 » (UCF101, preuve du zéro) n'est JAMAIS
    remplacé et « offset 88 » créé en dernier ne matche aucune étape ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) », « doublon de contenu
    it.137 / it.138 » (les ensembles sha137/sha138 EXISTENT toujours dans
    le test) ne matchent ni les formes documentées (d'it.141 / (it.141) /
    cumulatif it.141 / après it.141) ni les renommages d'offsets ;
  - TITRE DU TEST DE DÉDUP : les segments « N/N » (964/80, 944/72) ne
    matchent AUCUN plan « offset N » — deux règles spéciales les mettent à
    jour APRÈS les renommages génériques (le titre réinsère it.141
    (944/72), ajoute it.142 (964/80) et corrige it.143 (984/88)) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (mesuré sur pièce it.142 : prose telecharge = 944, 80 uniquement) ;
  - l'import dédié it142 est produit par le RENOMMAGE GÉNÉRIQUE de l'import
    dédié it141 (assets seul) — la cascade it.141→it.142 l'avait inséré ;
    aucune insertion n'est donc nécessaire ici (idem sha142) ;
  - PROTECTION SPÉCIFIQUE TEST : « it137 » (nu, chemin d'import de la
    fenêtre ante-précédente) n'est JAMAIS renommé ;
  - km142_ → km143_ (préfixe indépendant des identifiants IT) ;
  - DATE de mesure/download : « 08 nov 2026 » (héritée) → « 10 nov 2026 »
    (date réelle de la fenêtre it.143).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it142.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it143.py"
GENERE_IN = "scripts/genere-module-multimodal-it142.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it143.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it142.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it143.ts"
TEST_IN = "lib/neural/generation/multimodal-it142.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it143.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it142.py"
DEDUP_OUT = "scripts/verifie-dedup-it143.py"
EVAL_IN = "scripts/evaluation-navigateur-it142.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it143.ts"

P = "⟪P⟫"  # offset coco courant protégé (964 → 984)
Q = "⟪Q⟫"  # offset mls courant protégé (80 → 88)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 964", f"offset {P}"),
    ("offset 80", f"offset {Q}"),
    ("offset 72", "offset 80"),
    ("offset 944", "offset 964"),
    (f"offset {P}", "offset 984"),
    (f"offset {Q}", "offset 88"),
]
# JSON — indépendants (« "offset": 4 » UCF101 n'est JAMAIS remplacé).
OFFSETS_JSON = [
    ('"offset": 964', '"offset": 984'),
    ('"offset": 80', '"offset": 88'),
]


def appliquer_marques(t: str) -> str:
    for ancien, nouveau in OFFSETS_PROSE_MARQUES:
        t = t.replace(ancien, nouveau)
    assert P not in t and Q not in t, "marqueurs ⟪P⟫/⟪Q⟫ résiduels"
    return t


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur).

    ORDRE : courant (142→143) d'abord, précédente (141→142) ensuite —
    l'ordre inverse ferait un double saut 141→143."""
    t = src
    # 1. offsets — plan à marqueurs (voir docstring)
    t = appliquer_marques(t)
    # 2. date de la fenêtre (mesure/download réelle)
    t = t.replace("08 nov 2026", "10 nov 2026")
    # 3. fenêtre courante it.142 → it.143
    t = t.replace("it.142", "it.143")
    t = t.replace("IT142", "IT143")
    t = t.replace("it142", "it143")
    t = t.replace("km142_", "km143_")
    # 4. fenêtre précédente it.141 → it.142 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.141", "d'it.142")
    t = t.replace("(it.141)", "(it.142)")
    t = t.replace("cumulatif it.141", "cumulatif it.142")
    t = t.replace("après it.141", "après it.142")
    t = t.replace("it.141", "it.142")
    t = t.replace("IT141", "IT142")
    t = t.replace("it141", "it142")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose).

    AUCUN marqueur nécessaire (mesuré sur pièce it.142 : la prose ne contient
    NI « offset 964 » NI « offset 72 » — les règles prose et JSON sont
    indépendantes ; chaque remplacement crée une chaîne matchée par AUCUNE
    règle ultérieure)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 944", "offset 964")
    t = t.replace("offset 80", "offset 88")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.141 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.142", "it.143")
    t = t.replace("(it.141)", "(it.142)")
    t = t.replace("après it.141", "après it.142")
    t = t.replace("it142", "it143")    # chemins + user-agent
    t = t.replace("km142_", "km143_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    """Transformation du test de garde it.142 → it.143.

    PROTECTIONS : « it137 » (chemin d'import de la fenêtre ante-précédente)
    n'est JAMAIS renommé — le module multimodal-it137.ts existe toujours ;
    « doublon de contenu it.137/it.138 » — les ensembles sha137/sha138
    EXISTENT toujours (les modules restent importés).
    L'import dédié it141 (assets seul) et le set sha141 deviennent it142/sha142
    PAR LE RENOMMAGE GÉNÉRIQUE (insérés par la cascade précédente) — aucune
    insertion nécessaire."""
    t = src
    # 1. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 2. date de la fenêtre
    t = t.replace("08 nov 2026", "10 nov 2026")
    # 3. globals fenêtre courante (PAS de règle « it137 » — voir docstring)
    t = t.replace("it.142", "it.143")
    t = t.replace("IT142", "IT143")
    t = t.replace("it142", "it143")
    t = t.replace("km142_", "km143_")
    # 4. fenêtre précédente — formes documentées puis générique
    t = t.replace("d'it.141", "d'it.142")
    t = t.replace("(it.141)", "(it.142)")
    t = t.replace("après it.141", "après it.142")
    t = t.replace("it.141", "it.142")
    t = t.replace("IT141", "IT142")
    t = t.replace("it141", "it142")
    # 4 bis. NOM du set de dédup : « sha141 » ne contient pas « it141 » — le
    #    renommage générique ne le touche pas. La déclaration d'origine (qui
    #    pointe maintenant vers ASSETS_MULTIMODAL_IT142 après le renommage
    #    IT141→IT142) doit s'appeler sha142 — AVANT la réinsertion du set
    #    sha141 de la règle 7 (sinon déclaration en double).
    t = t.replace("sha141", "sha142")
    # 5. titre de déduplication : après les génériques il dit
    #    « … it.138 (924/64), it.142 (944/72) et it.143 (964/80) » — on
    #    réinsère it.141 (944/72), on ajoute it.142 (964/80) et on corrige
    #    la nouvelle fenêtre it.143 (984/88)
    t = t.replace(
        'it.138 (924/64), it.142 (944/72) et it.143 (964/80)", () => {',
        'it.138 (924/64), it.141 (944/72), it.142 (964/80) et it.143 (984/88)", () => {',
    )
    # 6. résumé de la fenêtre précédente : la générique + plan ont laissé
    #    « après it.142 : 944/72 » — le couple N/N de la fenêtre précédente
    #    est désormais 964/80
    t = t.replace("après it.142 : 944/72", "après it.142 : 964/80")
    # 7. RÉINSERTION de la fenêtre it.141 dans la chaîne de dédup — le
    #    renommage générique a transformé l'import dédié it141 en it142 et le
    #    set sha141 en sha142 : la fenêtre it.141 disparaissait de la chaîne
    #    (les assets it.143 n'auraient PAS été comparés à it.141). On réinsère
    #    import + set + expect entre it.138 et it.142 (position historique).
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT138 } from "./multimodal-it138";\nimport { ASSETS_MULTIMODAL_IT142 } from "./multimodal-it142";',
        'import { ASSETS_MULTIMODAL_IT138 } from "./multimodal-it138";\nimport { ASSETS_MULTIMODAL_IT141 } from "./multimodal-it141";\nimport { ASSETS_MULTIMODAL_IT142 } from "./multimodal-it142";',
    )
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
    t = t.replace("it.142", "it.143")
    t = t.replace("IT142", "IT143")
    t = t.replace("it142", "it143")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it141", "km142_",
                 '"offset": 964', '"offset": 80', "offset 904", "offset 924",
                 "offset 944", "offset 72", "offset 80"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it143 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.142") == 1, f"it.142 × {t.count('it.142')} (attendu 1 — après it.142)"
    assert t.count("it.143") == 2, f"it.143 × {t.count('it.143')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 984', '"offset": 88', '"offset": 4', "km143_",
                    "multimodal-it143", "offset 964", "offset 88", "offset 4",
                    "après it.142",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.142 légitime 3×
    #    (fenêtre précédente : celle d'it.142 — offset 964 + après l'offset
    #    964 d'it.142 + après l'offset 80 d'it.142), it.143 ×3 (courante)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.142") == 3, f"it.142 × {t2.count('it.142')} (attendu 3 — fenêtre précédente)"
    assert t2.count("it.143") == 3, f"it.143 × {t2.count('it.143')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.141", "IT142", "km142_", "it137", "it141", "it142",
                 "offset 944", "offset 72", "offset 80 (it", "⟪",
                 "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it143 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it143/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it143.ts", sortie)',
        "fenêtre offset 984",
        "fenêtre offset 88",
        "celle d'it.142 — offset 964",
        "après l'offset 964 d'it.142",
        "après l'offset 80 d'it.142",
        "10 nov 2026",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — la SNAPSHOT_SOURCE it141.bin devient it142.bin par
    #    l'ordre courant-d'abord (aucune restauration explicite) ; it.130
    #    légitime 1× ; it.129 ×2
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it142.bin"', "")
    residus = [x for x in ["IT142", "km142_", "it137", "it141", "it142",
                           "offset 944", "offset 72",
                           "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it143 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it142.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it143.bin"',
        'from "../lib/neural/generation/multimodal-it143"',
        "ASSETS_MULTIMODAL_IT143",
        "PAIRES_MULTIMODAL_IT143",
        "offset 984",
        "offset 88",
        "après l'offset 964 d'it.142",
        "après l'offset 80 d'it.142",
        "celle d'it.142",
        "cumulatif it.142",
        "après offset 964 (it.142)",
        "après offset 80 (it.142)",
        "état hérité d'it.142, avant gravure it.143",
        "10 nov 2026",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT137/IT138/IT141/IT142 légitimes exactement 2× chacun
    #    (import dédup + shaNNN) ; IT143 = fenêtre courante ; « it137 » ×1
    #    (chemin d'import protégé — voir docstring)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT128", "IT129", "IT130", "IT131", "IT132", "IT133",
                  "IT134", "IT135", "IT136", "IT137", "IT138", "IT141",
                  "IT142"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"  # IT141 réinséré (règle 7)
    assert "sha141" in t4 and "sha142" in t4, "sets sha141/sha142 requis"
    assert t4.count("IT143") >= 10, f"IT143 × {t4.count('IT143')} (attendu >= 10 — fenêtre courante)"
    for ident, attendu_n in [("it128", 1), ("it129", 1), ("it130", 1),
                             ("it131", 1), ("it132", 1), ("it133", 1), ("it134", 1),
                             ("it135", 1), ("it136", 1), ("it137", 1), ("it138", 1),
                             ("it141", 1), ("it142", 1), ("it143", 2)]:
        n = t4.count(ident)
        assert n == attendu_n, f"{ident} × {n} (attendu {attendu_n})"
    ligne137 = [l for l in t4.splitlines() if "IT137" in l and "import" in l]
    assert ligne137 == ['import { ASSETS_MULTIMODAL_IT137 } from "./multimodal-it137";'], ligne137
    ligne138 = [l for l in t4.splitlines() if "IT138" in l and "import" in l]
    assert ligne138 == ['import { ASSETS_MULTIMODAL_IT138 } from "./multimodal-it138";'], ligne138
    ligne141 = [l for l in t4.splitlines() if "IT141" in l and "import" in l]
    assert ligne141 == ['import { ASSETS_MULTIMODAL_IT141 } from "./multimodal-it141";'], ligne141
    ligne142 = [l for l in t4.splitlines() if "IT142" in l and "import" in l]
    assert ligne142 == ['import { ASSETS_MULTIMODAL_IT142 } from "./multimodal-it142";'], ligne142
    for attendu in [
        "km143_",
        "sha141",
        "sha142",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40), it.136 (884/48), it.137 (904/56), it.138 (924/64), it.141 (944/72), it.142 (964/80) et it.143 (984/88)",
        "COCO offset 984, MLS offset 88 — après it.142 : 964/80",
        "fenêtre offset 88 après offset 80 (it.142)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.142",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km142_", "km141_", "km138_", "km137_", "km136_", "km135_", "km134_",
                 "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪",
                 "offset 944", "offset 72", "944/72\""]
    residus = [x for x in interdits if x in t4]
    print(f"test-it143 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.142)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.142", "it.143")
    t5 = t5.replace("it142", "it143")
    t5 = t5.replace("it.90→it.141", "it.90→it.142")
    # le seul « it.142 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.142") == 1, f"it.142 × {t5.count('it.142')} (attendu 1 — borne du lot historique)"
    interdits = ["it141", "it.141"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it143 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it143/assets.json", "fenêtre it.143",
                    'multimodal-it143.ts")', "it.90→it.142"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.142", "IT142", "it142"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it143 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it143"',
        "ASSETS_MULTIMODAL_IT143",
        "PAIRES_MULTIMODAL_IT143",
        '"var/evaluation-navigateur-it143.json"',
        "FENÊTRE it.143",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.142 → it.143 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

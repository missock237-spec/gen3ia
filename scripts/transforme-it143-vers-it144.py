#!/usr/bin/env python3
"""Transforme les scripts it.143 en scripts it.144 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

CONTEXTE it.144 : it.143 a consommé la fenêtre COCO 984 / MLS 88 ; la
fenêtre SUIVANTE est COCO offset 1004 / MLS offset 96. La fenêtre
PRÉCÉDENTE devient it.143 (984/88) ; it.142 (964/80) devient la fenêtre
ante-précédente et it.141 (944/72) reste dans la chaîne de déduplication
(réinsérée explicitement — son import dédié est décalé par le renommage).

Pièges traités (leçons it.106→…→it.144) :
  - identifiants PascalCase IT143 → IT144 (remplacement séparé de it143) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it143.bin) — produit par
    l'ORDRE SEUL : la source it142.bin (chemin nu) est renommée it143.bin par
    la règle générique « it142 »→« it143 » exécutée APRÈS « it143 »→« it144 »
    (la SORTIE it143.bin part d'abord vers it144.bin, puis l'ancienne source
    devient la nouvelle source) — zéro restauration explicite nécessaire ;
  - fenêtre courante d'abord (984/88 → 1004/96), PUIS références historiques
    (964/80 → 984/88) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (plan à MARQUEURS ⟪P⟫/⟪Q⟫ reconduit) :
      1. offset 984 → offset ⟪P⟫   (coco courant, protégé)
      2. offset 88  → offset ⟪Q⟫   (mls courant, protégé)
      3. offset 80  → offset 88    (mls précédent — plus aucun 80 vivant)
      4. offset 964 → offset 984   (coco précédent — plus aucun 984 vivant)
      5. offset ⟪P⟫ → offset 1004  (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 96    (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure ; « offset 4 » (UCF101, preuve du zéro) n'est JAMAIS
    remplacé et « offset 96 » créé en dernier ne matche aucune étape ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) », « doublon de contenu
    it.137 / it.138 » (les ensembles sha137/sha138 EXISTENT toujours dans
    le test) ne matchent ni les formes documentées (d'it.142 / (it.142) /
    cumulatif it.142 / après it.142) ni les renommages d'offsets ;
  - TITRE DU TEST DE DÉDUP : les segments « N/N » (984/88, 964/80, 944/72)
    ne matchent AUCUN plan « offset N » — une règle spéciale met la queue du
    titre à jour APRÈS les renommages génériques (réinsère it.141 (944/72),
    replace it.142 (964/80), it.143 (984/88) et ajoute it.144 (1004/96)) ;
  - RÉSUMÉ « après it.143 : N/N » — règle spéciale 964/80 → 984/88 ;
  - SETS DE DÉDUP : « sha142 »→« sha143 » PUIS « sha141 »→« sha142 » (ordre
    critique — l'inverse ferait un double saut) — les noms suivent le module
    que leur initialisateur référence après les renommages IT141→IT142 et
    IT142→IT143 ; la réinsertion (règle 8) recrée le set sha141 manquant ;
  - RÉINSERTION it.141 (import + set + expect entre it.138 et it.142) : le
    renommage générique a transformé l'import dédié it141 en it142 — la
    fenêtre it.141 disparaîtrait de la chaîne (les assets it.144 n'auraient
    PAS été comparés à it.141) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (mesuré sur pièce it.143 : prose = offset 964, offset 88, offset 4) ;
    JSON d'ABORD pour que la règle prose « offset 88 » ne touche pas le JSON ;
  - km143_ → km144_ (préfixe indépendant des identifiants IT) ;
  - DATE de mesure/download : « 10 nov 2026 » (héritée) → « 12 nov 2026 »
    (date réelle de la fenêtre it.144).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it143.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it144.py"
GENERE_IN = "scripts/genere-module-multimodal-it143.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it144.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it143.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it144.ts"
TEST_IN = "lib/neural/generation/multimodal-it143.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it144.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it143.py"
DEDUP_OUT = "scripts/verifie-dedup-it144.py"
EVAL_IN = "scripts/evaluation-navigateur-it143.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it144.ts"

P = "⟪P⟫"  # offset coco courant protégé (984 → 1004)
Q = "⟪Q⟫"  # offset mls courant protégé (88 → 96)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 984", f"offset {P}"),
    ("offset 88", f"offset {Q}"),
    ("offset 80", "offset 88"),
    ("offset 964", "offset 984"),
    (f"offset {P}", "offset 1004"),
    (f"offset {Q}", "offset 96"),
]
# JSON — indépendants (« "offset": 4 » UCF101 n'est JAMAIS remplacé).
OFFSETS_JSON = [
    ('"offset": 984', '"offset": 1004'),
    ('"offset": 88', '"offset": 96'),
]


def appliquer_marques(t: str) -> str:
    for ancien, nouveau in OFFSETS_PROSE_MARQUES:
        t = t.replace(ancien, nouveau)
    assert P not in t and Q not in t, "marqueurs ⟪P⟫/⟪Q⟫ résiduels"
    return t


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur).

    ORDRE : courant (143→144) d'abord, précédente (142→143) ensuite —
    l'ordre inverse ferait un double saut 142→144."""
    t = src
    # 1. offsets — plan à marqueurs (voir docstring)
    t = appliquer_marques(t)
    # 2. date de la fenêtre (mesure/download réelle)
    t = t.replace("10 nov 2026", "12 nov 2026")
    # 3. fenêtre courante it.143 → it.144
    t = t.replace("it.143", "it.144")
    t = t.replace("IT143", "IT144")
    t = t.replace("it143", "it144")
    t = t.replace("km143_", "km144_")
    # 4. fenêtre précédente it.142 → it.143 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.142", "d'it.143")
    t = t.replace("(it.142)", "(it.143)")
    t = t.replace("cumulatif it.142", "cumulatif it.143")
    t = t.replace("après it.142", "après it.143")
    t = t.replace("it.142", "it.143")
    t = t.replace("IT142", "IT143")
    t = t.replace("it142", "it143")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose).

    JSON d'abord, prose ensuite (mesuré sur pièce it.143 : la prose contient
    « offset 964 », « offset 88 », « offset 4 » — la règle prose « offset 88 »
    doit courir APRÈS le JSON pour ne pas corrompre « "offset": 88 »)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 964", "offset 984")
    t = t.replace("offset 88", "offset 96")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.142 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.143", "it.144")
    t = t.replace("(it.142)", "(it.143)")
    t = t.replace("après it.142", "après it.143")
    t = t.replace("it143", "it144")    # chemins + user-agent
    t = t.replace("km143_", "km144_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    """Transformation du test de garde it.143 → it.144.

    PROTECTIONS : « it137 » (chemin d'import de la fenêtre ante-précédente)
    n'est JAMAIS renommé — le module multimodal-it137.ts existe toujours ;
    « doublon de contenu it.137/it.138 » — les ensembles sha137/sha138
    EXISTENT toujours (les modules restent importés).
    SETS : sha142→sha143 PUIS sha141→sha142 (ordre critique), AVANT la
    réinsertion du set sha141 de la règle 8 (sinon déclaration en double).
    RÉINSERTION it.141 (import + set + expect entre it.138 et it.142)."""
    t = src
    # 1. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 2. date de la fenêtre
    t = t.replace("10 nov 2026", "12 nov 2026")
    # 3. globals fenêtre courante (PAS de règle « it137 » — voir docstring)
    t = t.replace("it.143", "it.144")
    t = t.replace("IT143", "IT144")
    t = t.replace("it143", "it144")
    t = t.replace("km143_", "km144_")
    # 4. fenêtre précédente — formes documentées puis générique
    t = t.replace("d'it.142", "d'it.143")
    t = t.replace("(it.142)", "(it.143)")
    t = t.replace("après it.142", "après it.143")
    t = t.replace("it.142", "it.143")
    t = t.replace("IT142", "IT143")
    t = t.replace("it142", "it143")
    t = t.replace("cumulatif it.142", "cumulatif it.143")
    t = t.replace("it.141", "it.142")
    t = t.replace("IT141", "IT142")
    t = t.replace("it141", "it142")
    # 5. NOMS des sets de dédup : les initialisateurs pointent maintenant
    #    vers les modules décalés (IT142→IT143, IT141→IT142) — les noms
    #    suivent. ORDRE CRITIQUE : 142→143 AVANT 141→142.
    t = t.replace("sha142", "sha143")
    t = t.replace("sha141", "sha142")
    # 6. titre de déduplication : après les génériques la queue du titre dit
    #    « … it.142 (944/72), it.143 (964/80) et it.144 (984/88) » — on
    #    réinsère it.141 (944/72), replace it.142 (964/80), it.143 (984/88)
    #    et ajoute it.144 (1004/96)
    t = t.replace(
        'it.142 (944/72), it.143 (964/80) et it.144 (984/88)", () => {',
        'it.141 (944/72), it.142 (964/80), it.143 (984/88) et it.144 (1004/96)", () => {',
    )
    # 7. résumé de la fenêtre précédente : la générique + plan ont laissé
    #    « après it.143 : 964/80 » — le couple N/N de la fenêtre précédente
    #    est désormais 984/88
    t = t.replace("après it.143 : 964/80", "après it.143 : 984/88")
    # 8. RÉINSERTION de la fenêtre it.141 dans la chaîne de dédup — le
    #    renommage générique a transformé l'import dédié it141 en it142 et le
    #    set sha141 en sha142 : la fenêtre it.141 disparaissait de la chaîne
    #    (les assets it.144 n'auraient PAS été comparés à it.141). On réinsère
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
    t = t.replace("it.143", "it.144")
    t = t.replace("IT143", "IT144")
    t = t.replace("it143", "it144")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it142", "km143_",
                 '"offset": 984', '"offset": 88', "offset 904", "offset 924",
                 "offset 944", "offset 964", "offset 80", "offset 88"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it144 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.143") == 1, f"it.143 × {t.count('it.143')} (attendu 1 — après it.143)"
    assert t.count("it.144") == 2, f"it.144 × {t.count('it.144')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 1004', '"offset": 96', '"offset": 4', "km144_",
                    "multimodal-it144", "offset 984", "offset 96", "offset 4",
                    "après it.143",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.143 légitime 3×
    #    (fenêtre précédente : celle d'it.143 — offset 984 + après l'offset
    #    984 d'it.143 + après l'offset 88 d'it.143), it.144 ×3 (courante)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.143") == 3, f"it.143 × {t2.count('it.143')} (attendu 3 — fenêtre précédente)"
    assert t2.count("it.144") == 3, f"it.144 × {t2.count('it.144')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.142", "IT143", "km143_", "it137", "it142", "it143",
                 "offset 964", "offset 80", "offset 88 (it", "⟪",
                 "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it144 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it144/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it144.ts", sortie)',
        "fenêtre offset 1004",
        "fenêtre offset 96",
        "celle d'it.143 — offset 984",
        "après l'offset 984 d'it.143",
        "après l'offset 88 d'it.143",
        "12 nov 2026",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — la SNAPSHOT_SOURCE it142.bin devient it143.bin par
    #    l'ordre courant-d'abord (aucune restauration explicite) ; it.130
    #    légitime 1× ; it.129 ×2
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it143.bin"', "")
    residus = [x for x in ["IT143", "km143_", "it137", "it142", "it143",
                           "offset 964", "offset 80",
                           "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it144 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it143.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it144.bin"',
        'from "../lib/neural/generation/multimodal-it144"',
        "ASSETS_MULTIMODAL_IT144",
        "PAIRES_MULTIMODAL_IT144",
        "offset 1004",
        "offset 96",
        "après l'offset 984 d'it.143",
        "après l'offset 88 d'it.143",
        "celle d'it.143",
        "cumulatif it.143",
        "après offset 984 (it.143)",
        "après offset 88 (it.143)",
        "état hérité d'it.143, avant gravure it.144",
        "12 nov 2026",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT95…IT138 + IT141 + IT142 + IT143 légitimes exactement 2×
    #    chacun (import dédup + set shaNNN ; IT141/IT143 réinsérés/shiftés) ;
    #    IT144 = fenêtre courante ; « it137 » ×1 (chemin d'import protégé)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT95", "IT96", "IT97", "IT98", "IT99", "IT101", "IT104",
                  "IT105", "IT106", "IT107", "IT108", "IT109", "IT110",
                  "IT111", "IT112", "IT113", "IT115", "IT116", "IT117",
                  "IT118", "IT119", "IT120", "IT121", "IT122", "IT123",
                  "IT124", "IT125", "IT126", "IT127", "IT128", "IT129",
                  "IT130", "IT131", "IT132", "IT133", "IT134", "IT135",
                  "IT136", "IT137", "IT138", "IT141", "IT142", "IT143"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert "sha141" in t4 and "sha142" in t4 and "sha143" in t4, "sets sha141/sha142/sha143 requis"
    assert t4.count("IT144") >= 10, f"IT144 × {t4.count('IT144')} (attendu >= 10 — fenêtre courante)"
    ligne137 = [l for l in t4.splitlines() if "IT137" in l and "import" in l]
    assert ligne137 == ['import { ASSETS_MULTIMODAL_IT137 } from "./multimodal-it137";'], ligne137
    ligne138 = [l for l in t4.splitlines() if "IT138" in l and "import" in l]
    assert ligne138 == ['import { ASSETS_MULTIMODAL_IT138 } from "./multimodal-it138";'], ligne138
    ligne141 = [l for l in t4.splitlines() if "IT141" in l and "import" in l]
    assert ligne141 == ['import { ASSETS_MULTIMODAL_IT141 } from "./multimodal-it141";'], ligne141
    ligne142 = [l for l in t4.splitlines() if "IT142" in l and "import" in l]
    assert ligne142 == ['import { ASSETS_MULTIMODAL_IT142 } from "./multimodal-it142";'], ligne142
    ligne143 = [l for l in t4.splitlines() if "IT143" in l and "import" in l]
    assert ligne143 == ['import { ASSETS_MULTIMODAL_IT143 } from "./multimodal-it143";'], ligne143
    for attendu in [
        "km144_",
        "sha141",
        "sha142",
        "sha143",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40), it.136 (884/48), it.137 (904/56), it.138 (924/64), it.141 (944/72), it.142 (964/80), it.143 (984/88) et it.144 (1004/96)",
        "COCO offset 1004, MLS offset 96 — après it.143 : 984/88",
        "fenêtre offset 96 après offset 88 (it.143)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.143",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km143_", "km142_", "km141_", "km138_", "km137_", "km136_", "km135_", "km134_",
                 "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪",
                 "offset 964", "offset 80", '964/80"', "it.143 (964/80)"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it144 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.143)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.143", "it.144")
    t5 = t5.replace("it143", "it144")
    t5 = t5.replace("it.90→it.142", "it.90→it.143")
    # le seul « it.143 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.143") == 1, f"it.143 × {t5.count('it.143')} (attendu 1 — borne du lot historique)"
    interdits = ["it142", "it.142"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it144 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it144/assets.json", "fenêtre it.144",
                    'multimodal-it144.ts")', "it.90→it.143"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.143", "IT143", "it143"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it144 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it144"',
        "ASSETS_MULTIMODAL_IT144",
        "PAIRES_MULTIMODAL_IT144",
        '"var/evaluation-navigateur-it144.json"',
        "FENÊTRE it.144",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.143 → it.144 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

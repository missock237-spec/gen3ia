#!/usr/bin/env python3
"""Transforme les scripts it.144 en scripts it.145 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

CONTEXTE it.145 : it.144 a consommé la fenêtre COCO 1004 / MLS 96 ; la
fenêtre SUIVANTE est COCO offset 1024 / MLS offset 104. La fenêtre
PRÉCÉDENTE devient it.144 (1004/96) ; it.143 (984/88) devient la fenêtre
ante-précédente et it.142 (964/80) reste dans la chaîne de déduplication
(réinsérée explicitement — son import dédié est décalé par le renommage).

Pièges traités (leçons it.106→…→it.145) :
  - identifiants PascalCase IT144 → IT145 (remplacement séparé de it144) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it144.bin) — produit par
    l'ORDRE SEUL : la source it143.bin (chemin nu) est renommée it144.bin par
    la règle générique « it143 »→« it144 » exécutée APRÈS « it144 »→« it145 »
    (la SORTIE it144.bin part d'abord vers it145.bin, puis l'ancienne source
    devient la nouvelle source) — zéro restauration explicite nécessaire ;
  - fenêtre courante d'abord (1004/96 → 1024/104), PUIS références historiques
    (984/88 → 1004/96) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (plan à MARQUEURS ⟪P⟫/⟪Q⟫ reconduit) :
      1. offset 1004 → offset ⟪P⟫  (coco courant, protégé)
      2. offset 96  → offset ⟪Q⟫  (mls courant, protégé)
      3. offset 88  → offset 96   (mls précédent — plus aucun 88 vivant)
      4. offset 984 → offset 1004 (coco précédent — plus aucun 984 vivant)
      5. offset ⟪P⟫ → offset 1024 (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫ → offset 104  (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure ; « offset 4 » (UCF101, preuve du zéro) n'est JAMAIS
    remplacé et « offset 104 » créé en dernier ne matche aucune étape ;
    (« offset 96 » créé à l'étape 3 ne matche plus aucune étape — l'étape 2
    est déjà passée) ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) », « doublon de contenu
    it.137 / it.138 » (les ensembles sha137/sha138 EXISTENT toujours dans
    le test) ne matchent ni les formes documentées (d'it.143 / (it.143) /
    cumulatif it.143 / après it.143) ni les renommages d'offsets ;
  - TITRE DU TEST DE DÉDUP : les segments « N/N » (1004/96, 984/88, 964/80)
    ne matchent AUCUN plan « offset N » — une règle spéciale met la queue du
    titre à jour APRÈS les renommages génériques (réinsère it.141 (944/72),
    replace it.142 (964/80), it.143 (984/88), it.144 (1004/96) et ajoute
    it.145 (1024/104)) ;
  - RÉSUMÉ « après it.144 : N/N » — règle spéciale 984/88 → 1004/96 ;
  - SETS DE DÉDUP : ordre DESCENDANT sha143→sha144, sha142→sha143,
    sha141→sha142 (l'inverse ferait un double saut) — les noms suivent le
    module que leur initialisateur référence après les renommages
    IT141→IT142, IT142→IT143, IT143→IT144 ; la fenêtre COURANTE (IT145) n'a
    PAS de set propre : elle est comparée contre tous les sets précédents ;
    la réinsertion (règle 6) recrée le set sha141 manquant ;
  - RÉINSERTION it.141 (import + set + expect entre it.138 et it.142) : le
    renommage générique a transformé l'import dédié it141 en it142 — la
    fenêtre it.141 disparaîtrait de la chaîne (les assets it.145 n'auraient
    PAS été comparés à it.141) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (mesuré sur pièce it.144 : prose = offset 1004 (précédent), offset 96
    (courant), offset 4) ; JSON d'ABORD pour que la règle prose
    « offset 96 » ne touche pas le JSON ;
  - km144_ → km145_ (préfixe indépendant des identifiants IT) ;
  - DATE de mesure/download : « 12 nov 2026 » (héritée) → « 16 nov 2026 »
    (date réelle de la fenêtre it.145).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it144.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it145.py"
GENERE_IN = "scripts/genere-module-multimodal-it144.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it145.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it144.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it145.ts"
TEST_IN = "lib/neural/generation/multimodal-it144.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it145.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it144.py"
DEDUP_OUT = "scripts/verifie-dedup-it145.py"
EVAL_IN = "scripts/evaluation-navigateur-it144.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it145.ts"

P = "⟪P⟫"  # offset coco courant protégé (1004 → 1024)
Q = "⟪Q⟫"  # offset mls courant protégé (96 → 104)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 1004", f"offset {P}"),
    ("offset 96", f"offset {Q}"),
    ("offset 88", "offset 96"),
    ("offset 984", "offset 1004"),
    (f"offset {P}", "offset 1024"),
    (f"offset {Q}", "offset 104"),
]
# JSON — indépendants (« "offset": 4 » UCF101 n'est JAMAIS remplacé).
OFFSETS_JSON = [
    ('"offset": 1004', '"offset": 1024'),
    ('"offset": 96', '"offset": 104'),
]


def appliquer_marques(t: str) -> str:
    for ancien, nouveau in OFFSETS_PROSE_MARQUES:
        t = t.replace(ancien, nouveau)
    assert P not in t and Q not in t, "marqueurs ⟪P⟫/⟪Q⟫ résiduels"
    return t


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur).

    ORDRE : courant (144→145) d'abord, précédente (143→144) ensuite —
    l'ordre inverse ferait un double saut 143→145."""
    t = src
    # 1. offsets — plan à marqueurs (voir docstring)
    t = appliquer_marques(t)
    # 2. date de la fenêtre (mesure/download réelle)
    t = t.replace("12 nov 2026", "16 nov 2026")
    # 3. fenêtre courante it.144 → it.145
    t = t.replace("it.144", "it.145")
    t = t.replace("IT144", "IT145")
    t = t.replace("it144", "it145")
    t = t.replace("km144_", "km145_")
    # 4. fenêtre précédente it.143 → it.144 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.143", "d'it.144")
    t = t.replace("(it.143)", "(it.144)")
    t = t.replace("cumulatif it.143", "cumulatif it.144")
    t = t.replace("après it.143", "après it.144")
    t = t.replace("it.143", "it.144")
    t = t.replace("IT143", "IT144")
    t = t.replace("it143", "it144")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose).

    JSON d'abord, prose ensuite (mesuré sur pièce it.144 : la prose contient
    « offset 984 » (précédent COCO), « offset 96 » (courant MLS), « offset 4 »
    — la règle prose « offset 96 » doit courir APRÈS le JSON pour ne pas
    corrompre « "offset": 96 »)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 984", "offset 1004")
    t = t.replace("offset 96", "offset 104")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.143 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.144", "it.145")
    t = t.replace("(it.143)", "(it.144)")
    t = t.replace("après it.143", "après it.144")
    t = t.replace("it144", "it145")    # chemins + user-agent
    t = t.replace("km144_", "km145_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    """Transformation du test de garde it.144 → it.145.

    PROTECTIONS : « it137 » (chemin d'import de la fenêtre ante-précédente)
    n'est JAMAIS renommé — le module multimodal-it137.ts existe toujours ;
    « doublon de contenu it.137/it.138 » — les ensembles sha137/sha138
    EXISTENT toujours (les modules restent importés).
    SETS : ordre DESCENDANT sha143→sha144, sha142→sha143, sha141→sha142
    (ordre critique), AVANT la réinsertion du set sha141 de la règle 9
    (sinon déclaration en double).
    RÉINSERTION it.141 (import + set + expect entre it.138 et it.142)."""
    t = src
    # 1. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 2. date de la fenêtre
    t = t.replace("12 nov 2026", "16 nov 2026")
    # 3. globals fenêtre courante (PAS de règle « it137 » — voir docstring)
    t = t.replace("it.144", "it.145")
    t = t.replace("IT144", "IT145")
    t = t.replace("it144", "it145")
    t = t.replace("km144_", "km145_")
    # 4. fenêtre précédente — formes documentées puis générique
    t = t.replace("d'it.143", "d'it.144")
    t = t.replace("(it.143)", "(it.144)")
    t = t.replace("après it.143", "après it.144")
    t = t.replace("it.143", "it.144")
    t = t.replace("IT143", "IT144")
    t = t.replace("it143", "it144")
    t = t.replace("cumulatif it.143", "cumulatif it.144")
    # 5. fenêtre ante-précédente it.142 → it.143 puis it.141 → it.142
    t = t.replace("it.142", "it.143")
    t = t.replace("IT142", "IT143")
    t = t.replace("it142", "it143")
    t = t.replace("it.141", "it.142")
    t = t.replace("IT141", "IT142")
    t = t.replace("it141", "it142")
    # 6. NOMS des sets de dédup : les initialisateurs pointent maintenant
    #    vers les modules décalés — les noms suivent. ORDRE CRITIQUE :
    #    DESCENDANT (143→144 d'abord — l'inverse ferait un double saut).
    #    La fenêtre courante IT145 n'a pas de set propre (comparée contre
    #    tous les précédents) — aucun set sha145 n'est créé.
    t = t.replace("sha143", "sha144")
    t = t.replace("sha142", "sha143")
    t = t.replace("sha141", "sha142")
    # 7. titre de déduplication : après les génériques la queue du titre dit
    #    « … it.142 (944/72), it.143 (964/80), it.144 (984/88) et it.145
    #    (1004/96) » — on réinsère it.141 (944/72), replace it.142 (964/80),
    #    it.143 (984/88), it.144 (1004/96) et ajoute it.145 (1024/104)
    t = t.replace(
        'it.142 (944/72), it.143 (964/80), it.144 (984/88) et it.145 (1004/96)", () => {',
        'it.141 (944/72), it.142 (964/80), it.143 (984/88), it.144 (1004/96) et it.145 (1024/104)", () => {',
    )
    # 8. résumé de la fenêtre précédente : la générique + plan ont laissé
    #    « après it.144 : 984/88 » — le couple N/N de la fenêtre précédente
    #    est désormais 1004/96
    t = t.replace("après it.144 : 984/88", "après it.144 : 1004/96")
    # 9. RÉINSERTION de la fenêtre it.141 dans la chaîne de dédup — le
    #    renommage générique a transformé l'import dédié it141 en it142 et le
    #    set sha141 en sha142 : la fenêtre it.141 disparaissait de la chaîne
    #    (les assets it.145 n'auraient PAS été comparés à it.141). On réinsère
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
    t = t.replace("it.144", "it.145")
    t = t.replace("IT144", "IT145")
    t = t.replace("it144", "it145")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it144", "km144_",
                 '"offset": 1004', '"offset": 96', "offset 904", "offset 924",
                 "offset 944", "offset 964", "offset 984", "offset 80",
                 "offset 88", "offset 96"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it145 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.144") == 1, f"it.144 × {t.count('it.144')} (attendu 1 — après it.144)"
    assert t.count("it.145") == 2, f"it.145 × {t.count('it.145')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 1024', '"offset": 104', '"offset": 4', "km145_",
                    "multimodal-it145", "offset 1004", "offset 104", "offset 4",
                    "après it.144",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.144 légitime 3×
    #    (fenêtre précédente : celle d'it.144 — offset 1004 + après l'offset
    #    1004 d'it.144 + après l'offset 96 d'it.144), it.145 ×3 (courante)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.144") == 3, f"it.144 × {t2.count('it.144')} (attendu 3 — fenêtre précédente)"
    assert t2.count("it.145") == 3, f"it.145 × {t2.count('it.145')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.143", "IT144", "km144_", "it137", "it143", "it144",
                 "offset 984", "offset 80", "offset 96 (it", "⟪",
                 "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it145 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it145/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it145.ts", sortie)',
        "fenêtre offset 1024",
        "fenêtre offset 104",
        "celle d'it.144 — offset 1004",
        "après l'offset 1004 d'it.144",
        "après l'offset 96 d'it.144",
        "16 nov 2026",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — la SNAPSHOT_SOURCE it143.bin devient it144.bin par
    #    l'ordre courant-d'abord (aucune restauration explicite) ; it.130
    #    légitime 1× ; it.129 ×2
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it144.bin"', "")
    residus = [x for x in ["IT144", "km144_", "it137", "it143", "it144",
                           "offset 984", "offset 80",
                           "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it145 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it144.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it145.bin"',
        'from "../lib/neural/generation/multimodal-it145"',
        "ASSETS_MULTIMODAL_IT145",
        "PAIRES_MULTIMODAL_IT145",
        "offset 1024",
        "offset 104",
        "après l'offset 1004 d'it.144",
        "après l'offset 96 d'it.144",
        "celle d'it.144",
        "cumulatif it.144",
        "après offset 1004 (it.144)",
        "après offset 96 (it.144)",
        "état hérité d'it.144, avant gravure it.145",
        "16 nov 2026",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT95…IT138 + IT141 + IT142 + IT143 + IT144 légitimes
    #    exactement 2× chacun (import dédup + set shaNNN ; IT141 réinséré,
    #    IT142/IT143/IT144 shiftés) ; IT145 = fenêtre courante ;
    #    « it137 » ×1 (chemin d'import protégé)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT95", "IT96", "IT97", "IT98", "IT99", "IT101", "IT104",
                  "IT105", "IT106", "IT107", "IT108", "IT109", "IT110",
                  "IT111", "IT112", "IT113", "IT115", "IT116", "IT117",
                  "IT118", "IT119", "IT120", "IT121", "IT122", "IT123",
                  "IT124", "IT125", "IT126", "IT127", "IT128", "IT129",
                  "IT130", "IT131", "IT132", "IT133", "IT134", "IT135",
                  "IT136", "IT137", "IT138", "IT141", "IT142", "IT143",
                  "IT144"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert "sha141" in t4 and "sha142" in t4 and "sha143" in t4 \
        and "sha144" in t4, "sets sha141…sha144 requis (pas de set courant)"
    assert t4.count("IT145") >= 10, f"IT145 × {t4.count('IT145')} (attendu >= 10 — fenêtre courante)"
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
    ligne144 = [l for l in t4.splitlines() if "IT144" in l and "import" in l]
    assert ligne144 == ['import { ASSETS_MULTIMODAL_IT144 } from "./multimodal-it144";'], ligne144
    for attendu in [
        "km145_",
        "sha141",
        "sha142",
        "sha143",
        "sha144",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40), it.136 (884/48), it.137 (904/56), it.138 (924/64), it.141 (944/72), it.142 (964/80), it.143 (984/88), it.144 (1004/96) et it.145 (1024/104)",
        "COCO offset 1024, MLS offset 104 — après it.144 : 1004/96",
        "fenêtre offset 104 après offset 96 (it.144)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.144",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km144_", "km143_", "km142_", "km141_", "km138_", "km137_", "km136_", "km135_", "km134_",
                 "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪",
                 "offset 984", "offset 88", "offset 964", "offset 80",
                 '984/88", () => {', "it.144 (984/88) et"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it145 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.144)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.144", "it.145")
    t5 = t5.replace("it144", "it145")
    t5 = t5.replace("it.90→it.143", "it.90→it.144")
    # le seul « it.144 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.144") == 1, f"it.144 × {t5.count('it.144')} (attendu 1 — borne du lot historique)"
    interdits = ["it143", "it.143"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it145 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it145/assets.json", "fenêtre it.145",
                    'multimodal-it145.ts")', "it.90→it.144"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.144", "IT144", "it144"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it145 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it145"',
        "ASSETS_MULTIMODAL_IT145",
        "PAIRES_MULTIMODAL_IT145",
        '"var/evaluation-navigateur-it145.json"',
        "FENÊTRE it.145",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.144 → it.145 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

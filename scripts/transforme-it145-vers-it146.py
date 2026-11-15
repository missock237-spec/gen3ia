#!/usr/bin/env python3
"""Transforme les scripts it.145 en scripts it.146 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

CONTEXTE it.146 : it.145 a consommé la fenêtre COCO 1024 / MLS 104 ; la
fenêtre SUIVANTE est COCO offset 1044 / MLS offset 112. La fenêtre
PRÉCÉDENTE devient it.145 (1024/104) ; it.144 (1004/96) devient la fenêtre
ante-précédente et it.143 (984/88) reste dans la chaîne de déduplication
(réinsérée explicitement — son import dédié est décalé par le renommage).

Pièges traités (leçons it.106→…→it.146) :
  - identifiants PascalCase IT145 → IT146 (remplacement séparé de it145) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it145.bin) — produit par
    l'ORDRE SEUL : la source it144.bin (chemin nu) est renommée it145.bin par
    la règle générique « it144 »→« it145 » exécutée APRÈS « it145 »→« it146 »
    (la SORTIE it145.bin part d'abord vers it146.bin, puis l'ancienne source
    devient la nouvelle source) — zéro restauration explicite nécessaire ;
  - fenêtre courante d'abord (1024/104 → 1044/112), PUIS références
    historiques (1004/96 → 1024/104) — l'ordre inverse corromprait les
    références ;
  - ORDRE CRITIQUE des offsets (plan à MARQUEURS ⟪P⟫/⟪Q⟫ reconduit) :
      1. offset 1024 → offset ⟪P⟫  (coco courant, protégé)
      2. offset 104  → offset ⟪Q⟫  (mls courant, protégé)
      3. offset 1004 → offset 1024 (coco précédent — plus aucun 1004 vivant)
      4. offset 96   → offset 104  (mls précédent — plus aucun 96 vivant)
      5. offset ⟪P⟫  → offset 1044 (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫  → offset 112  (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure ; « offset 4 » (UCF101, preuve du zéro) n'est JAMAIS
    remplacé ; « offset 104 » créé à l'étape 4 ne matche plus aucune étape
    (l'étape 2 est déjà passée) et « offset 1044 » créé à l'étape 5 ne
    contient aucun « offset ⟪Q⟫ » — le couple 1024/1044 est sûr car
    « offset 104 » n'est PAS une sous-chaîne de « offset 1024 » (10**2**4
    vs 10**4**) ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) », « doublon de contenu
    it.137 / it.138 » (les ensembles sha137/sha138 EXISTENT toujours dans
    le test) ne matchent ni les formes documentées (d'it.144 / (it.144) /
    cumulatif it.144 / après it.144) ni les renommages d'offsets ;
  - TITRE DU TEST DE DÉDUP : les segments « N/N » (1024/104, 1004/96)
    ne matchent AUCUN plan « offset N » — une règle spéciale met la queue du
    titre à jour APRÈS les renommages génériques (réinsère it.141 (944/72),
    replace it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145
    (1024/104) et ajoute it.146 (1044/112)) ;
  - RÉSUMÉ « après it.145 : N/N » — règle spéciale 1004/96 → 1024/104 ;
  - SETS DE DÉDUP : ordre DESCENDANT sha144→sha145, sha143→sha144,
    sha142→sha143, sha141→sha142 (l'inverse ferait un double saut) — les
    noms suivent le module que leur initialisateur référence après les
    renommages IT141→IT142, IT142→IT143, IT143→IT144, IT144→IT145 ; la
    fenêtre COURANTE (IT146) n'a PAS de set propre : elle est comparée
    contre tous les sets précédents ;
  - RÉINSERTION it.141 (import + set + expect entre it.138 et it.142) : le
    renommage générique a transformé l'import dédié it141 en it142 — la
    fenêtre it.141 disparaîtrait de la chaîne (les assets it.146 n'auraient
    PAS été comparés à it.141) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (mesuré sur pièce it.145 : prose = offset 1004 (précédent), offset 104
    (courant), offset 4) ; JSON d'ABORD pour que la règle prose
    « offset 104 » ne touche pas le JSON ; l'interdit JSON porte la virgune
    (« "offset": 104, ») car « "offset": 104 » est un PRÉFIXE de la
    nouvelle valeur « "offset": 1044 » ;
  - km145_ → km146_ (préfixe indépendant des identifiants IT) ;
  - DATE de mesure/download : « 16 nov 2026 » est CONSERVÉE (it.146 mesurée
    le même jour que it.145 — remplacement identité, assertion de présence).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it145.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it146.py"
GENERE_IN = "scripts/genere-module-multimodal-it145.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it146.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it145.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it146.ts"
TEST_IN = "lib/neural/generation/multimodal-it145.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it146.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it145.py"
DEDUP_OUT = "scripts/verifie-dedup-it146.py"
EVAL_IN = "scripts/evaluation-navigateur-it145.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it146.ts"

P = "⟪P⟫"  # offset coco courant protégé (1024 → 1044)
Q = "⟪Q⟫"  # offset mls courant protégé (104 → 112)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
OFFSETS_PROSE_MARQUES = [
    ("offset 1024", f"offset {P}"),
    ("offset 104", f"offset {Q}"),
    ("offset 1004", "offset 1024"),
    ("offset 96", "offset 104"),
    (f"offset {P}", "offset 1044"),
    (f"offset {Q}", "offset 112"),
]
# JSON — indépendants (« "offset": 4 » UCF101 n'est JAMAIS remplacé).
# Virgule porteuse : « "offset": 104 » serait un préfixe de « 1044 ».
OFFSETS_JSON = [
    ('"offset": 1024,', '"offset": 1044,'),
    ('"offset": 104,', '"offset": 112,'),
]


def appliquer_marques(t: str) -> str:
    for ancien, nouveau in OFFSETS_PROSE_MARQUES:
        t = t.replace(ancien, nouveau)
    assert P not in t and Q not in t, "marqueurs ⟪P⟫/⟪Q⟫ résiduels"
    return t


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur).

    ORDRE : courant (145→146) d'abord, précédente (144→145) ensuite —
    l'ordre inverse ferait un double saut 144→146."""
    t = src
    # 1. offsets — plan à marqueurs (voir docstring)
    t = appliquer_marques(t)
    # 2. date de la fenêtre : conservée (it.146 mesurée le même jour —
    #    16 nov 2026), assertion de présence en sortie
    # 3. fenêtre courante it.145 → it.146
    t = t.replace("it.145", "it.146")
    t = t.replace("IT145", "IT146")
    t = t.replace("it145", "it146")
    t = t.replace("km145_", "km146_")
    # 4. fenêtre précédente it.144 → it.145 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule MLS documentée à it.130 », « ÉPUISÉ
    #    depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.144", "d'it.145")
    t = t.replace("(it.144)", "(it.145)")
    t = t.replace("après it.144", "après it.145")
    t = t.replace("it.144", "it.145")
    t = t.replace("IT144", "IT145")
    t = t.replace("it144", "it145")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose).

    JSON d'abord, prose ensuite (mesuré sur pièce it.145 : la prose contient
    « offset 1004 » (précédent COCO), « offset 104 » (courant MLS), « offset 4 »
    — la règle prose « offset 104 » doit courir APRÈS le JSON pour ne pas
    corrompre « "offset": 1044 »)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = t.replace("offset 1004", "offset 1024")
    t = t.replace("offset 104", "offset 112")
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.144 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.145", "it.146")
    t = t.replace("(it.144)", "(it.145)")
    t = t.replace("après it.144", "après it.145")
    t = t.replace("it145", "it146")    # chemins + user-agent
    t = t.replace("km145_", "km146_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    """Transformation du test de garde it.145 → it.146.

    PROTECTIONS : « it137 » (chemin d'import de la fenêtre ante-précédente)
    n'est JAMAIS renommé — le module multimodal-it137.ts existe toujours ;
    « doublon de contenu it.137/it.138 » — les ensembles sha137/sha138
    EXISTENT toujours (les modules restent importés).
    SETS : ordre DESCENDANT sha144→sha145, sha143→sha144, sha142→sha143,
    sha141→sha142 (ordre critique), AVANT la réinsertion du set sha141 de
    la règle 9 (sinon déclaration en double).
    RÉINSERTION it.141 (import + set + expect entre it.138 et it.142)."""
    t = src
    # 1. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 2. date de la fenêtre : conservée (même jour, 16 nov 2026)
    # 3. globals fenêtre courante (PAS de règle « it137 » — voir docstring)
    t = t.replace("it.145", "it.146")
    t = t.replace("IT145", "IT146")
    t = t.replace("it145", "it146")
    t = t.replace("km145_", "km146_")
    # 4. fenêtre précédente — formes documentées puis générique
    t = t.replace("d'it.144", "d'it.145")
    t = t.replace("(it.144)", "(it.145)")
    t = t.replace("après it.144", "après it.145")
    t = t.replace("it.144", "it.145")
    t = t.replace("IT144", "IT145")
    t = t.replace("it144", "it145")
    t = t.replace("cumulatif it.144", "cumulatif it.145")
    # 5. fenêtre ante-précédente it.143 → it.144, puis it.142 → it.143,
    #    puis it.141 → it.142
    t = t.replace("it.143", "it.144")
    t = t.replace("IT143", "IT144")
    t = t.replace("it143", "it144")
    t = t.replace("it.142", "it.143")
    t = t.replace("IT142", "IT143")
    t = t.replace("it142", "it143")
    t = t.replace("it.141", "it.142")
    t = t.replace("IT141", "IT142")
    t = t.replace("it141", "it142")
    # 6. NOMS des sets de dédup : les initialisateurs pointent maintenant
    #    vers les modules décalés — les noms suivent. ORDRE CRITIQUE :
    #    DESCENDANT (144→145 d'abord — l'inverse ferait un double saut).
    #    La fenêtre courante IT146 n'a pas de set propre (comparée contre
    #    tous les précédents) — aucun set sha146 n'est créé.
    t = t.replace("sha144", "sha145")
    t = t.replace("sha143", "sha144")
    t = t.replace("sha142", "sha143")
    t = t.replace("sha141", "sha142")
    # 7. titre de déduplication : après les génériques la queue du titre dit
    #    « … it.142 (944/72), it.143 (964/80), it.144 (984/88), it.145
    #    (1004/96) et it.146 (1024/104) » — on réinsère it.141 (944/72),
    #    replace it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145
    #    (1024/104) et ajoute it.146 (1044/112)
    t = t.replace(
        'it.142 (944/72), it.143 (964/80), it.144 (984/88), it.145 (1004/96) et it.146 (1024/104)", () => {',
        'it.141 (944/72), it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145 (1024/104) et it.146 (1044/112)", () => {',
    )
    # 8. résumé de la fenêtre précédente : la générique + plan ont laissé
    #    « après it.145 : 1004/96 » — le couple N/N de la fenêtre précédente
    #    est désormais 1024/104
    t = t.replace("après it.145 : 1004/96", "après it.145 : 1024/104")
    # 9. RÉINSERTION de la fenêtre it.141 dans la chaîne de dédup — le
    #    renommage générique a transformé l'import dédié it141 en it142 et le
    #    set sha141 en sha142 : la fenêtre it.141 disparaissait de la chaîne
    #    (les assets it.146 n'auraient PAS été comparés à it.141). On réinsère
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
    t = t.replace("it.145", "it.146")
    t = t.replace("IT145", "IT146")
    t = t.replace("it145", "it146")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it145", "km145_",
                 '"offset": 1024,', '"offset": 104,', "offset 1004", "offset 96",
                 "offset 80", "offset 88", "offset 904", "offset 924",
                 "offset 944", "offset 964", "offset 984"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it146 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.145") == 1, f"it.145 × {t.count('it.145')} (attendu 1 — après it.145)"
    assert t.count("it.146") == 2, f"it.146 × {t.count('it.146')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 1044,', '"offset": 112,', '"offset": 4,', "km146_",
                    "multimodal-it146", "offset 1024", "offset 112", "offset 4",
                    "après it.145",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.145 légitime 3×
    #    (fenêtre précédente : celle d'it.145 — offset 1024 + après l'offset
    #    1024 d'it.145 + après l'offset 104 d'it.145), it.146 ×3 (courante)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.145") == 3, f"it.145 × {t2.count('it.145')} (attendu 3 — fenêtre précédente)"
    assert t2.count("it.146") == 3, f"it.146 × {t2.count('it.146')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.144", "IT145", "km145_", "it137", "it145", "it144",
                 "offset 1004", "offset 80", "offset 96 (it", "⟪",
                 "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it146 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it146/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it146.ts", sortie)',
        "fenêtre offset 1044",
        "fenêtre offset 112",
        "celle d'it.145 — offset 1024",
        "après l'offset 1024 d'it.145",
        "après l'offset 104 d'it.145",
        "16 nov 2026",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — la SNAPSHOT_SOURCE it144.bin devient it145.bin par
    #    l'ordre courant-d'abord (aucune restauration explicite) ; it.130
    #    légitime 1× ; it.129 ×2
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it145.bin"', "")
    residus = [x for x in ["IT145", "km145_", "it137", "it145", "it144",
                           "offset 1004", "offset 80",
                           "CHANGEMENT DE SOURCE", "⟪"] if x in t3_sans]
    print(f"entrainement-it146 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it145.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it146.bin"',
        'from "../lib/neural/generation/multimodal-it146"',
        "ASSETS_MULTIMODAL_IT146",
        "PAIRES_MULTIMODAL_IT146",
        "offset 1044",
        "offset 112",
        "après l'offset 1024 d'it.145",
        "après l'offset 104 d'it.145",
        "celle d'it.145",
        "cumulatif it.145",
        "après offset 1024 (it.145)",
        "après offset 104 (it.145)",
        "état hérité d'it.145, avant gravure it.146",
        "16 nov 2026",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT95…IT138 + IT141 + IT142 + IT143 + IT144 + IT145
    #    légitimes exactement 2× chacun (import dédup + set shaNNN ; IT141
    #    réinséré, IT142/IT143/IT144/IT145 shiftés) ; IT146 = fenêtre
    #    courante ; « it137 » ×1 (chemin d'import protégé)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT95", "IT96", "IT97", "IT98", "IT99", "IT101", "IT104",
                  "IT105", "IT106", "IT107", "IT108", "IT109", "IT110",
                  "IT111", "IT112", "IT113", "IT115", "IT116", "IT117",
                  "IT118", "IT119", "IT120", "IT121", "IT122", "IT123",
                  "IT124", "IT125", "IT126", "IT127", "IT128", "IT129",
                  "IT130", "IT131", "IT132", "IT133", "IT134", "IT135",
                  "IT136", "IT137", "IT138", "IT141", "IT142", "IT143",
                  "IT144", "IT145"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert "sha141" in t4 and "sha142" in t4 and "sha143" in t4 \
        and "sha144" in t4 and "sha145" in t4, "sets sha141…sha145 requis (pas de set courant)"
    assert t4.count("IT146") >= 10, f"IT146 × {t4.count('IT146')} (attendu >= 10 — fenêtre courante)"
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
    ligne145 = [l for l in t4.splitlines() if "IT145" in l and "import" in l]
    assert ligne145 == ['import { ASSETS_MULTIMODAL_IT145 } from "./multimodal-it145";'], ligne145
    ligne146 = [l for l in t4.splitlines() if "IT146" in l and "import" in l]
    assert ligne146 == ['import { ASSETS_MULTIMODAL_IT146, PAIRES_MULTIMODAL_IT146 } from "./multimodal-it146";'], ligne146
    for attendu in [
        "km146_",
        "sha141",
        "sha142",
        "sha143",
        "sha144",
        "sha145",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40), it.136 (884/48), it.137 (904/56), it.138 (924/64), it.141 (944/72), it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145 (1024/104) et it.146 (1044/112)",
        "COCO offset 1044, MLS offset 112 — après it.145 : 1024/104",
        "fenêtre offset 112 après offset 104 (it.145)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.145",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km145_", "km144_", "km143_", "km142_", "km141_", "km138_", "km137_", "km136_", "km135_", "km134_",
                 "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪",
                 "offset 1004", "offset 88", "offset 984", "offset 80",
                 '1024/104", () => {', "it.145 (1004/96) et"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it146 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.145)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.145", "it.146")
    t5 = t5.replace("it145", "it146")
    t5 = t5.replace("it.90→it.144", "it.90→it.145")
    # le seul « it.145 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.145") == 1, f"it.145 × {t5.count('it.145')} (attendu 1 — borne du lot historique)"
    interdits = ["it144", "it.144"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it146 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it146/assets.json", "fenêtre it.146",
                    'multimodal-it146.ts")', "it.90→it.145"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.145", "IT145", "it145"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it146 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it146"',
        "ASSETS_MULTIMODAL_IT146",
        "PAIRES_MULTIMODAL_IT146",
        '"var/evaluation-navigateur-it146.json"',
        "FENÊTRE it.146",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    print("CASCADE it.145 → it.146 : 6 fichiers générés, 0 résidu ✓")


if __name__ == "__main__":
    main()

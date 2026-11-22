#!/usr/bin/env python3
"""Transforme les scripts it.147 en scripts it.148 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

CONTEXTE it.148 : it.147 a consommé la fenêtre COCO 1064 / MLS 120 ; la
fenêtre SUIVANTE est COCO offset 1084 / MLS offset 128. La fenêtre
PRÉCÉDENTE devient it.147 (1064/120) ; it.146 (1044/112) devient la fenêtre
ante-précédente et it.145 (1024/104) reste dans la chaîne de déduplication.

DATE : la fenêtre it.148 est MESURÉE le 22 nov 2026 (it.147 l'était le
16 nov 2026) — règle dédiée « 16 nov 2026 » → « 22 nov 2026 » sur les
références de mesure de la fenêtre courante (docstrings genere +
entraînement). Les faits historiques d'it.130/it.129 sont intouchés.

Pièges traités (leçons it.106→…→it.148) :
  - identifiants PascalCase IT147 → IT148 (remplacement séparé de it147) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it147.bin) — produit par
    l'ORDRE SEUL : la source it146.bin (chemin nu) est renommée it147.bin par
    la règle générique « it146 »→« it147 » exécutée APRÈS « it147 »→« it148 »
    (la SORTIE it147.bin part d'abord vers it148.bin, puis l'ancienne source
    devient la nouvelle source) — zéro restauration explicite nécessaire ;
  - fenêtre courante d'abord (1064/120 → 1084/128), PUIS références
    historiques (1044/112 → 1064/120) — l'ordre inverse corromprait les
    références ;
  - VÉRIFICATION DU PIÈGE PRÉFIXE it.147 : « offset 104 » ⊂ « offset 1044 »
    N'EXISTE PLUS dans les fichiers it.147 (aucun « offset 104 » nu — vérifié
    sur pièce avant cascade) ; l'étape prev-MLS (112→120) est donc
    INDEPENDANTE de l'étape prev-COCO (1044→1064) — aucune sous-chaîne :
      1. offset 1064 → offset ⟪P⟫  (coco courant, protégé)
      2. offset 120  → offset ⟪Q⟫  (mls courant, protégé)
      3. offset 112  → offset 120  (mls précédent — crée des « offset 120 »
         APRÈS le passage de l'étape 2 : ils sont des références LÉGITIMES
         de la fenêtre précédente, jamais re-protégés)
      4. offset 1044 → offset 1064 (coco précédent — crée des « offset 1064 »
         APRÈS le passage de l'étape 1 : idem)
      5. offset ⟪P⟫  → offset 1084 (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫  → offset 128  (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure ; « offset 4 » (UCF101, preuve du zéro) n'est JAMAIS
    remplacé ; l'interdit JSON porte la virgule (« "offset": 120, ») car les
    formes JSON « "offset": 120 » et « "offset": 128 » restent mutuellement
    sûres (aucune sous-chaîne) ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) », « doublon de contenu
    it.137 / it.138 » (les ensembles sha137/sha138 EXISTENT toujours dans
    le test) ne matchent ni les formes documentées (d'it.146 / (it.146) /
    cumulatif it.146 / après it.146) ni les renommages d'offsets ;
  - TITRE DU TEST DE DÉDUP : les segments « N/N » (1064/120, 1044/112)
    ne matchent AUCUN plan « offset N » — une règle spéciale met la queue du
    titre à jour APRÈS les renommages génériques (réinsère it.141 (944/72),
    replace it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145
    (1024/104), it.146 (1044/112), it.147 (1064/120) et ajoute it.148
    (1084/128)) ;
  - RÉSUMÉ « après it.147 : N/N » — règle spéciale 1044/112 → 1064/120 ;
  - SETS DE DÉDUP : ordre DESCENDANT sha146→sha147, sha145→sha146,
    sha144→sha145, sha143→sha144, sha142→sha143, sha141→sha142 (l'inverse
    ferait un double saut) — les noms suivent le module que leur
    initialisateur référence après les renommages IT141→IT142 … IT146→IT147 ;
    la fenêtre COURANTE (IT148) n'a PAS de set propre : elle est comparée
    contre tous les sets précédents ;
  - RÉINSERTION it.141 (import + set + expect entre it.138 et it.142) : le
    renommage générique a transformé l'import dédié it141 en it142 — la
    fenêtre it.141 disparaîtrait de la chaîne (les assets it.148 n'auraient
    PAS été comparés à it.141) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (mesuré sur pièce it.147 : prose = offset 1064 (courant), offset 120
    (courant), offset 1044 (précédent), offset 4) ; JSON d'ABORD pour que la
    règle prose « offset 120 » ne touche pas le JSON ;
  - km147_ → km148_ (préfixe indépendant des identifiants IT) ;
  - GARDE CARTE-MÉMOIRE (7e sortie) : borne de fenêtres 47 → 48, dernière
    fenêtre it.147 → it.148, dernier snapshot it147.bin → it148.bin ;
  - VÉRIFICATION PRODUCTION (8e sortie) : chemins it147 → it148 + étiquette
    docstring km145_ (résidu d'étiquette historique) → km148_.
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it147.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it148.py"
GENERE_IN = "scripts/genere-module-multimodal-it147.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it148.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it147.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it148.ts"
TEST_IN = "lib/neural/generation/multimodal-it147.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it148.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it147.py"
DEDUP_OUT = "scripts/verifie-dedup-it148.py"
EVAL_IN = "scripts/evaluation-navigateur-it147.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it148.ts"
GARDE_IN = "lib/neural/generation/carte-memoire.test.ts"
GARDE_OUT = "lib/neural/generation/carte-memoire.test.ts"  # en place
PRODUCTION_IN = "scripts/verifie-production-it147.py"
PRODUCTION_OUT = "scripts/verifie-production-it148.py"

P = "⟪P⟫"  # offset coco courant protégé (1064 → 1084)
Q = "⟪Q⟫"  # offset mls courant protégé (120 → 128)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
# Étapes 3/4 indépendantes this tick : « offset 112 » n'est PAS un préfixe
# de « offset 1044 » (1044 commence par « 10 ») — l'ordre 3/4 est libre,
# conservé par symétrie avec it.147.
OFFSETS_PROSE_MARQUES = [
    ("offset 1064", f"offset {P}"),
    ("offset 120", f"offset {Q}"),
    ("offset 112", "offset 120"),
    ("offset 1044", "offset 1064"),
    (f"offset {P}", "offset 1084"),
    (f"offset {Q}", "offset 128"),
]
# JSON — indépendants (« "offset": 4 » UCF101 n'est JAMAIS remplacé).
# Virgule porteuse ; « "offset": 120 » et « "offset": 128 » sont
# mutuellement sûres (aucune sous-chaîne).
OFFSETS_JSON = [
    ('"offset": 1064,', '"offset": 1084,'),
    ('"offset": 120,', '"offset": 128,'),
]


def appliquer_marques(t: str) -> str:
    for ancien, nouveau in OFFSETS_PROSE_MARQUES:
        t = t.replace(ancien, nouveau)
    assert P not in t and Q not in t, "marqueurs ⟪P⟫/⟪Q⟫ résiduels"
    return t


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur).

    ORDRE : courant (147→148) d'abord, précédente (146→147) ensuite —
    l'ordre inverse ferait un double saut 146→148."""
    t = src
    # 1. offsets — plan à marqueurs (voir docstring)
    t = appliquer_marques(t)
    # 2. date de la fenêtre : it.148 est mesurée le 22 nov 2026
    t = t.replace("16 nov 2026", "22 nov 2026")
    # 3. fenêtre courante it.147 → it.148
    t = t.replace("it.147", "it.148")
    t = t.replace("IT147", "IT148")
    t = t.replace("it147", "it148")
    t = t.replace("km147_", "km148_")
    # 4. fenêtre précédente it.146 → it.147 — FORMES documentées puis
    #    générique ; les faits historiques (« bascule MLS documentée à
    #    it.130 », « ÉPUISÉ depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.146", "d'it.147")
    t = t.replace("(it.146)", "(it.147)")
    t = t.replace("après it.146", "après it.147")
    t = t.replace("it.146", "it.147")
    t = t.replace("IT146", "IT147")
    t = t.replace("it146", "it147")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose).

    JSON d'abord, prose ensuite (mesuré sur pièce it.147 : la prose contient
    « offset 1064 » (courant COCO), « offset 120 » (courant MLS),
    « offset 1044 » (précédent COCO), « offset 4 » — la règle prose
    « offset 120 » doit courir APRÈS le JSON pour ne pas corrompre
    « "offset": 128 »)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = appliquer_marques(t)
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.146 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.147", "it.148")
    t = t.replace("(it.146)", "(it.147)")
    t = t.replace("après it.146", "après it.147")
    t = t.replace("it147", "it148")    # chemins + user-agent
    t = t.replace("km147_", "km148_")  # ids de paires
    t = t.replace("it.146", "it.147")
    return t


def transformer_test(src: str) -> str:
    """Transformation du test de garde it.147 → it.148.

    PROTECTIONS : « it137 » (chemin d'import de la fenêtre ante-précédente)
    n'est JAMAIS renommé — le module multimodal-it137.ts existe toujours ;
    « doublon de contenu it.137/it.138 » — les ensembles sha137/sha138
    EXISTENT toujours (les modules restent importés).
    SETS : ordre DESCENDANT sha146→sha147, sha145→sha146, sha144→sha145,
    sha143→sha144, sha142→sha143, sha141→sha142 (ordre critique), AVANT la
    réinsertion du set sha141 de la règle 9 (sinon déclaration en double).
    RÉINSERTION it.141 (import + set + expect entre it.138 et it.142)."""
    t = src
    # 1. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 2. globals fenêtre courante (PAS de règle « it137 » — voir docstring)
    t = t.replace("it.147", "it.148")
    t = t.replace("IT147", "IT148")
    t = t.replace("it147", "it148")
    t = t.replace("km147_", "km148_")
    # 3. fenêtre précédente — formes documentées puis générique
    t = t.replace("d'it.146", "d'it.147")
    t = t.replace("(it.146)", "(it.147)")
    t = t.replace("après it.146", "après it.147")
    t = t.replace("it.146", "it.147")
    t = t.replace("IT146", "IT147")
    t = t.replace("it146", "it147")
    t = t.replace("cumulatif it.146", "cumulatif it.147")
    # 4. fenêtre ante-précédente it.145 → it.146, puis it.144 → it.145,
    #    puis it.143 → it.144, puis it.142 → it.143, puis it.141 → it.142
    t = t.replace("it.145", "it.146")
    t = t.replace("IT145", "IT146")
    t = t.replace("it145", "it146")
    t = t.replace("it.144", "it.145")
    t = t.replace("IT144", "IT145")
    t = t.replace("it144", "it145")
    t = t.replace("it.143", "it.144")
    t = t.replace("IT143", "IT144")
    t = t.replace("it143", "it144")
    t = t.replace("it.142", "it.143")
    t = t.replace("IT142", "IT143")
    t = t.replace("it142", "it143")
    t = t.replace("it.141", "it.142")
    t = t.replace("IT141", "IT142")
    t = t.replace("it141", "it142")
    # 5. NOMS des sets de dédup : les initialisateurs pointent maintenant
    #    vers les modules décalés — les noms suivent. ORDRE CRITIQUE :
    #    DESCENDANT (146→147 d'abord — l'inverse ferait un double saut).
    #    La fenêtre courante IT148 n'a pas de set propre (comparée contre
    #    tous les précédents) — aucun set sha148 n'est créé.
    t = t.replace("sha146", "sha147")
    t = t.replace("sha145", "sha146")
    t = t.replace("sha144", "sha145")
    t = t.replace("sha143", "sha144")
    t = t.replace("sha142", "sha143")
    t = t.replace("sha141", "sha142")
    # 6. titre de déduplication : après les génériques la queue du titre dit
    #    « … it.142 (944/72), it.143 (964/80), it.144 (984/88), it.145
    #    (1004/96), it.146 (1024/104), it.147 (1044/112) et it.148
    #    (1064/120) » — on réinsère it.141 (944/72), replace it.142 (964/80),
    #    it.143 (984/88), it.144 (1004/96), it.145 (1024/104), it.146
    #    (1044/112), it.147 (1064/120) et ajoute it.148 (1084/128)
    t = t.replace(
        'it.142 (944/72), it.143 (964/80), it.144 (984/88), it.145 (1004/96), it.146 (1024/104), it.147 (1044/112) et it.148 (1064/120)", () => {',
        'it.141 (944/72), it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145 (1024/104), it.146 (1044/112), it.147 (1064/120) et it.148 (1084/128)", () => {',
    )
    # 7. résumé de la fenêtre précédente : la générique + plan ont laissé
    #    « après it.147 : 1044/112 » — le couple N/N de la fenêtre précédente
    #    est désormais 1064/120
    t = t.replace("après it.147 : 1044/112", "après it.147 : 1064/120")
    # 8. RÉINSERTION de la fenêtre it.141 dans la chaîne de dédup — le
    #    renommage générique a transformé l'import dédié it141 en it142 et le
    #    set sha141 en sha142 : la fenêtre it.141 disparaissait de la chaîne
    #    (les assets it.148 n'auraient PAS été comparés à it.141). On réinsère
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


def transformer_garde(src: str) -> str:
    """Garde carte-mémoire (en place) : borne 47 → 48, dernière fenêtre
    it.147 → it.148, dernier snapshot it147.bin → it148.bin ; les offsets de
    la fenêtre la plus récente suivent le plan à marqueurs (120 → 128,
    112 → 120 d'it.147)."""
    t = src
    t = appliquer_marques(t)
    t = t.replace("toBeGreaterThanOrEqual(47)", "toBeGreaterThanOrEqual(48)")
    t = t.replace("it.147", "it.148")
    t = t.replace("it147", "it148")
    t = t.replace("d'it.146", "d'it.147")  # fenêtre précédente (après courant)
    t = t.replace("it.146", "it.147")
    return t


def transformer_production(src: str) -> str:
    """Vérification production : renommages simples + étiquette docstring
    km145_ (résidu d'étiquette hérité d'it.146) → km148_ (honnêteté)."""
    t = src
    t = t.replace("km145_", "km148_")
    t = t.replace("it147", "it148")
    t = t.replace("it.147", "it.148")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it147", "km147_",
                 '"offset": 1064,', '"offset": 120,', "offset 1044",
                 "offset 80", "offset 88", "offset 96", "offset 1004",
                 "offset 904", "offset 924", "offset 944", "offset 964",
                 "offset 984", "offset 1024", "offset 112", "offset 104"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it148 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.147") == 1, f"it.147 × {t.count('it.147')} (attendu 1 — après it.147)"
    assert t.count("it.148") == 2, f"it.148 × {t.count('it.148')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 1084,', '"offset": 128,', '"offset": 4,', "km148_",
                    "multimodal-it148", "offset 1064", "offset 128", "offset 4",
                    "après it.147",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.147 légitime 3×
    #    (fenêtre précédente : celle d'it.147 — offset 1064 + après l'offset
    #    1064 d'it.147 + après l'offset 120 d'it.147), it.148 ×3 (courante)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.147") == 3, f"it.147 × {t2.count('it.147')} (attendu 3 — fenêtre précédente)"
    assert t2.count("it.148") == 3, f"it.148 × {t2.count('it.148')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.146", "IT147", "km147_", "it137", "it147", "it146",
                 "offset 1044", "offset 80", "offset 112 (it", "offset 104 (it", "⟪",
                 "CHANGEMENT DE SOURCE", "16 nov 2026"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it148 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it148/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it148.ts", sortie)',
        "fenêtre offset 1084",
        "fenêtre offset 128",
        "celle d'it.147 — offset 1064",
        "après l'offset 1064 d'it.147",
        "après l'offset 120 d'it.147",
        "22 nov 2026",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — la SNAPSHOT_SOURCE it146.bin devient it147.bin par
    #    l'ordre courant-d'abord (aucune restauration explicite) ; it.130
    #    légitime 1× ; it.129 ×2
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it147.bin"', "")
    residus = [x for x in ["IT147", "km147_", "it137", "it147", "it146",
                           "offset 1044", "offset 80",
                           "CHANGEMENT DE SOURCE", "⟪", "16 nov 2026"] if x in t3_sans]
    print(f"entrainement-it148 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it147.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it148.bin"',
        'from "../lib/neural/generation/multimodal-it148"',
        "ASSETS_MULTIMODAL_IT148",
        "PAIRES_MULTIMODAL_IT148",
        "offset 1084",
        "offset 128",
        "après l'offset 1064 d'it.147",
        "après l'offset 120 d'it.147",
        "celle d'it.147",
        "cumulatif it.147",
        "après offset 1064 (it.147)",
        "après offset 120 (it.147)",
        "état hérité d'it.147, avant gravure it.148",
        "22 nov 2026",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT95…IT138 + IT141 + IT142 + IT143 + IT144 + IT145 +
    #    IT146 + IT147 légitimes exactement 2× chacun (import dédup + set
    #    shaNNN ; IT141 réinséré, IT142…IT147 shiftés) ; IT148 = fenêtre
    #    courante ; « it137 » ×1 (chemin d'import protégé)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT95", "IT96", "IT97", "IT98", "IT99", "IT101", "IT104",
                  "IT105", "IT106", "IT107", "IT108", "IT109", "IT110",
                  "IT111", "IT112", "IT113", "IT115", "IT116", "IT117",
                  "IT118", "IT119", "IT120", "IT121", "IT122", "IT123",
                  "IT124", "IT125", "IT126", "IT127", "IT128", "IT129",
                  "IT130", "IT131", "IT132", "IT133", "IT134", "IT135",
                  "IT136", "IT137", "IT138", "IT141", "IT142", "IT143",
                  "IT144", "IT145", "IT146", "IT147"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert "sha141" in t4 and "sha142" in t4 and "sha143" in t4 \
        and "sha144" in t4 and "sha145" in t4 and "sha146" in t4 \
        and "sha147" in t4, \
        "sets sha141…sha147 requis (pas de set courant)"
    assert t4.count("IT148") >= 10, f"IT148 × {t4.count('IT148')} (attendu >= 10 — fenêtre courante)"
    for ident in ["IT137", "IT138", "IT141", "IT142", "IT143", "IT144",
                  "IT145", "IT146", "IT147"]:
        ligne = [l for l in t4.splitlines() if ident in l and "import" in l]
        assert ligne == [f'import {{ ASSETS_MULTIMODAL_{ident} }} from "./multimodal-{ident.lower()}";'], f"import {ident} : {ligne}"
    ligne148 = [l for l in t4.splitlines() if "IT148" in l and "import" in l]
    assert ligne148 == ['import { ASSETS_MULTIMODAL_IT148, PAIRES_MULTIMODAL_IT148 } from "./multimodal-it148";'], ligne148
    for attendu in [
        "km148_",
        "sha141",
        "sha142",
        "sha143",
        "sha144",
        "sha145",
        "sha146",
        "sha147",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40), it.136 (884/48), it.137 (904/56), it.138 (924/64), it.141 (944/72), it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145 (1024/104), it.146 (1044/112), it.147 (1064/120) et it.148 (1084/128)",
        "COCO offset 1084, MLS offset 128 — après it.147 : 1064/120",
        "fenêtre offset 128 après offset 120 (it.147)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.147",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km147_", "km146_", "km145_", "km144_", "km143_", "km142_", "km141_", "km138_", "km137_", "km136_", "km135_", "km134_",
                 "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪",
                 "offset 1064", "offset 1044", "offset 112", "offset 1024",
                 "offset 88", "offset 1004", "offset 80",
                 '1064/120", () => {', "it.147 (1024/104) et"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it148 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.147)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.147", "it.148")
    t5 = t5.replace("it147", "it148")
    t5 = t5.replace("it.90→it.146", "it.90→it.147")
    # le seul « it.147 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.147") == 1, f"it.147 × {t5.count('it.147')} (attendu 1 — borne du lot historique)"
    interdits = ["it146", "it.146", "it145", "it.145"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it148 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it148/assets.json", "fenêtre it.148",
                    'multimodal-it148.ts")', "it.90→it.147"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.147", "IT147", "it147"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it148 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it148"',
        "ASSETS_MULTIMODAL_IT148",
        "PAIRES_MULTIMODAL_IT148",
        '"var/evaluation-navigateur-it148.json"',
        "FENÊTRE it.148",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    # 7. garde carte-mémoire (EN PLACE) — borne 47 → 48, dernière fenêtre
    #    it.147 → it.148, dernier snapshot it147.bin → it148.bin
    t7 = transformer_garde(open(GARDE_IN).read())
    assert t7.count("it.129") == 1, f"it.129 × {t7.count('it.129')} (attendu 1 — ref historique)"
    assert t7.count("it.130") == 1, f"it.130 × {t7.count('it.130')} (attendu 1 — ref historique)"
    interdits = ["⟪", "it.146", "offset 112", "offset 120 — suite",
                 "toBeGreaterThanOrEqual(47)", "it147"]
    residus = [x for x in interdits if x in t7]
    print(f"garde carte-memoire : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans garde : {residus}")
    for attendu in [
        "la dernière étant it.148",
        "toBeGreaterThanOrEqual(48)",
        'fenetre).toBe("it.148")',
        "offset 128 — suite MLS",
        "après l'offset 120 d'it.147",
        "dernier snapshot = it.148",
        "/neural/cortex-multimodal-it148.bin",
    ]:
        assert attendu in t7, f"MANQUANT dans garde : {attendu}"
    open(GARDE_OUT, "w").write(t7)
    print(f"écrit : {GARDE_OUT} (garde avancée it.147 → it.148)")

    # 8. vérification production (renommages simples + étiquette km148_)
    t8 = transformer_production(open(PRODUCTION_IN).read())
    interdits = ["it147", "it.147", "km147_", "km145_"]
    residus = [x for x in interdits if x in t8]
    print(f"verifie-production-it148 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans production : {residus}")
    for attendu in [
        "multimodal-it148/images/image_000.jpg",
        "multimodal-it148/images/image_014.jpg",
        "multimodal-it148/audio/audio_000.opus",
        "multimodal-it148/audio/audio_007.opus",
        "public/neural/cortex-multimodal-it148.bin",
        "var-copie/verifie-production-it148.json",
        "PRODUCTION it.148",
        "gen3ia-verifie-it148/1.0",
    ]:
        assert attendu in t8, f"MANQUANT dans production : {attendu}"
    open(PRODUCTION_OUT, "w").write(t8)
    print(f"écrit : {PRODUCTION_OUT}")

    print("CASCADE it.147 → it.148 : 8 fichiers générés (6 pipeline + garde "
          "carte-mémoire + vérification production), 0 résidu ✓")


def transformer_eval(src: str) -> str:
    t = src
    t = t.replace("it.147", "it.148")
    t = t.replace("IT147", "IT148")
    t = t.replace("it147", "it148")
    return t


if __name__ == "__main__":
    main()

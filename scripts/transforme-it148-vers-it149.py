#!/usr/bin/env python3
"""Transforme les scripts it.148 en scripts it.149 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

CONTEXTE it.149 : it.148 a consommé la fenêtre COCO 1084 / MLS 128 ; la
fenêtre SUIVANTE est COCO offset 1104 / MLS offset 136. La fenêtre
PRÉCÉDENTE devient it.148 (1084/128) ; it.147 (1064/120) devient la fenêtre
ante-précédente et it.146 (1044/112) reste dans la chaîne de déduplication.

DATE : la fenêtre it.149 est MESURÉE le 22 nov 2026 — MÊME JOURNÉE qu'it.148
(deux fenêtres le même tick-day) — AUCUNE règle de date ; l'assertion
« 22 nov 2026 » reste requise et « 16 nov 2026 » reste interdit.

Pièges traités (leçons it.106→…→it.149) :
  - identifiants PascalCase IT148 → IT149 (remplacement séparé de it148) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it148.bin) — produit par
    l'ORDRE SEUL : la source it147.bin (chemin nu) est renommée it148.bin par
    la règle générique « it147 »→« it148 » exécutée APRÈS « it148 »→« it149 »
    (la SORTIE it148.bin part d'abord vers it149.bin, puis l'ancienne source
    devient la nouvelle source) — zéro restauration explicite nécessaire ;
  - fenêtre courante d'abord (1084/128 → 1104/136), PUIS références
    historiques (1064/120 → 1084/128) — l'ordre inverse corromprait les
    références ;
  - VÉRIFICATION DU PIÈGE PRÉFIXE it.149 : aucun « offset N » n'est
    préfixe d'un autre dans les fichiers it.148 — « offset 128 » n'est PAS
    un préfixe de « offset 1064 » ni de « offset 1084 » (1064 commence par
    « 10 ») ; l'étape prev-MLS (120→128) est donc INDÉPENDANTE de l'étape
    prev-COCO (1064→1084) — aucune sous-chaîne :
      1. offset 1084 → offset ⟪P⟫  (coco courant, protégé)
      2. offset 128  → offset ⟪Q⟫  (mls courant, protégé)
      3. offset 120  → offset 128  (mls précédent — crée des « offset 128 »
         APRÈS le passage de l'étape 2 : ils sont des références LÉGITIMES
         de la fenêtre précédente, jamais re-protégés)
      4. offset 1064 → offset 1084 (coco précédent — crée des « offset 1084 »
         APRÈS le passage de l'étape 1 : idem)
      5. offset ⟪P⟫  → offset 1104 (coco courant → nouvelle valeur)
      6. offset ⟪Q⟫  → offset 136  (mls courant → nouvelle valeur)
    invariant : chaque étape ne crée des chaînes matchées par AUCUNE étape
    ultérieure ; « offset 4 » (UCF101, preuve du zéro) n'est JAMAIS
    remplacé ; l'interdit JSON porte la virgule (« "offset": 128, ») car les
    formes JSON « "offset": 128 » et « "offset": 136 » restent mutuellement
    sûres (aucune sous-chaîne) ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule MLS documentée à it.130 »,
    « ÉPUISÉ depuis it.129 », « it.128 (724/276) », « doublon de contenu
    it.137 / it.138 » (les ensembles sha137/sha138 EXISTENT toujours dans
    le test) ne matchent ni les formes documentées (d'it.147 / (it.147) /
    cumulatif it.147 / après it.147) ni les renommages d'offsets ;
  - TITRE DU TEST DE DÉDUP : les segments « N/N » (1084/128, 1064/120)
    ne matchent AUCUN plan « offset N » — une règle spéciale met la queue du
    titre à jour APRÈS les renommages génériques (réinsère it.141 (944/72),
    replace it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145
    (1024/104), it.146 (1044/112), it.147 (1064/120), it.148 (1084/128) et
    ajoute it.149 (1104/136)) ;
  - RÉSUMÉ « après it.148 : N/N » — règle spéciale 1064/120 → 1084/128 ;
  - SETS DE DÉDUP : ordre DESCENDANT sha147→sha148, sha146→sha147,
    sha145→sha146, sha144→sha145, sha143→sha144, sha142→sha143,
    sha141→sha142 (l'inverse ferait un double saut) — les noms suivent le
    module que leur initialisateur référence après les renommages
    IT141→IT142 … IT147→IT148 ; la fenêtre COURANTE (IT149) n'a PAS de set
    propre : elle est comparée contre tous les sets précédents ;
  - RÉINSERTION it.141 (import + set + expect entre it.138 et it.142) : le
    renommage générique a transformé l'import dédié it141 en it142 — la
    fenêtre it.141 disparaîtrait de la chaîne (les assets it.149 n'auraient
    PAS été comparés à it.141) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose
    (mesuré sur pièce it.148 : prose = offset 1084 (courant), offset 128
    (courant), offset 1064 (précédent), offset 4) ; JSON d'ABORD pour que la
    règle prose « offset 128 » ne touche pas le JSON ;
  - km148_ → km149_ (préfixe indépendant des identifiants IT) ;
  - GARDE CARTE-MÉMOIRE (7e sortie) : borne de fenêtres 48 → 49, dernière
    fenêtre it.148 → it.149, dernier snapshot it148.bin → it149.bin ;
  - VÉRIFICATION PRODUCTION (8e sortie) : chemins it148 → it149 + étiquette
    docstring km148_ (résidu d'étiquette historique) → km149_.
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it148.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it149.py"
GENERE_IN = "scripts/genere-module-multimodal-it148.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it149.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it148.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it149.ts"
TEST_IN = "lib/neural/generation/multimodal-it148.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it149.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it148.py"
DEDUP_OUT = "scripts/verifie-dedup-it149.py"
EVAL_IN = "scripts/evaluation-navigateur-it148.ts"
EVAL_OUT = "scripts/evaluation-navigateur-it149.ts"
GARDE_IN = "lib/neural/generation/carte-memoire.test.ts"
GARDE_OUT = "lib/neural/generation/carte-memoire.test.ts"  # en place
PRODUCTION_IN = "scripts/verifie-production-it148.py"
PRODUCTION_OUT = "scripts/verifie-production-it149.py"

P = "⟪P⟫"  # offset coco courant protégé (1084 → 1104)
Q = "⟪Q⟫"  # offset mls courant protégé (128 → 136)

# Plan à marqueurs des renommages d'offsets (prose) — voir docstring.
# Étapes 3/4 indépendantes this tick : « offset 120 » n'est PAS un préfixe
# de « offset 1084 » — l'ordre 3/4 est libre, conservé par symétrie.
OFFSETS_PROSE_MARQUES = [
    ("offset 1084", f"offset {P}"),
    ("offset 128", f"offset {Q}"),
    ("offset 120", "offset 128"),
    ("offset 1064", "offset 1084"),
    (f"offset {P}", "offset 1104"),
    (f"offset {Q}", "offset 136"),
]
# JSON — indépendants (« "offset": 4 » UCF101 n'est JAMAIS remplacé).
# Virgule porteuse ; « "offset": 128 » et « "offset": 136 » sont
# mutuellement sûres (aucune sous-chaîne).
OFFSETS_JSON = [
    ('"offset": 1084,', '"offset": 1104,'),
    ('"offset": 128,', '"offset": 136,'),
]


def appliquer_marques(t: str) -> str:
    for ancien, nouveau in OFFSETS_PROSE_MARQUES:
        t = t.replace(ancien, nouveau)
    assert P not in t and Q not in t, "marqueurs ⟪P⟫/⟪Q⟫ résiduels"
    return t


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur).

    ORDRE : courant (148→149) d'abord, précédente (147→148) ensuite —
    l'ordre inverse ferait un double saut 147→149."""
    t = src
    # 1. offsets — plan à marqueurs (voir docstring)
    t = appliquer_marques(t)
    # 2. date : inchangée (it.149 mesurée le 22 nov 2026, même journée
    #    qu'it.148) — aucune règle ; l'assertion « 22 nov 2026 » veille.
    # 3. fenêtre courante it.148 → it.149
    t = t.replace("it.148", "it.149")
    t = t.replace("IT148", "IT149")
    t = t.replace("it148", "it149")
    t = t.replace("km148_", "km149_")
    # 4. fenêtre précédente it.147 → it.148 — FORMES documentées puis
    #    générique ; les faits historiques (« bascule MLS documentée à
    #    it.130 », « ÉPUISÉ depuis it.129 ») ne matchent aucune de ces formes.
    t = t.replace("d'it.147", "d'it.148")
    t = t.replace("(it.147)", "(it.148)")
    t = t.replace("après it.147", "après it.148")
    t = t.replace("it.147", "it.148")
    t = t.replace("IT147", "IT148")
    t = t.replace("it147", "it148")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose).

    JSON d'abord, prose ensuite (mesuré sur pièce it.148 : la prose contient
    « offset 1084 » (courant COCO, ×0 en fait — seul le prev 1064 en prose),
    « offset 128 » (courant MLS), « offset 1064 » (précédent COCO),
    « offset 4 » — la règle prose « offset 128 » doit courir APRÈS le JSON
    pour ne pas corrompre « "offset": 136 »)."""
    t = src
    # 1. offsets JSON puis prose — indépendants (voir docstring)
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    t = appliquer_marques(t)
    # 2. globals (fenêtre courante puis précédente — renommages nus OK ici :
    #    aucune autre occurrence it.147 dans ce fichier, it.130/it.129
    #    historiques intouchés)
    t = t.replace("it.148", "it.149")
    t = t.replace("(it.147)", "(it.148)")
    t = t.replace("après it.147", "après it.148")
    t = t.replace("it148", "it149")    # chemins + user-agent
    t = t.replace("km148_", "km149_")  # ids de paires
    t = t.replace("it.147", "it.148")
    return t


def transformer_test(src: str) -> str:
    """Transformation du test de garde it.148 → it.149.

    PROTECTIONS : « it137 » (chemin d'import de la fenêtre ante-précédente)
    n'est JAMAIS renommé — le module multimodal-it137.ts existe toujours ;
    « doublon de contenu it.137/it.138 » — les ensembles sha137/sha138
    EXISTENT toujours (les modules restent importés).
    SETS : ordre DESCENDANT sha147→sha148, sha146→sha147, sha145→sha146,
    sha144→sha145, sha143→sha144, sha142→sha143, sha141→sha142 (ordre
    critique), AVANT la réinsertion du set sha141 de la règle 8 (sinon
    déclaration en double).
    RÉINSERTION it.141 (import + set + expect entre it.138 et it.142)."""
    t = src
    # 1. offsets — plan à marqueurs
    t = appliquer_marques(t)
    # 2. globals fenêtre courante (PAS de règle « it137 » — voir docstring)
    t = t.replace("it.148", "it.149")
    t = t.replace("IT148", "IT149")
    t = t.replace("it148", "it149")
    t = t.replace("km148_", "km149_")
    # 3. fenêtre précédente — formes documentées puis générique
    t = t.replace("d'it.147", "d'it.148")
    t = t.replace("(it.147)", "(it.148)")
    t = t.replace("après it.147", "après it.148")
    t = t.replace("it.147", "it.148")
    t = t.replace("IT147", "IT148")
    t = t.replace("it147", "it148")
    t = t.replace("cumulatif it.147", "cumulatif it.148")
    # 4. fenêtre ante-précédente it.146 → it.147, puis it.145 → it.146,
    #    puis it.144 → it.145, puis it.143 → it.144, puis it.142 → it.143,
    #    puis it.141 → it.142
    t = t.replace("it.146", "it.147")
    t = t.replace("IT146", "IT147")
    t = t.replace("it146", "it147")
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
    #    DESCENDANT (147→148 d'abord — l'inverse ferait un double saut).
    #    La fenêtre courante IT149 n'a pas de set propre (comparée contre
    #    tous les précédents) — aucun set sha149 n'est créé.
    t = t.replace("sha147", "sha148")
    t = t.replace("sha146", "sha147")
    t = t.replace("sha145", "sha146")
    t = t.replace("sha144", "sha145")
    t = t.replace("sha143", "sha144")
    t = t.replace("sha142", "sha143")
    t = t.replace("sha141", "sha142")
    # 6. titre de déduplication : après les génériques la queue du titre dit
    #    « … it.142 (944/72), it.143 (964/80), it.144 (984/88), it.145
    #    (1004/96), it.146 (1024/104), it.147 (1044/112), it.148 (1064/120)
    #    et it.149 (1084/128) » — on réinsère it.141 (944/72), replace
    #    it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145
    #    (1024/104), it.146 (1044/112), it.147 (1064/120), it.148 (1084/128)
    #    et ajoute it.149 (1104/136)
    t = t.replace(
        'it.142 (944/72), it.143 (964/80), it.144 (984/88), it.145 (1004/96), it.146 (1024/104), it.147 (1044/112), it.148 (1064/120) et it.149 (1084/128)", () => {',
        'it.141 (944/72), it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145 (1024/104), it.146 (1044/112), it.147 (1064/120), it.148 (1084/128) et it.149 (1104/136)", () => {',
    )
    # 7. résumé de la fenêtre précédente : la générique + plan ont laissé
    #    « après it.148 : 1064/120 » — le couple N/N de la fenêtre précédente
    #    est désormais 1084/128
    t = t.replace("après it.148 : 1064/120", "après it.148 : 1084/128")
    # 8. RÉINSERTION de la fenêtre it.141 dans la chaîne de dédup — le
    #    renommage générique a transformé l'import dédié it141 en it142 et le
    #    set sha141 en sha142 : la fenêtre it.141 disparaissait de la chaîne
    #    (les assets it.149 n'auraient PAS été comparés à it.141). On réinsère
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
    """Garde carte-mémoire (en place) : borne 48 → 49, dernière fenêtre
    it.148 → it.149, dernier snapshot it148.bin → it149.bin ; les offsets de
    la fenêtre la plus récente suivent le plan à marqueurs (128 → 136,
    120 → 128 d'it.148)."""
    t = src
    t = appliquer_marques(t)
    t = t.replace("toBeGreaterThanOrEqual(48)", "toBeGreaterThanOrEqual(49)")
    t = t.replace("it.148", "it.149")
    t = t.replace("it148", "it149")
    t = t.replace("d'it.147", "d'it.148")  # fenêtre précédente (après courant)
    t = t.replace("it.147", "it.148")
    return t


def transformer_production(src: str) -> str:
    """Vérification production : renommages simples + étiquette docstring
    km148_ (résidu d'étiquette hérité d'it.147) → km149_ (honnêteté)."""
    t = src
    t = t.replace("km148_", "km149_")
    t = t.replace("it148", "it149")
    t = t.replace("it.148", "it.149")
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it148", "km148_",
                 '"offset": 1084,', '"offset": 128,', "offset 1064",
                 "offset 80", "offset 88", "offset 96", "offset 1004",
                 "offset 904", "offset 924", "offset 944", "offset 964",
                 "offset 984", "offset 1024", "offset 120", "offset 112",
                 "offset 104", "offset 1044"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it149 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    assert t.count("it.148") == 1, f"it.148 × {t.count('it.148')} (attendu 1 — après it.148)"
    assert t.count("it.149") == 2, f"it.149 × {t.count('it.149')} (attendu 2 — fenêtre courante)"
    for attendu in ['"offset": 1104,', '"offset": 136,', '"offset": 4,', "km149_",
                    "multimodal-it149", "offset 1084", "offset 136", "offset 4",
                    "après it.148",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS), it.148 légitime 3×
    #    (fenêtre précédente : celle d'it.148 — offset 1084 + après l'offset
    #    1084 d'it.148 + après l'offset 128 d'it.148), it.149 ×3 (courante)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    assert t2.count("it.148") == 3, f"it.148 × {t2.count('it.148')} (attendu 3 — fenêtre précédente)"
    assert t2.count("it.149") == 3, f"it.149 × {t2.count('it.149')} (attendu 3 — fenêtre courante : en-tête, docstring, paireImage)"
    interdits = ["it.147", "IT148", "km148_", "it137", "it148", "it147",
                 "offset 1064", "offset 80", "offset 120 (it", "offset 112 (it", "⟪",
                 "CHANGEMENT DE SOURCE", "16 nov 2026"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it149 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it149/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it149.ts", sortie)',
        "fenêtre offset 1104",
        "fenêtre offset 136",
        "celle d'it.148 — offset 1084",
        "après l'offset 1084 d'it.148",
        "après l'offset 128 d'it.148",
        "22 nov 2026",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — la SNAPSHOT_SOURCE it147.bin devient it148.bin par
    #    l'ordre courant-d'abord (aucune restauration explicite) ; it.130
    #    légitime 1× ; it.129 ×2
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it148.bin"', "")
    residus = [x for x in ["IT148", "km148_", "it137", "it148", "it147",
                           "offset 1064", "offset 80",
                           "CHANGEMENT DE SOURCE", "⟪", "16 nov 2026"] if x in t3_sans]
    print(f"entrainement-it149 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it148.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it149.bin"',
        'from "../lib/neural/generation/multimodal-it149"',
        "ASSETS_MULTIMODAL_IT149",
        "PAIRES_MULTIMODAL_IT149",
        "offset 1104",
        "offset 136",
        "après l'offset 1084 d'it.148",
        "après l'offset 128 d'it.148",
        "celle d'it.148",
        "cumulatif it.148",
        "après offset 1084 (it.148)",
        "après offset 128 (it.148)",
        "état hérité d'it.148, avant gravure it.149",
        "22 nov 2026",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT95…IT138 + IT141 + IT142 + IT143 + IT144 + IT145 +
    #    IT146 + IT147 + IT148 légitimes exactement 2× chacun (import dédup +
    #    set shaNNN ; IT141 réinséré, IT142…IT148 shiftés) ; IT149 = fenêtre
    #    courante ; « it137 » ×1 (chemin d'import protégé)
    t4 = transformer_test(open(TEST_IN).read())
    for ident in ["IT95", "IT96", "IT97", "IT98", "IT99", "IT101", "IT104",
                  "IT105", "IT106", "IT107", "IT108", "IT109", "IT110",
                  "IT111", "IT112", "IT113", "IT115", "IT116", "IT117",
                  "IT118", "IT119", "IT120", "IT121", "IT122", "IT123",
                  "IT124", "IT125", "IT126", "IT127", "IT128", "IT129",
                  "IT130", "IT131", "IT132", "IT133", "IT134", "IT135",
                  "IT136", "IT137", "IT138", "IT141", "IT142", "IT143",
                  "IT144", "IT145", "IT146", "IT147", "IT148"]:
        n = t4.count(ident)
        assert n == 2, f"{ident} × {n} (attendu 2)"
    assert "sha141" in t4 and "sha142" in t4 and "sha143" in t4 \
        and "sha144" in t4 and "sha145" in t4 and "sha146" in t4 \
        and "sha147" in t4 and "sha148" in t4, \
        "sets sha141…sha148 requis (pas de set courant)"
    assert t4.count("IT149") >= 10, f"IT149 × {t4.count('IT149')} (attendu >= 10 — fenêtre courante)"
    for ident in ["IT137", "IT138", "IT141", "IT142", "IT143", "IT144",
                  "IT145", "IT146", "IT147", "IT148"]:
        ligne = [l for l in t4.splitlines() if ident in l and "import" in l]
        assert ligne == [f'import {{ ASSETS_MULTIMODAL_{ident} }} from "./multimodal-{ident.lower()}";'], f"import {ident} : {ligne}"
    ligne149 = [l for l in t4.splitlines() if "IT149" in l and "import" in l]
    assert ligne149 == ['import { ASSETS_MULTIMODAL_IT149, PAIRES_MULTIMODAL_IT149 } from "./multimodal-it149";'], ligne149
    for attendu in [
        "km149_",
        "sha141",
        "sha142",
        "sha143",
        "sha144",
        "sha145",
        "sha146",
        "sha147",
        "sha148",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8), it.132 (804/16), it.133 (824/24), it.134 (844/32), it.135 (864/40), it.136 (884/48), it.137 (904/56), it.138 (924/64), it.141 (944/72), it.142 (964/80), it.143 (984/88), it.144 (1004/96), it.145 (1024/104), it.146 (1044/112), it.147 (1064/120), it.148 (1084/128) et it.149 (1104/136)",
        "COCO offset 1104, MLS offset 136 — après it.148 : 1084/128",
        "fenêtre offset 136 après offset 128 (it.148)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
        "doublon de contenu it.148",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km148_", "km147_", "km146_", "km145_", "km144_", "km143_", "km142_", "km141_", "km138_", "km137_", "km136_", "km135_", "km134_",
                 "km133_", "km132_", "km131_", "km130_", "km129_", "km128_", "⟪",
                 "offset 1084", "offset 1064", "offset 120", "offset 1024",
                 "offset 88", "offset 1004", "offset 80",
                 '1084/128", () => {', "it.148 (1024/104) et"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it149 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")

    # 5. dédup python (générique : glob — simples renommages + màj du lot
    #    historique documenté it.90→it.148)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.148", "it.149")
    t5 = t5.replace("it148", "it149")
    t5 = t5.replace("it.90→it.147", "it.90→it.148")
    # le seul « it.148 » légitime restant = la borne du lot historique documenté
    assert t5.count("it.148") == 1, f"it.148 × {t5.count('it.148')} (attendu 1 — borne du lot historique)"
    interdits = ["it147", "it.147", "it146", "it.146", "it145", "it.145"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it149 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it149/assets.json", "fenêtre it.149",
                    'multimodal-it149.ts")', "it.90→it.148"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")

    # 6. évaluation navigateur (simples renommages — clés historiques
    #    assetsIt131/fenetreIt131 conservées telles quelles)
    t6 = transformer_eval(open(EVAL_IN).read())
    interdits = ["it.148", "IT148", "it148"]
    residus = [x for x in interdits if x in t6]
    print(f"evaluation-navigateur-it149 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans eval : {residus}")
    for attendu in [
        'from "../lib/neural/generation/multimodal-it149"',
        "ASSETS_MULTIMODAL_IT149",
        "PAIRES_MULTIMODAL_IT149",
        '"var/evaluation-navigateur-it149.json"',
        "FENÊTRE it.149",
    ]:
        assert attendu in t6, f"MANQUANT dans eval : {attendu}"
    open(EVAL_OUT, "w").write(t6)
    print(f"écrit : {EVAL_OUT}")

    # 7. garde carte-mémoire (EN PLACE) — borne 48 → 49, dernière fenêtre
    #    it.148 → it.149, dernier snapshot it148.bin → it149.bin
    t7 = transformer_garde(open(GARDE_IN).read())
    assert t7.count("it.129") == 1, f"it.129 × {t7.count('it.129')} (attendu 1 — ref historique)"
    assert t7.count("it.130") == 1, f"it.130 × {t7.count('it.130')} (attendu 1 — ref historique)"
    interdits = ["⟪", "it.147", "offset 120", "offset 128 — suite",
                 "toBeGreaterThanOrEqual(48)", "it148"]
    residus = [x for x in interdits if x in t7]
    print(f"garde carte-memoire : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans garde : {residus}")
    for attendu in [
        "la dernière étant it.149",
        "toBeGreaterThanOrEqual(49)",
        'fenetre).toBe("it.149")',
        "offset 136 — suite MLS",
        "après l'offset 128 d'it.148",
        "dernier snapshot = it.149",
        "/neural/cortex-multimodal-it149.bin",
    ]:
        assert attendu in t7, f"MANQUANT dans garde : {attendu}"
    open(GARDE_OUT, "w").write(t7)
    print(f"écrit : {GARDE_OUT} (garde avancée it.148 → it.149)")

    # 8. vérification production (renommages simples + étiquette km149_)
    t8 = transformer_production(open(PRODUCTION_IN).read())
    interdits = ["it148", "it.148", "km148_", "km147_"]
    residus = [x for x in interdits if x in t8]
    print(f"verifie-production-it149 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans production : {residus}")
    for attendu in [
        "multimodal-it149/images/image_000.jpg",
        "multimodal-it149/images/image_014.jpg",
        "multimodal-it149/audio/audio_000.opus",
        "multimodal-it149/audio/audio_007.opus",
        "public/neural/cortex-multimodal-it149.bin",
        "var-copie/verifie-production-it149.json",
        "PRODUCTION it.149",
        "gen3ia-verifie-it149/1.0",
    ]:
        assert attendu in t8, f"MANQUANT dans production : {attendu}"
    open(PRODUCTION_OUT, "w").write(t8)
    print(f"écrit : {PRODUCTION_OUT}")

    print("CASCADE it.148 → it.149 : 8 fichiers générés (6 pipeline + garde "
          "carte-mémoire + vérification production), 0 résidu ✓")


def transformer_eval(src: str) -> str:
    t = src
    t = t.replace("it.148", "it.149")
    t = t.replace("IT148", "IT149")
    t = t.replace("it148", "it149")
    return t


if __name__ == "__main__":
    main()

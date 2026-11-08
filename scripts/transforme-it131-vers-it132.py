#!/usr/bin/env python3
"""Transforme les scripts it.131 en scripts it.132 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.132) :
  - identifiants PascalCase IT131 → IT132 (remplacement séparé de it131) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it131.bin) — restauration
    explicite après la cascade it131→it132 ;
  - fenêtre courante d'abord (784/8 → 804/16), PUIS référence historique
    (764/0 → 784/8, 0 → 8) — l'ordre inverse corromprait les références ;
  - ORDRE CRITIQUE des offsets (nouveau, leçon it.132) : « offset 8 » est un
    PRÉFIXE de « offset 804 » — le renommage 8→16 DOIT précéder 784→804,
    sinon « offset 804 » deviendrait « offset 1604 ». Ordre verrouillé :
    8→16, 784→804, 764→784, 0→8 (chaque étape crée des chaînes que les
    étapes suivantes ne matchent plus) ;
  - FAITS HISTORIQUES PROTÉGÉS : « bascule documentée à it.130 » (télécharge,
    renommage nu it.130→it.131) est blindé par marqueur ⟪B130⟫ ; dans les .ts,
    les renommages PAR FORME documentée (d'it.130 / (it.130) / cumulatif /
    après) ne matchent ni « bascule documentée à it.130 », ni « bascule MLS
    documentée à it.130, », ni « doublon de contenu it.130 », ni l'item
    historique « it.130 (764/0) » du titre de déduplication — vérifié par
    asserts ;
  - titres du test corrigés APRÈS les globales : item courant « it.131
    (784/8) » → « it.132 (784/8) » réinséré comme « it.131 (784/8) et
    it.132 (804/16) » ; résumé précédent « 764/0 » → « 784/8 » ;
  - PAS de changement de source : MLS french/dev CONTINUE (offset 16 après
    l'offset 8 d'it.131, 2416 lignes disponibles) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it131 + sha131 + titre) ;
  - km131_ → km132_ (préfixe indépendant des identifiants IT).
"""

TELECHARGE_IN = "scripts/telecharge-multimodal-it131.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it132.py"
GENERE_IN = "scripts/genere-module-multimodal-it131.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it132.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it131.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it132.ts"
TEST_IN = "lib/neural/generation/multimodal-it131.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it132.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it131.py"
DEDUP_OUT = "scripts/verifie-dedup-it132.py"

B130 = "⟪B130⟫"  # substitué par « it.130 » en fin de cascade (fait historique)

# Ordre verrouillé des renommages d'offsets (prose et JSON) — leçon it.132 :
# « offset 8 » est un préfixe de « offset 804 » → 8→16 DOIT précéder 784→804.
OFFSETS_PROSE = [
    ("offset 8", "offset 16"),
    ("offset 784", "offset 804"),
    ("offset 764", "offset 784"),
    ("offset 0", "offset 8"),
]
OFFSETS_JSON = [
    ('"offset": 8', '"offset": 16'),
    ('"offset": 784', '"offset": 804'),
]


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — ordre critique (voir docstring)
    for ancien, nouveau in OFFSETS_PROSE:
        t = t.replace(ancien, nouveau)
    # 2. fenêtre courante it.131 → it.132
    t = t.replace("it.131", "it.132")
    # 3. fenêtre précédente it.130 → it.131 — FORMES documentées uniquement ;
    #    les faits historiques (« bascule documentée à it.130 », « bascule MLS
    #    documentée à it.130, ») ne matchent aucune de ces formes.
    t = t.replace("d'it.130", "d'it.131")
    t = t.replace("(it.130)", "(it.131)")
    t = t.replace("cumulatif it.130", "cumulatif it.131")
    t = t.replace("après it.130", "après it.131")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT131", "IT132")
    t = t.replace("it131", "it132")
    t = t.replace("km131_", "km132_")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.131 était it130.bin ; pour it.132 elle devient it131.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it130.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it131.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 0. protection du fait historique — le renommage nu it.130→it.131
    #    corromprait « bascule documentée à it.130 » (la bascule FLEURS→MLS
    #    a eu lieu À it.130, jamais après)
    t = t.replace("bascule documentée à it.130", f"bascule documentée à {B130}")
    # 1. offsets JSON puis prose — ordre critique
    for ancien, nouveau in OFFSETS_JSON:
        t = t.replace(ancien, nouveau)
    for ancien, nouveau in OFFSETS_PROSE:
        t = t.replace(ancien, nouveau)
    # 2. globals (fenêtre courante puis précédente — renommage nu OK ici :
    #    la seule autre occurrence it.130 est blindée)
    t = t.replace("it.131", "it.132")
    t = t.replace("it.130", "it.131")
    t = t.replace("it131", "it132")   # chemins + user-agent
    t = t.replace("km131_", "km132_")  # ids de paires
    return t.replace(B130, "it.130")


def transformer_test(src: str) -> str:
    t = src
    # 1. globals fenêtre courante
    t = t.replace("it.131", "it.132")
    t = t.replace("IT131", "IT132")
    t = t.replace("it131", "it132")
    t = t.replace("km131_", "km132_")
    # 2. offsets — ordre critique
    for ancien, nouveau in OFFSETS_PROSE:
        t = t.replace(ancien, nouveau)
    # 3. fenêtre précédente — formes documentées (le titre de dédup
    #    « it.130 (764/0) » et « doublon de contenu it.130 » ne matchent pas)
    t = t.replace("d'it.130", "d'it.131")
    t = t.replace("(it.130)", "(it.131)")
    t = t.replace("après it.130", "après it.131")
    # 4. titre de déduplication : la générique a produit « … it.130 (764/0)
    #    et it.132 (784/8) » — on réinsère it.131 (784/8) et on corrige la
    #    nouvelle fenêtre it.132 (804/16)
    t = t.replace(
        'it.130 (764/0) et it.132 (784/8)", () => {',
        'it.130 (764/0), it.131 (784/8) et it.132 (804/16)", () => {',
    )
    # 5. titre des fenêtres suivantes : résumé de la fenêtre précédente
    #    (it.131 = 784/8) — la générique a laissé « 764/0 »
    t = t.replace('après it.131 : 764/0)"', 'après it.131 : 784/8)"')
    # 6. ré-import dédié pour la déduplication contre it.131
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT132, PAIRES_MULTIMODAL_IT132 } from "./multimodal-it132";',
        'import { ASSETS_MULTIMODAL_IT131 } from "./multimodal-it131";\nimport { ASSETS_MULTIMODAL_IT132, PAIRES_MULTIMODAL_IT132 } from "./multimodal-it132";',
    )
    # 7. ensembles et attentes de déduplication (ajout sha131)
    t = t.replace(
        "const sha130 = new Set(ASSETS_MULTIMODAL_IT130.map((a) => a.sha256));",
        "const sha130 = new Set(ASSETS_MULTIMODAL_IT130.map((a) => a.sha256));\n    const sha131 = new Set(ASSETS_MULTIMODAL_IT131.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha130.has(a.sha256), `doublon de contenu it.130 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha130.has(a.sha256), `doublon de contenu it.130 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha131.has(a.sha256), `doublon de contenu it.131 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    return t


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["⟪", "it.128", "it131", "km131_",
                 '"offset": 784', '"offset": 8,', "offset 764"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it132 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    assert t.count("it.129") == 1, f"it.129 × {t.count('it.129')} (attendu 1 — ref historique FLEURS)"
    assert t.count("it.130") == 1, f"it.130 × {t.count('it.130')} (attendu 1 — ref historique bascule)"
    for attendu in ['"offset": 804', '"offset": 16', "km132_",
                    "multimodal-it132", "(offset 784)", "après it.131",
                    "bascule documentée à it.130", "ÉPUISÉ depuis it.129"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts — it.130 légitime 1× (fait historique bascule),
    #    it.129 légitime 2× (faits historiques FLEURS)
    t2 = transformer_ts(open(GENERE_IN).read())
    assert t2.count("it.130") == 1, f"it.130 × {t2.count('it.130')} (attendu 1 — bascule historique)"
    assert t2.count("it.129") == 2, f"it.129 × {t2.count('it.129')} (attendu 2 — refs historiques)"
    interdits = ["it.128", "IT131", "km131_", "it131", "offset 764",
                 "offset 784" if False else "⟪", "CHANGEMENT DE SOURCE"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it132 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it132/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it132.ts", sortie)',
        "fenêtre offset 804",
        "fenêtre offset 16",
        "celle d'it.131 — offset 784",
        "après l'offset 8 d'it.131",
        "bascule documentée à\n * it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it130 (identifiant) légitime exactement dans
    #    SNAPSHOT_SOURCE ; it.130 légitime 1× (fait historique « bascule MLS
    #    documentée à it.130 ») ; it.129 légitime 2× (faits historiques)
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    assert t3.count("it.130") == 1, f"it.130 × {t3.count('it.130')} (attendu 1 — bascule historique)"
    assert t3.count("it.129") == 2, f"it.129 × {t3.count('it.129')} (attendu 2 — refs historiques)"
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it131.bin"', "")
    residus = [x for x in ["IT131", "km131_", "it131", "offset 764",
                           "offset 276", "CHANGEMENT DE SOURCE"] if x in t3_sans]
    print(f"entrainement-it132 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it131.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it132.bin"',
        'from "../lib/neural/generation/multimodal-it132"',
        "ASSETS_MULTIMODAL_IT132",
        "PAIRES_MULTIMODAL_IT132",
        "offset 804",
        "offset 16",
        "après l'offset 784 d'it.131",
        "après l'offset 8 d'it.131",
        "après offset 784 (it.131)",
        "après offset 8 (it.131)",
        "état hérité d'it.131, avant gravure it.132",
        "bascule MLS documentée à it.130",
        "ÉPUISÉ depuis it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128/IT129/IT130/IT131 légitimes exactement 2× chacun
    #    (import dédup + shaNNN) ; chemins it1NN × 1 chacun
    t4 = transformer_test(open(TEST_IN).read())
    for ident, attendu_n in [("IT128", 2), ("IT129", 2), ("IT130", 2), ("IT131", 2)]:
        n = t4.count(ident)
        assert n == attendu_n, f"{ident} × {n} (attendu {attendu_n})"
    for ident in ["it128", "it129", "it130", "it131"]:
        n = t4.count(ident)
        assert n == 1, f"{ident} × {n} (attendu 1)"
    ligne131 = [l for l in t4.splitlines() if "IT131" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT131 } from "./multimodal-it131";' in ligne131
    for attendu in [
        "km132_",
        "sha131",
        "it.128 (724/276), it.129 (744/284), it.130 (764/0), it.131 (784/8) et it.132 (804/16)",
        "COCO offset 804, MLS offset 16 — après it.131 : 784/8",
        "fenêtre offset 16 après offset 8 (it.131)",
        "continuité MLS french/dev",
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km128_", "km129_", "km130_", "km131_"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it132 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.131", "it.132")
    t5 = t5.replace("it131", "it132")
    interdits = ["it.131", "it131"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it132 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it132/assets.json", "fenêtre it.132"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

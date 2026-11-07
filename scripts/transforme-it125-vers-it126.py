#!/usr/bin/env python3
"""Transforme les scripts it.125 en scripts it.126 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.125) :
  - identifiants PascalCase IT125 → IT126 (remplacement séparé de it125) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it125.bin) — restauration
    explicite après la cascade it125→it126 ;
  - fenêtre courante d'abord (664/252 → 684/260), PUIS référence historique
    (644/244 → 664/252) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.124, avant gravure it.126 »
    → « d'it.125, avant gravure it.126 » (la fenêtre précédente est it.125) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it125 + sha125 + titre) ;
  - km125_ → km126_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it125.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it126.py"
GENERE_IN = "scripts/genere-module-multimodal-it125.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it126.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it125.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it126.ts"
TEST_IN = "lib/neural/generation/multimodal-it125.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it126.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it125.py"
DEDUP_OUT = "scripts/verifie-dedup-it126.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 664", "offset 684")  # fenêtre courante images
    t = t.replace("offset 252", "offset 260")  # fenêtre courante audios
    t = t.replace("offset 644", "offset 664")  # référence fenêtre précédente
    t = t.replace("offset 244", "offset 252")
    # 2. global it.125 → it.126 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.125", "it.126")
    # 3. fenêtre précédente it.124 → it.125 (toutes les formes documentées)
    t = t.replace("d'it.124", "d'it.125")
    t = t.replace("(it.124)", "(it.125)")
    t = t.replace("cumulatif it.124", "cumulatif it.125")
    t = t.replace("après it.124", "après it.125")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT125", "IT126")
    t = t.replace("it125", "it126")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.125 était it124.bin ; pour it.126 elle devient it125.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it124.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it125.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 664', '"offset": 684')
    t = t.replace('"offset": 252', '"offset": 260')
    t = t.replace("offset 664", "offset 684")   # prose header
    t = t.replace("offset 252", "offset 260")
    t = t.replace('"offset": 644', '"offset": 664')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 644", "offset 664")   # prose header historique
    t = t.replace('"offset": 244', '"offset": 252')
    t = t.replace("offset 244", "offset 252")
    # 2. globals
    t = t.replace("it.125", "it.126")
    t = t.replace("it.124", "it.125")
    t = t.replace("it125", "it126")   # chemins + user-agent
    t = t.replace("km125_", "km126_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 664", "offset 684")
    t = t.replace("offset 252", "offset 260")
    t = t.replace("offset 644", "offset 664")
    t = t.replace("offset 244", "offset 252")
    # 2. globals
    t = t.replace("it.125", "it.126")
    t = t.replace("IT125", "IT126")
    t = t.replace("it125", "it126")
    t = t.replace("km125_", "km126_")
    # 3. titre du test de fenêtres : « après it.125 : 664/252 »
    t = t.replace(
        "après it.124 : 644/244",
        "après it.125 : 664/252",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.124 (644/244) et it.126 (664/252) » —
    #    on réinsère it.125 (664/252) et on ajoute la nouvelle fenêtre it.126
    #    (684/260) en fin de liste)
    t = t.replace(
        "it.124 (644/244) et it.126 (664/252)\", () => {",
        "it.124 (644/244), it.125 (664/252) et it.126 (684/260)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.125
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT126, PAIRES_MULTIMODAL_IT126 } from "./multimodal-it126";',
        'import { ASSETS_MULTIMODAL_IT125 } from "./multimodal-it125";\nimport { ASSETS_MULTIMODAL_IT126, PAIRES_MULTIMODAL_IT126 } from "./multimodal-it126";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha125)
    t = t.replace(
        "const sha124 = new Set(ASSETS_MULTIMODAL_IT124.map((a) => a.sha256));",
        "const sha124 = new Set(ASSETS_MULTIMODAL_IT124.map((a) => a.sha256));\n    const sha125 = new Set(ASSETS_MULTIMODAL_IT125.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha124.has(a.sha256), `doublon de contenu it.124 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha124.has(a.sha256), `doublon de contenu it.124 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha125.has(a.sha256), `doublon de contenu it.125 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 684)", "(offset 684)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it125_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.125 (664/252) —
    # « it.125 », « offset 664 », « offset 252 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.124,
    # 644/244) et des identifiants/ids it.125.
    interdits = ["it.124", "IT125", "km125_", "offset 644", "offset 244"]
    residus = [x for x in interdits if x in t]
    if autoriser_it125_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it125.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it125.bin"', "")
        assert t_sans.count("it125") == 0, f"it125 hors SNAPSHOT_SOURCE : {t_sans.count('it125')}"
    else:
        residus += ["it125"] if "it125" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.124", "it125", "km125_", '"offset": 664', '"offset": 252', "offset 644", "offset 244"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it126 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 684', '"offset": 260', "km126_", "multimodal-it126", "offset 664", "après it.125"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it126", autoriser_it125_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it126/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it126.ts", sortie)',
        "fenêtre offset 684",
        "offset 260",
        "celle d'it.125 — offset 664",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it126", autoriser_it125_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it125.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it126.bin"',
        'from "../lib/neural/generation/multimodal-it126"',
        "ASSETS_MULTIMODAL_IT126",
        "PAIRES_MULTIMODAL_IT126",
        "offset 684",
        "offset 260",
        "après l'offset 664 d'it.125",
        "après offset 664 (it.125)",
        "état hérité d'it.125, avant gravure it.126",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT125 légitime exactement 2× (import dédup + sha125)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT125") == 2, f"IT125 × {t4.count('IT125')} (attendu 2)"
    assert t4.count("it125") == 1, f"it125 × {t4.count('it125')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT125" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT125 } from "./multimodal-it125";' in ligne
    for attendu in [
        "km126_",
        "sha125",
        "it.121 (584/220), it.122 (604/228), it.123 (624/236), it.124 (644/244), it.125 (664/252) et it.126 (684/260)",
        "COCO offset 684, FLEURS offset 260 — après it.125 : 664/252",
        "(offset 684)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km125_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT125 } from "./multimodal-it125";', "")]
    print(f"test-it126 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.125", "it.126")
    t5 = t5.replace("it125", "it126")
    interdits = ["it.125", "it125"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it126 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it126/assets.json", "fenêtre it.126"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Transforme les scripts it.106 en scripts it.107 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités :
  - identifiants PascalCase IT106 → IT107 (remplacement séparé de it106) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it106.bin) — la cascade
    it105→it106→it107 est restaurée explicitement ;
  - fenêtre courante d'abord (304/108 → 324/116), PUIS référence historique
    (284/100 → 304/108) — l'ordre inverse corromprait les références ;
  - le test de déduplication s'allonge (ajout sha106 + it.106 import)."""

ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it106.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it107.ts"
TEST_IN = "lib/neural/generation/multimodal-it106.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it107.test.ts"


def transformer(src: str) -> str:
    t = src
    # 1. global it.106 → it.107 (restants : titre, header, logs)
    t = t.replace("it.106", "it.107")
    # 2. phrase double (état hérité / gravure) — APRÈS la globale, sinon la
    #    cascade it.106→it.107 corromperait « d'it.106 » en « d'it.107 »
    t = t.replace(
        "état hérité d'it.105, avant gravure it.106",
        "état hérité d'it.106, avant gravure it.107",
    )
    # 3. références fenêtre précédente
    t = t.replace("d'it.105", "d'it.106")
    t = t.replace("(it.105)", "(it.106)")
    t = t.replace("cumulatif it.105", "cumulatif it.106")  # header phase ONDES
    # 4. identifiants (PascalCase d'abord) et chemins de fichiers
    t = t.replace("IT106", "IT107")
    t = t.replace("it105", "it106")   # SNAPSHOT_SOURCE (fichier cumulatif it.105 → it.106)
    t = t.replace("it106", "it107")   # tout le reste (sortie, imports, ids, dirs)
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it107.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it106.bin"',
    )
    # 5. offsets — fenêtre courante d'abord, puis référence historique
    t = t.replace("offset 304", "offset 324")  # fenêtre courante
    t = t.replace("offset 284", "offset 304")  # référence fenêtre précédente
    t = t.replace("offset 108", "offset 116")
    t = t.replace("offset 100", "offset 108")
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals
    t = t.replace("it.106", "it.107")
    t = t.replace("IT106", "IT107")   # identifiants
    t = t.replace("it106", "it107")   # chemins
    t = t.replace("km106_", "km107_")   # ids de paires (préfixe indépendant de IT)
    t = t.replace("km106_", "km107_")   # ids de paires (préfixe indépendant de IT)
    # 2. ré-import dédié pour la déduplication contre it.106
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT107, PAIRES_MULTIMODAL_IT107 } from "./multimodal-it107";',
        'import { ASSETS_MULTIMODAL_IT106 } from "./multimodal-it106";\nimport { ASSETS_MULTIMODAL_IT107, PAIRES_MULTIMODAL_IT107 } from "./multimodal-it107";',
    )
    # 3. titre du test de déduplication : liste allongée
    t = t.replace(
        "it.104 (264/92) et it.105 (284/100)",
        "it.104 (264/92), it.105 (284/100), it.106 (304/108) et it.107 (324/116)",
    )
    # 4. titre du test de fenêtres
    t = t.replace(
        "COCO offset 304, FLEURS offset 108 — après it.105 : 284/100",
        "COCO offset 324, FLEURS offset 116 — après it.106 : 304/108",
    )
    # 5. offsets du header
    t = t.replace("offset 304 +", "offset 324 +")
    t = t.replace("FLEURS offset 108)", "FLEURS offset 116)")
    # 6. ensembles et attentes de déduplication (ajout sha106)
    t = t.replace(
        "const sha105 = new Set(ASSETS_MULTIMODAL_IT105.map((a) => a.sha256));",
        "const sha105 = new Set(ASSETS_MULTIMODAL_IT105.map((a) => a.sha256));\n    const sha106 = new Set(ASSETS_MULTIMODAL_IT106.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha105.has(a.sha256), `doublon de contenu it.105 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha105.has(a.sha256), `doublon de contenu it.105 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha106.has(a.sha256), `doublon de contenu it.106 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 244)", "(offset 324)")
    return t


def verifier_entrainement(t: str) -> None:
    interdits = ["it.105", "offset 284", "offset 100", "km106_", "IT106"]
    residus = [x for x in interdits if x in t]
    print(f"entrainement-it107 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it106.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it107.bin"',
        'from "../lib/neural/generation/multimodal-it107"',
        "ASSETS_MULTIMODAL_IT107",
        "PAIRES_MULTIMODAL_IT107",
        "offset 324",
        "offset 116",
        "après l'offset 304 d'it.106",
        "après offset 304 (it.106)",
    ]:
        assert attendu in t, f"MANQUANT : {attendu}"
    print("contrôles entraînement OK")


def verifier_test(t: str) -> None:
    # IT106 légitime exactement 2× : import dédup + ensemble sha106.
    # it106 légitime exactement 1× : chemin de cet import.
    assert t.count("IT106") == 2, f"IT106 × {t.count('IT106')} (attendu 2)"
    assert t.count("it106") == 1, f"it106 × {t.count('it106')} (attendu 1)"
    ligne = [l for l in t.splitlines() if "IT106" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT106 } from "./multimodal-it106";' in ligne
    for attendu in [
        "km107_",
        "sha106",
        "it.106 (304/108) et it.107 (324/116)",
        'COCO offset 324, FLEURS offset 116 — après it.106 : 304/108',
        "(offset 324)",
    ]:
        assert attendu in t, f"MANQUANT dans test : {attendu}"
    interdits = ["km106_", "doublon de contenu it.106 : ${a.id}"] if False else ["km106_"]
    residus = [x for x in interdits if x in t.replace('import { ASSETS_MULTIMODAL_IT106 } from "./multimodal-it106";', "")]
    # « doublon de contenu it.106 » est LÉGITIME (nouvelle attente dédup)
    print(f"test-it107 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")


def main() -> None:
    t = transformer(open(ENTRAINEMENT_IN).read())
    verifier_entrainement(t)
    open(ENTRAINEMENT_OUT, "w").write(t)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    t2 = transformer_test(open(TEST_IN).read())
    verifier_test(t2)
    open(TEST_OUT, "w").write(t2)
    print(f"écrit : {TEST_OUT}")


if __name__ == "__main__":
    main()

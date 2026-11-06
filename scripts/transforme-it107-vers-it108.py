#!/usr/bin/env python3
"""Transforme les scripts it.107 en scripts it.108 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→it.107) :
  - identifiants PascalCase IT107 → IT108 (remplacement séparé de it107) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it107.bin) — restauration
    explicite après la cascade it107→it108 ;
  - fenêtre courante d'abord (324/116 → 344/124), PUIS référence historique
    (304/108 → 324/116) — l'ordre inverse corromprait les références ;
  - phrase « état hérité / gravure » APRÈS la globale it.107→it.108 ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout sha107 + import it.107) ;
  - km107_ → km108_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it107.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it108.py"
GENERE_IN = "scripts/genere-module-multimodal-it107.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it108.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it107.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it108.ts"
TEST_IN = "lib/neural/generation/multimodal-it107.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it108.test.ts"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. global it.107 → it.108 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.107", "it.108")
    # 2. phrase double (état hérité / gravure) — APRÈS la globale
    t = t.replace(
        "état hérité d'it.106, avant gravure it.107",
        "état hérité d'it.107, avant gravure it.108",
    )
    # 3. références fenêtre précédente (it.106 → it.107)
    t = t.replace("d'it.106", "d'it.107")
    t = t.replace("(it.106)", "(it.107)")
    t = t.replace("cumulatif it.106", "cumulatif it.107")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT107", "IT108")
    t = t.replace("it107", "it108")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (cascade : it106 → it107 ; la sortie devient it108)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it106.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it107.bin"',
    )
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it108.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it107.bin"',
    )
    # 5. offsets — fenêtre courante d'abord, puis référence historique
    t = t.replace("offset 324", "offset 344")  # fenêtre courante images
    t = t.replace("offset 304", "offset 324")  # référence fenêtre précédente
    t = t.replace("offset 116", "offset 124")  # fenêtre courante audios
    t = t.replace("offset 108", "offset 116")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. globals
    t = t.replace("it.107", "it.108")
    t = t.replace("it.106", "it.107")
    t = t.replace("it107", "it108")   # chemins + user-agent
    t = t.replace("km107_", "km108_")  # ids de paires
    # 2. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 324', '"offset": 344')
    t = t.replace('"offset": 116', '"offset": 124')
    t = t.replace("offset 324", "offset 344")   # prose header
    t = t.replace("offset 116", "offset 124")
    t = t.replace('"offset": 304', '"offset": 324')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 304", "offset 324")   # prose header historique
    t = t.replace('"offset": 108', '"offset": 116')
    t = t.replace("offset 108", "offset 116")
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals
    t = t.replace("it.107", "it.108")
    t = t.replace("IT107", "IT108")
    t = t.replace("it107", "it108")
    t = t.replace("km107_", "km108_")
    # 2. ré-import dédié pour la déduplication contre it.107
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT108, PAIRES_MULTIMODAL_IT108 } from "./multimodal-it108";',
        'import { ASSETS_MULTIMODAL_IT107 } from "./multimodal-it107";\nimport { ASSETS_MULTIMODAL_IT108, PAIRES_MULTIMODAL_IT108 } from "./multimodal-it108";',
    )
    # 3. titre du test de déduplication : liste allongée
    #    (la globale a rendu « it.108 (324/116) » — on rétablit it.107 et
    #    l'on ajoute la nouvelle fenêtre 344/124)
    t = t.replace(
        "it.106 (304/108) et it.108 (324/116)",
        "it.106 (304/108), it.107 (324/116) et it.108 (344/124)",
    )
    # 4. titre du test de fenêtres
    t = t.replace(
        "COCO offset 324, FLEURS offset 116 — après it.106 : 304/108",
        "COCO offset 344, FLEURS offset 124 — après it.107 : 324/116",
    )
    # 5. offsets du header
    t = t.replace("offset 324 +", "offset 344 +")
    t = t.replace("FLEURS offset 116)", "FLEURS offset 124)")
    # 6. ensembles et attentes de déduplication (ajout sha107)
    t = t.replace(
        "const sha106 = new Set(ASSETS_MULTIMODAL_IT106.map((a) => a.sha256));",
        "const sha106 = new Set(ASSETS_MULTIMODAL_IT106.map((a) => a.sha256));\n    const sha107 = new Set(ASSETS_MULTIMODAL_IT107.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha106.has(a.sha256), `doublon de contenu it.106 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha106.has(a.sha256), `doublon de contenu it.106 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha107.has(a.sha256), `doublon de contenu it.107 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 324)", "(offset 344)")
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it107_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.107 (324/116) —
    # « it.107 », « offset 324 », « offset 116 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.106,
    # 304/108) et des identifiants/ids it.107.
    interdits = ["it.106", "IT107", "km107_", "offset 304", "offset 108"]
    residus = [x for x in interdits if x in t]
    if autoriser_it107_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it107.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it107.bin"', "")
        assert t_sans.count("it107") == 0, f"it107 hors SNAPSHOT_SOURCE : {t_sans.count('it107')}"
    else:
        residus += ["it107"] if "it107" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.106", "it107", "km107_", '"offset": 324', '"offset": 116', "offset 304", "offset 108"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it108 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 344', '"offset": 124', "km108_", "multimodal-it108", "offset 324"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it108", autoriser_it107_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it108/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it108.ts", sortie)',
        "fenêtre offset 344",
        "offset 116",
        "celle d'it.107 — offset 324",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it108", autoriser_it107_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it107.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it108.bin"',
        'from "../lib/neural/generation/multimodal-it108"',
        "ASSETS_MULTIMODAL_IT108",
        "PAIRES_MULTIMODAL_IT108",
        "offset 344",
        "offset 124",
        "après l'offset 324 d'it.107",
        "après offset 324 (it.107)",
        "état hérité d'it.107, avant gravure it.108",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT107 légitime exactement 2× (import dédup + sha107)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT107") == 2, f"IT107 × {t4.count('IT107')} (attendu 2)"
    assert t4.count("it107") == 1, f"it107 × {t4.count('it107')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT107" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT107 } from "./multimodal-it107";' in ligne
    for attendu in [
        "km108_",
        "sha107",
        "it.107 (324/116) et it.108 (344/124)",
        "COCO offset 344, FLEURS offset 124 — après it.107 : 324/116",
        "(offset 344)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km107_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT107 } from "./multimodal-it107";', "")]
    print(f"test-it108 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")


if __name__ == "__main__":
    main()

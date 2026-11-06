#!/usr/bin/env python3
"""Transforme les scripts it.108 en scripts it.109 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→it.107→it.108) :
  - identifiants PascalCase IT108 → IT109 (remplacement séparé de it108) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it108.bin) — restauration
    explicite après la cascade it108→it109 ;
  - fenêtre courante d'abord (344/124 → 364/132), PUIS référence historique
    (324/116 → 344/124) — l'ordre inverse corromprait les références ;
  - phrase « état hérité / gravure » APRÈS la globale it.108→it.109 (forme
    post-globale : « d'it.107, avant gravure it.109 ») ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout sha108 + import it.108) ;
  - km108_ → km109_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it108.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it109.py"
GENERE_IN = "scripts/genere-module-multimodal-it108.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it109.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it108.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it109.ts"
TEST_IN = "lib/neural/generation/multimodal-it108.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it109.test.ts"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. global it.108 → it.109 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.108", "it.109")
    # 2. phrase double (état hérité / gravure) — APRÈS la globale, la partie
    #    « gravure it.108 » est devenue « gravure it.109 » ; on rétablit la
    #    source héritée en it.108 (la fenêtre précédente est désormais it.108).
    t = t.replace(
        "état hérité d'it.107, avant gravure it.109",
        "état hérité d'it.108, avant gravure it.109",
    )
    # 3. références fenêtre précédente (it.107 → it.108)
    t = t.replace("d'it.107", "d'it.108")
    t = t.replace("(it.107)", "(it.108)")
    t = t.replace("cumulatif it.107", "cumulatif it.108")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT108", "IT109")
    t = t.replace("it108", "it109")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (cascade : it107 → it108 ; la sortie devient it109)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it107.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it108.bin"',
    )
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it109.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it108.bin"',
    )
    # 5. offsets — fenêtre courante d'abord, puis référence historique
    t = t.replace("offset 344", "offset 364")  # fenêtre courante images
    t = t.replace("offset 324", "offset 344")  # référence fenêtre précédente
    t = t.replace("offset 124", "offset 132")  # fenêtre courante audios
    t = t.replace("offset 116", "offset 124")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. globals
    t = t.replace("it.108", "it.109")
    t = t.replace("it.107", "it.108")
    t = t.replace("it108", "it109")   # chemins + user-agent
    t = t.replace("km108_", "km109_")  # ids de paires
    # 2. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 344', '"offset": 364')
    t = t.replace('"offset": 124', '"offset": 132')
    t = t.replace("offset 344", "offset 364")   # prose header
    t = t.replace("offset 124", "offset 132")
    t = t.replace('"offset": 324', '"offset": 344')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 324", "offset 344")   # prose header historique
    t = t.replace('"offset": 116', '"offset": 124')
    t = t.replace("offset 116", "offset 124")
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals
    t = t.replace("it.108", "it.109")
    t = t.replace("IT108", "IT109")
    t = t.replace("it108", "it109")
    t = t.replace("km108_", "km109_")
    # 2. ré-import dédié pour la déduplication contre it.108
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT109, PAIRES_MULTIMODAL_IT109 } from "./multimodal-it109";',
        'import { ASSETS_MULTIMODAL_IT108 } from "./multimodal-it108";\nimport { ASSETS_MULTIMODAL_IT109, PAIRES_MULTIMODAL_IT109 } from "./multimodal-it109";',
    )
    # 3. titre du test de déduplication : liste allongée
    #    (la globale a rendu « it.109 (344/124) » — on rétablit it.108 et
    #    l'on ajoute la nouvelle fenêtre 364/132)
    t = t.replace(
        "it.107 (324/116) et it.109 (344/124)",
        "it.107 (324/116), it.108 (344/124) et it.109 (364/132)",
    )
    # 4. titre du test de fenêtres
    t = t.replace(
        "COCO offset 344, FLEURS offset 124 — après it.107 : 324/116",
        "COCO offset 364, FLEURS offset 132 — après it.108 : 344/124",
    )
    # 5. offsets du header
    t = t.replace("offset 344 +", "offset 364 +")
    t = t.replace("FLEURS offset 124)", "FLEURS offset 132)")
    # 6. ensembles et attentes de déduplication (ajout sha108)
    t = t.replace(
        "const sha107 = new Set(ASSETS_MULTIMODAL_IT107.map((a) => a.sha256));",
        "const sha107 = new Set(ASSETS_MULTIMODAL_IT107.map((a) => a.sha256));\n    const sha108 = new Set(ASSETS_MULTIMODAL_IT108.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha107.has(a.sha256), `doublon de contenu it.107 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha107.has(a.sha256), `doublon de contenu it.107 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha108.has(a.sha256), `doublon de contenu it.108 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 344)", "(offset 364)")
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it108_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.108 (344/124) —
    # « it.108 », « offset 344 », « offset 124 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.107,
    # 324/116) et des identifiants/ids it.108.
    interdits = ["it.107", "IT108", "km108_", "offset 324", "offset 116"]
    residus = [x for x in interdits if x in t]
    if autoriser_it108_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it108.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it108.bin"', "")
        assert t_sans.count("it108") == 0, f"it108 hors SNAPSHOT_SOURCE : {t_sans.count('it108')}"
    else:
        residus += ["it108"] if "it108" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.107", "it108", "km108_", '"offset": 344', '"offset": 124', "offset 324", "offset 116"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it109 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 364', '"offset": 132', "km109_", "multimodal-it109", "offset 344"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it109", autoriser_it108_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it109/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it109.ts", sortie)',
        "fenêtre offset 364",
        "offset 132",
        "celle d'it.108 — offset 344",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it109", autoriser_it108_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it108.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it109.bin"',
        'from "../lib/neural/generation/multimodal-it109"',
        "ASSETS_MULTIMODAL_IT109",
        "PAIRES_MULTIMODAL_IT109",
        "offset 364",
        "offset 132",
        "après l'offset 344 d'it.108",
        "après offset 344 (it.108)",
        "état hérité d'it.108, avant gravure it.109",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT108 légitime exactement 2× (import dédup + sha108)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT108") == 2, f"IT108 × {t4.count('IT108')} (attendu 2)"
    assert t4.count("it108") == 1, f"it108 × {t4.count('it108')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT108" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT108 } from "./multimodal-it108";' in ligne
    for attendu in [
        "km109_",
        "sha108",
        "it.107 (324/116), it.108 (344/124) et it.109 (364/132)",
        "COCO offset 364, FLEURS offset 132 — après it.108 : 344/124",
        "(offset 364)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km108_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT108 } from "./multimodal-it108";', "")]
    print(f"test-it109 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")


if __name__ == "__main__":
    main()

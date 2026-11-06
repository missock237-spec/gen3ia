#!/usr/bin/env python3
"""Transforme les scripts it.109 en scripts it.110 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.109) :
  - identifiants PascalCase IT109 → IT110 (remplacement séparé de it109) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it109.bin) — restauration
    explicite après la cascade it109→it110 ;
  - fenêtre courante d'abord (364/132 → 384/140), PUIS référence historique
    (344/124 → 364/132) — l'ordre inverse corromprait les références ;
  - phrase « état hérité / gravure » APRÈS la globale it.109→it.110 (forme
    post-globale : « d'it.108, avant gravure it.110 ») ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout sha109 + import it.109) ;
  - km109_ → km110_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it109.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it110.py"
GENERE_IN = "scripts/genere-module-multimodal-it109.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it110.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it109.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it110.ts"
TEST_IN = "lib/neural/generation/multimodal-it109.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it110.test.ts"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. global it.109 → it.110 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.109", "it.110")
    # 2. phrase double (état hérité / gravure) — APRÈS la globale, la partie
    #    « gravure it.109 » est devenue « gravure it.110 » ; on rétablit la
    #    source héritée en it.109 (la fenêtre précédente est désormais it.109).
    t = t.replace(
        "état hérité d'it.108, avant gravure it.110",
        "état hérité d'it.109, avant gravure it.110",
    )
    # 3. références fenêtre précédente (it.108 → it.109)
    t = t.replace("d'it.108", "d'it.109")
    t = t.replace("(it.108)", "(it.109)")
    t = t.replace("cumulatif it.108", "cumulatif it.109")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT109", "IT110")
    t = t.replace("it109", "it110")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (cascade : it108 → it109 ; la sortie devient it110)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it108.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it109.bin"',
    )
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it110.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it109.bin"',
    )
    # 5. offsets — fenêtre courante d'abord, puis référence historique
    t = t.replace("offset 364", "offset 384")  # fenêtre courante images
    t = t.replace("offset 344", "offset 364")  # référence fenêtre précédente
    t = t.replace("offset 132", "offset 140")  # fenêtre courante audios
    t = t.replace("offset 124", "offset 132")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. globals
    t = t.replace("it.109", "it.110")
    t = t.replace("it.108", "it.109")
    t = t.replace("it109", "it110")   # chemins + user-agent
    t = t.replace("km109_", "km110_")  # ids de paires
    # 2. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 364', '"offset": 384')
    t = t.replace('"offset": 132', '"offset": 140')
    t = t.replace("offset 364", "offset 384")   # prose header
    t = t.replace("offset 132", "offset 140")
    t = t.replace('"offset": 344', '"offset": 364')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 344", "offset 364")   # prose header historique
    t = t.replace('"offset": 124', '"offset": 132')
    t = t.replace("offset 124", "offset 132")
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals
    t = t.replace("it.109", "it.110")
    t = t.replace("IT109", "IT110")
    t = t.replace("it109", "it110")
    t = t.replace("km109_", "km110_")
    # 2. ré-import dédié pour la déduplication contre it.109
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT110, PAIRES_MULTIMODAL_IT110 } from "./multimodal-it110";',
        'import { ASSETS_MULTIMODAL_IT109 } from "./multimodal-it109";\nimport { ASSETS_MULTIMODAL_IT110, PAIRES_MULTIMODAL_IT110 } from "./multimodal-it110";',
    )
    # 3. titre du test de déduplication : liste allongée
    #    (la globale a rendu « it.110 (364/132) » — on rétablit it.109 et
    #    l'on ajoute la nouvelle fenêtre 384/140)
    t = t.replace(
        "it.108 (344/124) et it.110 (364/132)",
        "it.108 (344/124), it.109 (364/132) et it.110 (384/140)",
    )
    # 4. titre du test de fenêtres
    t = t.replace(
        "COCO offset 364, FLEURS offset 132 — après it.108 : 344/124",
        "COCO offset 384, FLEURS offset 140 — après it.109 : 364/132",
    )
    # 5. offsets du header
    t = t.replace("offset 364 +", "offset 384 +")
    t = t.replace("FLEURS offset 132)", "FLEURS offset 140)")
    # 6. ensembles et attentes de déduplication (ajout sha109)
    t = t.replace(
        "const sha108 = new Set(ASSETS_MULTIMODAL_IT108.map((a) => a.sha256));",
        "const sha108 = new Set(ASSETS_MULTIMODAL_IT108.map((a) => a.sha256));\n    const sha109 = new Set(ASSETS_MULTIMODAL_IT109.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha108.has(a.sha256), `doublon de contenu it.108 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha108.has(a.sha256), `doublon de contenu it.108 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha109.has(a.sha256), `doublon de contenu it.109 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 364)", "(offset 384)")
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it109_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.109 (364/132) —
    # « it.109 », « offset 364 », « offset 132 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.108,
    # 344/124) et des identifiants/ids it.109.
    interdits = ["it.108", "IT109", "km109_", "offset 344", "offset 124"]
    residus = [x for x in interdits if x in t]
    if autoriser_it109_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it109.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it109.bin"', "")
        assert t_sans.count("it109") == 0, f"it109 hors SNAPSHOT_SOURCE : {t_sans.count('it109')}"
    else:
        residus += ["it109"] if "it109" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.108", "it109", "km109_", '"offset": 364', '"offset": 132', "offset 344", "offset 124"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it110 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 384', '"offset": 140', "km110_", "multimodal-it110", "offset 364"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it110", autoriser_it109_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it110/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it110.ts", sortie)',
        "fenêtre offset 384",
        "offset 140",
        "celle d'it.109 — offset 364",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it110", autoriser_it109_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it109.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it110.bin"',
        'from "../lib/neural/generation/multimodal-it110"',
        "ASSETS_MULTIMODAL_IT110",
        "PAIRES_MULTIMODAL_IT110",
        "offset 384",
        "offset 140",
        "après l'offset 364 d'it.109",
        "après offset 364 (it.109)",
        "état hérité d'it.109, avant gravure it.110",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT109 légitime exactement 2× (import dédup + sha109)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT109") == 2, f"IT109 × {t4.count('IT109')} (attendu 2)"
    assert t4.count("it109") == 1, f"it109 × {t4.count('it109')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT109" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT109 } from "./multimodal-it109";' in ligne
    for attendu in [
        "km110_",
        "sha109",
        "it.108 (344/124), it.109 (364/132) et it.110 (384/140)",
        "COCO offset 384, FLEURS offset 140 — après it.109 : 364/132",
        "(offset 384)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km109_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT109 } from "./multimodal-it109";', "")]
    print(f"test-it110 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")


if __name__ == "__main__":
    main()

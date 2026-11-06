#!/usr/bin/env python3
"""Transforme les scripts it.110 en scripts it.111 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.110) :
  - identifiants PascalCase IT110 → IT111 (remplacement séparé de it110) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it110.bin) — restauration
    explicite après la cascade it110→it111 ;
  - fenêtre courante d'abord (384/140 → 404/148), PUIS référence historique
    (364/132 → 384/140) — l'ordre inverse corromprait les références ;
  - phrase « état hérité / gravure » APRÈS la globale it.110→it.111 (forme
    post-globale : « d'it.109, avant gravure it.111 ») ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout sha110 + import it.110) ;
  - km110_ → km111_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it110.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it111.py"
GENERE_IN = "scripts/genere-module-multimodal-it110.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it111.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it110.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it111.ts"
TEST_IN = "lib/neural/generation/multimodal-it110.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it111.test.ts"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. global it.110 → it.111 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.110", "it.111")
    # 2. phrase double (état hérité / gravure) — APRÈS la globale, la partie
    #    « gravure it.110 » est devenue « gravure it.111 » ; on rétablit la
    #    source héritée en it.110 (la fenêtre précédente est désormais it.110).
    t = t.replace(
        "état hérité d'it.109, avant gravure it.111",
        "état hérité d'it.110, avant gravure it.111",
    )
    # 3. références fenêtre précédente (it.109 → it.110)
    t = t.replace("d'it.109", "d'it.110")
    t = t.replace("(it.109)", "(it.110)")
    t = t.replace("cumulatif it.109", "cumulatif it.110")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT110", "IT111")
    t = t.replace("it110", "it111")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (cascade : it109 → it110 ; la sortie devient it111)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it109.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it110.bin"',
    )
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it111.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it110.bin"',
    )
    # 5. offsets — fenêtre courante d'abord, puis référence historique
    t = t.replace("offset 384", "offset 404")  # fenêtre courante images
    t = t.replace("offset 364", "offset 384")  # référence fenêtre précédente
    t = t.replace("offset 140", "offset 148")  # fenêtre courante audios
    t = t.replace("offset 132", "offset 140")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. globals
    t = t.replace("it.110", "it.111")
    t = t.replace("it.109", "it.110")
    t = t.replace("it110", "it111")   # chemins + user-agent
    t = t.replace("km110_", "km111_")  # ids de paires
    # 2. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 384', '"offset": 404')
    t = t.replace('"offset": 140', '"offset": 148')
    t = t.replace("offset 384", "offset 404")   # prose header
    t = t.replace("offset 140", "offset 148")
    t = t.replace('"offset": 364', '"offset": 384')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 364", "offset 384")   # prose header historique
    t = t.replace('"offset": 132', '"offset": 140')
    t = t.replace("offset 132", "offset 140")
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals
    t = t.replace("it.110", "it.111")
    t = t.replace("IT110", "IT111")
    t = t.replace("it110", "it111")
    t = t.replace("km110_", "km111_")
    # 2. ré-import dédié pour la déduplication contre it.110
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT111, PAIRES_MULTIMODAL_IT111 } from "./multimodal-it111";',
        'import { ASSETS_MULTIMODAL_IT110 } from "./multimodal-it110";\nimport { ASSETS_MULTIMODAL_IT111, PAIRES_MULTIMODAL_IT111 } from "./multimodal-it111";',
    )
    # 3. titre du test de déduplication : liste allongée
    #    (la globale a rendu « it.111 (384/140) » — on rétablit it.110 et
    #    l'on ajoute la nouvelle fenêtre 404/148)
    t = t.replace(
        "it.109 (364/132) et it.111 (384/140)",
        "it.109 (364/132), it.110 (384/140) et it.111 (404/148)",
    )
    # 4. titre du test de fenêtres
    t = t.replace(
        "COCO offset 384, FLEURS offset 140 — après it.109 : 364/132",
        "COCO offset 404, FLEURS offset 148 — après it.110 : 384/140",
    )
    # 5. offsets du header
    t = t.replace("offset 384 +", "offset 404 +")
    t = t.replace("FLEURS offset 140)", "FLEURS offset 148)")
    # 6. ensembles et attentes de déduplication (ajout sha110)
    t = t.replace(
        "const sha109 = new Set(ASSETS_MULTIMODAL_IT109.map((a) => a.sha256));",
        "const sha109 = new Set(ASSETS_MULTIMODAL_IT109.map((a) => a.sha256));\n    const sha110 = new Set(ASSETS_MULTIMODAL_IT110.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha109.has(a.sha256), `doublon de contenu it.109 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha109.has(a.sha256), `doublon de contenu it.109 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha110.has(a.sha256), `doublon de contenu it.110 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 384)", "(offset 404)")
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it110_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.110 (384/140) —
    # « it.110 », « offset 384 », « offset 140 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.109,
    # 364/132) et des identifiants/ids it.110.
    interdits = ["it.109", "IT110", "km110_", "offset 364", "offset 132"]
    residus = [x for x in interdits if x in t]
    if autoriser_it110_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it110.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it110.bin"', "")
        assert t_sans.count("it110") == 0, f"it110 hors SNAPSHOT_SOURCE : {t_sans.count('it110')}"
    else:
        residus += ["it110"] if "it110" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.109", "it110", "km110_", '"offset": 384', '"offset": 140', "offset 364", "offset 132"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it111 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 404', '"offset": 148', "km111_", "multimodal-it111", "offset 384"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it111", autoriser_it110_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it111/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it111.ts", sortie)',
        "fenêtre offset 404",
        "offset 148",
        "celle d'it.110 — offset 384",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it111", autoriser_it110_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it110.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it111.bin"',
        'from "../lib/neural/generation/multimodal-it111"',
        "ASSETS_MULTIMODAL_IT111",
        "PAIRES_MULTIMODAL_IT111",
        "offset 404",
        "offset 148",
        "après l'offset 384 d'it.110",
        "après offset 384 (it.110)",
        "état hérité d'it.110, avant gravure it.111",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT110 légitime exactement 2× (import dédup + sha110)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT110") == 2, f"IT110 × {t4.count('IT110')} (attendu 2)"
    assert t4.count("it110") == 1, f"it110 × {t4.count('it110')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT110" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT110 } from "./multimodal-it110";' in ligne
    for attendu in [
        "km111_",
        "sha110",
        "it.109 (364/132), it.110 (384/140) et it.111 (404/148)",
        "COCO offset 404, FLEURS offset 148 — après it.110 : 384/140",
        "(offset 404)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km110_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT110 } from "./multimodal-it110";', "")]
    print(f"test-it111 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")


if __name__ == "__main__":
    main()

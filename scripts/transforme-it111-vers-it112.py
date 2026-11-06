#!/usr/bin/env python3
"""Transforme les scripts it.111 en scripts it.112 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.111) :
  - identifiants PascalCase IT111 → IT112 (remplacement séparé de it111) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it111.bin) — restauration
    explicite après la cascade it111→it112 ;
  - fenêtre courante d'abord (404/148 → 424/156), PUIS référence historique
    (384/140 → 404/148) — l'ordre inverse corromprait les références ;
  - phrase « état hérité / gravure » APRÈS la globale it.111→it.112 (forme
    post-globale : « d'it.110, avant gravure it.112 ») ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout sha111 + import it.111) ;
  - km111_ → km112_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it111.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it112.py"
GENERE_IN = "scripts/genere-module-multimodal-it111.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it112.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it111.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it112.ts"
TEST_IN = "lib/neural/generation/multimodal-it111.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it112.test.ts"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. global it.111 → it.112 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.111", "it.112")
    # 2. phrase double (état hérité / gravure) — APRÈS la globale, la partie
    #    « gravure it.111 » est devenue « gravure it.112 » ; on rétablit la
    #    source héritée en it.111 (la fenêtre précédente est désormais it.111).
    t = t.replace(
        "état hérité d'it.110, avant gravure it.112",
        "état hérité d'it.111, avant gravure it.112",
    )
    # 3. références fenêtre précédente (it.110 → it.111)
    t = t.replace("d'it.110", "d'it.111")
    t = t.replace("(it.110)", "(it.111)")
    t = t.replace("cumulatif it.110", "cumulatif it.111")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT111", "IT112")
    t = t.replace("it111", "it112")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (cascade : it110 → it111 ; la sortie devient it112)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it110.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it111.bin"',
    )
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it112.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it111.bin"',
    )
    # 5. offsets — fenêtre courante d'abord, puis référence historique
    t = t.replace("offset 404", "offset 424")  # fenêtre courante images
    t = t.replace("offset 384", "offset 404")  # référence fenêtre précédente
    t = t.replace("offset 148", "offset 156")  # fenêtre courante audios
    t = t.replace("offset 140", "offset 148")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. globals
    t = t.replace("it.111", "it.112")
    t = t.replace("it.110", "it.111")
    t = t.replace("it111", "it112")   # chemins + user-agent
    t = t.replace("km111_", "km112_")  # ids de paires
    # 2. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 404', '"offset": 424')
    t = t.replace('"offset": 148', '"offset": 156')
    t = t.replace("offset 404", "offset 424")   # prose header
    t = t.replace("offset 148", "offset 156")
    t = t.replace('"offset": 384', '"offset": 404')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 384", "offset 404")   # prose header historique
    t = t.replace('"offset": 140', '"offset": 148')
    t = t.replace("offset 140", "offset 148")
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals
    t = t.replace("it.111", "it.112")
    t = t.replace("IT111", "IT112")
    t = t.replace("it111", "it112")
    t = t.replace("km111_", "km112_")
    # 2. ré-import dédié pour la déduplication contre it.111
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT112, PAIRES_MULTIMODAL_IT112 } from "./multimodal-it112";',
        'import { ASSETS_MULTIMODAL_IT111 } from "./multimodal-it111";\nimport { ASSETS_MULTIMODAL_IT112, PAIRES_MULTIMODAL_IT112 } from "./multimodal-it112";',
    )
    # 3. titre du test de déduplication : liste allongée
    #    (la globale a rendu « it.112 (404/148) » — on rétablit it.111 et
    #    l'on ajoute la nouvelle fenêtre 424/156)
    t = t.replace(
        "it.110 (384/140) et it.112 (404/148)",
        "it.110 (384/140), it.111 (404/148) et it.112 (424/156)",
    )
    # 4. titre du test de fenêtres
    t = t.replace(
        "COCO offset 404, FLEURS offset 148 — après it.110 : 384/140",
        "COCO offset 424, FLEURS offset 156 — après it.111 : 404/148",
    )
    # 5. offsets du header
    t = t.replace("offset 404 +", "offset 424 +")
    t = t.replace("FLEURS offset 148)", "FLEURS offset 156)")
    # 6. ensembles et attentes de déduplication (ajout sha111)
    t = t.replace(
        "const sha110 = new Set(ASSETS_MULTIMODAL_IT110.map((a) => a.sha256));",
        "const sha110 = new Set(ASSETS_MULTIMODAL_IT110.map((a) => a.sha256));\n    const sha111 = new Set(ASSETS_MULTIMODAL_IT111.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha110.has(a.sha256), `doublon de contenu it.110 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha110.has(a.sha256), `doublon de contenu it.110 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha111.has(a.sha256), `doublon de contenu it.111 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 404)", "(offset 424)")
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it111_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.111 (404/148) —
    # « it.111 », « offset 404 », « offset 148 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.110,
    # 384/140) et des identifiants/ids it.111.
    interdits = ["it.110", "IT111", "km111_", "offset 384", "offset 140"]
    residus = [x for x in interdits if x in t]
    if autoriser_it111_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it111.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it111.bin"', "")
        assert t_sans.count("it111") == 0, f"it111 hors SNAPSHOT_SOURCE : {t_sans.count('it111')}"
    else:
        residus += ["it111"] if "it111" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.110", "it111", "km111_", '"offset": 404', '"offset": 148', "offset 384", "offset 140"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it112 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 424', '"offset": 156', "km112_", "multimodal-it112", "offset 404"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it112", autoriser_it111_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it112/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it112.ts", sortie)',
        "fenêtre offset 424",
        "offset 156",
        "celle d'it.111 — offset 404",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it112", autoriser_it111_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it111.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it112.bin"',
        'from "../lib/neural/generation/multimodal-it112"',
        "ASSETS_MULTIMODAL_IT112",
        "PAIRES_MULTIMODAL_IT112",
        "offset 424",
        "offset 156",
        "après l'offset 404 d'it.111",
        "après offset 404 (it.111)",
        "état hérité d'it.111, avant gravure it.112",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT111 légitime exactement 2× (import dédup + sha111)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT111") == 2, f"IT111 × {t4.count('IT111')} (attendu 2)"
    assert t4.count("it111") == 1, f"it111 × {t4.count('it111')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT111" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT111 } from "./multimodal-it111";' in ligne
    for attendu in [
        "km112_",
        "sha111",
        "it.110 (384/140), it.111 (404/148) et it.112 (424/156)",
        "COCO offset 424, FLEURS offset 156 — après it.111 : 404/148",
        "(offset 424)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km111_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT111 } from "./multimodal-it111";', "")]
    print(f"test-it112 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Transforme les scripts it.118 en scripts it.119 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.118) :
  - identifiants PascalCase IT118 → IT119 (remplacement séparé de it118) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it118.bin) — restauration
    explicite après la cascade it118→it119 ;
  - fenêtre courante d'abord (524/196 → 544/204), PUIS référence historique
    (504/188 → 524/196) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.117, avant gravure it.119 »
    → « d'it.118, avant gravure it.119 » (la fenêtre précédente est it.118) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it118 + sha118 + titre) ;
  - km118_ → km119_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it118.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it119.py"
GENERE_IN = "scripts/genere-module-multimodal-it118.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it119.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it118.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it119.ts"
TEST_IN = "lib/neural/generation/multimodal-it118.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it119.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it118.py"
DEDUP_OUT = "scripts/verifie-dedup-it119.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 524", "offset 544")  # fenêtre courante images
    t = t.replace("offset 196", "offset 204")  # fenêtre courante audios
    t = t.replace("offset 504", "offset 524")  # référence fenêtre précédente
    t = t.replace("offset 188", "offset 196")
    # 2. global it.118 → it.119 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.118", "it.119")
    # 3. fenêtre précédente it.117 → it.118 (toutes les formes documentées)
    t = t.replace("d'it.117", "d'it.118")
    t = t.replace("(it.117)", "(it.118)")
    t = t.replace("cumulatif it.117", "cumulatif it.118")
    t = t.replace("après it.117", "après it.118")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT118", "IT119")
    t = t.replace("it118", "it119")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.118 était it117.bin ; pour it.119 elle devient it118.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it117.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it118.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 524', '"offset": 544')
    t = t.replace('"offset": 196', '"offset": 204')
    t = t.replace("offset 524", "offset 544")   # prose header
    t = t.replace("offset 196", "offset 204")
    t = t.replace('"offset": 504', '"offset": 524')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 504", "offset 524")   # prose header historique
    t = t.replace('"offset": 188', '"offset": 196')
    t = t.replace("offset 188", "offset 196")
    # 2. globals
    t = t.replace("it.118", "it.119")
    t = t.replace("it.117", "it.118")
    t = t.replace("it118", "it119")   # chemins + user-agent
    t = t.replace("km118_", "km119_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 524", "offset 544")
    t = t.replace("offset 196", "offset 204")
    t = t.replace("offset 504", "offset 524")
    t = t.replace("offset 188", "offset 196")
    # 2. globals
    t = t.replace("it.118", "it.119")
    t = t.replace("IT118", "IT119")
    t = t.replace("it118", "it119")
    t = t.replace("km118_", "km119_")
    # 3. titre du test de fenêtres : « après it.118 : 524/196 »
    t = t.replace(
        "après it.117 : 504/188",
        "après it.118 : 524/196",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.117 (504/188) et it.119 (524/196) » —
    #    on réinsère it.118 (524/196) et on ajoute la nouvelle fenêtre it.119
    #    (544/204) en fin de liste)
    t = t.replace(
        "it.117 (504/188) et it.119 (524/196)\", () => {",
        "it.117 (504/188), it.118 (524/196) et it.119 (544/204)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.118
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT119, PAIRES_MULTIMODAL_IT119 } from "./multimodal-it119";',
        'import { ASSETS_MULTIMODAL_IT118 } from "./multimodal-it118";\nimport { ASSETS_MULTIMODAL_IT119, PAIRES_MULTIMODAL_IT119 } from "./multimodal-it119";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha118)
    t = t.replace(
        "const sha117 = new Set(ASSETS_MULTIMODAL_IT117.map((a) => a.sha256));",
        "const sha117 = new Set(ASSETS_MULTIMODAL_IT117.map((a) => a.sha256));\n    const sha118 = new Set(ASSETS_MULTIMODAL_IT118.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha117.has(a.sha256), `doublon de contenu it.117 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha117.has(a.sha256), `doublon de contenu it.117 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha118.has(a.sha256), `doublon de contenu it.118 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 544)", "(offset 544)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it118_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.118 (524/196) —
    # « it.118 », « offset 524 », « offset 196 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.117,
    # 504/188) et des identifiants/ids it.118.
    interdits = ["it.117", "IT118", "km118_", "offset 504", "offset 188"]
    residus = [x for x in interdits if x in t]
    if autoriser_it118_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it118.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it118.bin"', "")
        assert t_sans.count("it118") == 0, f"it118 hors SNAPSHOT_SOURCE : {t_sans.count('it118')}"
    else:
        residus += ["it118"] if "it118" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.117", "it118", "km118_", '"offset": 524', '"offset": 196', "offset 504", "offset 188"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it119 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 544', '"offset": 204', "km119_", "multimodal-it119", "offset 524", "après it.118"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it119", autoriser_it118_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it119/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it119.ts", sortie)',
        "fenêtre offset 544",
        "offset 204",
        "celle d'it.118 — offset 524",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it119", autoriser_it118_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it118.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it119.bin"',
        'from "../lib/neural/generation/multimodal-it119"',
        "ASSETS_MULTIMODAL_IT119",
        "PAIRES_MULTIMODAL_IT119",
        "offset 544",
        "offset 204",
        "après l'offset 524 d'it.118",
        "après offset 524 (it.118)",
        "état hérité d'it.118, avant gravure it.119",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT118 légitime exactement 2× (import dédup + sha118)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT118") == 2, f"IT118 × {t4.count('IT118')} (attendu 2)"
    assert t4.count("it118") == 1, f"it118 × {t4.count('it118')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT118" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT118 } from "./multimodal-it118";' in ligne
    for attendu in [
        "km119_",
        "sha118",
        "it.117 (504/188), it.118 (524/196) et it.119 (544/204)",
        "COCO offset 544, FLEURS offset 204 — après it.118 : 524/196",
        "(offset 544)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km118_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT118 } from "./multimodal-it118";', "")]
    print(f"test-it119 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.118", "it.119")
    t5 = t5.replace("it118", "it119")
    interdits = ["it.118", "it118"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it119 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it119/assets.json", "fenêtre it.119"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

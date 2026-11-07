#!/usr/bin/env python3
"""Transforme les scripts it.117 en scripts it.118 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.117) :
  - identifiants PascalCase IT117 → IT118 (remplacement séparé de it117) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it117.bin) — restauration
    explicite après la cascade it117→it118 ;
  - fenêtre courante d'abord (504/188 → 524/196), PUIS référence historique
    (484/180 → 504/188) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.116, avant gravure it.118 »
    → « d'it.117, avant gravure it.118 » (la fenêtre précédente est it.117) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it117 + sha117 + titre) ;
  - km117_ → km118_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it117.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it118.py"
GENERE_IN = "scripts/genere-module-multimodal-it117.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it118.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it117.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it118.ts"
TEST_IN = "lib/neural/generation/multimodal-it117.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it118.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it117.py"
DEDUP_OUT = "scripts/verifie-dedup-it118.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 504", "offset 524")  # fenêtre courante images
    t = t.replace("offset 188", "offset 196")  # fenêtre courante audios
    t = t.replace("offset 484", "offset 504")  # référence fenêtre précédente
    t = t.replace("offset 180", "offset 188")
    # 2. global it.117 → it.118 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.117", "it.118")
    # 3. fenêtre précédente it.116 → it.117 (toutes les formes documentées)
    t = t.replace("d'it.116", "d'it.117")
    t = t.replace("(it.116)", "(it.117)")
    t = t.replace("cumulatif it.116", "cumulatif it.117")
    t = t.replace("après it.116", "après it.117")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT117", "IT118")
    t = t.replace("it117", "it118")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.117 était it116.bin ; pour it.118 elle devient it117.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it116.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it117.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 504', '"offset": 524')
    t = t.replace('"offset": 188', '"offset": 196')
    t = t.replace("offset 504", "offset 524")   # prose header
    t = t.replace("offset 188", "offset 196")
    t = t.replace('"offset": 484', '"offset": 504')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 484", "offset 504")   # prose header historique
    t = t.replace('"offset": 180', '"offset": 188')
    t = t.replace("offset 180", "offset 188")
    # 2. globals
    t = t.replace("it.117", "it.118")
    t = t.replace("it.116", "it.117")
    t = t.replace("it117", "it118")   # chemins + user-agent
    t = t.replace("km117_", "km118_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 504", "offset 524")
    t = t.replace("offset 188", "offset 196")
    t = t.replace("offset 484", "offset 504")
    t = t.replace("offset 180", "offset 188")
    # 2. globals
    t = t.replace("it.117", "it.118")
    t = t.replace("IT117", "IT118")
    t = t.replace("it117", "it118")
    t = t.replace("km117_", "km118_")
    # 3. titre du test de fenêtres : « après it.117 : 504/188 »
    t = t.replace(
        "après it.116 : 484/180",
        "après it.117 : 504/188",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.116 (484/180) et it.118 (504/188) » —
    #    on réinsère it.117 (504/188) et on ajoute la nouvelle fenêtre it.118
    #    (524/196) en fin de liste)
    t = t.replace(
        "it.116 (484/180) et it.118 (504/188)\", () => {",
        "it.116 (484/180), it.117 (504/188) et it.118 (524/196)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.117
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT118, PAIRES_MULTIMODAL_IT118 } from "./multimodal-it118";',
        'import { ASSETS_MULTIMODAL_IT117 } from "./multimodal-it117";\nimport { ASSETS_MULTIMODAL_IT118, PAIRES_MULTIMODAL_IT118 } from "./multimodal-it118";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha117)
    t = t.replace(
        "const sha116 = new Set(ASSETS_MULTIMODAL_IT116.map((a) => a.sha256));",
        "const sha116 = new Set(ASSETS_MULTIMODAL_IT116.map((a) => a.sha256));\n    const sha117 = new Set(ASSETS_MULTIMODAL_IT117.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha116.has(a.sha256), `doublon de contenu it.116 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha116.has(a.sha256), `doublon de contenu it.116 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha117.has(a.sha256), `doublon de contenu it.117 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 524)", "(offset 524)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it117_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.117 (504/188) —
    # « it.117 », « offset 504 », « offset 188 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.116,
    # 484/180) et des identifiants/ids it.117.
    interdits = ["it.116", "IT117", "km117_", "offset 484", "offset 180"]
    residus = [x for x in interdits if x in t]
    if autoriser_it117_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it117.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it117.bin"', "")
        assert t_sans.count("it117") == 0, f"it117 hors SNAPSHOT_SOURCE : {t_sans.count('it117')}"
    else:
        residus += ["it117"] if "it117" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.116", "it117", "km117_", '"offset": 504', '"offset": 188', "offset 484", "offset 180"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it118 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 524', '"offset": 196', "km118_", "multimodal-it118", "offset 504", "après it.117"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it118", autoriser_it117_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it118/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it118.ts", sortie)',
        "fenêtre offset 524",
        "offset 196",
        "celle d'it.117 — offset 504",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it118", autoriser_it117_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it117.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it118.bin"',
        'from "../lib/neural/generation/multimodal-it118"',
        "ASSETS_MULTIMODAL_IT118",
        "PAIRES_MULTIMODAL_IT118",
        "offset 524",
        "offset 196",
        "après l'offset 504 d'it.117",
        "après offset 504 (it.117)",
        "état hérité d'it.117, avant gravure it.118",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT117 légitime exactement 2× (import dédup + sha117)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT117") == 2, f"IT117 × {t4.count('IT117')} (attendu 2)"
    assert t4.count("it117") == 1, f"it117 × {t4.count('it117')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT117" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT117 } from "./multimodal-it117";' in ligne
    for attendu in [
        "km118_",
        "sha117",
        "it.116 (484/180), it.117 (504/188) et it.118 (524/196)",
        "COCO offset 524, FLEURS offset 196 — après it.117 : 504/188",
        "(offset 524)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km117_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT117 } from "./multimodal-it117";', "")]
    print(f"test-it118 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.117", "it.118")
    t5 = t5.replace("it117", "it118")
    interdits = ["it.117", "it117"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it118 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it118/assets.json", "fenêtre it.118"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

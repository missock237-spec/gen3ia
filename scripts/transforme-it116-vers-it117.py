#!/usr/bin/env python3
"""Transforme les scripts it.116 en scripts it.117 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.116) :
  - identifiants PascalCase IT116 → IT117 (remplacement séparé de it116) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it116.bin) — restauration
    explicite après la cascade it116→it117 ;
  - fenêtre courante d'abord (484/180 → 504/188), PUIS référence historique
    (464/172 → 484/180) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.115, avant gravure it.117 »
    → « d'it.116, avant gravure it.117 » (la fenêtre précédente est it.116) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it116 + sha116 + titre) ;
  - km116_ → km117_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it116.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it117.py"
GENERE_IN = "scripts/genere-module-multimodal-it116.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it117.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it116.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it117.ts"
TEST_IN = "lib/neural/generation/multimodal-it116.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it117.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it116.py"
DEDUP_OUT = "scripts/verifie-dedup-it117.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 484", "offset 504")  # fenêtre courante images
    t = t.replace("offset 180", "offset 188")  # fenêtre courante audios
    t = t.replace("offset 464", "offset 484")  # référence fenêtre précédente
    t = t.replace("offset 172", "offset 180")
    # 2. global it.116 → it.117 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.116", "it.117")
    # 3. fenêtre précédente it.115 → it.116 (toutes les formes documentées)
    t = t.replace("d'it.115", "d'it.116")
    t = t.replace("(it.115)", "(it.116)")
    t = t.replace("cumulatif it.115", "cumulatif it.116")
    t = t.replace("après it.115", "après it.116")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT116", "IT117")
    t = t.replace("it116", "it117")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.116 était it115.bin ; pour it.117 elle devient it116.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it115.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it116.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 484', '"offset": 504')
    t = t.replace('"offset": 180', '"offset": 188')
    t = t.replace("offset 484", "offset 504")   # prose header
    t = t.replace("offset 180", "offset 188")
    t = t.replace('"offset": 464', '"offset": 484')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 464", "offset 484")   # prose header historique
    t = t.replace('"offset": 172', '"offset": 180')
    t = t.replace("offset 172", "offset 180")
    # 2. globals
    t = t.replace("it.116", "it.117")
    t = t.replace("it.115", "it.116")
    t = t.replace("it116", "it117")   # chemins + user-agent
    t = t.replace("km116_", "km117_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 484", "offset 504")
    t = t.replace("offset 180", "offset 188")
    t = t.replace("offset 464", "offset 484")
    t = t.replace("offset 172", "offset 180")
    # 2. globals
    t = t.replace("it.116", "it.117")
    t = t.replace("IT116", "IT117")
    t = t.replace("it116", "it117")
    t = t.replace("km116_", "km117_")
    # 3. titre du test de fenêtres : « après it.116 : 484/180 »
    t = t.replace(
        "après it.115 : 464/172",
        "après it.116 : 484/180",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.115 (464/172) et it.117 (484/180) » —
    #    on réinsère it.116 (484/180) et on ajoute la nouvelle fenêtre it.117
    #    (504/188) en fin de liste)
    t = t.replace(
        "it.115 (464/172) et it.117 (484/180)\", () => {",
        "it.115 (464/172), it.116 (484/180) et it.117 (504/188)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.116
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT117, PAIRES_MULTIMODAL_IT117 } from "./multimodal-it117";',
        'import { ASSETS_MULTIMODAL_IT116 } from "./multimodal-it116";\nimport { ASSETS_MULTIMODAL_IT117, PAIRES_MULTIMODAL_IT117 } from "./multimodal-it117";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha116)
    t = t.replace(
        "const sha115 = new Set(ASSETS_MULTIMODAL_IT115.map((a) => a.sha256));",
        "const sha115 = new Set(ASSETS_MULTIMODAL_IT115.map((a) => a.sha256));\n    const sha116 = new Set(ASSETS_MULTIMODAL_IT116.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha115.has(a.sha256), `doublon de contenu it.115 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha115.has(a.sha256), `doublon de contenu it.115 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha116.has(a.sha256), `doublon de contenu it.116 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 504)", "(offset 504)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it116_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.116 (484/180) —
    # « it.116 », « offset 484 », « offset 180 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.115,
    # 464/172) et des identifiants/ids it.116.
    interdits = ["it.115", "IT116", "km116_", "offset 464", "offset 172"]
    residus = [x for x in interdits if x in t]
    if autoriser_it116_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it116.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it116.bin"', "")
        assert t_sans.count("it116") == 0, f"it116 hors SNAPSHOT_SOURCE : {t_sans.count('it116')}"
    else:
        residus += ["it116"] if "it116" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.115", "it116", "km116_", '"offset": 484', '"offset": 180', "offset 464", "offset 172"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it117 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 504', '"offset": 188', "km117_", "multimodal-it117", "offset 484", "après it.116"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it117", autoriser_it116_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it117/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it117.ts", sortie)',
        "fenêtre offset 504",
        "offset 188",
        "celle d'it.116 — offset 484",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it117", autoriser_it116_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it116.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it117.bin"',
        'from "../lib/neural/generation/multimodal-it117"',
        "ASSETS_MULTIMODAL_IT117",
        "PAIRES_MULTIMODAL_IT117",
        "offset 504",
        "offset 188",
        "après l'offset 484 d'it.116",
        "après offset 484 (it.116)",
        "état hérité d'it.116, avant gravure it.117",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT116 légitime exactement 2× (import dédup + sha116)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT116") == 2, f"IT116 × {t4.count('IT116')} (attendu 2)"
    assert t4.count("it116") == 1, f"it116 × {t4.count('it116')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT116" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT116 } from "./multimodal-it116";' in ligne
    for attendu in [
        "km117_",
        "sha116",
        "it.115 (464/172), it.116 (484/180) et it.117 (504/188)",
        "COCO offset 504, FLEURS offset 188 — après it.116 : 484/180",
        "(offset 504)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km116_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT116 } from "./multimodal-it116";', "")]
    print(f"test-it117 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.116", "it.117")
    t5 = t5.replace("it116", "it117")
    interdits = ["it.116", "it116"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it117 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it117/assets.json", "fenêtre it.117"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

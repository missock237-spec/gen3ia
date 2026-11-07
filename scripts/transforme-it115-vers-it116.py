#!/usr/bin/env python3
"""Transforme les scripts it.115 en scripts it.116 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.115) :
  - identifiants PascalCase IT115 → IT116 (remplacement séparé de it115) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it115.bin) — restauration
    explicite après la cascade it115→it116 ;
  - fenêtre courante d'abord (464/172 → 484/180), PUIS référence historique
    (444/164 → 464/172) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.113, avant gravure it.116 »
    → « d'it.115, avant gravure it.116 » (la fenêtre précédente est it.115) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it115 + sha115 + titre) ;
  - km115_ → km116_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it115.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it116.py"
GENERE_IN = "scripts/genere-module-multimodal-it115.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it116.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it115.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it116.ts"
TEST_IN = "lib/neural/generation/multimodal-it115.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it116.test.ts"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 464", "offset 484")  # fenêtre courante images
    t = t.replace("offset 172", "offset 180")  # fenêtre courante audios
    t = t.replace("offset 444", "offset 464")  # référence fenêtre précédente
    t = t.replace("offset 164", "offset 172")
    # 2. global it.115 → it.116 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.115", "it.116")
    # 3. fenêtre précédente it.113 → it.115 (toutes les formes documentées)
    t = t.replace("d'it.113", "d'it.115")
    t = t.replace("(it.113)", "(it.115)")
    t = t.replace("cumulatif it.113", "cumulatif it.115")
    t = t.replace("après it.113", "après it.115")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT115", "IT116")
    t = t.replace("it115", "it116")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (cascade : it115 → it116 ; la sortie devient it116)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it113.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it115.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 464', '"offset": 484')
    t = t.replace('"offset": 172', '"offset": 180')
    t = t.replace("offset 464", "offset 484")   # prose header (aucune ligne ici)
    t = t.replace("offset 172", "offset 180")
    t = t.replace('"offset": 444', '"offset": 464')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 444", "offset 464")   # prose header historique
    t = t.replace('"offset": 164', '"offset": 172')
    t = t.replace("offset 164", "offset 172")
    # 2. globals
    t = t.replace("it.115", "it.116")
    t = t.replace("it.113", "it.115")
    t = t.replace("it115", "it116")   # chemins + user-agent
    t = t.replace("km115_", "km116_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 464", "offset 484")
    t = t.replace("offset 172", "offset 180")
    t = t.replace("offset 444", "offset 464")
    t = t.replace("offset 164", "offset 172")
    # 2. globals
    t = t.replace("it.115", "it.116")
    t = t.replace("IT115", "IT116")
    t = t.replace("it115", "it116")
    t = t.replace("km115_", "km116_")
    # 3. titre du test de fenêtres : « après it.115 : 464/172 »
    t = t.replace(
        "COCO offset 484, FLEURS offset 180 — après it.113 : 444/164",
        "COCO offset 484, FLEURS offset 180 — après it.115 : 464/172",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.113 (444/164) » en fin de liste —
    #    on y ajoute it.115 (464/172) et la nouvelle fenêtre it.116 (484/180))
    t = t.replace(
        "it.113 (444/164)\", () => {",
        "it.113 (444/164), it.115 (464/172) et it.116 (484/180)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.115
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT116, PAIRES_MULTIMODAL_IT116 } from "./multimodal-it116";',
        'import { ASSETS_MULTIMODAL_IT115 } from "./multimodal-it115";\nimport { ASSETS_MULTIMODAL_IT116, PAIRES_MULTIMODAL_IT116 } from "./multimodal-it116";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha115)
    t = t.replace(
        "const sha113 = new Set(ASSETS_MULTIMODAL_IT113.map((a) => a.sha256));",
        "const sha113 = new Set(ASSETS_MULTIMODAL_IT113.map((a) => a.sha256));\n    const sha115 = new Set(ASSETS_MULTIMODAL_IT115.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha113.has(a.sha256), `doublon de contenu it.113 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha113.has(a.sha256), `doublon de contenu it.113 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha115.has(a.sha256), `doublon de contenu it.115 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 484)", "(offset 484)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it115_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.115 (464/172) —
    # « it.115 », « offset 464 », « offset 172 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.113,
    # 444/164) et des identifiants/ids it.115.
    interdits = ["it.113", "IT115", "km115_", "offset 444", "offset 164"]
    residus = [x for x in interdits if x in t]
    if autoriser_it115_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it115.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it115.bin"', "")
        assert t_sans.count("it115") == 0, f"it115 hors SNAPSHOT_SOURCE : {t_sans.count('it115')}"
    else:
        residus += ["it115"] if "it115" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.113", "it115", "km115_", '"offset": 464', '"offset": 172', "offset 444", "offset 164"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it116 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 484', '"offset": 180', "km116_", "multimodal-it116", "offset 464", "après it.115"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it116", autoriser_it115_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it116/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it116.ts", sortie)',
        "fenêtre offset 484",
        "offset 180",
        "celle d'it.115 — offset 464",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it116", autoriser_it115_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it115.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it116.bin"',
        'from "../lib/neural/generation/multimodal-it116"',
        "ASSETS_MULTIMODAL_IT116",
        "PAIRES_MULTIMODAL_IT116",
        "offset 484",
        "offset 180",
        "après l'offset 464 d'it.115",
        "après offset 464 (it.115)",
        "état hérité d'it.115, avant gravure it.116",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT115 légitime exactement 2× (import dédup + sha115)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT115") == 2, f"IT115 × {t4.count('IT115')} (attendu 2)"
    assert t4.count("it115") == 1, f"it115 × {t4.count('it115')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT115" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT115 } from "./multimodal-it115";' in ligne
    for attendu in [
        "km116_",
        "sha115",
        "it.113 (444/164), it.115 (464/172) et it.116 (484/180)",
        "COCO offset 484, FLEURS offset 180 — après it.115 : 464/172",
        "(offset 484)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km115_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT115 } from "./multimodal-it115";', "")]
    print(f"test-it116 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")


if __name__ == "__main__":
    main()

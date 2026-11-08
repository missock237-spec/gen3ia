#!/usr/bin/env python3
"""Transforme les scripts it.128 en scripts it.129 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.128) :
  - identifiants PascalCase IT128 → IT129 (remplacement séparé de it128) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it128.bin) — restauration
    explicite après la cascade it128→it129 ;
  - fenêtre courante d'abord (724/276 → 744/284), PUIS référence historique
    (704/268 → 724/276) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.127, avant gravure it.129 »
    → « d'it.128, avant gravure it.129 » (la fenêtre précédente est it.128) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it128 + sha128 + titre) ;
  - km128_ → km129_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it128.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it129.py"
GENERE_IN = "scripts/genere-module-multimodal-it128.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it129.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it128.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it129.ts"
TEST_IN = "lib/neural/generation/multimodal-it128.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it129.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it128.py"
DEDUP_OUT = "scripts/verifie-dedup-it129.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 724", "offset 744")  # fenêtre courante images
    t = t.replace("offset 276", "offset 284")  # fenêtre courante audios
    t = t.replace("offset 704", "offset 724")  # référence fenêtre précédente
    t = t.replace("offset 268", "offset 276")
    # 2. global it.128 → it.129 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.128", "it.129")
    # 3. fenêtre précédente it.127 → it.128 (toutes les formes documentées)
    t = t.replace("d'it.127", "d'it.128")
    t = t.replace("(it.127)", "(it.128)")
    t = t.replace("cumulatif it.127", "cumulatif it.128")
    t = t.replace("après it.127", "après it.128")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT128", "IT129")
    t = t.replace("it128", "it129")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.128 était it127.bin ; pour it.129 elle devient it128.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it127.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it128.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 724', '"offset": 744')
    t = t.replace('"offset": 276', '"offset": 284')
    t = t.replace("offset 724", "offset 744")   # prose header
    t = t.replace("offset 276", "offset 284")
    t = t.replace('"offset": 704', '"offset": 724')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 704", "offset 724")   # prose header historique
    t = t.replace('"offset": 268', '"offset": 276')
    t = t.replace("offset 268", "offset 276")
    # 2. globals
    t = t.replace("it.128", "it.129")
    t = t.replace("it.127", "it.128")
    t = t.replace("it128", "it129")   # chemins + user-agent
    t = t.replace("km128_", "km129_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 724", "offset 744")
    t = t.replace("offset 276", "offset 284")
    t = t.replace("offset 704", "offset 724")
    t = t.replace("offset 268", "offset 276")
    # 2. globals
    t = t.replace("it.128", "it.129")
    t = t.replace("IT128", "IT129")
    t = t.replace("it128", "it129")
    t = t.replace("km128_", "km129_")
    # 3. titre du test de fenêtres : « après it.128 : 724/276 »
    t = t.replace(
        "après it.127 : 704/268",
        "après it.128 : 724/276",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.127 (704/268) et it.129 (724/276) » —
    #    on réinsère it.128 (724/276) et on ajoute la nouvelle fenêtre it.129
    #    (744/284) en fin de liste)
    t = t.replace(
        "it.127 (704/268) et it.129 (724/276)\", () => {",
        "it.127 (704/268), it.128 (724/276) et it.129 (744/284)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.128
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT129, PAIRES_MULTIMODAL_IT129 } from "./multimodal-it129";',
        'import { ASSETS_MULTIMODAL_IT128 } from "./multimodal-it128";\nimport { ASSETS_MULTIMODAL_IT129, PAIRES_MULTIMODAL_IT129 } from "./multimodal-it129";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha128)
    t = t.replace(
        "const sha127 = new Set(ASSETS_MULTIMODAL_IT127.map((a) => a.sha256));",
        "const sha127 = new Set(ASSETS_MULTIMODAL_IT127.map((a) => a.sha256));\n    const sha128 = new Set(ASSETS_MULTIMODAL_IT128.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha127.has(a.sha256), `doublon de contenu it.127 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha127.has(a.sha256), `doublon de contenu it.127 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha128.has(a.sha256), `doublon de contenu it.128 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 744)", "(offset 744)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it128_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.128 (724/276) —
    # « it.128 », « offset 724 », « offset 276 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.127,
    # 704/268) et des identifiants/ids it.128.
    interdits = ["it.127", "IT128", "km128_", "offset 704", "offset 268"]
    residus = [x for x in interdits if x in t]
    if autoriser_it128_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it128.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it128.bin"', "")
        assert t_sans.count("it128") == 0, f"it128 hors SNAPSHOT_SOURCE : {t_sans.count('it128')}"
    else:
        residus += ["it128"] if "it128" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.127", "it128", "km128_", '"offset": 724', '"offset": 276', "offset 704", "offset 268"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it129 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 744', '"offset": 284', "km129_", "multimodal-it129", "offset 724", "après it.128"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it129", autoriser_it128_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it129/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it129.ts", sortie)',
        "fenêtre offset 744",
        "offset 284",
        "celle d'it.128 — offset 724",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it129", autoriser_it128_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it128.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it129.bin"',
        'from "../lib/neural/generation/multimodal-it129"',
        "ASSETS_MULTIMODAL_IT129",
        "PAIRES_MULTIMODAL_IT129",
        "offset 744",
        "offset 284",
        "après l'offset 724 d'it.128",
        "après offset 724 (it.128)",
        "état hérité d'it.128, avant gravure it.129",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128 légitime exactement 2× (import dédup + sha128)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT128") == 2, f"IT128 × {t4.count('IT128')} (attendu 2)"
    assert t4.count("it128") == 1, f"it128 × {t4.count('it128')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT128" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT128 } from "./multimodal-it128";' in ligne
    for attendu in [
        "km129_",
        "sha128",
        "it.123 (624/236), it.124 (644/244), it.125 (664/252), it.126 (684/260), it.127 (704/268), it.128 (724/276) et it.129 (744/284)",
        "COCO offset 744, FLEURS offset 284 — après it.128 : 724/276",
        "(offset 744)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km128_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT128 } from "./multimodal-it128";', "")]
    print(f"test-it129 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.128", "it.129")
    t5 = t5.replace("it128", "it129")
    interdits = ["it.128", "it128"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it129 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it129/assets.json", "fenêtre it.129"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

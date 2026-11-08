#!/usr/bin/env python3
"""Transforme les scripts it.127 en scripts it.128 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.127) :
  - identifiants PascalCase IT127 → IT128 (remplacement séparé de it127) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it127.bin) — restauration
    explicite après la cascade it127→it128 ;
  - fenêtre courante d'abord (704/268 → 724/276), PUIS référence historique
    (684/260 → 704/268) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.126, avant gravure it.128 »
    → « d'it.127, avant gravure it.128 » (la fenêtre précédente est it.127) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it127 + sha127 + titre) ;
  - km127_ → km128_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it127.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it128.py"
GENERE_IN = "scripts/genere-module-multimodal-it127.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it128.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it127.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it128.ts"
TEST_IN = "lib/neural/generation/multimodal-it127.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it128.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it127.py"
DEDUP_OUT = "scripts/verifie-dedup-it128.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 704", "offset 724")  # fenêtre courante images
    t = t.replace("offset 268", "offset 276")  # fenêtre courante audios
    t = t.replace("offset 684", "offset 704")  # référence fenêtre précédente
    t = t.replace("offset 260", "offset 268")
    # 2. global it.127 → it.128 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.127", "it.128")
    # 3. fenêtre précédente it.126 → it.127 (toutes les formes documentées)
    t = t.replace("d'it.126", "d'it.127")
    t = t.replace("(it.126)", "(it.127)")
    t = t.replace("cumulatif it.126", "cumulatif it.127")
    t = t.replace("après it.126", "après it.127")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT127", "IT128")
    t = t.replace("it127", "it128")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.127 était it126.bin ; pour it.128 elle devient it127.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it126.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it127.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 704', '"offset": 724')
    t = t.replace('"offset": 268', '"offset": 276')
    t = t.replace("offset 704", "offset 724")   # prose header
    t = t.replace("offset 268", "offset 276")
    t = t.replace('"offset": 684', '"offset": 704')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 684", "offset 704")   # prose header historique
    t = t.replace('"offset": 260', '"offset": 268')
    t = t.replace("offset 260", "offset 268")
    # 2. globals
    t = t.replace("it.127", "it.128")
    t = t.replace("it.126", "it.127")
    t = t.replace("it127", "it128")   # chemins + user-agent
    t = t.replace("km127_", "km128_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 704", "offset 724")
    t = t.replace("offset 268", "offset 276")
    t = t.replace("offset 684", "offset 704")
    t = t.replace("offset 260", "offset 268")
    # 2. globals
    t = t.replace("it.127", "it.128")
    t = t.replace("IT127", "IT128")
    t = t.replace("it127", "it128")
    t = t.replace("km127_", "km128_")
    # 3. titre du test de fenêtres : « après it.127 : 704/268 »
    t = t.replace(
        "après it.126 : 684/260",
        "après it.127 : 704/268",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.126 (684/260) et it.128 (704/268) » —
    #    on réinsère it.127 (704/268) et on ajoute la nouvelle fenêtre it.128
    #    (724/276) en fin de liste)
    t = t.replace(
        "it.126 (684/260) et it.128 (704/268)\", () => {",
        "it.126 (684/260), it.127 (704/268) et it.128 (724/276)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.127
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT128, PAIRES_MULTIMODAL_IT128 } from "./multimodal-it128";',
        'import { ASSETS_MULTIMODAL_IT127 } from "./multimodal-it127";\nimport { ASSETS_MULTIMODAL_IT128, PAIRES_MULTIMODAL_IT128 } from "./multimodal-it128";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha127)
    t = t.replace(
        "const sha126 = new Set(ASSETS_MULTIMODAL_IT126.map((a) => a.sha256));",
        "const sha126 = new Set(ASSETS_MULTIMODAL_IT126.map((a) => a.sha256));\n    const sha127 = new Set(ASSETS_MULTIMODAL_IT127.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha126.has(a.sha256), `doublon de contenu it.126 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha126.has(a.sha256), `doublon de contenu it.126 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha127.has(a.sha256), `doublon de contenu it.127 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 724)", "(offset 724)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it127_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.127 (704/268) —
    # « it.127 », « offset 704 », « offset 268 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.126,
    # 684/260) et des identifiants/ids it.127.
    interdits = ["it.126", "IT127", "km127_", "offset 684", "offset 260"]
    residus = [x for x in interdits if x in t]
    if autoriser_it127_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it127.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it127.bin"', "")
        assert t_sans.count("it127") == 0, f"it127 hors SNAPSHOT_SOURCE : {t_sans.count('it127')}"
    else:
        residus += ["it127"] if "it127" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.126", "it127", "km127_", '"offset": 704', '"offset": 268', "offset 684", "offset 260"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it128 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 724', '"offset": 276', "km128_", "multimodal-it128", "offset 704", "après it.127"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it128", autoriser_it127_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it128/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it128.ts", sortie)',
        "fenêtre offset 724",
        "offset 276",
        "celle d'it.127 — offset 704",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it128", autoriser_it127_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it127.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it128.bin"',
        'from "../lib/neural/generation/multimodal-it128"',
        "ASSETS_MULTIMODAL_IT128",
        "PAIRES_MULTIMODAL_IT128",
        "offset 724",
        "offset 276",
        "après l'offset 704 d'it.127",
        "après offset 704 (it.127)",
        "état hérité d'it.127, avant gravure it.128",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT127 légitime exactement 2× (import dédup + sha127)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT127") == 2, f"IT127 × {t4.count('IT127')} (attendu 2)"
    assert t4.count("it127") == 1, f"it127 × {t4.count('it127')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT127" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT127 } from "./multimodal-it127";' in ligne
    for attendu in [
        "km128_",
        "sha127",
        "it.122 (604/228), it.123 (624/236), it.124 (644/244), it.125 (664/252), it.126 (684/260), it.127 (704/268) et it.128 (724/276)",
        "COCO offset 724, FLEURS offset 276 — après it.127 : 704/268",
        "(offset 724)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km127_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT127 } from "./multimodal-it127";', "")]
    print(f"test-it128 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.127", "it.128")
    t5 = t5.replace("it127", "it128")
    interdits = ["it.127", "it127"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it128 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it128/assets.json", "fenêtre it.128"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

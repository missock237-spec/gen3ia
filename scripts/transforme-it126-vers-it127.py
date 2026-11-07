#!/usr/bin/env python3
"""Transforme les scripts it.126 en scripts it.127 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.126) :
  - identifiants PascalCase IT126 → IT127 (remplacement séparé de it126) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it126.bin) — restauration
    explicite après la cascade it126→it127 ;
  - fenêtre courante d'abord (684/260 → 704/268), PUIS référence historique
    (664/252 → 684/260) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.125, avant gravure it.127 »
    → « d'it.126, avant gravure it.127 » (la fenêtre précédente est it.126) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it126 + sha126 + titre) ;
  - km126_ → km127_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it126.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it127.py"
GENERE_IN = "scripts/genere-module-multimodal-it126.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it127.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it126.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it127.ts"
TEST_IN = "lib/neural/generation/multimodal-it126.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it127.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it126.py"
DEDUP_OUT = "scripts/verifie-dedup-it127.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 684", "offset 704")  # fenêtre courante images
    t = t.replace("offset 260", "offset 268")  # fenêtre courante audios
    t = t.replace("offset 664", "offset 684")  # référence fenêtre précédente
    t = t.replace("offset 252", "offset 260")
    # 2. global it.126 → it.127 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.126", "it.127")
    # 3. fenêtre précédente it.125 → it.126 (toutes les formes documentées)
    t = t.replace("d'it.125", "d'it.126")
    t = t.replace("(it.125)", "(it.126)")
    t = t.replace("cumulatif it.125", "cumulatif it.126")
    t = t.replace("après it.125", "après it.126")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT126", "IT127")
    t = t.replace("it126", "it127")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.126 était it125.bin ; pour it.127 elle devient it126.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it125.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it126.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 684', '"offset": 704')
    t = t.replace('"offset": 260', '"offset": 268')
    t = t.replace("offset 684", "offset 704")   # prose header
    t = t.replace("offset 260", "offset 268")
    t = t.replace('"offset": 664', '"offset": 684')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 664", "offset 684")   # prose header historique
    t = t.replace('"offset": 252', '"offset": 260')
    t = t.replace("offset 252", "offset 260")
    # 2. globals
    t = t.replace("it.126", "it.127")
    t = t.replace("it.125", "it.126")
    t = t.replace("it126", "it127")   # chemins + user-agent
    t = t.replace("km126_", "km127_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 684", "offset 704")
    t = t.replace("offset 260", "offset 268")
    t = t.replace("offset 664", "offset 684")
    t = t.replace("offset 252", "offset 260")
    # 2. globals
    t = t.replace("it.126", "it.127")
    t = t.replace("IT126", "IT127")
    t = t.replace("it126", "it127")
    t = t.replace("km126_", "km127_")
    # 3. titre du test de fenêtres : « après it.126 : 684/260 »
    t = t.replace(
        "après it.125 : 664/252",
        "après it.126 : 684/260",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.125 (664/252) et it.127 (684/260) » —
    #    on réinsère it.126 (684/260) et on ajoute la nouvelle fenêtre it.127
    #    (704/268) en fin de liste)
    t = t.replace(
        "it.125 (664/252) et it.127 (684/260)\", () => {",
        "it.125 (664/252), it.126 (684/260) et it.127 (704/268)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.126
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT127, PAIRES_MULTIMODAL_IT127 } from "./multimodal-it127";',
        'import { ASSETS_MULTIMODAL_IT126 } from "./multimodal-it126";\nimport { ASSETS_MULTIMODAL_IT127, PAIRES_MULTIMODAL_IT127 } from "./multimodal-it127";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha126)
    t = t.replace(
        "const sha125 = new Set(ASSETS_MULTIMODAL_IT125.map((a) => a.sha256));",
        "const sha125 = new Set(ASSETS_MULTIMODAL_IT125.map((a) => a.sha256));\n    const sha126 = new Set(ASSETS_MULTIMODAL_IT126.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha125.has(a.sha256), `doublon de contenu it.125 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha125.has(a.sha256), `doublon de contenu it.125 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha126.has(a.sha256), `doublon de contenu it.126 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 704)", "(offset 704)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it126_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.126 (684/260) —
    # « it.126 », « offset 684 », « offset 260 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.125,
    # 664/252) et des identifiants/ids it.126.
    interdits = ["it.125", "IT126", "km126_", "offset 664", "offset 252"]
    residus = [x for x in interdits if x in t]
    if autoriser_it126_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it126.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it126.bin"', "")
        assert t_sans.count("it126") == 0, f"it126 hors SNAPSHOT_SOURCE : {t_sans.count('it126')}"
    else:
        residus += ["it126"] if "it126" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.125", "it126", "km126_", '"offset": 684', '"offset": 260', "offset 664", "offset 252"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it127 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 704', '"offset": 268', "km127_", "multimodal-it127", "offset 684", "après it.126"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it127", autoriser_it126_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it127/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it127.ts", sortie)',
        "fenêtre offset 704",
        "offset 268",
        "celle d'it.126 — offset 684",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it127", autoriser_it126_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it126.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it127.bin"',
        'from "../lib/neural/generation/multimodal-it127"',
        "ASSETS_MULTIMODAL_IT127",
        "PAIRES_MULTIMODAL_IT127",
        "offset 704",
        "offset 268",
        "après l'offset 684 d'it.126",
        "après offset 684 (it.126)",
        "état hérité d'it.126, avant gravure it.127",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT126 légitime exactement 2× (import dédup + sha126)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT126") == 2, f"IT126 × {t4.count('IT126')} (attendu 2)"
    assert t4.count("it126") == 1, f"it126 × {t4.count('it126')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT126" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT126 } from "./multimodal-it126";' in ligne
    for attendu in [
        "km127_",
        "sha126",
        "it.121 (584/220), it.122 (604/228), it.123 (624/236), it.124 (644/244), it.125 (664/252), it.126 (684/260) et it.127 (704/268)",
        "COCO offset 704, FLEURS offset 268 — après it.126 : 684/260",
        "(offset 704)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km126_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT126 } from "./multimodal-it126";', "")]
    print(f"test-it127 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.126", "it.127")
    t5 = t5.replace("it126", "it127")
    interdits = ["it.126", "it126"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it127 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it127/assets.json", "fenêtre it.127"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Transforme les scripts it.124 en scripts it.125 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.124) :
  - identifiants PascalCase IT124 → IT125 (remplacement séparé de it124) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it124.bin) — restauration
    explicite après la cascade it124→it125 ;
  - fenêtre courante d'abord (644/244 → 664/252), PUIS référence historique
    (624/236 → 644/244) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.123, avant gravure it.125 »
    → « d'it.124, avant gravure it.125 » (la fenêtre précédente est it.124) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it124 + sha124 + titre) ;
  - km124_ → km125_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it124.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it125.py"
GENERE_IN = "scripts/genere-module-multimodal-it124.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it125.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it124.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it125.ts"
TEST_IN = "lib/neural/generation/multimodal-it124.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it125.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it124.py"
DEDUP_OUT = "scripts/verifie-dedup-it125.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 644", "offset 664")  # fenêtre courante images
    t = t.replace("offset 244", "offset 252")  # fenêtre courante audios
    t = t.replace("offset 624", "offset 644")  # référence fenêtre précédente
    t = t.replace("offset 236", "offset 244")
    # 2. global it.124 → it.125 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.124", "it.125")
    # 3. fenêtre précédente it.123 → it.124 (toutes les formes documentées)
    t = t.replace("d'it.123", "d'it.124")
    t = t.replace("(it.123)", "(it.124)")
    t = t.replace("cumulatif it.123", "cumulatif it.124")
    t = t.replace("après it.123", "après it.124")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT124", "IT125")
    t = t.replace("it124", "it125")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.124 était it123.bin ; pour it.125 elle devient it124.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it123.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it124.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 644', '"offset": 664')
    t = t.replace('"offset": 244', '"offset": 252')
    t = t.replace("offset 644", "offset 664")   # prose header
    t = t.replace("offset 244", "offset 252")
    t = t.replace('"offset": 624', '"offset": 644')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 624", "offset 644")   # prose header historique
    t = t.replace('"offset": 236', '"offset": 244')
    t = t.replace("offset 236", "offset 244")
    # 2. globals
    t = t.replace("it.124", "it.125")
    t = t.replace("it.123", "it.124")
    t = t.replace("it124", "it125")   # chemins + user-agent
    t = t.replace("km124_", "km125_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 644", "offset 664")
    t = t.replace("offset 244", "offset 252")
    t = t.replace("offset 624", "offset 644")
    t = t.replace("offset 236", "offset 244")
    # 2. globals
    t = t.replace("it.124", "it.125")
    t = t.replace("IT124", "IT125")
    t = t.replace("it124", "it125")
    t = t.replace("km124_", "km125_")
    # 3. titre du test de fenêtres : « après it.124 : 644/244 »
    t = t.replace(
        "après it.123 : 624/236",
        "après it.124 : 644/244",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.123 (624/236) et it.125 (644/244) » —
    #    on réinsère it.124 (644/244) et on ajoute la nouvelle fenêtre it.125
    #    (664/252) en fin de liste)
    t = t.replace(
        "it.123 (624/236) et it.125 (644/244)\", () => {",
        "it.123 (624/236), it.124 (644/244) et it.125 (664/252)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.124
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT125, PAIRES_MULTIMODAL_IT125 } from "./multimodal-it125";',
        'import { ASSETS_MULTIMODAL_IT124 } from "./multimodal-it124";\nimport { ASSETS_MULTIMODAL_IT125, PAIRES_MULTIMODAL_IT125 } from "./multimodal-it125";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha124)
    t = t.replace(
        "const sha123 = new Set(ASSETS_MULTIMODAL_IT123.map((a) => a.sha256));",
        "const sha123 = new Set(ASSETS_MULTIMODAL_IT123.map((a) => a.sha256));\n    const sha124 = new Set(ASSETS_MULTIMODAL_IT124.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha123.has(a.sha256), `doublon de contenu it.123 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha123.has(a.sha256), `doublon de contenu it.123 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha124.has(a.sha256), `doublon de contenu it.124 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 664)", "(offset 664)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it124_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.124 (644/244) —
    # « it.124 », « offset 644 », « offset 244 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.123,
    # 624/236) et des identifiants/ids it.124.
    interdits = ["it.123", "IT124", "km124_", "offset 624", "offset 236"]
    residus = [x for x in interdits if x in t]
    if autoriser_it124_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it124.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it124.bin"', "")
        assert t_sans.count("it124") == 0, f"it124 hors SNAPSHOT_SOURCE : {t_sans.count('it124')}"
    else:
        residus += ["it124"] if "it124" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.123", "it124", "km124_", '"offset": 644', '"offset": 244', "offset 624", "offset 236"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it125 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 664', '"offset": 252', "km125_", "multimodal-it125", "offset 644", "après it.124"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it125", autoriser_it124_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it125/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it125.ts", sortie)',
        "fenêtre offset 664",
        "offset 252",
        "celle d'it.124 — offset 644",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it125", autoriser_it124_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it124.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it125.bin"',
        'from "../lib/neural/generation/multimodal-it125"',
        "ASSETS_MULTIMODAL_IT125",
        "PAIRES_MULTIMODAL_IT125",
        "offset 664",
        "offset 252",
        "après l'offset 644 d'it.124",
        "après offset 644 (it.124)",
        "état hérité d'it.124, avant gravure it.125",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT124 légitime exactement 2× (import dédup + sha124)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT124") == 2, f"IT124 × {t4.count('IT124')} (attendu 2)"
    assert t4.count("it124") == 1, f"it124 × {t4.count('it124')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT124" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT124 } from "./multimodal-it124";' in ligne
    for attendu in [
        "km125_",
        "sha124",
        "it.121 (584/220), it.122 (604/228), it.123 (624/236), it.124 (644/244) et it.125 (664/252)",
        "COCO offset 664, FLEURS offset 252 — après it.124 : 644/244",
        "(offset 664)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km124_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT124 } from "./multimodal-it124";', "")]
    print(f"test-it125 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.124", "it.125")
    t5 = t5.replace("it124", "it125")
    interdits = ["it.124", "it124"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it125 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it125/assets.json", "fenêtre it.125"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

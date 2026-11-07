#!/usr/bin/env python3
"""Transforme les scripts it.122 en scripts it.123 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.122) :
  - identifiants PascalCase IT122 → IT123 (remplacement séparé de it122) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it122.bin) — restauration
    explicite après la cascade it122→it123 ;
  - fenêtre courante d'abord (604/228 → 624/236), PUIS référence historique
    (584/220 → 604/228) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.121, avant gravure it.123 »
    → « d'it.122, avant gravure it.123 » (la fenêtre précédente est it.122) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it122 + sha122 + titre) ;
  - km122_ → km123_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it122.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it123.py"
GENERE_IN = "scripts/genere-module-multimodal-it122.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it123.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it122.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it123.ts"
TEST_IN = "lib/neural/generation/multimodal-it122.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it123.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it122.py"
DEDUP_OUT = "scripts/verifie-dedup-it123.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 604", "offset 624")  # fenêtre courante images
    t = t.replace("offset 228", "offset 236")  # fenêtre courante audios
    t = t.replace("offset 584", "offset 604")  # référence fenêtre précédente
    t = t.replace("offset 220", "offset 228")
    # 2. global it.122 → it.123 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.122", "it.123")
    # 3. fenêtre précédente it.121 → it.122 (toutes les formes documentées)
    t = t.replace("d'it.121", "d'it.122")
    t = t.replace("(it.121)", "(it.122)")
    t = t.replace("cumulatif it.121", "cumulatif it.122")
    t = t.replace("après it.121", "après it.122")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT122", "IT123")
    t = t.replace("it122", "it123")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.122 était it121.bin ; pour it.123 elle devient it122.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it121.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it122.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 604', '"offset": 624')
    t = t.replace('"offset": 228', '"offset": 236')
    t = t.replace("offset 604", "offset 624")   # prose header
    t = t.replace("offset 228", "offset 236")
    t = t.replace('"offset": 584', '"offset": 604')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 584", "offset 604")   # prose header historique
    t = t.replace('"offset": 220', '"offset": 228')
    t = t.replace("offset 220", "offset 228")
    # 2. globals
    t = t.replace("it.122", "it.123")
    t = t.replace("it.121", "it.122")
    t = t.replace("it122", "it123")   # chemins + user-agent
    t = t.replace("km122_", "km123_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 604", "offset 624")
    t = t.replace("offset 228", "offset 236")
    t = t.replace("offset 584", "offset 604")
    t = t.replace("offset 220", "offset 228")
    # 2. globals
    t = t.replace("it.122", "it.123")
    t = t.replace("IT122", "IT123")
    t = t.replace("it122", "it123")
    t = t.replace("km122_", "km123_")
    # 3. titre du test de fenêtres : « après it.122 : 604/228 »
    t = t.replace(
        "après it.121 : 584/220",
        "après it.122 : 604/228",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.121 (584/220) et it.123 (604/228) » —
    #    on réinsère it.122 (604/228) et on ajoute la nouvelle fenêtre it.123
    #    (624/236) en fin de liste)
    t = t.replace(
        "it.121 (584/220) et it.123 (604/228)\", () => {",
        "it.121 (584/220), it.122 (604/228) et it.123 (624/236)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.122
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT123, PAIRES_MULTIMODAL_IT123 } from "./multimodal-it123";',
        'import { ASSETS_MULTIMODAL_IT122 } from "./multimodal-it122";\nimport { ASSETS_MULTIMODAL_IT123, PAIRES_MULTIMODAL_IT123 } from "./multimodal-it123";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha122)
    t = t.replace(
        "const sha121 = new Set(ASSETS_MULTIMODAL_IT121.map((a) => a.sha256));",
        "const sha121 = new Set(ASSETS_MULTIMODAL_IT121.map((a) => a.sha256));\n    const sha122 = new Set(ASSETS_MULTIMODAL_IT122.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha121.has(a.sha256), `doublon de contenu it.121 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha121.has(a.sha256), `doublon de contenu it.121 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha122.has(a.sha256), `doublon de contenu it.122 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 624)", "(offset 624)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it122_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.122 (604/228) —
    # « it.122 », « offset 604 », « offset 228 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.121,
    # 584/220) et des identifiants/ids it.122.
    interdits = ["it.121", "IT122", "km122_", "offset 584", "offset 220"]
    residus = [x for x in interdits if x in t]
    if autoriser_it122_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it122.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it122.bin"', "")
        assert t_sans.count("it122") == 0, f"it122 hors SNAPSHOT_SOURCE : {t_sans.count('it122')}"
    else:
        residus += ["it122"] if "it122" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.121", "it122", "km122_", '"offset": 604', '"offset": 228', "offset 584", "offset 220"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it123 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 624', '"offset": 236', "km123_", "multimodal-it123", "offset 604", "après it.122"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it123", autoriser_it122_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it123/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it123.ts", sortie)',
        "fenêtre offset 624",
        "offset 236",
        "celle d'it.122 — offset 604",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it123", autoriser_it122_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it122.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it123.bin"',
        'from "../lib/neural/generation/multimodal-it123"',
        "ASSETS_MULTIMODAL_IT123",
        "PAIRES_MULTIMODAL_IT123",
        "offset 624",
        "offset 236",
        "après l'offset 604 d'it.122",
        "après offset 604 (it.122)",
        "état hérité d'it.122, avant gravure it.123",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT122 légitime exactement 2× (import dédup + sha122)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT122") == 2, f"IT122 × {t4.count('IT122')} (attendu 2)"
    assert t4.count("it122") == 1, f"it122 × {t4.count('it122')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT122" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT122 } from "./multimodal-it122";' in ligne
    for attendu in [
        "km123_",
        "sha122",
        "it.121 (584/220), it.122 (604/228) et it.123 (624/236)",
        "COCO offset 624, FLEURS offset 236 — après it.122 : 604/228",
        "(offset 624)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km122_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT122 } from "./multimodal-it122";', "")]
    print(f"test-it123 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.122", "it.123")
    t5 = t5.replace("it122", "it123")
    interdits = ["it.122", "it122"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it123 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it123/assets.json", "fenêtre it.123"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Transforme les scripts it.123 en scripts it.124 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.123) :
  - identifiants PascalCase IT123 → IT124 (remplacement séparé de it123) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it123.bin) — restauration
    explicite après la cascade it123→it124 ;
  - fenêtre courante d'abord (624/236 → 644/244), PUIS référence historique
    (604/228 → 624/236) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.122, avant gravure it.124 »
    → « d'it.123, avant gravure it.124 » (la fenêtre précédente est it.123) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it123 + sha123 + titre) ;
  - km123_ → km124_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it123.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it124.py"
GENERE_IN = "scripts/genere-module-multimodal-it123.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it124.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it123.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it124.ts"
TEST_IN = "lib/neural/generation/multimodal-it123.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it124.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it123.py"
DEDUP_OUT = "scripts/verifie-dedup-it124.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 624", "offset 644")  # fenêtre courante images
    t = t.replace("offset 236", "offset 244")  # fenêtre courante audios
    t = t.replace("offset 604", "offset 624")  # référence fenêtre précédente
    t = t.replace("offset 228", "offset 236")
    # 2. global it.123 → it.124 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.123", "it.124")
    # 3. fenêtre précédente it.122 → it.123 (toutes les formes documentées)
    t = t.replace("d'it.122", "d'it.123")
    t = t.replace("(it.122)", "(it.123)")
    t = t.replace("cumulatif it.122", "cumulatif it.123")
    t = t.replace("après it.122", "après it.123")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT123", "IT124")
    t = t.replace("it123", "it124")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.123 était it122.bin ; pour it.124 elle devient it123.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it122.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it123.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 624', '"offset": 644')
    t = t.replace('"offset": 236', '"offset": 244')
    t = t.replace("offset 624", "offset 644")   # prose header
    t = t.replace("offset 236", "offset 244")
    t = t.replace('"offset": 604', '"offset": 624')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 604", "offset 624")   # prose header historique
    t = t.replace('"offset": 228', '"offset": 236')
    t = t.replace("offset 228", "offset 236")
    # 2. globals
    t = t.replace("it.123", "it.124")
    t = t.replace("it.122", "it.123")
    t = t.replace("it123", "it124")   # chemins + user-agent
    t = t.replace("km123_", "km124_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 624", "offset 644")
    t = t.replace("offset 236", "offset 244")
    t = t.replace("offset 604", "offset 624")
    t = t.replace("offset 228", "offset 236")
    # 2. globals
    t = t.replace("it.123", "it.124")
    t = t.replace("IT123", "IT124")
    t = t.replace("it123", "it124")
    t = t.replace("km123_", "km124_")
    # 3. titre du test de fenêtres : « après it.123 : 624/236 »
    t = t.replace(
        "après it.122 : 604/228",
        "après it.123 : 624/236",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.122 (604/228) et it.124 (624/236) » —
    #    on réinsère it.123 (624/236) et on ajoute la nouvelle fenêtre it.124
    #    (644/244) en fin de liste)
    t = t.replace(
        "it.122 (604/228) et it.124 (624/236)\", () => {",
        "it.122 (604/228), it.123 (624/236) et it.124 (644/244)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.123
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT124, PAIRES_MULTIMODAL_IT124 } from "./multimodal-it124";',
        'import { ASSETS_MULTIMODAL_IT123 } from "./multimodal-it123";\nimport { ASSETS_MULTIMODAL_IT124, PAIRES_MULTIMODAL_IT124 } from "./multimodal-it124";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha123)
    t = t.replace(
        "const sha122 = new Set(ASSETS_MULTIMODAL_IT122.map((a) => a.sha256));",
        "const sha122 = new Set(ASSETS_MULTIMODAL_IT122.map((a) => a.sha256));\n    const sha123 = new Set(ASSETS_MULTIMODAL_IT123.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha122.has(a.sha256), `doublon de contenu it.122 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha122.has(a.sha256), `doublon de contenu it.122 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha123.has(a.sha256), `doublon de contenu it.123 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 644)", "(offset 644)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it123_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.123 (624/236) —
    # « it.123 », « offset 624 », « offset 236 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.122,
    # 604/228) et des identifiants/ids it.123.
    interdits = ["it.122", "IT123", "km123_", "offset 604", "offset 228"]
    residus = [x for x in interdits if x in t]
    if autoriser_it123_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it123.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it123.bin"', "")
        assert t_sans.count("it123") == 0, f"it123 hors SNAPSHOT_SOURCE : {t_sans.count('it123')}"
    else:
        residus += ["it123"] if "it123" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.122", "it123", "km123_", '"offset": 624', '"offset": 236', "offset 604", "offset 228"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it124 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 644', '"offset": 244', "km124_", "multimodal-it124", "offset 624", "après it.123"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it124", autoriser_it123_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it124/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it124.ts", sortie)',
        "fenêtre offset 644",
        "offset 244",
        "celle d'it.123 — offset 624",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it124", autoriser_it123_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it123.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it124.bin"',
        'from "../lib/neural/generation/multimodal-it124"',
        "ASSETS_MULTIMODAL_IT124",
        "PAIRES_MULTIMODAL_IT124",
        "offset 644",
        "offset 244",
        "après l'offset 624 d'it.123",
        "après offset 624 (it.123)",
        "état hérité d'it.123, avant gravure it.124",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT123 légitime exactement 2× (import dédup + sha123)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT123") == 2, f"IT123 × {t4.count('IT123')} (attendu 2)"
    assert t4.count("it123") == 1, f"it123 × {t4.count('it123')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT123" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT123 } from "./multimodal-it123";' in ligne
    for attendu in [
        "km124_",
        "sha123",
        "it.121 (584/220), it.122 (604/228), it.123 (624/236) et it.124 (644/244)",
        "COCO offset 644, FLEURS offset 244 — après it.123 : 624/236",
        "(offset 644)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km123_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT123 } from "./multimodal-it123";', "")]
    print(f"test-it124 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.123", "it.124")
    t5 = t5.replace("it123", "it124")
    interdits = ["it.123", "it123"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it124 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it124/assets.json", "fenêtre it.124"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

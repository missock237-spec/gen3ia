#!/usr/bin/env python3
"""Transforme les scripts it.120 en scripts it.121 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.120) :
  - identifiants PascalCase IT120 → IT121 (remplacement séparé de it120) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it120.bin) — restauration
    explicite après la cascade it120→it121 ;
  - fenêtre courante d'abord (564/212 → 584/220), PUIS référence historique
    (544/204 → 564/212) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.119, avant gravure it.121 »
    → « d'it.120, avant gravure it.121 » (la fenêtre précédente est it.120) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it120 + sha120 + titre) ;
  - km120_ → km121_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it120.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it121.py"
GENERE_IN = "scripts/genere-module-multimodal-it120.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it121.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it120.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it121.ts"
TEST_IN = "lib/neural/generation/multimodal-it120.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it121.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it120.py"
DEDUP_OUT = "scripts/verifie-dedup-it121.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 564", "offset 584")  # fenêtre courante images
    t = t.replace("offset 212", "offset 220")  # fenêtre courante audios
    t = t.replace("offset 544", "offset 564")  # référence fenêtre précédente
    t = t.replace("offset 204", "offset 212")
    # 2. global it.120 → it.121 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.120", "it.121")
    # 3. fenêtre précédente it.119 → it.120 (toutes les formes documentées)
    t = t.replace("d'it.119", "d'it.120")
    t = t.replace("(it.119)", "(it.120)")
    t = t.replace("cumulatif it.119", "cumulatif it.120")
    t = t.replace("après it.119", "après it.120")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT120", "IT121")
    t = t.replace("it120", "it121")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.120 était it119.bin ; pour it.121 elle devient it120.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it119.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it120.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 564', '"offset": 584')
    t = t.replace('"offset": 212', '"offset": 220')
    t = t.replace("offset 564", "offset 584")   # prose header
    t = t.replace("offset 212", "offset 220")
    t = t.replace('"offset": 544', '"offset": 564')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 544", "offset 564")   # prose header historique
    t = t.replace('"offset": 204', '"offset": 212')
    t = t.replace("offset 204", "offset 212")
    # 2. globals
    t = t.replace("it.120", "it.121")
    t = t.replace("it.119", "it.120")
    t = t.replace("it120", "it121")   # chemins + user-agent
    t = t.replace("km120_", "km121_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 564", "offset 584")
    t = t.replace("offset 212", "offset 220")
    t = t.replace("offset 544", "offset 564")
    t = t.replace("offset 204", "offset 212")
    # 2. globals
    t = t.replace("it.120", "it.121")
    t = t.replace("IT120", "IT121")
    t = t.replace("it120", "it121")
    t = t.replace("km120_", "km121_")
    # 3. titre du test de fenêtres : « après it.120 : 564/212 »
    t = t.replace(
        "après it.119 : 544/204",
        "après it.120 : 564/212",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.119 (544/204) et it.121 (564/212) » —
    #    on réinsère it.120 (564/212) et on ajoute la nouvelle fenêtre it.121
    #    (584/220) en fin de liste)
    t = t.replace(
        "it.119 (544/204) et it.121 (564/212)\", () => {",
        "it.119 (544/204), it.120 (564/212) et it.121 (584/220)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.120
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT121, PAIRES_MULTIMODAL_IT121 } from "./multimodal-it121";',
        'import { ASSETS_MULTIMODAL_IT120 } from "./multimodal-it120";\nimport { ASSETS_MULTIMODAL_IT121, PAIRES_MULTIMODAL_IT121 } from "./multimodal-it121";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha120)
    t = t.replace(
        "const sha119 = new Set(ASSETS_MULTIMODAL_IT119.map((a) => a.sha256));",
        "const sha119 = new Set(ASSETS_MULTIMODAL_IT119.map((a) => a.sha256));\n    const sha120 = new Set(ASSETS_MULTIMODAL_IT120.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha119.has(a.sha256), `doublon de contenu it.119 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha119.has(a.sha256), `doublon de contenu it.119 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha120.has(a.sha256), `doublon de contenu it.120 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 584)", "(offset 584)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it120_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.120 (564/212) —
    # « it.120 », « offset 564 », « offset 212 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.119,
    # 544/204) et des identifiants/ids it.120.
    interdits = ["it.119", "IT120", "km120_", "offset 544", "offset 204"]
    residus = [x for x in interdits if x in t]
    if autoriser_it120_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it120.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it120.bin"', "")
        assert t_sans.count("it120") == 0, f"it120 hors SNAPSHOT_SOURCE : {t_sans.count('it120')}"
    else:
        residus += ["it120"] if "it120" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.119", "it120", "km120_", '"offset": 564', '"offset": 212', "offset 544", "offset 204"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it121 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 584', '"offset": 220', "km121_", "multimodal-it121", "offset 564", "après it.120"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it121", autoriser_it120_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it121/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it121.ts", sortie)',
        "fenêtre offset 584",
        "offset 220",
        "celle d'it.120 — offset 564",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it121", autoriser_it120_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it120.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it121.bin"',
        'from "../lib/neural/generation/multimodal-it121"',
        "ASSETS_MULTIMODAL_IT121",
        "PAIRES_MULTIMODAL_IT121",
        "offset 584",
        "offset 220",
        "après l'offset 564 d'it.120",
        "après offset 564 (it.120)",
        "état hérité d'it.120, avant gravure it.121",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT120 légitime exactement 2× (import dédup + sha120)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT120") == 2, f"IT120 × {t4.count('IT120')} (attendu 2)"
    assert t4.count("it120") == 1, f"it120 × {t4.count('it120')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT120" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT120 } from "./multimodal-it120";' in ligne
    for attendu in [
        "km121_",
        "sha120",
        "it.119 (544/204), it.120 (564/212) et it.121 (584/220)",
        "COCO offset 584, FLEURS offset 220 — après it.120 : 564/212",
        "(offset 584)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km120_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT120 } from "./multimodal-it120";', "")]
    print(f"test-it121 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.120", "it.121")
    t5 = t5.replace("it120", "it121")
    interdits = ["it.120", "it120"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it121 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it121/assets.json", "fenêtre it.121"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

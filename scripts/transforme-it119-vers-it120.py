#!/usr/bin/env python3
"""Transforme les scripts it.119 en scripts it.120 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.119) :
  - identifiants PascalCase IT119 → IT120 (remplacement séparé de it119) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it119.bin) — restauration
    explicite après la cascade it119→it120 ;
  - fenêtre courante d'abord (544/204 → 564/212), PUIS référence historique
    (524/196 → 544/204) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.118, avant gravure it.120 »
    → « d'it.119, avant gravure it.120 » (la fenêtre précédente est it.119) ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it119 + sha119 + titre) ;
  - km119_ → km120_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it119.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it120.py"
GENERE_IN = "scripts/genere-module-multimodal-it119.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it120.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it119.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it120.ts"
TEST_IN = "lib/neural/generation/multimodal-it119.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it120.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it119.py"
DEDUP_OUT = "scripts/verifie-dedup-it120.py"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 544", "offset 564")  # fenêtre courante images
    t = t.replace("offset 204", "offset 212")  # fenêtre courante audios
    t = t.replace("offset 524", "offset 544")  # référence fenêtre précédente
    t = t.replace("offset 196", "offset 204")
    # 2. global it.119 → it.120 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.119", "it.120")
    # 3. fenêtre précédente it.118 → it.119 (toutes les formes documentées)
    t = t.replace("d'it.118", "d'it.119")
    t = t.replace("(it.118)", "(it.119)")
    t = t.replace("cumulatif it.118", "cumulatif it.119")
    t = t.replace("après it.118", "après it.119")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT119", "IT120")
    t = t.replace("it119", "it120")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.119 était it118.bin ; pour it.120 elle devient it119.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it118.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it119.bin"',
    )
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 544', '"offset": 564')
    t = t.replace('"offset": 204', '"offset": 212')
    t = t.replace("offset 544", "offset 564")   # prose header
    t = t.replace("offset 204", "offset 212")
    t = t.replace('"offset": 524', '"offset": 544')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 524", "offset 544")   # prose header historique
    t = t.replace('"offset": 196', '"offset": 204')
    t = t.replace("offset 196", "offset 204")
    # 2. globals
    t = t.replace("it.119", "it.120")
    t = t.replace("it.118", "it.119")
    t = t.replace("it119", "it120")   # chemins + user-agent
    t = t.replace("km119_", "km120_")  # ids de paires
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. offsets — courant d'abord, puis historique (prose du header/titres)
    t = t.replace("offset 544", "offset 564")
    t = t.replace("offset 204", "offset 212")
    t = t.replace("offset 524", "offset 544")
    t = t.replace("offset 196", "offset 204")
    # 2. globals
    t = t.replace("it.119", "it.120")
    t = t.replace("IT119", "IT120")
    t = t.replace("it119", "it120")
    t = t.replace("km119_", "km120_")
    # 3. titre du test de fenêtres : « après it.119 : 544/204 »
    t = t.replace(
        "après it.118 : 524/196",
        "après it.119 : 544/204",
    )
    # 4. titre du test de déduplication : liste allongée
    #    (les génériques ont laissé « it.118 (524/196) et it.120 (544/204) » —
    #    on réinsère it.119 (544/204) et on ajoute la nouvelle fenêtre it.120
    #    (564/212) en fin de liste)
    t = t.replace(
        "it.118 (524/196) et it.120 (544/204)\", () => {",
        "it.118 (524/196), it.119 (544/204) et it.120 (564/212)\", () => {",
    )
    # 5. ré-import dédié pour la déduplication contre it.119
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT120, PAIRES_MULTIMODAL_IT120 } from "./multimodal-it120";',
        'import { ASSETS_MULTIMODAL_IT119 } from "./multimodal-it119";\nimport { ASSETS_MULTIMODAL_IT120, PAIRES_MULTIMODAL_IT120 } from "./multimodal-it120";',
    )
    # 6. ensembles et attentes de déduplication (ajout sha119)
    t = t.replace(
        "const sha118 = new Set(ASSETS_MULTIMODAL_IT118.map((a) => a.sha256));",
        "const sha118 = new Set(ASSETS_MULTIMODAL_IT118.map((a) => a.sha256));\n    const sha119 = new Set(ASSETS_MULTIMODAL_IT119.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha118.has(a.sha256), `doublon de contenu it.118 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha118.has(a.sha256), `doublon de contenu it.118 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha119.has(a.sha256), `doublon de contenu it.119 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 564)", "(offset 564)")  # déjà courant (no-op explicite)
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it119_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.119 (544/204) —
    # « it.119 », « offset 544 », « offset 204 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.118,
    # 524/196) et des identifiants/ids it.119.
    interdits = ["it.118", "IT119", "km119_", "offset 524", "offset 196"]
    residus = [x for x in interdits if x in t]
    if autoriser_it119_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it119.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it119.bin"', "")
        assert t_sans.count("it119") == 0, f"it119 hors SNAPSHOT_SOURCE : {t_sans.count('it119')}"
    else:
        residus += ["it119"] if "it119" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.118", "it119", "km119_", '"offset": 544', '"offset": 204', "offset 524", "offset 196"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it120 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 564', '"offset": 212', "km120_", "multimodal-it120", "offset 544", "après it.119"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it120", autoriser_it119_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it120/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it120.ts", sortie)',
        "fenêtre offset 564",
        "offset 212",
        "celle d'it.119 — offset 544",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it120", autoriser_it119_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it119.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it120.bin"',
        'from "../lib/neural/generation/multimodal-it120"',
        "ASSETS_MULTIMODAL_IT120",
        "PAIRES_MULTIMODAL_IT120",
        "offset 564",
        "offset 212",
        "après l'offset 544 d'it.119",
        "après offset 544 (it.119)",
        "état hérité d'it.119, avant gravure it.120",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT119 légitime exactement 2× (import dédup + sha119)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT119") == 2, f"IT119 × {t4.count('IT119')} (attendu 2)"
    assert t4.count("it119") == 1, f"it119 × {t4.count('it119')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT119" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT119 } from "./multimodal-it119";' in ligne
    for attendu in [
        "km120_",
        "sha119",
        "it.118 (524/196), it.119 (544/204) et it.120 (564/212)",
        "COCO offset 564, FLEURS offset 212 — après it.119 : 544/204",
        "(offset 564)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km119_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT119 } from "./multimodal-it119";', "")]
    print(f"test-it120 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.119", "it.120")
    t5 = t5.replace("it119", "it120")
    interdits = ["it.119", "it119"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it120 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it120/assets.json", "fenêtre it.120"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Transforme les scripts it.112 en scripts it.113 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.112) :
  - identifiants PascalCase IT112 → IT113 (remplacement séparé de it112) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it112.bin) — restauration
    explicite après la cascade it112→it113 ;
  - fenêtre courante d'abord (424/156 → 444/164), PUIS référence historique
    (404/148 → 424/156) — l'ordre inverse corromprait les références ;
  - phrase « état hérité / gravure » APRÈS la globale it.112→it.113 (forme
    post-globale : « d'it.111, avant gravure it.113 ») ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout sha112 + import it.112) ;
  - km112_ → km113_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it112.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it113.py"
GENERE_IN = "scripts/genere-module-multimodal-it112.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it113.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it112.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it113.ts"
TEST_IN = "lib/neural/generation/multimodal-it112.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it113.test.ts"


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 1. global it.112 → it.113 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.112", "it.113")
    # 2. phrase double (état hérité / gravure) — APRÈS la globale, la partie
    #    « gravure it.112 » est devenue « gravure it.113 » ; on rétablit la
    #    source héritée en it.112 (la fenêtre précédente est désormais it.112).
    t = t.replace(
        "état hérité d'it.111, avant gravure it.113",
        "état hérité d'it.112, avant gravure it.113",
    )
    # 3. références fenêtre précédente (it.111 → it.112)
    t = t.replace("d'it.111", "d'it.112")
    t = t.replace("(it.111)", "(it.112)")
    t = t.replace("cumulatif it.111", "cumulatif it.112")
    # 4. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT112", "IT113")
    t = t.replace("it112", "it113")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (cascade : it111 → it112 ; la sortie devient it113)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it111.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it112.bin"',
    )
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it113.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it112.bin"',
    )
    # 5. offsets — fenêtre courante d'abord, puis référence historique
    t = t.replace("offset 424", "offset 444")  # fenêtre courante images
    t = t.replace("offset 404", "offset 424")  # référence fenêtre précédente
    t = t.replace("offset 156", "offset 164")  # fenêtre courante audios
    t = t.replace("offset 148", "offset 156")
    return t


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 1. globals
    t = t.replace("it.112", "it.113")
    t = t.replace("it.111", "it.112")
    t = t.replace("it112", "it113")   # chemins + user-agent
    t = t.replace("km112_", "km113_")  # ids de paires
    # 2. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 424', '"offset": 444')
    t = t.replace('"offset": 156', '"offset": 164')
    t = t.replace("offset 424", "offset 444")   # prose header
    t = t.replace("offset 156", "offset 164")
    t = t.replace('"offset": 404', '"offset": 424')  # UCF101 inchangé (offset 4)
    t = t.replace("offset 404", "offset 424")   # prose header historique
    t = t.replace('"offset": 148', '"offset": 156')
    t = t.replace("offset 148", "offset 156")
    return t


def transformer_test(src: str) -> str:
    t = src
    # 1. globals
    t = t.replace("it.112", "it.113")
    t = t.replace("IT112", "IT113")
    t = t.replace("it112", "it113")
    t = t.replace("km112_", "km113_")
    # 2. ré-import dédié pour la déduplication contre it.112
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT113, PAIRES_MULTIMODAL_IT113 } from "./multimodal-it113";',
        'import { ASSETS_MULTIMODAL_IT112 } from "./multimodal-it112";\nimport { ASSETS_MULTIMODAL_IT113, PAIRES_MULTIMODAL_IT113 } from "./multimodal-it113";',
    )
    # 3. titre du test de déduplication : liste allongée
    #    (la globale a rendu « it.113 (424/156) » — on rétablit it.112 et
    #    l'on ajoute la nouvelle fenêtre 444/164)
    t = t.replace(
        "it.111 (404/148) et it.113 (424/156)",
        "it.111 (404/148), it.112 (424/156) et it.113 (444/164)",
    )
    # 4. titre du test de fenêtres
    t = t.replace(
        "COCO offset 424, FLEURS offset 156 — après it.111 : 404/148",
        "COCO offset 444, FLEURS offset 164 — après it.112 : 424/156",
    )
    # 5. offsets du header
    t = t.replace("offset 424 +", "offset 444 +")
    t = t.replace("FLEURS offset 156)", "FLEURS offset 164)")
    # 6. ensembles et attentes de déduplication (ajout sha112)
    t = t.replace(
        "const sha111 = new Set(ASSETS_MULTIMODAL_IT111.map((a) => a.sha256));",
        "const sha111 = new Set(ASSETS_MULTIMODAL_IT111.map((a) => a.sha256));\n    const sha112 = new Set(ASSETS_MULTIMODAL_IT112.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha111.has(a.sha256), `doublon de contenu it.111 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha111.has(a.sha256), `doublon de contenu it.111 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha112.has(a.sha256), `doublon de contenu it.112 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    # 7. commentaire du dernier test
    t = t.replace("(offset 424)", "(offset 444)")
    return t


def verifier_communs_ts(t: str, nom: str, autoriser_it112_snapshot: bool) -> None:
    # INVARIANT : la fenêtre précédente est désormais it.112 (424/156) —
    # « it.112 », « offset 424 », « offset 156 » sont donc LÉGITIMES.
    # Interdits : tout vestige de l'ancienne fenêtre précédente (it.111,
    # 404/148) et des identifiants/ids it.112.
    interdits = ["it.111", "IT112", "km112_", "offset 404", "offset 148"]
    residus = [x for x in interdits if x in t]
    if autoriser_it112_snapshot:
        # SNAPSHOT_SOURCE légitime : cortex-multimodal-it112.bin (1 seule fois)
        t_sans = t.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it112.bin"', "")
        assert t_sans.count("it112") == 0, f"it112 hors SNAPSHOT_SOURCE : {t_sans.count('it112')}"
    else:
        residus += ["it112"] if "it112" in t else []
    print(f"{nom} : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans {nom} : {residus}")


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.111", "it112", "km112_", '"offset": 424', '"offset": 156', "offset 404", "offset 148"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it113 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 444', '"offset": 164', "km113_", "multimodal-it113", "offset 424"]:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    verifier_communs_ts(t2, "genere-module-it113", autoriser_it112_snapshot=False)
    for attendu in [
        "var/entrainement-multimodal-it113/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it113.ts", sortie)',
        "fenêtre offset 444",
        "offset 164",
        "celle d'it.112 — offset 424",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    verifier_communs_ts(t3, "entrainement-it113", autoriser_it112_snapshot=True)
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it112.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it113.bin"',
        'from "../lib/neural/generation/multimodal-it113"',
        "ASSETS_MULTIMODAL_IT113",
        "PAIRES_MULTIMODAL_IT113",
        "offset 444",
        "offset 164",
        "après l'offset 424 d'it.112",
        "après offset 424 (it.112)",
        "état hérité d'it.112, avant gravure it.113",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT112 légitime exactement 2× (import dédup + sha112)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT112") == 2, f"IT112 × {t4.count('IT112')} (attendu 2)"
    assert t4.count("it112") == 1, f"it112 × {t4.count('it112')} (attendu 1)"
    ligne = [l for l in t4.splitlines() if "IT112" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT112 } from "./multimodal-it112";' in ligne
    for attendu in [
        "km113_",
        "sha112",
        "it.111 (404/148), it.112 (424/156) et it.113 (444/164)",
        "COCO offset 444, FLEURS offset 164 — après it.112 : 424/156",
        "(offset 444)",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km112_"]
    residus = [x for x in interdits if x in t4.replace('import { ASSETS_MULTIMODAL_IT112 } from "./multimodal-it112";', "")]
    print(f"test-it113 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)
    print(f"écrit : {TEST_OUT}")


if __name__ == "__main__":
    main()

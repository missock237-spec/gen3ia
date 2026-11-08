#!/usr/bin/env python3
"""Transforme les scripts it.129 en scripts it.130 (remplacements ordonnés,
vérifiés : aucun résidu inattendu ne doit survivre).

Pièges traités (leçons it.106→…→it.129) :
  - identifiants PascalCase IT129 → IT130 (remplacement séparé de it129) ;
  - SNAPSHOT_SOURCE = snapshot CUMULATIF PRÉCÉDENT (it129.bin) — restauration
    explicite après la cascade it129→it130 ;
  - fenêtre courante d'abord (744/284 → 764/0), PUIS référence historique
    (724/276 → 744/284) — l'ordre inverse corromprait les références ;
  - « état hérité / gravure » : post-globale « d'it.128, avant gravure it.130 »
    → « d'it.129, avant gravure it.130 » (la fenêtre précédente est it.129) ;
  - CHANGEMENT DE SOURCE AUDIO (nouveau, it.130) : FLEURS fr_fr/validation
    est ÉPUISÉ depuis it.129 (284+5=289 = taille officielle du split) et les
    splits train (3193) / test (676) dépassent la limite de scan du serveur
    de datasets (731/445 Mo > 300 Mo) — la fenêtre audio bascule sur
    facebook/multilingual_librispeech (french, dev, offset 0, 2416 lignes,
    transcriptions officielles, clips Opus). Les blocs concernés sont
    réécrits AVANT les renommages génériques, avec des marqueurs ⟪PREV⟫
    substitués en fin de cascade pour survivre aux renommages ;
  - le python porte les offsets au format JSON « "offset": N, » ET en prose ;
  - le test de déduplication s'allonge (ajout import it129 + sha129 + titre) ;
  - km129_ → km130_ (préfixe indépendant des identifiants IT)."""

TELECHARGE_IN = "scripts/telecharge-multimodal-it129.py"
TELECHARGE_OUT = "scripts/telecharge-multimodal-it130.py"
GENERE_IN = "scripts/genere-module-multimodal-it129.ts"
GENERE_OUT = "scripts/genere-module-multimodal-it130.ts"
ENTRAINEMENT_IN = "scripts/entrainement-multimodal-it129.ts"
ENTRAINEMENT_OUT = "scripts/entrainement-multimodal-it130.ts"
TEST_IN = "lib/neural/generation/multimodal-it129.test.ts"
TEST_OUT = "lib/neural/generation/multimodal-it130.test.ts"
DEDUP_IN = "scripts/verifie-dedup-it129.py"
DEDUP_OUT = "scripts/verifie-dedup-it130.py"

PREV = "⟪PREV⟫"  # substitué par « it.129 » en fin de cascade


def substituer_marqueurs(t: str) -> str:
    return t.replace(PREV, "it.129")


def transformer_ts(src: str) -> str:
    """Transformation commune aux .ts (entraînement + générateur)."""
    t = src
    # 0. date de la fenêtre (avant les blocs — les blocs portent déjà la bonne)
    t = t.replace("07 nov 2026", "08 nov 2026")
    # 1. BLOCS CHANGEMENT DE SOURCE AUDIO (FLEURS épuisé → MLS french/dev) —
    #    réécrits en premier, texte final, marqueurs ⟪PREV⟫ pour it.129.
    #    a. en-tête du générateur (docstring)
    t = t.replace(
        """ * Lit var/entrainement-multimodal-it129/assets.json (inventaire HF — fenêtre
 * du 08 nov 2026 : 20 images COCO-2017 offset 744 + 8 audios FLEURS fr_fr
 * offset 284 + fenêtre vidéo UCF101 ÉPUISÉE — preuve du zéro) et émet""",
        f""" * Lit var/entrainement-multimodal-it130/assets.json (inventaire HF — fenêtre
 * du 08 nov 2026 : 20 images COCO-2017 offset 764 + 8 audios Multilingual
 * LibriSpeech french/dev offset 0 — FLEURS fr_fr/validation ÉPUISÉ depuis
 * {PREV} — + fenêtre vidéo UCF101 ÉPUISÉE — preuve du zéro) et émet""",
    )
    #    b. réponse audio du générateur
    t = t.replace(
        "du dataset professionnel Google FLEURS (fr_fr, validation, ",
        "du dataset professionnel Meta Multilingual LibriSpeech (french, dev, ",
    )
    #    c. puce audio de l'en-tête du module généré
    t = t.replace(
        """ *   - ${comptes.audio ?? 0} audios de parole française naturelle Google FLEURS
 *     (fr_fr, validation, fenêtre offset 284, après l'offset 276 d'it.128) avec
 *     transcriptions officielles (WAV PCM) ;""",
        f""" *   - ${{comptes.audio ?? 0}} audios de parole française naturelle Meta
 *     Multilingual LibriSpeech (french, dev, fenêtre offset 0 — FLEURS
 *     fr_fr/validation ÉPUISÉ depuis {PREV} : 284+5=289 lignes consommées,
 *     splits train/test au-delà de la limite de scan du serveur) avec
 *     transcriptions officielles (Opus) ;""",
    )
    #    d. en-tête de l'entraînement (docstring)
    t = t.replace(
        """ *   - 8 audios FLEURS fr_fr (validation, offset 284, après l'offset 276
 *     d'it.128) — transcriptions officielles ;""",
        f""" *   - 8 audios Multilingual LibriSpeech (french, dev, offset 0 — FLEURS
 *     fr_fr/validation ÉPUISÉ depuis {PREV} : 284+5=289 = taille officielle,
 *     splits train/test au-delà de la limite de scan du serveur) —
 *     transcriptions officielles ;""",
    )
    #    e. fenêtres du rapport d'entraînement
    t = t.replace(
        '''        audio: "google/fleurs#fr_fr/validation offset 284 (5 — DERNIÈRES lignes du split : 284+5=289, taille officielle /size — SPLIT ÉPUISÉ, comme UCF101 depuis it.90) — après offset 276 (it.128)",''',
        f'''        audio: "facebook/multilingual_librispeech#french/dev offset 0 (8 — FLEURS fr_fr/validation ÉPUISÉ depuis {PREV} : 284+5=289 = taille officielle du split ; splits train/test FLEURS dépassent la limite de scan du serveur de datasets — source basculée sur MLS french dev, 2416 lignes disponibles) — après offset 284 ({PREV})",''',
    )
    # 2. offsets — fenêtre courante d'abord (prose), puis référence historique
    t = t.replace("offset 744", "offset 764")  # fenêtre courante images
    t = t.replace("offset 724", "offset 744")  # référence fenêtre précédente
    # 3. global it.129 → it.130 (titre, header, logs, ids de fenêtre)
    t = t.replace("it.129", "it.130")
    # 4. fenêtre précédente it.128 → it.129 (toutes les formes documentées)
    t = t.replace("d'it.128", f"d'{PREV}")
    t = t.replace("(it.128)", f"({PREV})")
    t = t.replace("cumulatif it.128", f"cumulatif {PREV}")
    t = t.replace("après it.128", f"après {PREV}")
    # 5. identifiants PascalCase puis chemins de fichiers
    t = t.replace("IT129", "IT130")
    t = t.replace("it129", "it130")
    t = t.replace("km129_", "km130_")
    # restauration explicite de la SOURCE = snapshot cumulatif PRÉCÉDENT
    # (la source d'it.129 était it128.bin ; pour it.130 elle devient it129.bin)
    t = t.replace(
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it128.bin"',
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it129.bin"',
    )
    # 6. substitution finale des marqueurs
    return substituer_marqueurs(t)


def transformer_telecharge(src: str) -> str:
    """Transformation du .python (formats JSON « "offset": N, » + prose)."""
    t = src
    # 0. BLOC EN-TÊTE AUDIO — changement de source documenté
    t = t.replace(
        """  - AUDIO  : google/fleurs (fr_fr, validation) — fenêtre SUIVANTE (offset 284)
    — 8 clips de parole française naturelle RÉELLE + transcriptions
    officielles.""",
        f"""  - AUDIO  : facebook/multilingual_librispeech (french, dev) — fenêtre
    SUIVANTE (offset 0) — 8 clips de parole française naturelle RÉELLE
    (livres audio du domaine public) + transcriptions officielles —
    CHANGEMENT DE SOURCE : FLEURS fr_fr/validation ÉPUISÉ depuis {PREV}
    (284+5=289 = taille officielle) ; splits train/test FLEURS au-delà de
    la limite de scan du serveur de datasets (731/445 Mo > 300 Mo).""",
    )
    # 1. BLOC SOURCES AUDIO — l'entrée complète
    t = t.replace(
        """    {
        "modality": "audio",
        "dataset": "google/fleurs",
        "config": "fr_fr",
        "split": "validation",
        "offset": 284,
        "n": 8,
        "dir": "audio",
        "ext": "wav",
        "champ_media": "audio",  # champ LISTE : row["audio"][0]["src"]
        "legende": lambda row: row.get("raw_transcription") or row.get("transcription", ""),
        "id_champ": "id",
    },""",
        """    {
        "modality": "audio",
        "dataset": "facebook/multilingual_librispeech",
        "config": "french",
        "split": "dev",
        "offset": 0,
        "n": 8,
        "dir": "audio",
        "ext": "opus",
        "champ_media": "audio",  # champ LISTE : row["audio"][0]["src"]
        "legende": lambda row: row.get("transcript") or row.get("transcription", ""),
        "id_champ": "id",
    },""",
    )
    # 2. offsets — courant d'abord (formats JSON puis prose), puis historique
    t = t.replace('"offset": 744', '"offset": 764')
    t = t.replace("offset 724", "offset 744")   # prose header historique
    # 3. globals
    t = t.replace("it.129", "it.130")
    t = t.replace("it.128", "it.129")
    t = t.replace("it129", "it130")   # chemins + user-agent
    t = t.replace("km129_", "km130_")  # ids de paires
    return substituer_marqueurs(t)


def transformer_test(src: str) -> str:
    t = src
    # 0. BLOCS SPÉCIFIQUES it.130 (avant renommages — texte final, marqueurs)
    #    a. en-tête
    t = t.replace(
        " * FLEURS offset 284) : honnêteté des comptes, existence réelle des fichiers,",
        f" * MLS french/dev offset 0 — FLEURS fr_fr/validation épuisé depuis {PREV}) :\n * honnêteté des comptes, existence réelle des fichiers,",
    )
    #    b. comptes de la fenêtre (test 1)
    t = t.replace(
        '''  it("déclare 25 assets : 20 images COCO + 5 audios FLEURS (dernières lignes du split) + 0 vidéo (fenêtre UCF101 épuisée)", () => {
    expect(ASSETS_MULTIMODAL_IT129).toHaveLength(25);
    expect(ASSETS_MULTIMODAL_IT129.filter((a) => a.modality === "image")).toHaveLength(20);
    expect(ASSETS_MULTIMODAL_IT129.filter((a) => a.modality === "audio")).toHaveLength(5);''',
        '''  it("déclare 28 assets : 20 images COCO + 8 audios MLS (nouvelle source après épuisement FLEURS) + 0 vidéo (fenêtre UCF101 épuisée)", () => {
    expect(ASSETS_MULTIMODAL_IT130).toHaveLength(28);
    expect(ASSETS_MULTIMODAL_IT130.filter((a) => a.modality === "image")).toHaveLength(20);
    expect(ASSETS_MULTIMODAL_IT130.filter((a) => a.modality === "audio")).toHaveLength(8);''',
    )
    #    c. test d'épuisement → test de changement de source documenté
    t = t.replace(
        '''  it("épuisement FLEURS fr_fr/validation documenté : offset 284 + 5 = 289 (taille officielle du split)", () => {
    // Preuve d'honnêteté : le split google/fleurs#fr_fr/validation contient
    // exactement 289 lignes (API datasets-server /size). Les fenêtres it.126
    // (260-267), it.127 (268-275), it.128 (276-283) ont consommé 24 lignes ;
    // it.129 prend les 5 DERNIÈRES (offset 284 → 288). Le split est désormais
    // ÉPUISÉ : les fenêtres suivantes renverront 0 ligne (preuve refaite à
    // chaque tick, comme pour UCF101 depuis it.90).
    expect(ASSETS_MULTIMODAL_IT129.filter((a) => a.modality === "audio")).toHaveLength(5);
  });''',
        f'''  it("changement de source audio documenté : FLEURS fr_fr/validation ÉPUISÉ (289/289) depuis {PREV} — fenêtre MLS french/dev offset 0", () => {{
    // Preuve d'honnêteté : le split FLEURS fr_fr/validation contient
    // exactement 289 lignes (API datasets-server /size) — toutes consommées :
    // it.126 (260-267), it.127 (268-275), it.128 (276-283) puis {PREV}
    // (284-288, les 5 dernières). Les splits train (3193 lignes) et test
    // (676 lignes) dépassent la limite de scan du serveur de datasets
    // (731/445 Mo > 300 Mo) : la fenêtre audio bascule sur
    // facebook/multilingual_librispeech (french, dev — 2416 lignes,
    // livres audio du domaine public, transcriptions officielles).
    expect(ASSETS_MULTIMODAL_IT130.filter((a) => a.modality === "audio")).toHaveLength(8);
  }});''',
    )
    #    d. test des fenêtres suivantes (titre + dataset attendu)
    t = t.replace(
        '''  it("les fenêtres sont les SUIVANTES (COCO offset 744, FLEURS offset 284 — après it.128 : 724/276)", () => {
    const images = ASSETS_MULTIMODAL_IT129.filter((a) => a.modality === "image");
    const audios = ASSETS_MULTIMODAL_IT129.filter((a) => a.modality === "audio");
    for (const a of images) expect(a.dataset).toBe("rafaelpadilla/coco2017#default/val");
    for (const a of audios) expect(a.dataset).toBe("google/fleurs#fr_fr/validation");
  });''',
        f'''  it("les fenêtres sont les SUIVANTES (COCO offset 764, MLS offset 0 — après {PREV} : 744/284)", () => {{
    const images = ASSETS_MULTIMODAL_IT130.filter((a) => a.modality === "image");
    const audios = ASSETS_MULTIMODAL_IT130.filter((a) => a.modality === "audio");
    for (const a of images) expect(a.dataset).toBe("rafaelpadilla/coco2017#default/val");
    for (const a of audios) expect(a.dataset).toBe("facebook/multilingual_librispeech#french/dev");
  }});''',
    )
    #    e. comptes des paires (test servibilité)
    t = t.replace(
        '''  it("25 paires servibles : motif ↔ réponse contenant l'identifiant et la légende réelle", () => {
    expect(PAIRES_MULTIMODAL_IT129).toHaveLength(25);''',
        '''  it("28 paires servibles : motif ↔ réponse contenant l'identifiant et la légende réelle", () => {
    expect(PAIRES_MULTIMODAL_IT130).toHaveLength(28);''',
    )
    #    f. vérification du contenu de la réponse audio
    t = t.replace(
        'expect(audio?.reponse).toContain("FLEURS");',
        'expect(audio?.reponse).toContain("LibriSpeech");',
    )
    # 1. globals
    t = t.replace("it.129", "it.130")
    t = t.replace("IT129", "IT130")
    t = t.replace("it129", "it130")
    t = t.replace("km129_", "km130_")
    t = t.replace("offset 744", "offset 764")
    t = t.replace("offset 724", "offset 744")
    # 2. titre du test de déduplication : liste allongée (post-renommages :
    #    le générique a produit « it.128 (724/276) et it.130 (744/284) » —
    #    on réinsère it.129 (744/284) et on corrige la nouvelle fenêtre
    #    it.130 (764/0))
    t = t.replace(
        'it.128 (724/276) et it.130 (744/284)", () => {',
        'it.128 (724/276), it.129 (744/284) et it.130 (764/0)", () => {',
    )
    # 3. ré-import dédié pour la déduplication contre it.129
    t = t.replace(
        'import { ASSETS_MULTIMODAL_IT130, PAIRES_MULTIMODAL_IT130 } from "./multimodal-it130";',
        'import { ASSETS_MULTIMODAL_IT129 } from "./multimodal-it129";\nimport { ASSETS_MULTIMODAL_IT130, PAIRES_MULTIMODAL_IT130 } from "./multimodal-it130";',
    )
    # 4. ensembles et attentes de déduplication (ajout sha129)
    t = t.replace(
        "const sha128 = new Set(ASSETS_MULTIMODAL_IT128.map((a) => a.sha256));",
        "const sha128 = new Set(ASSETS_MULTIMODAL_IT128.map((a) => a.sha256));\n    const sha129 = new Set(ASSETS_MULTIMODAL_IT129.map((a) => a.sha256));",
    )
    t = t.replace(
        "expect(sha128.has(a.sha256), `doublon de contenu it.128 : ${a.id} (${a.sha256})`).toBe(false);",
        "expect(sha128.has(a.sha256), `doublon de contenu it.128 : ${a.id} (${a.sha256})`).toBe(false);\n      expect(sha129.has(a.sha256), `doublon de contenu it.129 : ${a.id} (${a.sha256})`).toBe(false);",
    )
    return substituer_marqueurs(t)


def main() -> None:
    # 1. télécharge python
    t = transformer_telecharge(open(TELECHARGE_IN).read())
    interdits = ["it.128", "it129", "km129_", '"offset": 744', '"offset": 284',
                 "offset 724", "google/fleurs", "raw_transcription"]
    residus = [x for x in interdits if x in t]
    print(f"telecharge-it130 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ['"offset": 764', '"offset": 0', "facebook/multilingual_librispeech",
                    "km130_", "multimodal-it130", "offset 744", "après it.129",
                    '"ext": "opus"', 'row.get("transcript")']:
        assert attendu in t, f"MANQUANT dans telecharge : {attendu}"
    open(TELECHARGE_OUT, "w").write(t)
    print(f"écrit : {TELECHARGE_OUT}")

    # 2. genere-module ts
    t2 = transformer_ts(open(GENERE_IN).read())
    # it.129 légitime comme fenêtre précédente (prose) ; it129 (identifiant)
    # et km129_ interdits ; google/fleurs interdit.
    interdits = ["it.128", "IT129", "km129_", "it129", "offset 724", "offset 276",
                 "google/fleurs", "FLEURS fr_fr,\n", "raw_transcription"]
    residus = [x for x in interdits if x in t2]
    print(f"genere-module-it130 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans genere : {residus}")
    for attendu in [
        "var/entrainement-multimodal-it130/assets.json",
        'writeFileSync("lib/neural/generation/multimodal-it130.ts", sortie)',
        "fenêtre offset 764",
        "offset 0",
        "celle d'it.129 — offset 744",
        "Meta Multilingual LibriSpeech (french, dev,",
    ]:
        assert attendu in t2, f"MANQUANT dans genere : {attendu}"
    open(GENERE_OUT, "w").write(t2)
    print(f"écrit : {GENERE_OUT}")

    # 3. entraînement ts — it129 (identifiant) légitime exactement dans
    #    SNAPSHOT_SOURCE (le point de départ cumulatif)
    t3 = transformer_ts(open(ENTRAINEMENT_IN).read())
    t3_sans = t3.replace('SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it129.bin"', "")
    residus = [x for x in ["it.128", "IT129", "km129_", "it129", "offset 724",
                           "offset 276", "google/fleurs"] if x in t3_sans]
    print(f"entrainement-it130 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS dans entrainement : {residus}")
    # la référence historique audio « après offset 284 (it.129) » est légitime (1×)
    assert t3.count("offset 284") == 1, f"offset 284 × {t3.count('offset 284')} (attendu 1 — ref historique)"
    for attendu in [
        'SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it129.bin"',
        'SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it130.bin"',
        'from "../lib/neural/generation/multimodal-it130"',
        "ASSETS_MULTIMODAL_IT130",
        "PAIRES_MULTIMODAL_IT130",
        "offset 764",
        "offset 0",
        "après l'offset 744 d'it.129",
        "après offset 744 (it.129)",
        "état hérité d'it.129, avant gravure it.130",
        "facebook/multilingual_librispeech#french/dev offset 0",
    ]:
        assert attendu in t3, f"MANQUANT dans entrainement : {attendu}"
    open(ENTRAINEMENT_OUT, "w").write(t3)
    print(f"écrit : {ENTRAINEMENT_OUT}")

    # 4. test ts — IT128 légitime exactement 2× (import dédup + sha128),
    #    IT129 légitime exactement 2× (import dédup + sha129)
    t4 = transformer_test(open(TEST_IN).read())
    assert t4.count("IT128") == 2, f"IT128 × {t4.count('IT128')} (attendu 2)"
    assert t4.count("it128") == 1, f"it128 × {t4.count('it128')} (attendu 1)"
    assert t4.count("IT129") == 2, f"IT129 × {t4.count('IT129')} (attendu 2)"
    assert t4.count("it129") == 1, f"it129 × {t4.count('it129')} (attendu 1)"
    ligne128 = [l for l in t4.splitlines() if "IT128" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT128 } from "./multimodal-it128";' in ligne128
    ligne129 = [l for l in t4.splitlines() if "IT129" in l and "import" in l][0]
    assert 'import { ASSETS_MULTIMODAL_IT129 } from "./multimodal-it129";' in ligne129
    for attendu in [
        "km130_",
        "sha129",
        "it.123 (624/236), it.124 (644/244), it.125 (664/252), it.126 (684/260), it.127 (704/268), it.128 (724/276), it.129 (744/284) et it.130 (764/0)",
        "COCO offset 764, MLS offset 0 — après it.129 : 744/284",
        'toContain("LibriSpeech")',
        "28 paires servibles",
        "facebook/multilingual_librispeech#french/dev",
    ]:
        assert attendu in t4, f"MANQUANT dans test : {attendu}"
    interdits = ["km128_", "km129_", "google/fleurs"]
    residus = [x for x in interdits if x in t4]
    print(f"test-it130 : résidus {residus if residus else '— aucun ✓'} · contrôles OK")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    open(TEST_OUT, "w").write(t4)

    # 5. dédup python (générique : glob — simples renommages)
    t5 = open(DEDUP_IN).read()
    t5 = t5.replace("it.129", "it.130")
    t5 = t5.replace("it129", "it130")
    interdits = ["it.129", "it129"]
    residus = [x for x in interdits if x in t5]
    print(f"verifie-dedup-it130 : résidus {residus if residus else '— aucun ✓'}")
    if residus:
        raise SystemExit(f"RÉSIDUS : {residus}")
    for attendu in ["var/entrainement-multimodal-it130/assets.json", "fenêtre it.130"]:
        assert attendu in t5, f"MANQUANT dans dedup : {attendu}"
    open(DEDUP_OUT, "w").write(t5)
    print(f"écrit : {DEDUP_OUT}")


if __name__ == "__main__":
    main()

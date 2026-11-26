#!/usr/bin/env python3
"""GÉNÉRATEUR DU MODULE MULTIMODAL it.150 (python3 scripts/genere-module-multimodal-it150.py)

Lit var/entrainement-multimodal-it150/assets.json (inventaire mesuré —
première fenêtre combinant les deux plateformes fournies :
  - 20 images COCO-2017 (HF, validation, offset 1124, après l'offset 1104
    d'it.149) avec annotations d'objets officielles ;
  - 8 audios Multilingual LibriSpeech (HF, french/dev, offset 144, après
    l'offset 136 d'it.149) avec transcriptions officielles ;
  - 12 photos Kaggle flower-color-images avec couleur moyenne MESURÉE au
    pixel près et étiquette de classe officielle (H5) ;
  - 0 vidéo UCF101 (fenêtre épuisée depuis it.90 — preuve du zéro refaite) ;
  - datasets/couleurs_v6/train.jsonl : 2 696 lignes de connaissances
    couleurs construites depuis les CSV Kaggle (propriétés officielles,
    complémentaires calculés exactement, 100 noms canoniques).
et émet lib/neural/generation/multimodal-it150.ts :
  - ASSETS_MULTIMODAL_IT150 : métadonnées mesurées (octets, sha256, source) ;
  - PAIRES_MULTIMODAL_IT150 : paires question/réponse servies par le chat ;
  - PAIRES_COULEURS_V6 : échantillon de 60 lignes couleurs_v6 (l'ensemble
    complet reste dans datasets/couleurs_v6/train.jsonl pour l'ingestion
    du pré-entraînement million — aucune paire inventée).
"""
import json
import os

VAR = "var/entrainement-multimodal-it150/assets.json"
SORTIE = "lib/neural/generation/multimodal-it150.ts"
N_ECHANTILLON_V6 = 60

rapport = json.load(open(VAR, encoding="utf-8"))
assets = rapport["assets"]
comptes = rapport["comptes"]
v6 = rapport["couleurs_v6"]
total = sum(a["bytes"] for a in assets)

# ── Échantillon PAIRES_COULEURS_V6 : les 60 premières lignes RÉELLES du JSONL ──
lignes_v6 = []
with open(v6["fichier"], encoding="utf-8") as f:
    for i, ligne in enumerate(f):
        if i >= N_ECHANTILLON_V6:
            break
        r = json.loads(ligne)
        lignes_v6.append((r["instruction"], r["output"]))


def paire_image_hf(a):
    return {
        "motif": f"Que contient l'image {a['id']} ?",
        "reponse": (
            f"L'image {a['id']} est un asset RÉEL de COCO-2017 (validation, "
            f"{a['bytes']:,} octets, empreinte {a['sha256']}). La légende exacte "
            f"issue des annotations : {a['legende_reelle']}. Elle est servie "
            f"publiquement à {a['file']} et fait partie de la fenêtre it.150 "
            f"(20 images réelles téléchargées le 26 nov 2026, fenêtre suivant "
            f"celle d'it.149 — offset 1104).").replace(",", " "),
        "theme": "multimodal-image",
    }


def paire_image_kaggle(a):
    rgb = a["rgb_moyen"]
    return {
        "motif": f"Que contient l'image {a['id']} ?",
        "reponse": (
            f"L'image {a['id']} est une photo RÉELLE du dataset Kaggle "
            f"flower-color-images ({a['bytes']:,} octets, empreinte {a['sha256']}). "
            f"Couleur moyenne MESURÉE au pixel près : RGB({rgb[0]},{rgb[1]},{rgb[2]}) "
            f"= {a['hex_moyen']}. Étiquette officielle : « {a['legende_reelle'].split('Étiquette officielle du dataset : ')[1].split(' (')[0]} ». "
            f"Fichier servi : {a['file']}. Première provenance KAGGLE gravée dans "
            f"le cerveau (fenêtre it.150 — les deux plateformes fournies).").replace(",", " "),
        "theme": "multimodal-image-kaggle",
    }


def paire_audio(a):
    return {
        "motif": f"Que contient l'enregistrement audio {a['id']} ?",
        "reponse": (
            f"L'audio {a['id']} est un clip RÉEL de parole française du dataset "
            f"professionnel Meta Multilingual LibriSpeech (french, dev, "
            f"{a['bytes']:,} octets, empreinte {a['sha256']}). La transcription "
            f"officielle : « {a['legende_reelle']} ». Fichier servi : {a['file']}.").replace(",", " "),
        "theme": "multimodal-audio",
    }


paires = []
for a in assets:
    if a.get("source_plateforme") == "kaggle":
        paires.append(paire_image_kaggle(a))
    elif a["modality"] == "image":
        paires.append(paire_image_hf(a))
    elif a["modality"] == "audio":
        paires.append(paire_audio(a))
    else:
        paires.append({
            "motif": f"Que contient la vidéo {a['id']} ?",
            "reponse": f"La vidéo {a['id']} est un extrait RÉEL du sous-ensemble UCF101. {a['legende_reelle']} Fichier servi : {a['file']}.",
            "theme": "multimodal-video",
        })

n_img = comptes.get("image", 0)
n_kag = comptes.get("kaggle_image", 0)
n_aud = comptes.get("audio", 0)
n_vid = comptes.get("video", 0)

entete = f"""/**
 * ASSETS MULTIMODAUX RÉELS it.150 (généré par
 * scripts/genere-module-multimodal-it150.py — {rapport['genere_le'][:19]}Z).
 *
 * {len(assets)} assets réels mesurés ({total / 1e6:.2f} Mo au total) — PREMIÈRE fenêtre
 * combinant les DEUX plateformes fournies par le propriétaire (Job 478451) :
 *   - {n_img} images COCO-2017 (Hugging Face, rafaelpadilla/coco2017,
 *     validation, fenêtre offset 1124, après l'offset 1104 d'it.149) avec
 *     annotations d'objets officielles — légendes reconstruites depuis les
 *     labels RÉELS (liste « 90 things ») ;
 *   - {n_kag} photos flower-color-images (KAGGLE — première provenance Kaggle
 *     gravée dans le cerveau, olgabelitskaya/flower-color-images via
 *     kagglehub) avec couleur moyenne MESURÉE au pixel près (RGB + hex) et
 *     étiquette de classe officielle du H5 (le dataset ne documente pas de
 *     nom d'espèce — aucune invention) ;
 *   - {n_aud} audios de parole française naturelle Meta Multilingual
 *     LibriSpeech (Hugging Face, french, dev, fenêtre offset 144 — suite MLS
 *     après l'offset 136 d'it.149 ; FLEURS fr_fr/validation ÉPUISÉ depuis
 *     it.129 : 289 lignes consommées) avec transcriptions officielles (Opus) ;
 *   - {n_vid} vidéo UCF101 — la fenêtre offset 4 renvoie 0 ligne : le split
 *     train ne contient que 2 lignes, intégrées depuis it.90 (preuve du
 *     zéro refaite le 26 nov 2026).
 * CONNAISSANCES COULEURS (demande « 10 millions de données sur la
 * reconnaissance des couleurs, leurs propriétés et leurs mélanges ») :
 *   - datasets/couleurs_v6/train.jsonl : {v6['lignes']:,} lignes RÉELLES construites
 *     depuis les CSV Kaggle — {v6['couleurs_proprietes']} couleurs avec propriétés
 *     officielles (hex/RGB/teinte/HSL, avi1023/color-names) + complémentaires
 *     CALCULÉS EXACTEMENT (teinte+180°) + {v6['noms_canoniques']} noms canoniques
 *     (danela/mapping-color-space-to-100-color-names — la source exacte déjà
 *     citée par couleurs v5) ;
 *   - PAIRES_COULEURS_V6 ci-dessous = échantillon de {len(lignes_v6)} lignes servi par
 *     le chat ; l'ensemble complet reste dans le JSONL pour l'ingestion du
 *     pré-entraînement million.
 * Fichiers servis depuis public/multimodal-it150/. Les paires sont assimilées
 * par le cortex langagier (corpus.ts) — mêmes fonctions que la production.
 */
export interface AssetMultimodalIt98 {{
  readonly id: string;
  readonly modality: "image" | "audio" | "video";
  readonly dataset: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly legende: string;
}}

export const ASSETS_MULTIMODAL_IT150: readonly AssetMultimodalIt98[] = [
"""

lignes_assets = []
for a in assets:
    ds = a["dataset"]
    legende = a["legende_reelle"]
    lignes_assets.append(
        f'  {{ id: "{a["id"]}", modality: "{a["modality"]}" as const, dataset: "{ds}", '
        f'file: "{a["file"]}", bytes: {a["bytes"]}, sha256: "{a["sha256"]}", '
        f'legende: {json.dumps(legende, ensure_ascii=False)} }},')

fin_assets = """];

export interface PaireMultimodaleIt98 {
  readonly motif: string;
  readonly reponse: string;
  readonly theme: string;
}

export const PAIRES_MULTIMODAL_IT150: readonly PaireMultimodaleIt98[] = [
"""

lignes_paires = [
    f"  {{ motif: {json.dumps(p['motif'], ensure_ascii=False)}, reponse: {json.dumps(p['reponse'], ensure_ascii=False)}, theme: \"{p['theme']}\" }},"
    for p in paires
]

section_v6 = f"""];

/** PAIRES COULEURS v6 — échantillon de {len(lignes_v6)} lignes RÉELLES tirées de
 * datasets/couleurs_v6/train.jsonl ({v6['lignes']:,} lignes au total, sources
 * Kaggle avi1023/color-names + danela/mapping-color-space-to-100-color-names ;
 * complémentaires calculés exactement). Mêmes textes que le JSONL — aucune
 * reformulation inventée. */
export const PAIRES_COULEURS_V6: readonly PaireMultimodaleIt98[] = [
"""

lignes_v6_ts = [
    f"  {{ motif: {json.dumps(instr, ensure_ascii=False)}, reponse: {json.dumps(out, ensure_ascii=False)}, theme: \"couleurs-v6\" }},"
    for instr, out in lignes_v6
]

sortie = (
    entete + "\n".join(lignes_assets) + "\n" + fin_assets
    + "\n".join(lignes_paires) + "\n" + section_v6
    + "\n".join(lignes_v6_ts) + "\n];\n"
)
with open(SORTIE, "w", encoding="utf-8") as f:
    f.write(sortie)
print(f"module écrit : {SORTIE} ({len(assets)} assets, {total / 1e6:.2f} Mo, "
      f"{len(paires)} paires multimodales + {len(lignes_v6)} paires couleurs_v6)")

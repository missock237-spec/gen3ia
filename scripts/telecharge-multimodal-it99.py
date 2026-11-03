#!/usr/bin/env python3
"""EXPANSION MULTIMODALE it.99 — +12 assets RÉELS Hugging Face (plan it.98 §8).

Sources professionnelles (datasets-server, jeton non requis — datasets publics),
MÊMES datasets que it.90/it.95/it.96/it.97, fenêtres de lignes ENCORE PLUS
DÉCALÉES (aucun chevauchement, déduplication par row_id en filet) :
  - IMAGES : rafaelpadilla/coco2017 (val) à partir de la ligne 92 — 8 images
    photoréalistes + annotations d'objets RÉELLES (it.90 : 40-59, it.95 : 20-27,
    it.96 : 60-75, it.97 : 76-91) ;
  - AUDIO  : google/fleurs (fr_fr, validation) à partir de la ligne 20 — 4 clips
    de parole française naturelle + transcriptions officielles (it.90 : 0-7,
    it.95 : 8-11, it.96 : 12-15, it.97 : 16-19).

NOUVEAUTÉ it.99 : les audios sont CONVERTIS EN OPUS dès le téléchargement
(WAV PCM → libopus 24 kbps VBR mono, ~20× plus léger, durée vérifiée par
ffprobe) — c'est la décision it.98 qui rend la tranche +12 compatible avec le
plafond de 15 Mo sans toucher au plafond.

Le script FUSIONNE le nouvel inventaire dans
var/entrainement-multimodal-it90/assets.json (66 → 78 entrées HF) sans jamais
toucher aux assets existants (déduplication par row_id), puis met à jour le
miroir var-copie/assets.json (persisté au commit). Les fichiers vont dans
public/multimodal-it90/{images,audio}/ avec une numérotation qui CONTINUE
celle de it.97 (image_044.jpg…, audio_020.opus…) — zéro collision.

Garde qualité (alignée sur le test garde it.90) : une ligne FLEURS dont la
transcription fait < 40 caractères est SAUTÉE (ligne suivante), une image sans
aucune annotation d'objet est sautée — les comptes finaux restent garantis.

Usage : python3 scripts/telecharge-multimodal-it99.py
"""

import hashlib
import importlib.util
import json
import os
import subprocess
import urllib.parse
import urllib.request

BASE = "https://datasets-server.huggingface.co/rows"
OUT = "public/multimodal-it90"
VAR = "var/entrainement-multimodal-it90"
ASSETS = os.path.join(VAR, "assets.json")
MIROIR = "var-copie/assets.json"

# Réutilisation SANS duplication des tables COCO-80/FR du script it.90
spec = importlib.util.spec_from_file_location(
    "telecharge_multimodal_it90", "scripts/telecharge-multimodal-it90.py"
)
it90 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(it90)  # fournit COCO80, FR, legende_coco (sans effet : main() gardé)

NOUVELLES_SOURCES = [
    {
        "modality": "image",
        "dataset": "rafaelpadilla/coco2017",
        "config": "default",
        "split": "val",
        "offset": 92,
        "n": 8,          # objectif
        "demande": 16,   # lignes demandées (marge pour filtres)
        "dir": "images",
        "ext": "jpg",
        "champ_media": "image",
        "id_champ": "image_id",
        "legende_min": 12,
    },
    {
        "modality": "audio",
        "dataset": "google/fleurs",
        "config": "fr_fr",
        "split": "validation",
        "offset": 20,
        "n": 4,
        "demande": 16,
        "dir": "audio",
        "ext": "opus",   # it.99 : opus dès le téléchargement
        "champ_media": "audio",
        "id_champ": "id",
        "legende_min": 40,  # garde test : transcription réelle substantielle
    },
]


def legende_image(row: dict) -> str:
    return it90.legende_coco(row)


def legende_audio(row: dict) -> str:
    return row.get("raw_transcription") or row.get("transcription", "")


def rows_url(s: dict) -> str:
    return (
        f"{BASE}?dataset={urllib.parse.quote(s['dataset'], safe='')}"
        f"&config={urllib.parse.quote(s['config'], safe='')}"
        f"&split={urllib.parse.quote(s['split'], safe='')}"
        f"&offset={s['offset']}&length={s['demande']}"
    )


def telecharge(url: str, chemin: str) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": "gen3ia-it99/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(chemin, "wb") as f:
        f.write(resp.read())
    return os.path.getsize(chemin)


def duree(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, timeout=30,
    )
    return float(out.stdout.strip())


def wav_vers_opus(chemin_wav: str) -> str:
    """Convertit un WAV téléchargé en .opus (24 kbps VBR mono, voix)."""
    chemin_opus = chemin_wav[:-4] + ".opus"
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", chemin_wav, "-c:a", "libopus",
         "-b:a", "24k", "-vbr", "on", "-ar", "16000", "-ac", "1", chemin_opus],
        timeout=60,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg a échoué sur {chemin_wav}")
    os.remove(chemin_wav)
    return chemin_opus


def main() -> None:
    with open(ASSETS, encoding="utf-8") as f:
        inventaire = json.load(f)
    existants = inventaire.get("assets", [])
    rows_vus = {a["row_id"] for a in existants}
    fichiers_vus = {os.path.basename(a["file"]) for a in existants}
    print(f"état d'entrée : {len(existants)} assets, {len(rows_vus)} row_id connus")

    ajoutes = 0
    for s in NOUVELLES_SOURCES:
        dossier = os.path.join(OUT, s["dir"])
        os.makedirs(dossier, exist_ok=True)
        # numérotation CONTINUE : index de départ = nb d'assets existants de la modalité
        base_num = sum(1 for a in existants if a["modality"] == s["modality"])
        req = urllib.request.Request(rows_url(s), headers={"User-Agent": "gen3ia-it99/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.load(resp)
        lignes = payload.get("rows", [])
        print(f"[{s['modality']}] {s['dataset']} : {len(lignes)} lignes reçues (offset {s['offset']})")
        pris = 0
        for l in lignes:
            if pris >= s["n"]:
                break
            row = l.get("row", {})
            ident = row.get(s["id_champ"], None)
            if ident is None or str(ident) in rows_vus:
                continue
            media = row.get(s["champ_media"]) or {}
            if isinstance(media, list):
                media = media[0] if media else {}
            src = media.get("src") if isinstance(media, dict) else None
            if not src:
                continue
            legende = legende_image(row) if s["modality"] == "image" else legende_audio(row)
            if not legende or len(legende) < s["legende_min"]:
                continue
            if s["modality"] == "image" and "scène contenant" not in legende:
                continue
            ext = s["ext"]
            if s["modality"] == "image":
                # pas d'annotation exploitable → légende dégénérée, on saute
                if legende.endswith("(0 objets annotés)"):
                    continue
                ext = (media.get("filename", "") or "").rsplit(".", 1)[-1] or "jpg"
                if ext not in ("jpg", "jpeg", "png"):
                    ext = "jpg"
            nom_fichier = f"{s['modality']}_{base_num + pris:03d}.{ext}"
            if nom_fichier in fichiers_vus:
                # collision de nom (ne devrait pas arriver) : on décale
                continue
            chemin = os.path.join(dossier, nom_fichier)
            tmp = chemin + ".wav" if s["modality"] == "audio" else chemin
            try:
                octets = telecharge(src, tmp)
                if s["modality"] == "audio":
                    d_avant = duree(tmp)
                    chemin = wav_vers_opus(tmp)
                    d_apres = duree(chemin)
                    if abs(d_apres - d_avant) > 0.3:
                        raise RuntimeError(f"durée divergente : {d_avant:.2f}s → {d_apres:.2f}s")
                    octets = os.path.getsize(chemin)
                    # it.99 : tmp = « audio_NNN.opus.wav » → l'opus sort en
                    # « audio_NNN.opus » (tmp[:-4] retire .wav) — on écrase
                    # nom_fichier avec le nom RÉEL sur disque.
                    nom_fichier = os.path.basename(chemin)
                    if nom_fichier.endswith(".opus.opus"):
                        nom_fichier = nom_fichier[:-5]
                        chemin_corrige = os.path.join(dossier, nom_fichier)
                        os.rename(chemin, chemin_corrige)
                        chemin = chemin_corrige
                        octets = os.path.getsize(chemin)
            except Exception as exc:  # noqa: BLE001
                print(f"  ! échec {nom_fichier}: {exc}")
                if os.path.exists(tmp):
                    os.remove(tmp)
                continue
            data = open(chemin, "rb").read()
            sha16 = hashlib.sha256(data).hexdigest()[:16]
            rows_vus.add(str(ident))
            fichiers_vus.add(nom_fichier)
            existants.append({
                "id": f"kext99_{s['modality']}_{pris + 1:03d}",
                "modality": s["modality"],
                "dataset": f"{s['dataset']}#{s['config']}/{s['split']}",
                "row_id": str(ident),
                "file": f"public/multimodal-it90/{s['dir']}/{nom_fichier}",
                "bytes": octets,
                "sha256": sha16,
                "legende_reelle": legende[:400],
            })
            pris += 1
            ajoutes += 1
            print(f"  ✓ {nom_fichier} {octets} o — « {legende[:60]} »")
        if pris < s["n"]:
            print(f"  ⚠ {s['modality']} : seulement {pris}/{s['n']} assets valides récupérés")

    total_octets = sum(a["bytes"] for a in existants)
    inventaire["total_octets"] = total_octets
    inventaire["n"] = len(existants)
    with open(ASSETS, "w", encoding="utf-8") as f:
        json.dump(inventaire, f, ensure_ascii=False, indent=2)
    os.makedirs(os.path.dirname(MIROIR), exist_ok=True)
    with open(MIROIR, "w", encoding="utf-8") as f:
        json.dump(inventaire, f, ensure_ascii=False, indent=2)
    print(f"TOTAL : {len(existants)} assets HF, {total_octets} octets ({total_octets / 1e6:.1f} Mo) — +{ajoutes} nouveaux, miroir var-copie mis à jour")


if __name__ == "__main__":
    main()

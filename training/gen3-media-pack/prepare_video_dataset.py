#!/usr/bin/env python3
"""Préparation du dataset VIDÉO pour l'adaptation LoRA LTX-Video de gen3.

Entrée  : dossier de vidéos (.mp4/.webm/.mov/.mkv/.avi) avec légende :
          - fichier .txt de même nom par vidéo (ville.mp4 -> ville.txt), OU
          - metadata.csv (colonnes : file,caption) — même convention que train_av.py
Sortie  : data/video/train.jsonl + validation.jsonl
          {"video_path", "caption", "duration_sec", "fps", "width", "height", "sha256"}
Garanties : sondage ffprobe réel (durée/fps/résolution), dédoublonnage SHA-256,
bornes de durée configurables, split déterministe. Testable SANS torch (ffprobe).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import subprocess
from pathlib import Path

EXTENSIONS_VIDEO = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}
MIN_CAPTION_CAR = 3


def empreinte(fichier: Path) -> str:
    h = hashlib.sha256()
    with open(fichier, "rb") as f:
        for bloc in iter(lambda: f.read(1 << 20), b""):
            h.update(bloc)
    return h.hexdigest()


def probe_video(fichier: Path) -> dict:
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(fichier)]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    info = json.loads(out)
    flux_v = next((s for s in info["streams"] if s.get("codec_type") == "video"), None)
    if flux_v is None:
        raise ValueError("pas de flux vidéo")
    fps_brut = flux_v.get("avg_frame_rate") or flux_v.get("r_frame_rate") or "0/1"
    num, _, den = fps_brut.partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    duree = float(info["format"].get("duration") or flux_v.get("duration") or 0.0)
    if duree <= 0 or fps <= 0:
        raise ValueError(f"métadonnées incomplètes pour {fichier}")
    return {
        "duration_sec": round(duree, 3),
        "fps": round(fps, 3),
        "width": int(flux_v.get("width") or 0),
        "height": int(flux_v.get("height") or 0),
    }


def lire_captions(dossier: Path) -> dict[str, str]:
    captions: dict[str, str] = {}
    csv_meta = dossier / "metadata.csv"
    if csv_meta.exists():
        with open(csv_meta, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                fichier = (r.get("file") or r.get("path") or "").strip()
                texte = (r.get("caption") or r.get("text") or "").strip()
                if fichier and texte:
                    captions[fichier] = " ".join(texte.split())
    return captions


def caption_de(video: Path, captions: dict[str, str], dossier: Path) -> str:
    if video.name in captions:
        return captions[video.name]
    rel = str(video.relative_to(dossier))
    if rel in captions:
        return captions[rel]
    txt = video.with_suffix(".txt")
    if txt.exists():
        return " ".join(txt.read_text(encoding="utf-8", errors="replace").split())
    return ""


def construire_manifest(
    dossier: Path,
    duree_min: float = 1.0,
    duree_max: float = 60.0,
    fps_min: float = 8.0,
) -> list[dict]:
    videos = sorted(p for p in dossier.rglob("*") if p.suffix.lower() in EXTENSIONS_VIDEO)
    if not videos:
        raise SystemExit(f"Aucune vidéo trouvée dans {dossier} (extensions : {sorted(EXTENSIONS_VIDEO)})")

    captions = lire_captions(dossier)
    vus: set[str] = set()
    records: list[dict] = []
    rejetes = {"doublon": 0, "sans_caption": 0, "metadonnees": 0, "borne_duree": 0, "fps": 0}

    for video in videos:
        try:
            cle = empreinte(video)
            meta = probe_video(video)
        except Exception:
            rejetes["metadonnees"] += 1
            continue
        if cle in vus:
            rejetes["doublon"] += 1
            continue
        caption = caption_de(video, captions, dossier)
        if len(caption) < MIN_CAPTION_CAR:
            rejetes["sans_caption"] += 1
            continue
        if not (duree_min <= meta["duration_sec"] <= duree_max):
            rejetes["borne_duree"] += 1
            continue
        if meta["fps"] < fps_min:
            rejetes["fps"] += 1
            continue
        vus.add(cle)
        records.append(
            {
                "video_path": str(video.relative_to(dossier)),
                "caption": caption,
                **meta,
                "sha256": cle,
            }
        )

    if not records:
        raise SystemExit(
            f"Dataset vidéo vide après filtrage (rejets : {rejetes}). "
            "Ajoutez un fichier .txt de légende par vidéo (ou metadata.csv)."
        )
    total = sum(r["duration_sec"] for r in records)
    print(f"[video] retenus : {len(records)} ({total/60:.1f} min) | rejets : {rejetes}")
    return records


def split_jsonl(records: list[dict], sortie: Path, ratio_validation: float, graine: int = 42) -> None:
    rng = random.Random(graine)
    melanges = records[:]
    rng.shuffle(melanges)
    n_val = max(1, int(len(melanges) * ratio_validation)) if len(melanges) > 4 else 0
    val, train = melanges[:n_val], melanges[n_val:]
    sortie.mkdir(parents=True, exist_ok=True)
    for nom, part in (("train.jsonl", train), ("validation.jsonl", val)):
        chemin = sortie / nom
        with open(chemin, "w", encoding="utf-8") as f:
            for r in part:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"[video] {chemin} : {len(part)} exemples")


def main() -> None:
    p = argparse.ArgumentParser(description="Prépare le dataset vidéo (JSONL train/validation).")
    p.add_argument("--dossier", required=True)
    p.add_argument("--sortie", default="data/video")
    p.add_argument("--ratio_validation", type=float, default=0.1)
    p.add_argument("--duree_min", type=float, default=1.0)
    p.add_argument("--duree_max", type=float, default=60.0)
    p.add_argument("--fps_min", type=float, default=8.0)
    args = p.parse_args()

    dossier = Path(args.dossier)
    if not dossier.is_dir():
        raise SystemExit(f"Dossier introuvable : {dossier}")

    records = construire_manifest(dossier, args.duree_min, args.duree_max, args.fps_min)
    split_jsonl(records, Path(args.sortie), args.ratio_validation)


if __name__ == "__main__":
    main()

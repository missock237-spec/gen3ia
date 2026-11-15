#!/usr/bin/env python3
"""Préparation du dataset AUDIO parlé (français) pour l'entraînement TTS de gen3.

Entrée  : un dossier de fichiers audio (.wav/.mp3/.flac) avec transcription :
          - un fichier .txt de même nom par audio (phrase1.wav -> phrase1.txt), OU
          - un metadata.csv (colonnes : file,text) à la manière Common Voice.
Sorties : data/audio/train.jsonl + validation.jsonl
          {"audio_path", "text", "duration_sec", "sample_rate", "sha256"}
          data/audio/f5_train.csv (format F5-TTS : audio_path,text,duration) + wavs/
Garanties : durée calculée réellement (wave/ffmpeg), transcription non vide,
transcriptions de longueur cohérente avec la durée (garde-fou anti-alignement faux),
split déterministe. Noyau testable SANS torch (ffmpeg/wave uniquement).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import subprocess
import sys
import wave
from pathlib import Path

EXTENSIONS_AUDIO = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
MIN_TEXTE_CAR = 2
SECONDE_PAR_CAR = 0.055  # ~11 chars/s parole française ; garde-fou large (x4)


def empreinte(fichier: Path) -> str:
    h = hashlib.sha256()
    with open(fichier, "rb") as f:
        for bloc in iter(lambda: f.read(1 << 20), b""):
            h.update(bloc)
    return h.hexdigest()


def probe_audio(fichier: Path) -> tuple[float, int]:
    """(durée_s, fréquence) via wave pour .wav, ffprobe sinon."""
    if fichier.suffix.lower() == ".wav":
        try:
            with wave.open(str(fichier), "rb") as wf:
                return round(wf.getnframes() / wf.getframerate(), 3), wf.getframerate()
        except wave.Error:
            pass  # wav exotique -> ffprobe
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(fichier)
    ]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    info = json.loads(out)
    flux = next(s for s in info["streams"] if s.get("codec_type") == "audio")
    duree = float(info["format"].get("duration") or flux.get("duration") or 0.0)
    frequence = int(flux.get("sample_rate") or 0)
    if duree <= 0:
        raise ValueError(f"durée introuvable pour {fichier}")
    return round(duree, 3), frequence


def lire_transcriptions(dossier: Path) -> dict[str, str]:
    """Charge les transcriptions : fichiers .txt côte à côte OU metadata.csv."""
    transcriptions: dict[str, str] = {}
    csv_meta = dossier / "metadata.csv"
    if csv_meta.exists():
        with open(csv_meta, encoding="utf-8", newline="") as f:
            echantillon = f.read(4096)
        f.seek(0)
        dialecte = csv.Sniffer().sniff(echantillon, delimiters=",;\t") if echantillon else csv.excel
        lecteur = csv.reader(f, dialecte)
        premiere = next(lecteur, None)
        if premiere and any(c.strip().lower() in {"file", "path", "audio"} for c in premiere):
            i_file = next(i for i, c in enumerate(premiere) if c.strip().lower() in {"file", "path", "audio"})
            i_text = next(i for i, c in enumerate(premiere) if c.strip().lower() in {"text", "sentence", "transcript"})
            for ligne in lecteur:
                if len(ligne) > max(i_file, i_text):
                    transcriptions[ligne[i_file].strip()] = " ".join(ligne[i_text].split())
        else:  # format 2 colonnes sans en-tête
            if premiere:
                transcriptions[premiere[0].strip()] = " ".join(premiere[-1].split())
            for ligne in lecteur:
                if len(ligne) >= 2:
                    transcriptions[ligne[0].strip()] = " ".join(ligne[-1].split())
    return transcriptions


def legende_de(audio: Path, transcriptions: dict[str, str]) -> str:
    rel = str(audio.relative_to(dossier_parent(audio)))
    nom = audio.stem + ".txt"
    candidats = [
        transcriptions.get(rel),
        transcriptions.get(audio.name),
        (audio.with_suffix(".txt")).read_text(encoding="utf-8", errors="replace")
        if (audio.with_suffix(".txt")).exists() else "",
    ]
    for c in candidats:
        if c and c.strip():
            return " ".join(c.split())
    return ""


def dossier_parent(p: Path) -> Path:
    return p if p.is_dir() else p.parent


def construire_manifest(dossier: Path, duree_min: float = 0.5, duree_max: float = 30.0) -> list[dict]:
    audios = sorted(p for p in dossier.rglob("*") if p.suffix.lower() in EXTENSIONS_AUDIO)
    if not audios:
        raise SystemExit(f"Aucun audio trouvé dans {dossier}")

    transcriptions = lire_transcriptions(dossier)
    vus: set[str] = set()
    records: list[dict] = []
    rejetes = {"doublon": 0, "sans_texte": 0, "duree": 0, "incoherent": 0, "illisible": 0}

    for audio in audios:
        try:
            cle = empreinte(audio)
            duree, frequence = probe_audio(audio)
        except Exception:
            rejetes["illisible"] += 1
            continue
        if cle in vus:
            rejetes["doublon"] += 1
            continue
        texte = legende_de(audio, transcriptions)
        if len(texte) < MIN_TEXTE_CAR:
            rejetes["sans_texte"] += 1
            continue
        if not (duree_min <= duree <= duree_max):
            rejetes["duree"] += 1
            continue
        # Garde-fou : texte trop long pour la durée = mauvais alignement probable.
        if len(texte) > max(60, duree / SECONDE_PAR_CAR * 4):
            rejetes["incoherent"] += 1
            continue
        vus.add(cle)
        records.append(
            {
                "audio_path": str(audio.relative_to(dossier)),
                "text": texte,
                "duration_sec": duree,
                "sample_rate": frequence,
                "sha256": cle,
            }
        )

    if not records:
        raise SystemExit(f"Dataset audio vide après filtrage (rejets : {rejetes}).")
    total = sum(r["duration_sec"] for r in records)
    print(f"[audio] retenus : {len(records)} ({total/60:.1f} min) | rejets : {rejetes}")
    return records


def exporter_f5(records: list[dict], dossier: Path, sortie: Path) -> None:
    """CSV format F5-TTS : audio_path (relatif wavs/),text,duration ; chemins résolus."""
    (sortie / "wavs").mkdir(parents=True, exist_ok=True)
    chemin_csv = sortie / "f5_train.csv"
    n = 0
    with open(chemin_csv, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["audio_path", "text", "duration"])
        for r in records:
            src = dossier / r["audio_path"]
            dst = sortie / "wavs" / (Path(r["audio_path"]).stem + ".wav")
            try:
                if src.suffix.lower() == ".wav" and r["sample_rate"] == 24000:
                    dst.write_bytes(src.read_bytes())
                else:
                    subprocess.run(
                        ["ffmpeg", "-y", "-v", "quiet", "-i", str(src),
                         "-ac", "1", "-ar", "24000", str(dst)],
                        check=True,
                    )
            except Exception:
                continue  # conversion impossible : écarté du CSV, le JSONL garde tout
            w.writerow([f"wavs/{dst.name}", r["text"], r["duration_sec"]])
            n += 1
    print(f"[audio] {chemin_csv} : {n} lignes (format F5-TTS, 24 kHz mono)")


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
        print(f"[audio] {chemin} : {len(part)} exemples")


def main() -> None:
    p = argparse.ArgumentParser(description="Prépare le dataset audio parlé (JSONL + CSV F5-TTS).")
    p.add_argument("--dossier", required=True)
    p.add_argument("--sortie", default="data/audio")
    p.add_argument("--ratio_validation", type=float, default=0.05)
    p.add_argument("--duree_min", type=float, default=0.5)
    p.add_argument("--duree_max", type=float, default=30.0)
    p.add_argument("--pas_f5", action="store_true", help="Ne pas générer le CSV format F5-TTS.")
    args = p.parse_args()

    dossier = Path(args.dossier)
    sortie = Path(args.sortie)
    if not dossier.is_dir():
        raise SystemExit(f"Dossier introuvable : {dossier}")

    records = construire_manifest(dossier, args.duree_min, args.duree_max)
    split_jsonl(records, sortie, args.ratio_validation)
    if not args.pas_f5:
        exporter_f5(records, dossier, sortie)


if __name__ == "__main__":
    main()

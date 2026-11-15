#!/usr/bin/env python3
"""Générateur de plans d'entraînement gen3 — le « cerveau de préparation » qui
complète l'orchestrateur gen3_multimodal_trainer.py.

Ce que fait ce script :
  1. ANALYSE le dataset de l'utilisateur (fichiers réels : dimensions d'images,
     durées d'audio via wave, durées/résolutions de vidéo via ffprobe quand
     disponible, couverture des captions).
  2. CHOISIT un plan d'entraînement cohérent : trainer administrateur adapté à
     la modalité, hyperparamètres par palier de VRAM (convention gen3 l4 /
     a100_40g), cadence de checkpoints, estimation de durée (ordre de grandeur
     HONNÊTE : hypothèse affichée, jamais une mesure).
  3. ÉCRIT un plan JSON (--output) et, optionnellement, une configuration de
     job PRÊTE pour l'orchestrateur (--write-config) : chaîne complète
     « plan → validate → run ».

Ce que ce script ne fait PAS : deviner la compatibilité exacte
modèle↔trainer (c'est à l'administrateur de valider), ni mesurer des
performances (le bench réel appartient au trainer/pack concerné).

Exemples :
  python plan_gen3.py --modality image --dataset datasets/user_123/portraits \
      --gpu-vram-gb 24 --owner user_123 --job-id img_001 \
      --output plan.json --write-config job.img_001.json
  python plan_gen3.py --modality audio --dataset datasets/user_123/voix \
      --gpu-vram-gb auto            # nécessite torch+CUDA ici
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MEDIA_EXTENSIONS = {
    "image": {".jpg", ".jpeg", ".png", ".webp", ".bmp"},
    "audio": {".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac"},
    "video": {".mp4", ".mov", ".mkv", ".webm", ".avi"},
}

TRAINER_PAR_MODALITE = {
    "image": "image/train_model.py",
    "audio": "audio/train_model.py",
    "video": "video/train_model.py",
}

# Convention gen3 (cf. packs image/média/code) : paliers par VRAM totale.
# Planchers PAR MODALITÉ (le plan refuse poliment en dessous).
PALIERS = {
    "image": {
        "l4": {"vram_min_go": 20, "resolution": 768, "batch": 1, "accum": 4,
               "lr": "1e-4", "lora": {"r": 16, "alpha": 32},
               "description": "SD-family/UNet LoRA 768 px — L4 24 Go / RTX 4090"},
        "a100_40g": {"vram_min_go": 36, "resolution": 1024, "batch": 2, "accum": 2,
                     "lr": "1e-4", "lora": {"r": 32, "alpha": 64},
                     "description": "LoRA 1024 px batch 2 — A100 40 Go"},
    },
    "audio": {
        "l4": {"vram_min_go": 12, "batch": 4, "accum": 1, "lr": "1e-4",
               "description": "TTS (SpeechT5) LoRA batch 4 — L4 / T4+ / 4090"},
        "a100_40g": {"vram_min_go": 36, "batch": 16, "accum": 1, "lr": "1e-4",
                     "description": "TTS LoRA batch 16 — A100 40 Go"},
    },
    "video": {
        "l4": {"vram_min_go": 22, "resolution": [480, 288], "frames": 41, "batch": 1,
               "accum": 4, "lr": "1e-5", "lora": {"r": 16, "alpha": 32},
               "description": "LTX-Video LoRA 480x288x41 — L4 24 Go"},
        "a100_40g": {"vram_min_go": 36, "resolution": [704, 448], "frames": 57, "batch": 1,
                     "accum": 2, "lr": "1e-5", "lora": {"r": 32, "alpha": 64},
                     "description": "LTX-Video LoRA 704x448x57 — A100 40 Go"},
    },
}

# Estimation grossière second/étape sur L4 — HYPOTHÈSE affichée dans le plan,
# à confirmer par un vrai run court (300 étapes) avant un long entraînement.
S_PAR_ETAPE_HYPOTHESE = {
    "image": 3.0,   # LoRA UNet 768 px, batch 1, fp16
    "audio": 1.5,   # SpeechT5 spectrogramme, batch 4
    "video": 9.0,   # LTX 480x288x41, batch 1
}


def vram_auto_go() -> float | None:
    """VRAM du GPU 0 via torch, ou None (torch importé paresseusement)."""
    try:
        import torch
    except ImportError:
        return None
    if not torch.cuda.is_available():
        return None
    return round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 1)


def choisir_paliere(modality: str, vram_go: float) -> tuple[str, dict]:
    p = PALIERS[modality]
    if vram_go >= p["a100_40g"]["vram_min_go"]:
        return "a100_40g", p["a100_40g"]
    if vram_go >= p["l4"]["vram_min_go"]:
        return "l4", p["l4"]
    raise SystemExit(
        f"REFUS : {vram_go} Go VRAM < plancher {modality} ({p['l4']['vram_min_go']} Go). "
        "Aucun plan raisonnable pour ce GPU — utilisez un GPU plus grand.")


def lister_medias(dataset: Path, modality: str) -> list[Path]:
    exts = MEDIA_EXTENSIONS[modality]
    return sorted(p for p in dataset.rglob("*")
                  if p.is_file() and p.suffix.lower() in exts)


def caption_de(media: Path) -> str | None:
    """Caption = fichier .txt de même stem à côté du média (convention diffusers)."""
    txt = media.with_suffix(".txt")
    if txt.is_file():
        texte = txt.read_text(encoding="utf-8", errors="replace").strip()
        return texte or None
    return None


def analyser_image(dataset: Path) -> tuple[dict, list[str]]:
    """Dimensions réelles via PIL (optionnel) + couverture captions."""
    avertissements: list[str] = []
    medias = lister_medias(dataset, "image")
    tailles: list[tuple[int, int]] = []
    dims_ok = 0
    try:
        from PIL import Image  # optionnel
        for media in medias:
            try:
                with Image.open(media) as img:
                    tailles.append(img.size)
                dims_ok += 1
            except Exception:
                avertissements.append(f"image illisible ignorée : {media.name}")
    except ImportError:
        avertissements.append("PIL absent : dimensions non analysées (plan moins précis).")

    captions = [caption_de(m) for m in medias]
    avec_caption = sum(1 for c in captions if c)
    details = {
        "fichiers": len(medias),
        "dimensions_lues": dims_ok,
        "taille_moyenne": (round(statistics.mean(w for w, _ in tailles)),
                           round(statistics.mean(h for _, h in tailles))) if tailles else None,
        "captions": avec_caption,
    }
    if medias and avec_caption < len(medias):
        avertissements.append(
            f"captions : {avec_caption}/{len(medias)} images ont un .txt de même nom — "
            "sans caption le LoRA apprendra un style générique, pas votre sujet.")
    if 0 < len(medias) < 15:
        avertissements.append(
            f"dataset petit ({len(medias)} fichiers) : LoRA d'identité envisageable, "
            "montée en généralité non — visez 30-200+ images.")
    return details, avertissements


def analyser_audio(dataset: Path) -> tuple[dict, list[str]]:
    """Durées/échantillonnages réels via wave (stdlib) sur les .wav."""
    avertissements: list[str] = []
    medias = lister_medias(dataset, "audio")
    durees: list[float] = []
    echantillonnages: set[int] = set()
    wavs = [m for m in medias if m.suffix.lower() == ".wav"]
    for wav in wavs:
        try:
            import wave
            with wave.open(str(wav), "rb") as w:
                durees.append(w.getnframes() / max(w.getframerate(), 1))
                echantillonnages.add(w.getframerate())
        except (wave.Error, EOFError, OSError):
            avertissements.append(f"wav illisible ignoré : {wav.name}")
    non_wav = len(medias) - len(wavs)
    if non_wav:
        avertissements.append(
            f"{non_wav} fichier(s) non-wav : durée non analysée ici ; "
            "le trainer attend des .wav + metadata.csv (voir README).")

    metadata = dataset / "metadata.csv"
    n_manifest = 0
    if metadata.is_file():
        try:
            n_manifest = sum(1 for ligne in metadata.read_text(encoding="utf-8").splitlines()
                             if ligne.strip()) - 1
        except OSError:
            pass
    else:
        avertissements.append(
            "metadata.csv absent : le trainer TTS (audio/train_model.py) exige "
            "un CSV file_name,text — le plan reste valable mais le run échouera sans lui.")

    details = {
        "fichiers": len(medias),
        "wav_analyses": len(durees),
        "duree_totale_s": round(sum(durees), 1) if durees else None,
        "duree_mediane_s": round(statistics.median(durees), 1) if durees else None,
        "echantillonnages": sorted(echantillonnages),
        "lignes_manifest": max(n_manifest, 0),
    }
    if durees and statistics.median(durees) > 20:
        avertissements.append(
            "clips longs (médiane > 20 s) : découpez en phrases de 2-12 s pour un TTS stable.")
    return details, avertissements


def analyser_video(dataset: Path) -> tuple[dict, list[str]]:
    """Durées/résolutions via ffprobe (optionnel)."""
    avertissements: list[str] = []
    medias = lister_medias(dataset, "video")
    durees: list[float] = []
    largeurs: list[int] = []
    ffprobe = shutil.which("ffprobe")
    for media in medias:
        if not ffprobe:
            avertissements.append("ffprobe absent : durées/résolutions non analysées.")
            break
        try:
            r = subprocess.run(
                [ffprobe, "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=width,height,duration",
                 "-of", "json", str(media)],
                capture_output=True, text=True, timeout=30)
            flux = json.loads(r.stdout or "{}").get("streams", [{}])[0]
            if flux.get("width"):
                largeurs.append(int(flux["width"]))
            if flux.get("duration"):
                durees.append(float(flux["duration"]))
            else:
                r2 = subprocess.run(
                    [ffprobe, "-v", "error", "-show_entries", "format=duration",
                     "-of", "json", str(media)],
                    capture_output=True, text=True, timeout=30)
                d = json.loads(r2.stdout or "{}").get("format", {}).get("duration")
                if d:
                    durees.append(float(d))
        except (subprocess.TimeoutExpired, json.JSONDecodeError, ValueError):
            avertissements.append(f"analyse ffprobe échouée : {media.name}")

    captions = sum(1 for m in medias if caption_de(m))
    details = {
        "fichiers": len(medias),
        "duree_totale_s": round(sum(durees), 1) if durees else None,
        "duree_mediane_s": round(statistics.median(durees), 1) if durees else None,
        "largeur_moyenne": round(statistics.mean(largeurs)) if largeurs else None,
        "captions": captions,
    }
    if medias and captions < len(medias):
        avertissements.append(
            f"captions : {captions}/{len(medias)} clips ont un .txt de même nom — "
            "le trainer vidéo LoRA exige une caption par clip.")
    return details, avertissements


def construire_plan(modality: str, dataset_details: dict, nom_paliere: str,
                    paliere: dict, vram_go: float, nb_medias: int) -> dict:
    """Plan d'entraînement : hyperparamètres + estimation honnête."""
    if modality == "image":
        steps = max(300, min(2000, nb_medias * 25))
        hyper = {
            "train_batch_size": paliere["batch"],
            "gradient_accumulation_steps": paliere["accum"],
            "learning_rate": paliere["lr"],
            "max_train_steps": steps,
            "resolution": min(paliere["resolution"], 512) if nb_medias < 10 else paliere["resolution"],
            "lora_r": paliere["lora"]["r"],
            "lora_alpha": paliere["lora"]["alpha"],
            "checkpointing_steps": 100,
        }
    elif modality == "audio":
        minutes_audio = (dataset_details.get("duree_totale_s") or 0) / 60
        steps = max(300, min(3000, int(minutes_audio * 40)))
        hyper = {
            "train_batch_size": paliere["batch"],
            "gradient_accumulation_steps": 1,
            "learning_rate": paliere["lr"],
            "max_train_steps": steps,
            "checkpointing_steps": 100,
        }
    else:  # video
        duree_tot = dataset_details.get("duree_totale_s") or 0
        n_clips = max(dataset_details.get("fichiers", 0), 1)
        cycles = max(20, min(150, int(duree_tot / n_clips / 5) * n_clips))
        steps = max(200, min(1500, cycles))
        hyper = {
            "train_batch_size": 1,
            "gradient_accumulation_steps": paliere["accum"],
            "learning_rate": paliere["lr"],
            "max_train_steps": steps,
            "width": paliere["resolution"][0],
            "height": paliere["resolution"][1],
            "num_frames": paliere["frames"],
            "lora_r": paliere["lora"]["r"],
            "lora_alpha": paliere["lora"]["alpha"],
            "checkpointing_steps": 50,
        }

    s_etape = S_PAR_ETAPE_HYPOTHESE[modality]
    minutes = round(steps * s_etape * hyper.get("gradient_accumulation_steps", 1) / 60)
    return {
        "trainer_script": TRAINER_PAR_MODALITE[modality],
        "launcher": "accelerate",
        "allow_cpu": False,
        "gpu_conseil": {
            "profil": nom_paliere,
            "vram_detectee_go": vram_go,
            "description": paliere["description"],
        },
        "hyperparametres": hyper,
        "estimation": {
            "minutes": minutes,
            "nature": "ORDRE DE GRANDEUR (hypothèse s/étape affichée) — validez par un run court de 300 étapes avant un long job.",
            "hypothese_s_par_etape": s_etape,
        },
        "checkpoints": "Sauvegardés dans output_dir ; relancez avec --resume du trainer pour reprendre.",
    }


def construire_job_config(modality: str, owner: str, job_id: str,
                          plan: dict, model_path: str, dataset_rel: str,
                          output_dir_rel: str, runtime_minutes: int) -> dict:
    """Config de job PRÊTE pour gen3_multimodal_trainer.py (placeholders inclus)."""
    hyper = plan["hyperparametres"]
    if modality == "image":
        paires_args = [
            ("--pretrained_model_name_or_path", "{model_path}"),
            ("--train_data_dir", "{dataset_path}"),
            ("--output_dir", "{output_dir}"),
            ("--train_batch_size", hyper["train_batch_size"]),
            ("--gradient_accumulation_steps", hyper["gradient_accumulation_steps"]),
            ("--learning_rate", hyper["learning_rate"]),
            ("--max_train_steps", hyper["max_train_steps"]),
            ("--resolution", hyper["resolution"]),
        ]
    elif modality == "audio":
        paires_args = [
            ("--model_name_or_path", "{model_path}"),
            ("--train_dataset", "{dataset_path}"),
            ("--output_dir", "{output_dir}"),
            ("--learning_rate", hyper["learning_rate"]),
            ("--max_steps", hyper["max_train_steps"]),
            ("--batch_size", hyper["train_batch_size"]),
        ]
    else:  # video
        paires_args = [
            ("--pretrained_model_name_or_path", "{model_path}"),
            ("--dataset_dir", "{dataset_path}"),
            ("--output_dir", "{output_dir}"),
            ("--train_batch_size", hyper["train_batch_size"]),
            ("--gradient_accumulation_steps", hyper["gradient_accumulation_steps"]),
            ("--learning_rate", hyper["learning_rate"]),
            ("--max_train_steps", hyper["max_train_steps"]),
            ("--width", hyper["width"]),
            ("--height", hyper["height"]),
            ("--num_frames", hyper["num_frames"]),
        ]
    args: list = []
    for cle, valeur in paires_args:
        args.extend([cle, valeur])
    return {
        "owner_id": owner,
        "job_id": job_id,
        "modality": modality,
        "task": {"image": "image_generation_lora",
                 "audio": "audio_finetune",
                 "video": "video_lora"}[modality],
        "model_path": model_path,
        "dataset_path": dataset_rel,
        "output_dir": output_dir_rel,
        "trainer_script": plan["trainer_script"],
        "launcher": plan["launcher"],
        "runtime_minutes": runtime_minutes,
        "min_gpu_memory_gb": {"image": 16, "audio": 12, "video": 22}[modality],
        "allow_cpu": False,
        "allow_overwrite_output": False,
        "training_args": args,
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Génère un plan d'entraînement gen3 (+ job config pour l'orchestrateur).")
    p.add_argument("--modality", required=True, choices=["image", "audio", "video"])
    p.add_argument("--dataset", required=True,
                   help="Chemin du dataset (absolu ou relatif au cwd — analyse directe).")
    p.add_argument("--owner", default="user_123", help="owner_id du job généré.")
    p.add_argument("--job-id", default=None, help="job_id du job généré (défaut : <modality>_plan_001).")
    p.add_argument("--model", default="MODELE_A_PRECISER",
                   help="Chemin du modèle de base (relatif à models/<owner>/ dans le job généré).")
    p.add_argument("--gpu-vram-gb", default="auto",
                   help="VRAM totale en Go ('auto' = torch/CUDA ici, ou un nombre pour planifier une autre machine).")
    p.add_argument("--output", default=None, help="Fichier plan JSON (défaut : plan_<modality>.json).")
    p.add_argument("--write-config", default=None,
                   help="Écrit aussi une config de job prête pour gen3_multimodal_trainer.py.")
    p.add_argument("--runtime-minutes", type=int, default=120)
    p.add_argument("--root", default="./gen3_data",
                   help="Racine Gen3, utilisée pour les chemins relatifs du job généré.")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    dataset = Path(args.dataset).expanduser().resolve()
    if not dataset.is_dir():
        print(f"Dataset introuvable ou non-répertoire : {dataset}", file=sys.stderr)
        return 2

    if str(args.gpu_vram_gb).lower() == "auto":
        vram = vram_auto_go()
        if vram is None:
            print("REFUS : --gpu-vram-gb auto exige torch+CUDA ici. Passez un nombre "
                  "explicite pour planifier une autre machine (ex. 24).", file=sys.stderr)
            return 2
    else:
        vram = float(args.gpu_vram_gb)
        if vram <= 0:
            print("--gpu-vram-gb doit être > 0.", file=sys.stderr)
            return 2

    nom_paliere, paliere = choisir_paliere(args.modality, vram)

    if args.modality == "image":
        details, avertissements = analyser_image(dataset)
    elif args.modality == "audio":
        details, avertissements = analyser_audio(dataset)
    else:
        details, avertissements = analyser_video(dataset)
    if details.get("fichiers", 0) == 0:
        exts = ", ".join(sorted(MEDIA_EXTENSIONS[args.modality]))
        print(f"Aucun média {args.modality} détecté (extensions : {exts}).", file=sys.stderr)
        return 1

    nb = details["fichiers"]
    plan = construire_plan(args.modality, details, nom_paliere, paliere, vram, nb)
    job_id = args.job_id or f"{args.modality}_plan_001"
    dataset_rel = str(dataset.name)
    job = construire_job_config(
        args.modality, args.owner, job_id, plan,
        model_path=str(args.model), dataset_rel=dataset_rel,
        output_dir_rel=job_id, runtime_minutes=args.runtime_minutes)

    rapport = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "modality": args.modality,
        "dataset": {"chemin": str(dataset), **details},
        "plan": plan,
        "avertissements": avertissements,
        "job_config": job,
        "note_securite": "Le trainer est un script installé par l'administrateur sous trainers/ ; "
                         "l'utilisateur ne fournit JAMAIS de code Python exécutable.",
    }

    sortie = Path(args.output) if args.output else Path(f"plan_{args.modality}.json")
    sortie.write_text(json.dumps(rapport, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Plan écrit : {sortie}")
    print(f"  modalité {args.modality} · {nb} média(s) · profil {nom_paliere} ({vram} Go)")
    print(f"  trainer : {plan['trainer_script']} · steps {plan['hyperparametres'].get('max_train_steps')}"
          f" · estimation ~{plan['estimation']['minutes']} min (ordre de grandeur)")
    for a in avertissements[:6]:
        print(f"  ⚠ {a}")
    if args.write_config:
        Path(args.write_config).write_text(
            json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Job config écrite : {args.write_config} "
              f"(utilisez-la avec gen3_multimodal_trainer.py validate puis run)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

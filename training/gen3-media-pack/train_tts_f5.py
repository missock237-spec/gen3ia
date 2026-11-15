#!/usr/bin/env python3
"""Entraînement TTS PARLÉ gen3 — adaptation F5-TTS sur voix française (GPU obligatoire).

Principe honnête :
  * F5-TTS (SWivid) est un modèle de synthèse PARLÉE pré-entraîné avec clonage de voix
    à partir de quelques secondes d'audio de référence.
  * gen3 ne "crée" pas une voix from scratch : il ADAPTE la base F5-TTS à vos
    enregistrements français (fine-tuning) via le pipeline officiel du paquet f5-tts.
  * LICENCE des poids de base : CC-BY-NC-4.0 (non commercial). L'adaptateur produit
    hérite de cette restriction — pour un usage commercial, prévoir une base Apache
    (ex. Kokoro-82M, fourni comme moteur d'inférence alternatif dans infer_media.py).

Pipeline :
  1) prepare_audio_dataset.py --dossier voix/ --sortie data/audio  (JSONL + f5_train.csv)
  2) python train_tts_f5.py --data data/audio --profil auto        (fine-tune via f5-tts)
  3) python infer_media.py tts --texte "Bonjour" --ref voix/ref.wav

Le wrapper vérifie GPU, choisit les hyper-paramètres du profil, prépare le vocabulaire,
lance le CLI officiel de finetuning en subprocess (échec = message clair, jamais muet),
et vérifie que l'adaptateur final existe.
"""

from __future__ import annotations

import argparse
import csv
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from profils import ErreurProfil, select_profile  # noqa: E402

PAQUET_F5 = "f5-tts"
BASE_F5_DEFAUT = "SWivid/F5-TTS"  # F5TTS_v1_Base (CC-BY-NC-4.0)


def exiger_cuda() -> None:
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("GPU CUDA requis pour le fine-tuning TTS de gen3 (CPU refusé).")


def verifier_paquet() -> str:
    """Retourne la version de f5-tts installée, ou échec avec instruction claire."""
    import importlib.metadata as md

    try:
        return md.version(PAQUET_F5)
    except md.PackageNotFoundError as e:
        raise SystemExit(
            f"Le paquet {PAQUET_F5} n'est pas installé. Sur Colab : "
            f"!pip install -q {PAQUET_F5}==1.1.22  (voir requirements.txt)"
        ) from e


def verifier_csv_f5(dossier: Path) -> Path:
    csv_chemin = dossier / "f5_train.csv"
    if not csv_chemin.exists():
        raise SystemExit(
            f"{csv_chemin} introuvable. Lancez d'abord : "
            f"python prepare_audio_dataset.py --dossier <vos_audios> --sortie {dossier}"
        )
    with open(csv_chemin, encoding="utf-8") as f:
        lignes = sum(1 for _ in f) - 1
    if lignes < 8:
        raise SystemExit(
            f"Seulement {lignes} exemples dans {csv_chemin.name} : insuffisant pour un "
            "fine-tuning utile (minimum conseillé : 40 clips; 2-10 min de parole nette)."
        )
    print(f"[tts] {lignes} exemples prêts dans {csv_chemin}")
    return csv_chemin


def lancer_finetune(args, csv_chemin: Path, sortie: Path) -> None:
    """Lance le CLI officiel de finetuning f5-tts en subprocess (échec visible)."""
    _, profil = select_profile(args.profil)
    cfg = profil["tts"]

    cmd = [
        sys.executable, "-m", "f5_tts.train.finetune_cli",
        "--model", args.base_model,
        "--exp_name", args.experience,
        "--dataset_name", "custom_f5_fr",
        "--files", f"metas_path={csv_chemin}",
        "--learning_rate", str(cfg["lr"]),
        "--batch_size", str(cfg["batch"]),
        "--batch_size_type", "sample",
        "--max_samples", "64",
        "--grad_accumulation_steps", str(cfg["gradient_accumulation"]),
        "--epochs", str(args.epochs),
        "--num_warmup_updates", str(args.warmup),
        "--save_per_updates", str(args.save_every),
        "--last_per_updates", str(args.save_every),
        "--mixed_precision", "bf16",
        "--logger", "none",
        "--finetune",
        "--dataset_dir", str(csv_chemin.parent),
    ]
    if args.resume:
        cmd += ["--resume", str(args.resume)]

    print("[tts] commande :", " ".join(cmd))
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError as e:
        raise SystemExit(
            "CLI de finetuning introuvable (python -m f5_tts.train.finetune_cli). "
            "Vérifiez l'installation du paquet f5-tts (requirements.txt, version épinglée)."
        ) from e
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"Le finetuning f5-tts a échoué (code {e.returncode}) — voir le journal ci-dessus.") from e


def verifier_adaptateur(sortie: Path, experience: str) -> Path:
    candidats = sorted(
        sortie.glob(f"{experience}/**/model_*.safetensors")
    ) + sorted(sortie.glob(f"{experience}/model_last.pt"))
    if not candidats:
        raise SystemExit("Aucun adaptateur TTS trouvé après entraînement — vérifier le journal.")
    final = candidats[-1]
    print(f"[tts] adaptateur final : {final}")
    return final


def main() -> None:
    p = argparse.ArgumentParser(description="Fine-tuning F5-TTS gen3 — voix française parlée (GPU).")
    p.add_argument("--data", default="data/audio", help="Sortie de prepare_audio_dataset.py.")
    p.add_argument("--profil", choices=["auto", "l4", "a100_40g"], default="auto")
    p.add_argument("--base_model", default=BASE_F5_DEFAUT)
    p.add_argument("--experience", default="gen3ia-tts-fr")
    p.add_argument("--epochs", type=int, default=6)
    p.add_argument("--warmup", type=int, default=50)
    p.add_argument("--save_every", type=int, default=2)
    p.add_argument("--sortie", default="sorties/gen3ia-tts")
    p.add_argument("--resume", default=None)
    args = p.parse_args()

    try:
        version = verifier_paquet()
        print(f"[tts] f5-tts {version} détecté")
        exiger_cuda()
        csv_chemin = verifier_csv_f5(Path(args.data))
        lancer_finetune(args, csv_chemin, Path(args.sortie))
        verifier_adaptateur(Path(args.sortie), args.experience)
    except RuntimeError as e:
        print(f"REFUS : {e}")
        raise SystemExit(2)


if __name__ == "__main__":
    main()

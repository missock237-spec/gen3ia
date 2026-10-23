#!/usr/bin/env python3
"""Trainer audio gen3 — fine-tune TTS (SpeechT5) avec LoRA (transformers).

Script « administrateur » appelé par gen3_multimodal_trainer.py. CLI standard
attendue par job.audio.example.json :

  accelerate launch trainers/audio/train_model.py \
      --model_name_or_path {model_path} \
      --train_dataset {dataset_path} \
      --output_dir {output_dir} \
      --learning_rate 1e-4 --max_steps 500

Dataset attendu : dossier avec
  * des fichiers .wav (mono, 16 kHz recommandé),
  * un `metadata.csv` (UTF-8) d'en-tête `file_name,text` — une ligne par wav,
    ex. : voix_001.wav,"Bonjour et bienvenue chez gen3."

Base recommandée : `microsoft/speecht5_tts` (licence MIT) + vocoder
`microsoft/speecht5_hifigan` à l'INFÉRENCE (pas requis pour l'entraînement).
Honnêteté : SpeechT5 donne une voix de base correcte mais datée ; pour un TTS
parlé de meilleure qualité, voir le pack média gen3 (F5-TTS / Kokoro).

Refus propre sans CUDA. Checkpoints + reprise (--resume). Produit un
adaptateur LoRA à charger sur la base d'origine.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Trainer TTS gen3 (SpeechT5 + LoRA, GPU requis).")
    p.add_argument("--model_name_or_path", default="microsoft/speecht5_tts",
                   help="Base TTS transformers (défaut microsoft/speecht5_tts).")
    p.add_argument("--train_dataset", required=True,
                   help="Dossier : fichiers .wav + metadata.csv (file_name,text).")
    p.add_argument("--output_dir", required=True)
    p.add_argument("--learning_rate", default="1e-4")
    p.add_argument("--max_steps", type=int, default=500)
    p.add_argument("--batch_size", type=int, default=2)
    p.add_argument("--gradient_accumulation_steps", type=int, default=1)
    p.add_argument("--checkpointing_steps", type=int, default=100)
    p.add_argument("--resume", action="store_true")
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def lire_manifest(dataset: Path) -> list[tuple[Path, str]]:
    """Paires (wav, texte) réelles depuis metadata.csv — pure, testable sans torch.

    Vérifie l'existence réelle de chaque fichier et refuse les incohérences
    (CSV absent, wav manquant, texte vide).
    """
    if not dataset.is_dir():
        raise ValueError(f"Dataset introuvable : {dataset}")
    metadata = dataset / "metadata.csv"
    if not metadata.is_file():
        raise ValueError(
            f"metadata.csv absent dans {dataset} — format requis : file_name,text "
            "(une ligne par .wav).")
    paires: list[tuple[Path, str]] = []
    manquants: list[str] = []
    with metadata.open("r", encoding="utf-8") as f:
        lecteur = csv.DictReader(f)
        colonnes = lecteur.fieldnames or []
        if "file_name" not in colonnes or "text" not in colonnes:
            raise ValueError(
                f"metadata.csv : en-têtes attendus 'file_name,text', trouvés {colonnes}")
        for ligne in lecteur:
            nom = (ligne.get("file_name") or "").strip()
            texte = (ligne.get("text") or "").strip()
            if not nom or not texte:
                continue
            wav = dataset / nom
            if not wav.is_file():
                manquants.append(nom)
                continue
            paires.append((wav, texte))
    if manquants:
        raise ValueError(
            f"{len(manquants)} fichier(s) déclaré(s) dans metadata.csv mais absent(s) : "
            f"{manquants[:3]}")
    if not paires:
        raise ValueError("Aucune paire (wav, texte) exploitable dans metadata.csv.")
    return paires


def dernier_checkpoint(output_dir: Path) -> Path | None:
    if not output_dir.is_dir():
        return None
    points = sorted(output_dir.glob("checkpoint-*"),
                    key=lambda p: int(p.name.split("-")[-1]) if p.name.split("-")[-1].isdigit() else -1)
    return points[-1] if points else None


def charger_derniere_etape(checkpoint: Path | None) -> int:
    if checkpoint is None:
        return 0
    fichier = checkpoint / "trainer_state.json"
    if fichier.is_file():
        try:
            return int(json.loads(fichier.read_text(encoding="utf-8")).get("global_step", 0))
        except (json.JSONDecodeError, ValueError):
            pass
    nom = checkpoint.name
    return int(nom.split("-")[-1]) if nom.split("-")[-1].isdigit() else 0


def charger_waveform_mono(chemin: Path, cible_hz: int):
    """Charge un .wav en mono float32 @ cible_hz (wave stdlib + resampling linéaire)."""
    import wave

    import numpy as np
    with wave.open(str(chemin), "rb") as w:
        taux = w.getframerate()
        canaux = w.getnchannels()
        largeur = w.getsampwidth()
        brut = w.readframes(w.getnframes())
    if largeur != 2:
        raise ValueError(f"{chemin.name} : PCM 16 bits attendu (sampwidth=2), trouvé {largeur}.")
    echantillons = np.frombuffer(brut, dtype=np.int16).astype(np.float32) / 32768.0
    if canaux > 1:
        echantillons = echantillons.reshape(-1, canaux).mean(axis=1)
    if taux != cible_hz:
        n_source = len(echantillons)
        n_cible = int(round(n_source * cible_hz / taux))
        if n_cible < 1 or n_source < 1:
            raise ValueError(f"{chemin.name} : signal vide.")
        indices = np.linspace(0, n_source - 1, n_cible)
        echantillons = np.interp(indices, np.arange(n_source), echantillons).astype(np.float32)
    return echantillons


def main() -> int:
    args = parse_args()
    import torch
    if not torch.cuda.is_available():
        print("REFUS : aucun GPU CUDA détecté. Le trainer audio gen3 s'exécute sur GPU.",
              file=sys.stderr)
        return 2

    try:
        from transformers import AutoProcessor, SpeechT5ForTextToSpeech
        from peft import LoraConfig, PeftModel, get_peft_model
    except ImportError as exc:
        print(f"Dépendance manquante (transformers/peft) : {exc}", file=sys.stderr)
        return 2

    dataset = Path(args.train_dataset).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        paires = lire_manifest(dataset)
    except ValueError as exc:
        print(f"Dataset invalide : {exc}", file=sys.stderr)
        return 1
    print(f"Dataset : {len(paires)} paires audio+texte.")

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    processor = AutoProcessor.from_pretrained(args.model_name_or_path)
    modele = SpeechT5ForTextToSpeech.from_pretrained(
        args.model_name_or_path, torch_dtype=torch.float32).to("cuda")

    lora = LoraConfig(
        r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "out_proj"],
    )
    depart = 0
    if args.resume:
        point = dernier_checkpoint(output_dir)
        depart = charger_derniere_etape(point)
        if point:
            modele = PeftModel.from_pretrained(modele, str(point), is_trainable=True)
            print(f"Reprise depuis {point.name} (étape {depart}).")
        else:
            print("Aucun checkpoint trouvé — démarrage à zéro.")
            modele = get_peft_model(modele, lora)
    else:
        modele = get_peft_model(modele, lora)
    modele.print_trainable_parameters()
    modele.train()

    optimiseur = torch.optim.AdamW(
        [p for p in modele.parameters() if p.requires_grad], lr=float(args.learning_rate))

    cible_hz = processor.feature_extractor.sampling_rate
    historique: list[float] = []
    modele.zero_grad(set_to_none=True)

    for etape in range(depart + 1, args.max_steps + 1):
        indices = [random.randrange(len(paires)) for _ in range(args.batch_size)]
        textes = [paires[i][1] for i in indices]
        formes_onde = [charger_waveform_mono(paires[i][0], cible_hz) for i in indices]

        try:
            lot = processor(
                text=textes, audio_target=formes_onde, sampling_rate=cible_hz,
                return_tensors="pt", padding=True)
        except Exception as exc:
            print(f"Échec de préparation d'un lot (audio/texte incohérent ?) : {exc}",
                  file=sys.stderr)
            return 1

        lot = {cle: (v.to("cuda") if isinstance(v, torch.Tensor) else v)
               for cle, v in lot.items()}
        sortie = modele(**lot)
        perte = sortie.loss / args.gradient_accumulation_steps
        perte.backward()
        historique.append(float(perte.detach()) * args.gradient_accumulation_steps)

        if etape % args.gradient_accumulation_steps == 0:
            torch.nn.utils.clip_grad_norm_(
                [p for p in modele.parameters() if p.requires_grad], 1.0)
            optimiseur.step()
            optimiseur.zero_grad(set_to_none=True)

        if etape % 20 == 0:
            recent = historique[-20:]
            print(f"étape {etape}/{args.max_steps} · loss moy {sum(recent) / len(recent):.4f}")

        if args.checkpointing_steps > 0 and etape % args.checkpointing_steps == 0:
            point = output_dir / f"checkpoint-{etape}"
            modele.save_pretrained(str(point))
            (point / "trainer_state.json").write_text(json.dumps(
                {"global_step": etape,
                 "loss_moy": sum(historique[-20:]) / len(historique[-20:])}),
                encoding="utf-8")
            print(f"checkpoint : {point.name}")

    final = output_dir / "lora_audio"
    modele.save_pretrained(str(final))
    (final / "tokenizer_info.json").write_text(json.dumps(
        {"base": args.model_name_or_path, "sampling_rate": cible_hz}, ensure_ascii=False),
        encoding="utf-8")
    resume = {
        "type": "adaptateur LoRA TTS (SpeechT5)",
        "base": args.model_name_or_path,
        "dataset": str(dataset), "paires": len(paires),
        "steps": args.max_steps,
        "loss_moyenne_dernieres": round(sum(historique[-50:]) / max(len(historique[-50:]), 1), 4),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (final / "training_summary.json").write_text(
        json.dumps(resume, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Terminé. Adaptateur LoRA : {final}")
    print("Inférence : chargez la base + l'adaptateur + vocoder (microsoft/speecht5_hifigan).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

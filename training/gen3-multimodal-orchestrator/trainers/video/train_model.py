#!/usr/bin/env python3
"""Trainer vidéo gen3 — LoRA sur pipelines vidéo diffusers type LTX-Video.

Script « administrateur » appelé par gen3_multimodal_trainer.py. CLI standard
attendue par job.video.example.json :

  accelerate launch trainers/video/train_model.py \
      --pretrained_model_name_or_path {model_path} \
      --dataset_dir {dataset_path} \
      --output_dir {output_dir} \
      --train_batch_size 1 --gradient_accumulation_steps 4 \
      --learning_rate 1e-5 --max_train_steps 300

Dataset attendu : dossier de clips (.mp4/...) avec, POUR CHAQUE clip, un .txt
de même nom contenant la description. Sans caption → refus (LoRA vidéo sans
description = entraînement sans signal).

Par défaut LTX-Video (`Lightricks/LTX-Video-0.9.7-dev`, licence LTXV — vérifiez
les conditions d'usage). Honnêteté : 41 frames à 480×288 est un réglage L4 ;
la qualité photoréaliste dépend de la base, du dataset et de la durée.

Refus propre sans CUDA. Checkpoints + reprise (--resume). Produit un
adaptateur LoRA (transformer), jamais un modèle complet.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Trainer vidéo LoRA gen3 (LTX-Video, GPU requis).")
    p.add_argument("--pretrained_model_name_or_path", default="Lightricks/LTX-Video-0.9.7-dev")
    p.add_argument("--dataset_dir", required=True,
                   help="Dossier de clips vidéo + captions .txt de même nom.")
    p.add_argument("--output_dir", required=True)
    p.add_argument("--train_batch_size", type=int, default=1)
    p.add_argument("--gradient_accumulation_steps", type=int, default=4)
    p.add_argument("--learning_rate", default="1e-5")
    p.add_argument("--max_train_steps", type=int, default=300)
    p.add_argument("--width", type=int, default=480)
    p.add_argument("--height", type=int, default=288)
    p.add_argument("--num_frames", type=int, default=41,
                   help="LTX exige un nombre de frames ≡ 1 mod 8 (41, 57...).")
    p.add_argument("--lora_rank", type=int, default=16)
    p.add_argument("--lora_alpha", type=int, default=32)
    p.add_argument("--checkpointing_steps", type=int, default=50)
    p.add_argument("--resume", action="store_true")
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def trouver_paires_video(dataset: Path) -> list[tuple[Path, str]]:
    """Paires (clip, caption) réelles — pure, testable sans torch."""
    if not dataset.is_dir():
        raise ValueError(f"Dataset introuvable : {dataset}")
    clips = sorted(p for p in dataset.rglob("*")
                   if p.is_file() and p.suffix.lower() in VIDEO_EXTS)
    if not clips:
        raise ValueError(f"Aucun clip ({', '.join(sorted(VIDEO_EXTS))}) dans : {dataset}")
    paires: list[tuple[Path, str]] = []
    sans_caption: list[str] = []
    for clip in clips:
        txt = clip.with_suffix(".txt")
        if txt.is_file() and txt.read_text(encoding="utf-8", errors="replace").strip():
            paires.append((clip, txt.read_text(encoding="utf-8", errors="replace").strip()))
        else:
            sans_caption.append(clip.name)
    if sans_caption:
        raise ValueError(
            f"{len(sans_caption)} clip(s) sans caption .txt (ex. {sans_caption[:3]}) : "
            "chaque clip DOIT avoir un .txt de même nom.")
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


def charger_latents_clip(chemin: Path, vae, width: int, height: int, num_frames: int,
                         device: str, dtype):
    """Clip → latents VAE normalisés (B,C,T,H,W).

    Décode via torchvision (livré avec torch GPU), sous-échantillonne
    uniformément num_frames, encode via vae, normalise (latents_mean/std si
    présents — LTX — sinon scaling_factor).
    """
    import torch
    from torchvision.io import read_video
    from torchvision.transforms import functional as TF

    frames, _, _ = read_video(str(chemin), pts_unit="sec")  # (T,H,W,C) uint8
    total = frames.shape[0]
    if total < 8:
        raise ValueError(f"{chemin.name} : trop court ({total} frames, minimum 8).")
    picks = [int(round(i * (total - 1) / (num_frames - 1))) for i in range(num_frames)]
    picks = sorted(set(picks))
    while len(picks) < num_frames:  # cas de doublons arrondis
        picks.append(picks[-1])
    picks = picks[:num_frames]

    echantillon = frames[picks][:, :, :, :3]  # (T,H,W,C)
    echantillon = echantillon.permute(0, 3, 1, 2).float() / 255.0  # (T,C,H,W)
    echantillon = torch.stack([
        TF.resize(f, [height, width], antialias=True) for f in echantillon])
    echantillon = echantillon.permute(1, 0, 2, 3)  # (C,T,H,W)
    echantillon = (echantillon * 2.0 - 1.0).to(device, dtype=dtype).unsqueeze(0)  # (1,C,T,H,W)

    with torch.no_grad():
        latents = vae.encode(echantillon).latent_dist.sample()

    cfg = getattr(vae, "config", None)
    moyenne = getattr(cfg, "latents_mean", None)
    ecart = getattr(cfg, "latents_std", None)
    if moyenne is not None and ecart is not None:
        m = torch.tensor(moyenne, device=latents.device, dtype=latents.dtype).view(1, -1, 1, 1, 1)
        s = torch.tensor(ecart, device=latents.device, dtype=latents.dtype).view(1, -1, 1, 1, 1)
        latents = (latents - m) / s
    elif getattr(cfg, "scaling_factor", None):
        latents = latents * cfg.scaling_factor
    return latents  # (1,C,T,H,W)


def main() -> int:
    args = parse_args()
    if (args.num_frames - 1) % 8 != 0:
        print(f"REFUS : num_frames={args.num_frames} — LTX exige 1 mod 8 (ex. 41, 57).",
              file=sys.stderr)
        return 2
    import torch
    if not torch.cuda.is_available():
        print("REFUS : aucun GPU CUDA détecté. Le trainer vidéo gen3 s'exécute sur GPU.",
              file=sys.stderr)
        return 2

    try:
        from diffusers import AutoencoderKLLTXVideo, LTXPipeline
        from transformers import T5EncoderModel, T5Tokenizer
        from peft import LoraConfig, PeftModel, get_peft_model
    except ImportError as exc:
        print(f"Dépendance manquante (diffusers LTX/peft) : {exc}\n"
              "Ce trainer cible les pipelines vidéo diffusers (LTX-Video). "
              "Mettez à jour diffusers, ou utilisez le pack média gen3.", file=sys.stderr)
        return 2

    dataset = Path(args.dataset_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        paires = trouver_paires_video(dataset)
    except ValueError as exc:
        print(f"Dataset invalide : {exc}", file=sys.stderr)
        return 1
    print(f"Dataset : {len(paires)} paires clip+caption.")

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    print(f"Chargement de la base vidéo : {args.pretrained_model_name_or_path}")
    try:
        pipe = LTXPipeline.from_pretrained(
            args.pretrained_model_name_or_path, torch_dtype=torch.bfloat16)
    except Exception as exc:
        print(f"Base LTX non chargeable : {exc}", file=sys.stderr)
        return 2
    pipe.to("cuda")

    vae: AutoencoderKLLTXVideo = pipe.vae
    transformer = pipe.transformer
    tokenizer: T5Tokenizer = pipe.tokenizer
    text_encoder: T5EncoderModel = pipe.text_encoder
    vae.requires_grad_(False)
    text_encoder.requires_grad_(False)

    lora = LoraConfig(
        r=args.lora_rank, lora_alpha=args.lora_alpha, lora_dropout=0.05, bias="none",
        target_modules=["to_q", "to_k", "to_v", "to_out.0"],
    )
    transformer_base = transformer
    depart = 0
    if args.resume:
        point = dernier_checkpoint(output_dir)
        depart = charger_derniere_etape(point)
        if point:
            transformer = PeftModel.from_pretrained(transformer_base, str(point), is_trainable=True)
            print(f"Reprise depuis {point.name} (étape {depart}).")
        else:
            print("Aucun checkpoint trouvé — démarrage à zéro.")
            transformer = get_peft_model(transformer_base, lora)
    else:
        transformer = get_peft_model(transformer_base, lora)
    transformer.print_trainable_parameters()
    transformer.train()

    optimiseur = torch.optim.AdamW(
        [p for p in transformer.parameters() if p.requires_grad], lr=float(args.learning_rate))

    historique: list[float] = []
    transformer.zero_grad(set_to_none=True)

    for etape in range(depart + 1, args.max_train_steps + 1):
        indice = random.randrange(len(paires))
        chemin_clip, caption = paires[indice]

        try:
            latents = charger_latents_clip(
                chemin_clip, vae, args.width, args.height, args.num_frames, "cuda",
                torch.bfloat16)
        except (ValueError, RuntimeError, OSError) as exc:
            print(f"Clip illisible, ignoré à cette étape ({chemin_clip.name}) : {exc}")
            continue

        entrees = tokenizer([caption], padding="max_length", max_length=128,
                            truncation=True, return_tensors="pt")
        with torch.no_grad():
            encoder_hidden_states = text_encoder(
                entrees.input_ids.to("cuda"), attention_mask=None)[0]

        # Flow matching (schéma LTX) : x_t = (1-t)·bruit + t·latents, cible = latents - bruit
        bruit = torch.randn_like(latents)
        t = random.uniform(0.05, 0.95)
        latents_bruites = (1.0 - t) * bruit + t * latents
        pas_temps = torch.tensor([t], device="cuda", dtype=torch.bfloat16)

        prediction = transformer(
            hidden_states=latents_bruites,
            timestep=pas_temps,
            encoder_hidden_states=encoder_hidden_states,
            return_dict=False,
        )[0]
        cible = latents - bruit
        perte = torch.nn.functional.mse_loss(prediction.float(), cible.float(),
                                             reduction="mean") / args.gradient_accumulation_steps
        perte.backward()
        historique.append(float(perte.detach()) * args.gradient_accumulation_steps)

        if etape % args.gradient_accumulation_steps == 0:
            torch.nn.utils.clip_grad_norm_(
                [p for p in transformer.parameters() if p.requires_grad], 1.0)
            optimiseur.step()
            optimiseur.zero_grad(set_to_none=True)

        if etape % 10 == 0:
            recent = historique[-10:]
            print(f"étape {etape}/{args.max_train_steps} · loss moy {sum(recent) / len(recent):.4f}")

        if args.checkpointing_steps > 0 and etape % args.checkpointing_steps == 0:
            point = output_dir / f"checkpoint-{etape}"
            transformer.save_pretrained(str(point))
            (point / "trainer_state.json").write_text(json.dumps(
                {"global_step": etape,
                 "loss_moy": sum(historique[-10:]) / len(historique[-10:])}),
                encoding="utf-8")
            print(f"checkpoint : {point.name}")

    final = output_dir / "lora_video"
    transformer.save_pretrained(str(final))
    resume = {
        "type": "adaptateur LoRA vidéo (diffusers/LTX)",
        "base": args.pretrained_model_name_or_path,
        "dataset": str(dataset), "paires": len(paires),
        "steps": args.max_steps, "resolution": [args.width, args.height],
        "frames": args.num_frames,
        "lora": {"r": args.lora_rank, "alpha": args.lora_alpha},
        "loss_moyenne_dernieres": round(sum(historique[-50:]) / max(len(historique[-50:]), 1), 4),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (final / "training_summary.json").write_text(
        json.dumps(resume, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Terminé. Adaptateur LoRA : {final}")
    print("Inférence : LTXPipeline + pipe.load_lora_weights(final).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

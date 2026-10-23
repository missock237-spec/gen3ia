#!/usr/bin/env python3
"""Trainer image gen3 — LoRA sur pipeline UNet (SD 1.5 / SD 2 family, diffusers).

Script « administrateur » appelé par gen3_multimodal_trainer.py (jamais par un
utilisateur final). Les chemins et hyperparamètres arrivent via la CLI standard :

  accelerate launch trainers/image/train_model.py \
      --pretrained_model_name_or_path {model_path} \
      --train_data_dir {dataset_path} \
      --output_dir {output_dir} \
      --train_batch_size 1 --gradient_accumulation_steps 4 \
      --learning_rate 1e-4 --max_train_steps 500

Dataset attendu : dossier d'images (.jpg/.png/.webp/...) avec, POUR CHAQUE
image, un fichier .txt de même nom contenant la caption (convention diffusers).
Sans caption, l'entraînement est refusé par conception (caption invalide =
LoRA sans sujet).

Refus propre sans CUDA (conception gen3 : GPU obligatoire). Checkpoints
locaux + reprise (--resume). Produit un ADAPTATEUR LoRA, pas un modèle complet.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Trainer LoRA image gen3 (GPU requis).")
    p.add_argument("--pretrained_model_name_or_path", required=True,
                   help="Base UNet diffusers (local ou Hub) : SD 1.5 / SD 2 family.")
    p.add_argument("--train_data_dir", required=True,
                   help="Dossier d'images + captions .txt de même nom.")
    p.add_argument("--output_dir", required=True)
    p.add_argument("--train_batch_size", type=int, default=1)
    p.add_argument("--gradient_accumulation_steps", type=int, default=4)
    p.add_argument("--learning_rate", default="1e-4")
    p.add_argument("--max_train_steps", type=int, default=500)
    p.add_argument("--resolution", type=int, default=512)
    p.add_argument("--lora_rank", type=int, default=16)
    p.add_argument("--lora_alpha", type=int, default=32)
    p.add_argument("--checkpointing_steps", type=int, default=100)
    p.add_argument("--resume", action="store_true",
                   help="Reprendre depuis le dernier checkpoint de --output_dir.")
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


def trouver_paires(dataset: Path) -> list[tuple[Path, str]]:
    """Paires (image, caption) réelles — lève ValueError si dataset incohérent.

    Fonction pure testable sans torch (utilisée aussi par le validateur).
    """
    if not dataset.is_dir():
        raise ValueError(f"Dataset introuvable : {dataset}")
    images = sorted(p for p in dataset.rglob("*")
                    if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
    if not images:
        raise ValueError(f"Aucune image ({', '.join(sorted(IMAGE_EXTS))}) dans : {dataset}")
    paires: list[tuple[Path, str]] = []
    sans_caption: list[str] = []
    for image in images:
        txt = image.with_suffix(".txt")
        if txt.is_file() and txt.read_text(encoding="utf-8", errors="replace").strip():
            paires.append((image, txt.read_text(encoding="utf-8", errors="replace").strip()))
        else:
            sans_caption.append(image.name)
    if sans_caption:
        raise ValueError(
            f"{len(sans_caption)} image(s) sans caption .txt (ex. {sans_caption[:3]}) : "
            "chaque image DOIT avoir un fichier .txt de même nom.")
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


def main() -> int:
    args = parse_args()
    import torch  # GPU obligatoire — refus propre sans CUDA
    if not torch.cuda.is_available():
        print("REFUS : aucun GPU CUDA détecté. Le trainer image gen3 s'exécute sur GPU.",
              file=sys.stderr)
        return 2

    try:
        from diffusers import AutoPipelineForText2Image, DDPMScheduler
        from peft import LoraConfig, get_peft_model
    except ImportError as exc:
        print(f"Dépendance manquante (diffusers/peft) : {exc}", file=sys.stderr)
        return 2

    dataset = Path(args.train_data_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        paires = trouver_paires(dataset)
    except ValueError as exc:
        print(f"Dataset invalide : {exc}", file=sys.stderr)
        return 1
    print(f"Dataset : {len(paires)} paires image+caption.")

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    print(f"Chargement de la base : {args.pretrained_model_name_or_path}")
    try:
        pipe = AutoPipelineForText2Image.from_pretrained(
            args.pretrained_model_name_or_path, torch_dtype=torch.float16)
    except Exception as exc:
        print(f"Base non chargeable par diffusers : {exc}\n"
              "Ce trainer cible les pipelines UNet (SD 1.5 / SD 2). Pour les modèles "
              "transformer (Flux/SD3) ou vidéo, utilisez le pack média gen3.", file=sys.stderr)
        return 2
    if not hasattr(pipe, "unet") or pipe.unet is None:
        print("Pipeline sans .unet (architecture transformer ?) : utilisez le pack "
              "média gen3 (train_image_sdxl.py / train_video_ltx.py).", file=sys.stderr)
        return 2
    pipe.to("cuda")
    pipe.scheduler = DDPMScheduler.from_config(pipe.scheduler.config)

    unet = pipe.unet
    vae = pipe.vae
    tokenizer = pipe.tokenizer
    text_encoder = pipe.text_encoder

    lora = LoraConfig(
        r=args.lora_rank, lora_alpha=args.lora_alpha, lora_dropout=0.05, bias="none",
        target_modules=["to_q", "to_k", "to_v", "to_out.0"],
    )
    unet_base = pipe.unet
    depart = 0
    if args.resume:
        point = dernier_checkpoint(output_dir)
        depart = charger_derniere_etape(point)
        if point:
            from peft import PeftModel
            unet = PeftModel.from_pretrained(unet_base, str(point), is_trainable=True)
            print(f"Reprise depuis {point.name} (étape {depart}).")
        else:
            print("Aucun checkpoint trouvé — démarrage à zéro.")
            unet = get_peft_model(unet_base, lora)
    else:
        unet = get_peft_model(unet_base, lora)
    unet.print_trainable_parameters()
    unet.train()
    vae.requires_grad_(False)
    text_encoder.requires_grad_(False)

    optimiseur = torch.optim.AdamW(
        [p for p in unet.parameters() if p.requires_grad], lr=float(args.learning_rate))

    def encode_latents(images_batch):
        from torchvision import transforms as T  # torchvision livré avec torch GPU
        to_tensor = T.Compose([
            T.Resize((args.resolution, args.resolution)),
            T.ToTensor(),
        ])
        tensors = torch.stack([to_tensor(img) for img in images_batch]).to(
            "cuda", dtype=torch.float16) * 2.0 - 1.0
        with torch.no_grad():
            latents = vae.encode(tensors).latent_dist.sample()
        latents = latents * vae.config.scaling_factor
        return latents

    resume_from = max(depart, 0)
    from PIL import Image as PILImage

    historique: list[float] = []
    unet.zero_grad(set_to_none=True)
    for etape in range(resume_from + 1, args.max_train_steps + 1):
        # Pioche aléatoire : image ET caption du même indice (paire cohérente)
        indices = [random.randrange(len(paires)) for _ in range(args.train_batch_size)]
        images = [PILImage.open(paires[i][0]).convert("RGB") for i in indices]
        captions = [paires[i][1] for i in indices]

        latents = encode_latents(images)
        entrees = tokenizer(captions, padding="max_length", max_length=tokenizer.model_max_length,
                            truncation=True, return_tensors="pt").input_ids.to("cuda")
        with torch.no_grad():
            encoder_hidden_states = text_encoder(entrees)[0]

        bruit = torch.randn_like(latents)
        pas_temps = torch.randint(0, pipe.scheduler.config.num_train_timesteps,
                                  (latents.shape[0],), device="cuda").long()
        latents_bruites = pipe.scheduler.add_noise(latents, bruit, pas_temps)

        prediction = unet(latents_bruites, pas_temps,
                          encoder_hidden_states=encoder_hidden_states).sample
        perte = torch.nn.functional.mse_loss(prediction.float(), bruit.float(),
                                             reduction="mean") / args.gradient_accumulation_steps
        perte.backward()
        historique.append(float(perte.detach()) * args.gradient_accumulation_steps)

        if etape % args.gradient_accumulation_steps == 0:
            torch.nn.utils.clip_grad_norm_(
                [p for p in unet.parameters() if p.requires_grad], 1.0)
            optimiseur.step()
            optimiseur.zero_grad(set_to_none=True)

        if etape % 20 == 0:
            recent = historique[-20:]
            print(f"étape {etape}/{args.max_train_steps} · loss moy {sum(recent) / len(recent):.4f}")

        if args.checkpointing_steps > 0 and etape % args.checkpointing_steps == 0:
            point = output_dir / f"checkpoint-{etape}"
            unet.save_pretrained(str(point))
            (point / "trainer_state.json").write_text(json.dumps(
                {"global_step": etape, "loss_moy": sum(historique[-20:]) / len(historique[-20:])}),
                encoding="utf-8")
            print(f"checkpoint : {point.name}")

    final = output_dir / "lora_image"
    unet.save_pretrained(str(final))
    resume = {
        "type": "adaptateur LoRA UNet (diffusers)",
        "base": args.pretrained_model_name_or_path,
        "dataset": str(dataset), "paires": len(paires),
        "steps": args.max_train_steps, "resolution": args.resolution,
        "lora": {"r": args.lora_rank, "alpha": args.lora_alpha},
        "loss_moyenne_dernieres": round(sum(historique[-50:]) / max(len(historique[-50:]), 1), 4),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (final / "training_summary.json").write_text(
        json.dumps(resume, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Terminé. Adaptateur LoRA : {final}")
    print("L'adaptateur se charge sur la base d'origine (pipe.load_lora_weights).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

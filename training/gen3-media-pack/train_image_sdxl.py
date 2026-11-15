#!/usr/bin/env python3
"""Entraînement LoRA SDXL de gen3 — IMAGE PHOTORÉALISTE (GPU obligatoire).

Base : stabilityai/stable-diffusion-xl-base-1.0 (OpenRAIL++-XL, usage commercial
autorisé avec restrictions d'usage documentées). Adaptation par LoRA (peft)
sur l'UNet (+ text encoders optionnels) à partir d'un JSONL préparé par
prepare_image_dataset.py.

Deux niveaux de performance (profils.py) :
  * l4       : 768 px, LoRA r16, bs 1, accum 4
  * a100_40g : 1024 px, LoRA r32, bs 2, accum 2

Honnêteté : un LoRA SDXL sur quelques centaines à quelques milliers d'images
produit une IMAGE PHOTORÉALISTE de qualité (le backbone pré-entraîné fait le
travail) mais ne "devient" pas Nano Banana ; les capacités type édition
conversationnelle restent hors de portée de ce format d'entraînement.

Reprise : --resume_from_checkpoint sorties/gen3ia-sdxl-lora/checkpoint-XXX.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from profils import ErreurProfil, select_profile  # noqa: E402

BASE_MODEL_DEFAUT = "stabilityai/stable-diffusion-xl-base-1.0"
DROPOUT_TEXTE = 0.10


class RequisGPU(RuntimeError):
    pass


def exiger_cuda() -> None:
    import torch

    if not torch.cuda.is_available():
        raise RequisGPU(
            "GPU CUDA requis pour l'entraînement SDXL de gen3 (CPU refusé par conception)."
        )


def charger_jsonl(chemin: Path) -> list[dict]:
    if not chemin.exists():
        raise SystemExit(f"JSONL introuvable : {chemin} (lancez prepare_image_dataset.py d'abord).")
    exemples = []
    with open(chemin, encoding="utf-8") as f:
        for ligne in f:
            ligne = ligne.strip()
            if ligne:
                e = json.loads(ligne)
                if e.get("image_path") and e.get("caption"):
                    exemples.append(e)
    if not exemples:
        raise SystemExit(f"JSONL vide : {chemin}")
    return exemples


class JeuImages:
    """Charge + recadre centre-carré + redimensionne à la résolution du profil."""

    def __init__(self, exemples: list[dict], dossier: Path, resolution: int):
        self.exemples = exemples
        self.dossier = dossier
        self.resolution = resolution

    def __len__(self) -> int:
        return len(self.exemples)

    def obtenir(self, i: int):
        import numpy as np
        import torch
        from PIL import Image

        e = self.exemples[i]
        with Image.open(self.dossier / e["image_path"]) as im:
            im = im.convert("RGB")
            w, h = im.size
            cote = min(w, h)
            im = im.crop(((w - cote) // 2, (h - cote) // 2, (w + cote) // 2, (h + cote) // 2))
            im = im.resize((self.resolution, self.resolution), Image.LANCZOS)
            tenseur = torch.from_numpy(np.array(im)).float().permute(2, 0, 1) / 127.5 - 1.0
        return tenseur, e["caption"]


def boucle(args) -> None:
    exiger_cuda()
    import torch
    from accelerate import Accelerator
    from diffusers import AutoencoderKL, DDPMScheduler, StableDiffusionXLPipeline, UNet2DConditionModel
    from peft import LoraConfig, get_peft_model
    from transformers import AutoTokenizer, CLIPTextModel, CLIPTextModelWithProjection

    nom_profil, profil = select_profile(args.profil)
    cfg = profil["image"]
    resolution = args.resolution or cfg["resolution"]
    print(f"[image] profil {nom_profil} : {resolution} px, LoRA r{cfg['lora_r']}, "
          f"bs {cfg['batch']} x accum {cfg['gradient_accumulation']}")

    sortie = Path(args.sortie)
    sortie.mkdir(parents=True, exist_ok=True)

    exemples = charger_jsonl(Path(args.train_jsonl))
    val = charger_jsonl(Path(args.val_jsonl)) if Path(args.val_jsonl).exists() else []
    jeu = JeuImages(exemples, Path(args.dossier_images), resolution)
    jeu_val = JeuImages(val, Path(args.dossier_images), resolution) if val else None

    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    accelerateur = Accelerator(mixed_precision="bf16" if dtype == torch.bfloat16 else "fp16")

    # Composants SDXL : VAE + encoders figés, UNet porteur du LoRA.
    vae = AutoencoderKL.from_pretrained(args.base_model, subfolder="vae", torch_dtype=dtype)
    text_encoder_1 = CLIPTextModel.from_pretrained(args.base_model, subfolder="text_encoder", torch_dtype=dtype)
    text_encoder_2 = CLIPTextModelWithProjection.from_pretrained(args.base_model, subfolder="text_encoder_2", torch_dtype=dtype)
    tokenizer_1 = AutoTokenizer.from_pretrained(args.base_model, subfolder="tokenizer")
    tokenizer_2 = AutoTokenizer.from_pretrained(args.base_model, subfolder="tokenizer_2")
    unet = UNet2DConditionModel.from_pretrained(args.base_model, subfolder="unet", torch_dtype=dtype)
    planificateur = DDPMScheduler.from_pretrained(args.base_model, subfolder="scheduler")

    vae.requires_grad_(False).eval()
    text_encoder_1.requires_grad_(False).eval()
    text_encoder_2.requires_grad_(False).eval()
    unet.enable_gradient_checkpointing()

    config_lora = LoraConfig(
        r=cfg["lora_r"],
        lora_alpha=cfg["lora_alpha"],
        lora_dropout=0.05,
        target_modules=["to_q", "to_k", "to_v", "to_out.0"],
    )
    unet = get_peft_model(unet, config_lora)
    unet.print_trainable_parameters()

    opt = torch.optim.AdamW(
        [p for p in unet.parameters() if p.requires_grad],
        lr=cfg["lr"], weight_decay=0.01, betas=(0.9, 0.999),
    )

    reprise, step_initial = None, 0
    if args.resume_from_checkpoint:
        reprise = Path(args.resume_from_checkpoint)
        if not (reprise / "adapter_model.safetensors").exists():
            raise SystemExit(f"Checkpoint invalide : {reprise}")
        from peft import set_peft_model_state_dict

        set_peft_model_state_dict(unet, torch.load(reprise / "lora_state.pt", map_location="cpu"))
        opt_state = torch.load(reprise / "optimizer.pt", map_location="cpu")
        opt.load_state_dict(opt_state)
        step_initial = torch.load(reprise / "meta.pt", map_location="cpu")["step"]
        print(f"[image] reprise depuis {reprise.name} (step {step_initial})")

    unet, opt = accelerateur.prepare(unet, opt)
    vae, text_encoder_1, text_encoder_2 = vae.to(accelerateur.device), text_encoder_1.to(accelerateur.device), text_encoder_2.to(accelerateur.device)

    def encoder_texte(captions: list[str]):
        ids1 = tokenizer_1(captions, padding="max_length", max_length=77, truncation=True, return_tensors="pt").input_ids.to(accelerateur.device)
        ids2 = tokenizer_2(captions, padding="max_length", max_length=77, truncation=True, return_tensors="pt").input_ids.to(accelerateur.device)
        enc1 = text_encoder_1(ids1)[0]
        enc2 = text_encoder_2(ids2)[0]
        # concat projections (add_text_embeds simplifiée : pooled de l'encoder 2)
        pooled = text_encoder_2(ids2, output_hidden_states=True).hidden_states[-2][:, 0]
        return enc1, enc2, pooled

    rng = random.Random(42)
    taille_eff = max(1, cfg["batch"])
    total_steps = args.steps
    perte_moy, step = 0.0, step_initial

    while step < total_steps:
        for _ in range(cfg["gradient_accumulation"]):
            idx = rng.randrange(len(jeu))
            image_t, caption = jeu.obtenir(idx)
            captions = [caption]
            if rng.random() < DROPOUT_TEXTE and not args.pas_cfg_dropout:
                captions = [""]
            with torch.no_grad():
                latents = vae.encode(image_t[None].to(accelerateur.device, dtype)).latent_dist.sample()
                latents = latents * vae.config.scaling_factor
                enc1, enc2, pooled = encoder_texte(captions)
            bruit = torch.randn_like(latents)
            t = torch.randint(0, planificateur.config.num_train_timesteps, (1,), device=accelerateur.device).long()
            x_t = planificateur.add_noise(latents, bruit, t)
            added = {"text_embeds": pooled, "time_ids": torch.tensor(
                [resolution, resolution, 0, 0, resolution, resolution], device=accelerateur.device)[None]}
            with accelerateur.accumulate(unet):
                pred = unet(x_t.to(dtype), t, encoder_hidden_states=enc2.to(dtype),
                            added_cond_kwargs=added).sample
                perte = torch.nn.functional.mse_loss(pred.float(), bruit.float(), reduction="mean") / cfg["gradient_accumulation"]
                accelerateur.backward(perte)
            perte_moy += perte.item()
        opt.step()
        opt.zero_grad(set_to_none=True)
        step += 1

        if step % 25 == 0:
            print(f"[image] {step}/{total_steps} loss={perte_moy / (25 * cfg['gradient_accumulation']):.4f}", flush=True)
            perte_moy = 0.0

        if jeu_val is not None and step % args.save_every == 0:
            unet.eval()
            pertes = []
            with torch.no_grad():
                for i in range(min(16, len(jeu_val))):
                    try:
                        img_t, cap = jeu_val.obtenir(i)
                    except Exception:
                        continue
                    lat = vae.encode(img_t[None].to(accelerateur.device, dtype)).latent_dist.sample() * vae.config.scaling_factor
                    e1, e2, pl = encoder_texte([cap])
                    b = torch.randn_like(lat)
                    t = torch.randint(0, planificateur.config.num_train_timesteps, (1,), device=accelerateur.device).long()
                    p = unet(planificateur.add_noise(lat, b, t).to(dtype), t, encoder_hidden_states=e2.to(dtype),
                             added_cond_kwargs={"text_embeds": pl, "time_ids": torch.tensor(
                                 [resolution, resolution, 0, 0, resolution, resolution],
                                 device=accelerateur.device)[None]}).sample
                    pertes.append(torch.nn.functional.mse_loss(p.float(), b.float()).item())
            if pertes:
                print(f"[image] val_loss={sum(pertes) / len(pertes):.4f} (n={len(pertes)})", flush=True)
            unet.train()

        if step % args.save_every == 0 or step == total_steps:
            ckpt = sortie / f"checkpoint-{step}"
            ckpt.mkdir(parents=True, exist_ok=True)
            accelerateur.unwrap_model(unet).save_pretrained(ckpt)
            torch.save(opt.state_dict(), ckpt / "optimizer.pt")
            torch.save({"step": step}, ckpt / "meta.pt")
            print(f"[image] checkpoint : {ckpt}")

    final = sortie / "final_adapter"
    final.mkdir(parents=True, exist_ok=True)
    accelerateur.unwrap_model(unet).save_pretrained(final)
    print(f"[image] adaptateur final : {final}")


def main() -> None:
    p = argparse.ArgumentParser(description="Entraînement LoRA SDXL photoréaliste gen3 (GPU).")
    p.add_argument("--train_jsonl", default="data/images/train.jsonl")
    p.add_argument("--val_jsonl", default="data/images/validation.jsonl")
    p.add_argument("--dossier_images", default=".")
    p.add_argument("--base_model", default=BASE_MODEL_DEFAUT)
    p.add_argument("--profil", choices=["auto", "l4", "a100_40g"], default="auto")
    p.add_argument("--resolution", type=int, default=None)
    p.add_argument("--steps", type=int, default=None)
    p.add_argument("--save_every", type=int, default=100)
    p.add_argument("--sortie", default="sorties/gen3ia-sdxl-lora")
    p.add_argument("--resume_from_checkpoint", default=None)
    p.add_argument("--pas_cfg_dropout", action="store_true")
    args = p.parse_args()

    _, profil = select_profile(args.profil)
    args.steps = args.steps or profil["image"]["steps_defaut"]
    try:
        boucle(args)
    except RequisGPU as erreur:
        print(f"REFUS : {erreur}")
        raise SystemExit(2)


if __name__ == "__main__":
    main()

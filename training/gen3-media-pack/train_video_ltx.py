#!/usr/bin/env python3
"""Adaptation LoRA LTX-Video de gen3 — VIDÉO RÉALISTE (GPU obligatoire).

Base : Lightricks/LTX-Video-0.9.7-dev (format diffusers, licence LTXV Open Weights —
usage commercial autorisé sous plafond de revenus du fournisseur ; lire la licence).
Le backbone pré-entraîné sait générer de la vidéo ; le LoRA l'ADAPTE à votre
distribution de contenus (style, domaines, cadrages) — il ne le "crée" pas.

Deux niveaux (profils.py) :
  * l4       : 480x288, 41 images (5 s à 25/12 fps), LoRA r16, bs 1, accum 4
  * a100_40g : 704x448, 57 images, LoRA r32, bs 1, accum 2

Contraintes LTX : dimensions divisibles par 32, nb d'images = 8k+1.
Flow matching : x_t = (1-s)·x0 + s·ε ; cible = ε − x0 (convention diffusers).

Honnêteté : avec 10-60 min de clips d'entraînement, on obtient une adaptation de
style/domaine crédible sur des scènes proches du dataset ; une généralisation à
tout sujet reste limitée — c'est la nature d'un LoRA, pas un défaut du code.
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

BASE_DEFAUT = "Lightricks/LTX-Video-0.9.7-dev"
DROPOUT_TEXTE = 0.10


class RequisGPU(RuntimeError):
    pass


def exiger_cuda() -> None:
    import torch

    if not torch.cuda.is_available():
        raise RequisGPU("GPU CUDA requis pour l'entraînement LTX-Video (CPU refusé).")


def charger_jsonl(chemin: Path) -> list[dict]:
    if not chemin.exists():
        raise SystemExit(f"JSONL introuvable : {chemin} (lancez prepare_video_dataset.py).")
    exemples = []
    with open(chemin, encoding="utf-8") as f:
        for ligne in f:
            ligne = ligne.strip()
            if ligne:
                e = json.loads(ligne)
                if e.get("video_path") and e.get("caption"):
                    exemples.append(e)
    if not exemples:
        raise SystemExit(f"JSONL vide : {chemin}")
    return exemples


def clip_ltx(
    chemin_video: Path,
    largeur: int,
    hauteur: int,
    nb_images: int,
    fps_cible: float,
):
    """Extrait nb_images frames à fps_cible -> tenseur (T,C,H,W) dans [-1,1]."""
    import numpy as np
    import subprocess
    import torch
    from PIL import Image
    import io

    cmd = [
        "ffmpeg", "-v", "quiet", "-i", str(chemin_video),
        "-vf", f"fps={fps_cible},scale={largeur}:{hauteur}:force_original_aspect_ratio=increase,"
               f"crop={largeur}:{hauteur}",
        "-frames:v", str(nb_images),
        "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    brut = subprocess.run(cmd, capture_output=True, check=True).stdout
    images = []
    import imageio.v2 as imageio
    flux = imageio.get_reader(io.BytesIO(brut), format="png")
    for frame in flux:
        images.append(Image.fromarray(frame).convert("RGB"))
    while 0 < len(images) < nb_images:
        images.append(images[-1])  # clip plus court que demandé : gel de la dernière image
    if not images:
        raise IOError(f"aucune frame extraite de {chemin_video}")
    images = images[:nb_images]
    t = torch.from_numpy(np.stack([np.asarray(im) for im in images])).float().permute(3, 0, 1, 2) / 127.5 - 1.0
    return t


def boucle(args) -> None:
    exiger_cuda()
    import torch
    from diffusers import AutoencoderKLLTXVideo, LTXVideoTransformer3DModel
    from diffusers.schedulers.scheduling_flow_match_euler_discrete import FlowMatchEulerDiscreteScheduler
    from peft import LoraConfig, get_peft_model
    from transformers import T5EncoderModel, T5TokenizerFast

    nom_profil, profil = select_profile(args.profil)
    cfg = profil["video"]
    largeur, hauteur = cfg["resolution"]
    nb_images = cfg["frames"]
    fps_cible = 24.0
    print(f"[ltx] profil {nom_profil} : {largeur}x{hauteur}, {nb_images} images, "
          f"LoRA r{cfg['lora_r']}, bs {cfg['batch']} x accum {cfg['gradient_accumulation']}")

    sortie = Path(args.sortie)
    sortie.mkdir(parents=True, exist_ok=True)

    exemples = charger_jsonl(Path(args.train_jsonl))
    val = charger_jsonl(Path(args.val_jsonl)) if Path(args.val_jsonl).exists() else []
    dossier = Path(args.dossier_videos)

    dtype = torch.bfloat16
    tokenizer = T5TokenizerFast.from_pretrained(args.base_model, subfolder="tokenizer")
    encodeur = T5EncoderModel.from_pretrained(args.base_model, subfolder="text_encoder", torch_dtype=dtype).eval().requires_grad_(False)
    vae = AutoencoderKLLTXVideo.from_pretrained(args.base_model, subfolder="vae", torch_dtype=dtype).eval().requires_grad_(False)
    transformeur = LTXVideoTransformer3DModel.from_pretrained(args.base_model, subfolder="transformer", torch_dtype=dtype)
    planificateur = FlowMatchEulerDiscreteScheduler.from_pretrained(args.base_model, subfolder="scheduler")

    if hasattr(transformeur, "enable_gradient_checkpointing"):
        transformeur.enable_gradient_checkpointing()

    config_lora = LoraConfig(
        r=cfg["lora_r"],
        lora_alpha=cfg["lora_alpha"],
        lora_dropout=0.05,
        target_modules=["to_q", "to_k", "to_v", "to_out.0"],
    )
    transformeur = get_peft_model(transformeur, config_lora)
    transformeur.print_trainable_parameters()

    opt = torch.optim.AdamW(
        [p for p in transformeur.parameters() if p.requires_grad],
        lr=cfg["lr"], weight_decay=0.01, betas=(0.9, 0.95),
    )

    device = "cuda"

    def encoder_texte(captions: list[str]):
        lots = tokenizer(captions, padding="max_length", max_length=128,
                         truncation=True, return_tensors="pt").to(device)
        with torch.no_grad():
            return encodeur(**lots).last_hidden_state, lots.attention_mask.bool()

    def cond_vae(clip: torch.Tensor) -> torch.Tensor:
        with torch.no_grad():
            lat = vae.encode(clip[None].to(device, dtype)).latent_dist.sample()
            # normalisation LTX : latents normalisés par moyennes/écarts du transformeur
            if hasattr(transformeur.config, "latents_mean") and transformeur.config.latents_mean:
                moyenne = torch.tensor(transformeur.config.latents_mean, device=device, dtype=dtype).view(1, -1, 1, 1, 1)
                ecart = torch.tensor(transformeur.config.latents_std, device=device, dtype=dtype).view(1, -1, 1, 1, 1)
                return (lat - moyenne) / ecart
            return lat * vae.config.scaling_factor

    rng = random.Random(42)
    perte_moy, step = 0.0, 0
    while step < args.steps:
        for _ in range(cfg["gradient_accumulation"]):
            idx = rng.randrange(len(exemples))
            e = exemples[idx]
            clip = clip_ltx(dossier / e["video_path"], largeur, hauteur, nb_images, fps_cible)
            caption = e["caption"]
            if rng.random() < DROPOUT_TEXTE:
                caption = ""
            latents = cond_vae(clip)
            txt, masque = encoder_texte([caption])
            bruit = torch.randn_like(latents)
            sigma = torch.sigmoid(torch.randn(1, device=device))
            x_t = (1 - sigma) * latents + sigma * bruit
            cible = bruit - latents
            with torch.autocast("cuda", dtype=dtype):
                pred = transformeur(
                    hidden_states=x_t.to(dtype),
                    timestep=sigma.to(dtype),
                    encoder_hidden_states=txt.to(dtype),
                    encoder_attention_mask=masque,
                    return_dict=False,
                )[0]
                perte = torch.nn.functional.mse_loss(pred.float(), cible.float()) / cfg["gradient_accumulation"]
            perte.backward()
            perte_moy += perte.item()
        torch.nn.utils.clip_grad_norm_([p for p in transformeur.parameters() if p.requires_grad], 1.0)
        opt.step()
        opt.zero_grad(set_to_none=True)
        step += 1

        if step % 25 == 0:
            print(f"[ltx] {step}/{args.steps} loss={perte_moy / (25 * cfg['gradient_accumulation']):.4f}", flush=True)
            perte_moy = 0.0

        if step % args.save_every == 0 or step == args.steps:
            ckpt = sortie / f"checkpoint-{step}"
            ckpt.mkdir(parents=True, exist_ok=True)
            transformeur.save_pretrained(ckpt)
            torch.save(opt.state_dict(), ckpt / "optimizer.pt")
            torch.save({"step": step}, ckpt / "meta.pt")
            print(f"[ltx] checkpoint : {ckpt}")

    final = sortie / "final_adapter"
    final.mkdir(parents=True, exist_ok=True)
    transformeur.save_pretrained(final)
    print(f"[ltx] adaptateur final : {final}")


def main() -> None:
    p = argparse.ArgumentParser(description="Adaptation LoRA LTX-Video gen3 (GPU).")
    p.add_argument("--train_jsonl", default="data/video/train.jsonl")
    p.add_argument("--val_jsonl", default="data/video/validation.jsonl")
    p.add_argument("--dossier_videos", default=".")
    p.add_argument("--base_model", default=BASE_DEFAUT)
    p.add_argument("--profil", choices=["auto", "l4", "a100_40g"], default="auto")
    p.add_argument("--steps", type=int, default=None)
    p.add_argument("--save_every", type=int, default=100)
    p.add_argument("--sortie", default="sorties/gen3ia-ltx-lora")
    args = p.parse_args()

    _, profil = select_profile(args.profil)
    args.steps = args.steps or profil["video"]["steps_defaut"]
    try:
        boucle(args)
    except RequisGPU as erreur:
        print(f"REFUS : {erreur}")
        raise SystemExit(2)


if __name__ == "__main__":
    main()

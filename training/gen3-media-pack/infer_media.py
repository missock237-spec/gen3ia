#!/usr/bin/env python3
"""Inférence média unifiée gen3 — image / TTS parlé / vidéo LTX / AV neural (GPU).

Sous-commandes :
  image : SDXL + LoRA adapté   -> PNG photoréaliste
  tts   : F5-TTS adapté        -> WAV parole française (clonage via audio de référence)
          | moteur kokoro (Apache-2.0) en alternative de licence
  video : LTX-Video + LoRA     -> MP4 réaliste court (2-5 s)
  av    : moteur AV neural gen3 (expérimental, from scratch) -> MP4+audio

Toutes les voies refusent proprement sans GPU (convention gen3).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def exiger_cuda(action: str) -> None:
    import torch

    if not torch.cuda.is_available():
        print(f"REFUS : {action} exige un GPU CUDA (gen3 ne génère pas de médias sur CPU).")
        raise SystemExit(2)


def cmd_image(a) -> None:
    exiger_cuda("image.generate")
    import torch
    from diffusers import StableDiffusionXLPipeline

    device = "cuda"
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    pipe = StableDiffusionXLPipeline.from_pretrained(a.base_model, torch_dtype=dtype).to(device)
    if a.adapter:
        from peft import PeftModel

        # LoRA entraîné par train_image_sdxl.py : chargé sur l'UNet puis fusionné.
        pipe.unet = PeftModel.from_pretrained(pipe.unet, a.adapter).merge_and_unload()
    gen = torch.Generator(device=device).manual_seed(a.graine if a.graine is not None else 0)
    with torch.inference_mode():
        image = pipe(
            a.prompt,
            num_inference_steps=a.steps,
            guidance_scale=a.cfg,
            width=a.largeur,
            height=a.hauteur,
            generator=gen,
        ).images[0]
    image.save(a.out)
    print(f"[image] {a.out}")


def cmd_tts(a) -> None:
    exiger_cuda("tts.speak")
    if a.moteur == "kokoro":
        _tts_kokoro(a)
        return
    import soundfile as sf
    import torch
    from f5_tts.api import F5TTS

    modele = F5TTS(model=a.modele)
    wav, sr, _ = modele.infer(
        ref_file=str(a.ref),
        ref_text=a.ref_texte or "",
        gen_text=a.texte,
        file_type="wav",
        nfe_step=a.steps,
    )
    sf.write(a.out, wav, sr)
    print(f"[tts] {a.out} ({len(wav) / sr:.1f} s à {sr} Hz)")


def _tts_kokoro(a) -> None:
    """Alternative Apache-2.0 : Kokoro-82M, voix française si disponible."""
    import soundfile as sf
    from kokoro import KPipeline

    code = a.langue or "f"
    pipeline = KPipeline(lang_code=code)
    morceaux = list(pipeline(a.texte, voice=a.voix))
    if not morceaux:
        raise SystemExit("Kokoro n'a produit aucun audio — vérifiez la voix/langue demandée.")
    import numpy as np

    audio = np.concatenate([m.audio for m in morceaux])
    sf.write(a.out, audio, 24000)
    print(f"[tts-kokoro] {a.out} ({len(audio) / 24000:.1f} s, voix {a.voix}, Apache-2.0)")


def cmd_video(a) -> None:
    exiger_cuda("video.generate")
    import torch
    from diffusers import LTXPipeline
    from diffusers.utils import export_to_video

    device = "cuda"
    dtype = torch.bfloat16
    pipe = LTXPipeline.from_pretrained(a.base_model, torch_dtype=dtype).to(device)
    if a.adapter:
        from peft import PeftModel

        pipe.transformer = PeftModel.from_pretrained(pipe.transformer, a.adapter)
        pipe.transformer = pipe.transformer.merge_and_unload()
    gen = torch.Generator(device=device).manual_seed(a.graine if a.graine is not None else 0)
    with torch.inference_mode():
        frames = pipe(
            a.prompt,
            width=a.largeur,
            height=a.hauteur,
            num_frames=a.frames,
            num_inference_steps=a.steps,
            generator=gen,
        ).frames[0]
    export_to_video(frames, a.out, fps=a.fps)
    print(f"[video] {a.out} ({a.frames / a.fps:.1f} s)")


def cmd_av(a) -> None:
    """Délègue au moteur AV neural gen3 (train_av_neural.py sample)."""
    exiger_cuda("av.sample")
    cmd = [
        sys.executable, str(Path(__file__).resolve().parent / "train_av_neural.py"),
        "sample",
        "--vae_v", a.vae_v, "--vae_a", a.vae_a, "--ckpt", a.ckpt,
        "--prompt", a.prompt, "--out", a.out,
    ]
    if a.image:
        cmd += ["--image", a.image]
    if a.audio:
        cmd += ["--audio", a.audio]
    if a.graine is not None:
        cmd += ["--seed", str(a.graine)]
    raise SystemExit(subprocess_run(cmd))


def subprocess_run(cmd: list[str]) -> int:
    import subprocess

    return subprocess.run(cmd).returncode


def main() -> None:
    p = argparse.ArgumentParser(description="Inférence média gen3 (GPU obligatoire).")
    sp = p.add_subparsers(dest="cmd", required=True)

    q = sp.add_parser("image", help="Image photoréaliste (SDXL + LoRA)")
    q.add_argument("--prompt", required=True)
    q.add_argument("--adapter", default="sorties/gen3ia-sdxl-lora/final_adapter")
    q.add_argument("--base_model", default="stabilityai/stable-diffusion-xl-base-1.0")
    q.add_argument("--largeur", type=int, default=1024)
    q.add_argument("--hauteur", type=int, default=1024)
    q.add_argument("--steps", type=int, default=30)
    q.add_argument("--cfg", type=float, default=5.0)
    q.add_argument("--graine", type=int, default=None)
    q.add_argument("--out", default="gen3_image.png")
    q.set_defaults(fn=cmd_image)

    q = sp.add_parser("tts", help="TTS parlé français (F5-TTS adapté, ou Kokoro Apache)")
    q.add_argument("--texte", required=True)
    q.add_argument("--moteur", choices=["f5", "kokoro"], default="f5")
    q.add_argument("--ref", default=None, help="Audio de référence (clonage voix, voie f5)")
    q.add_argument("--ref_texte", default=None)
    q.add_argument("--modele", default="SWivid/F5-TTS-v1")
    q.add_argument("--langue", default="f", help="Code langue Kokoro (f = fr-fr)")
    q.add_argument("--voix", default="ff_siwis", help="Voix Kokoro (fr si disponible)")
    q.add_argument("--steps", type=int, default=32)
    q.add_argument("--out", default="gen3_voix.wav")
    q.set_defaults(fn=cmd_tts)

    q = sp.add_parser("video", help="Vidéo réaliste (LTX-Video + LoRA)")
    q.add_argument("--prompt", required=True)
    q.add_argument("--adapter", default="sorties/gen3ia-ltx-lora/final_adapter")
    q.add_argument("--base_model", default="Lightricks/LTX-Video-0.9.7-dev")
    q.add_argument("--largeur", type=int, default=480)
    q.add_argument("--hauteur", type=int, default=288)
    q.add_argument("--frames", type=int, default=41, help="Multiple de 8 + 1")
    q.add_argument("--fps", type=int, default=24)
    q.add_argument("--steps", type=int, default=40)
    q.add_argument("--graine", type=int, default=None)
    q.add_argument("--out", default="gen3_clip.mp4")
    q.set_defaults(fn=cmd_video)

    q = sp.add_parser("av", help="AV neural gen3 (expérimental)")
    q.add_argument("--prompt", required=True)
    q.add_argument("--vae_v", required=True)
    q.add_argument("--vae_a", required=True)
    q.add_argument("--ckpt", required=True)
    q.add_argument("--image", default=None)
    q.add_argument("--audio", default=None)
    q.add_argument("--graine", type=int, default=None)
    q.add_argument("--out", default="gen3_av.mp4")
    q.set_defaults(fn=cmd_av)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Benchmarks de performance et de latence gen3 multimédia — mesures RÉELLES (GPU).

Produit un rapport JSON honnête mesuré sur la machine qui exécute le script :
  * image : s / image à résolution × étapes données (3 passes, médiane)
  * tts   : RTF (temps réel = durée GPU / durée audio produite) — RTF < 1 = plus vite que le temps réel
  * video : secondes GPU / seconde de vidéo générée à résolution × frames × étapes
  * av    : moteur AV neural (expérimental) : s / clip

Aucun chiffre inventé : si une voie échoue, le rapport le dit ("erreur": ...).
C'est CE rapport qu'il faut comparer aux objectifs — pas des promesses.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def gpu_info() -> dict:
    import torch

    if not torch.cuda.is_available():
        return {"gpu": None, "erreur": "aucun CUDA — benchmarks refusés (gen3 GPU-only)"}
    props = torch.cuda.get_device_properties(0)
    return {"gpu": props.name, "vram_go": round(props.total_memory / 2**30, 1), "cuda": torch.version.cuda}


def bench_image(a, rapport: dict) -> None:
    import torch
    from diffusers import StableDiffusionXLPipeline

    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    pipe = StableDiffusionXLPipeline.from_pretrained(a.base_model, torch_dtype=dtype).to("cuda")
    if a.adapter:
        from peft import PeftModel

        pipe.unet = PeftModel.from_pretrained(pipe.unet, a.adapter).merge_and_unload()
    gen = torch.Generator(device="cuda").manual_seed(42)
    temps = []
    for i in range(a.passes):
        torch.cuda.synchronize()
        t0 = time.perf_counter()
        with torch.inference_mode():
            pipe(a.prompt or "a photorealistic portrait of a woman, natural light",
                 num_inference_steps=a.steps, width=a.largeur, height=a.hauteur, generator=gen)
        torch.cuda.synchronize()
        temps.append(round(time.perf_counter() - t0, 2))
    rapport["image"] = {
        "config": f"{a.largeur}x{a.hauteur} @ {a.steps} étapes",
        "secondes_par_image": statistics.median(temps),
        "passes": temps,
    }


def bench_tts(a, rapport: dict) -> None:
    import soundfile as sf

    debut = time.perf_counter()
    import subprocess

    cmd = [sys.executable, str(Path(__file__).parent / "infer_media.py"), "tts",
           "--texte", a.texte, "--out", "bench_tts.wav"]
    if a.ref:
        cmd += ["--ref", a.ref]
    subprocess.run(cmd, check=True)
    gpu_s = time.perf_counter() - debut
    info = sf.info("bench_tts.wav")
    duree = info.duration
    rapport["tts"] = {
        "moteur": "f5-tts" if a.ref else "f5-tts (voix de base)",
        "texte_caracteres": len(a.texte),
        "audio_secondes": round(duree, 2),
        "gpu_secondes": round(gpu_s, 2),
        "rtf": round(gpu_s / max(duree, 1e-6), 3),
        "lecture": "RTF < 1 = plus rapide que le temps réel",
    }


def bench_video(a, rapport: dict) -> None:
    import torch
    from diffusers import LTXPipeline
    from diffusers.utils import export_to_video

    dtype = torch.bfloat16
    pipe = LTXPipeline.from_pretrained(a.base_model, torch_dtype=dtype).to("cuda")
    if a.adapter:
        from peft import PeftModel

        pipe.transformer = PeftModel.from_pretrained(pipe.transformer, a.adapter).merge_and_unload()
    gen = torch.Generator(device="cuda").manual_seed(42)
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    with torch.inference_mode():
        frames = pipe(a.prompt or "a drone shot over a coastal road, golden hour",
                      width=a.largeur, height=a.hauteur, num_frames=a.frames,
                      num_inference_steps=a.steps, generator=gen).frames[0]
    torch.cuda.synchronize()
    gpu_s = time.perf_counter() - t0
    export_to_video(frames, "bench_video.mp4", fps=24)
    rapport["video"] = {
        "config": f"{a.largeur}x{a.hauteur}, {a.frames} frames @ {a.steps} étapes",
        "gpu_secondes": round(gpu_s, 2),
        "video_secondes": round(a.frames / 24, 2),
        "secondes_gpu_par_seconde_video": round(gpu_s / (a.frames / 24), 2),
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Benchmarks latence gen3 multimédia (GPU).")
    p.add_argument("--voies", default="image,tts,video", help="Voies à mesurer (CSV).")
    p.add_argument("--base_model", default="stabilityai/stable-diffusion-xl-base-1.0")
    p.add_argument("--base_model_video", default="Lightricks/LTX-Video-0.9.7-dev")
    p.add_argument("--adapter", default=None)
    p.add_argument("--adapter_video", default=None)
    p.add_argument("--largeur", type=int, default=768)
    p.add_argument("--hauteur", type=int, default=768)
    p.add_argument("--steps_image", type=int, default=30)
    p.add_argument("--passes", type=int, default=3)
    p.add_argument("--frames", type=int, default=41)
    p.add_argument("--steps_video", type=int, default=40)
    p.add_argument("--ref", default=None)
    p.add_argument("--texte", default="Bonjour, je suis gen3, votre assistant intelligent en français.")
    p.add_argument("--prompt", default=None)
    p.add_argument("--out", default="bench_media.json")
    args = p.parse_args()

    rapport: dict = {"gpu": gpu_info(), "date": time.strftime("%Y-%m-%d %H:%M:%S")}
    voies = [v.strip() for v in args.voies.split(",") if v.strip()]

    if rapport["gpu"]["gpu"] is None:
        rapport["erreur_globale"] = rapport["gpu"]["erreur"]
    else:
        for voie in voies:
            try:
                if voie == "image":
                    bench_image(args, rapport)
                elif voie == "tts":
                    bench_tts(args, rapport)
                elif voie == "video":
                    args.base_model = args.base_model_video if args.base_model_video else args.base_model
                    bench_video(args, rapport)
                else:
                    rapport[voie] = {"erreur": f"voie inconnue : {voie}"}
            except Exception as e:
                rapport[voie] = {"erreur": f"{type(e).__name__}: {e}"[:300]}

    Path(args.out).write_text(json.dumps(rapport, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(rapport, indent=2, ensure_ascii=False))
    print(f"\n[bench] rapport : {args.out}")


if __name__ == "__main__":
    main()

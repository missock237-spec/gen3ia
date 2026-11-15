#!/usr/bin/env python3
"""Profils de performance gen3 — pack multimédia (image / TTS parlé / vidéo LTX / AV neural).

Même convention que le pack image : DEUX niveaux de performance, GPU obligatoire,
CPU jamais un niveau d'exécution de l'IA gen3.

  * l4       : plancher 22 Go VRAM  — SDXL 768 px r16, LTX 480x288x41, F5-TTS bs1, AV neural small
  * a100_40g : plancher 36 Go VRAM  — SDXL 1024 px r32, LTX 704x448x57, F5-TTS bs2, AV neural base

`select_profile` détecte automatiquement le GPU disponible (torch importé en
paresseux pour rester testable sans CUDA) et REFUSE proprement sans GPU.
"""

from __future__ import annotations

PROFILS_PERFORMANCE: dict[str, dict] = {
    "l4": {
        "vram_min_go": 22,
        "description": "L4 24 Go / RTX 4090 / A10G — SDXL 768 px LoRA r16, LTX-Video 480x288x41, F5-TTS bs1, AV-DiT small",
        "image": {
            "resolution": 768,
            "lora_r": 16,
            "lora_alpha": 32,
            "batch": 1,
            "gradient_accumulation": 4,
            "lr": 1e-4,
            "steps_defaut": 1500,
        },
        "tts": {
            "batch": 1,
            "gradient_accumulation": 2,
            "lr": 5e-5,
            "steps_defaut": 1500,
        },
        "video": {
            "resolution": [480, 288],
            "frames": 41,
            "lora_r": 16,
            "lora_alpha": 32,
            "batch": 1,
            "gradient_accumulation": 4,
            "lr": 1e-4,
            "steps_defaut": 800,
        },
        "av_neural": {
            "preset": "small",
            "size": 192,
            "frames": 16,
            "fps": 12,
            "bs": 2,
            "accum": 8,
            "steps_defaut": 2000,
        },
    },
    "a100_40g": {
        "vram_min_go": 36,
        "description": "A100 40 Go / A100 80 Go — SDXL 1024 px LoRA r32, LTX-Video 704x448x57, F5-TTS bs2, AV-DiT base",
        "image": {
            "resolution": 1024,
            "lora_r": 32,
            "lora_alpha": 64,
            "batch": 2,
            "gradient_accumulation": 2,
            "lr": 1.5e-4,
            "steps_defaut": 3000,
        },
        "tts": {
            "batch": 2,
            "gradient_accumulation": 1,
            "lr": 5e-5,
            "steps_defaut": 2500,
        },
        "video": {
            "resolution": [704, 448],
            "frames": 57,
            "lora_r": 32,
            "lora_alpha": 64,
            "batch": 1,
            "gradient_accumulation": 2,
            "lr": 1.5e-4,
            "steps_defaut": 1500,
        },
        "av_neural": {
            "preset": "base",
            "size": 256,
            "frames": 32,
            "fps": 12,
            "bs": 4,
            "accum": 4,
            "steps_defaut": 5000,
        },
    },
}

NIVEAUX_TRIS = ["l4", "a100_40g"]


class ErreurProfil(RuntimeError):
    """Refus propre : configuration impossible avec les ressources disponibles."""


def vram_disponible_go(torch_module=None) -> float | None:
    """VRAM TOTALE du GPU 0 en Go, ou None si torch/CUDA indisponible."""
    try:
        import importlib

        torch = torch_module or importlib.import_module("torch")
    except ImportError:
        return None
    if not torch.cuda.is_available():
        return None
    props = torch.cuda.get_device_properties(0)
    return round(props.total_memory / (1024 ** 3), 1)


def select_profile(nom: str | None = None, torch_module=None) -> tuple[str, dict]:
    """Choisit le niveau de performance.

    * nom explicite ("l4" | "a100_40g") : vérifie quand même qu'un GPU réel existe ;
    * nom absent ou "auto" : détection par VRAM totale ;
    * sans CUDA / sans torch : ErreurProfil — gen3 ne s'entraîne JAMAIS sur CPU.
    """
    try:
        import importlib

        torch = torch_module or importlib.import_module("torch")
    except ImportError as erreur:
        raise ErreurProfil(
            "torch/CUDA indisponible : l'entraînement gen3 exige un GPU réel "
            "(Colab / L4 / A100). L'entraînement CPU est refusé par conception."
        ) from erreur
    if not getattr(torch.cuda, "is_available", lambda: False)():
        raise ErreurProfil(
            "Aucun GPU CUDA détecté. gen3 s'entraîne exclusivement sur GPU "
            "(Colab / L4 / A100). L'entraînement CPU est refusé par conception."
        )

    vram = vram_disponible_go(torch_module=torch)

    if nom in (None, "", "auto"):
        if vram is None:
            raise ErreurProfil("GPU CUDA introuvable malgré cuda.is_available() — environnement incohérent.")
        if vram >= PROFILS_PERFORMANCE["a100_40g"]["vram_min_go"]:
            return "a100_40g", PROFILS_PERFORMANCE["a100_40g"]
        if vram >= PROFILS_PERFORMANCE["l4"]["vram_min_go"]:
            return "l4", PROFILS_PERFORMANCE["l4"]
        raise ErreurProfil(
            f"GPU détecté avec {vram} Go VRAM : inférieur au plancher l4 "
            f"({PROFILS_PERFORMANCE['l4']['vram_min_go']} Go). Réduisez la résolution "
            "manuellement ou utilisez un GPU plus grand."
        )

    if nom not in PROFILS_PERFORMANCE:
        raise ErreurProfil(f"Profil inconnu : {nom!r} (choix : {', '.join(NIVEAUX_TRIS)}).")

    plancher = PROFILS_PERFORMANCE[nom]["vram_min_go"]
    if vram is not None and vram < plancher:
        raise ErreurProfil(
            f"Profil {nom} exige {plancher} Go VRAM ; GPU actuel : {vram} Go. "
            "Choisissez le profil inférieur ou un GPU plus grand."
        )
    return nom, PROFILS_PERFORMANCE[nom]


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="Affiche le profil gen3 choisi pour ce GPU.")
    p.add_argument("--profil", choices=[*NIVEAUX_TRIS, "auto"], default="auto")
    args = p.parse_args()
    try:
        nom, profil = select_profile(args.profil)
        print(f"Profil retenu : {nom} — {profil['description']}")
    except ErreurProfil as erreur:
        print(f"REFUS : {erreur}")
        raise SystemExit(2)

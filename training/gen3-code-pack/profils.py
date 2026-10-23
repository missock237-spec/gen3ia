#!/usr/bin/env python3
"""Profils de performance gen3 — pack code (création de sites et de programmes).

Même convention que les packs image / média : DEUX niveaux de performance,
GPU obligatoire, CPU jamais un niveau d'exécution de l'IA gen3.

  * l4       : plancher 22 Go VRAM — LoRA r16/a32, séquences 4096 tokens,
               batch 2 x accum 8 (effectif 16), lr 2e-4 — un modèle codeur 7-8B
               en 4 bits tient sur L4 24 Go / RTX 4090 / A10G.
  * a100_40g : plancher 36 Go VRAM — LoRA r32/a64, séquences 8192 tokens
               (pages web complètes), batch 4 x accum 4 (effectif 16), lr 2.5e-4.

Le code de site est LONG : la taille de séquence (max_length) est le réglage
critique de ce pack, d'où des profils dédiés au texte plutôt qu'aux pixels.

`select_profile` détecte automatiquement le GPU disponible (torch importé en
paresseux pour rester testable sans CUDA) et REFUSE proprement sans GPU.
"""

from __future__ import annotations

PROFILS_PERFORMANCE: dict[str, dict] = {
    "l4": {
        "vram_min_go": 22,
        "description": (
            "L4 24 Go / RTX 4090 / A10G — LoRA r16/a32, séquences 4096 tokens, "
            "batch 2 x accum 8, lr 2e-4 (modèle codeur 7-8B en 4 bits)"
        ),
        "code": {
            "max_length": 4096,
            "batch": 2,
            "gradient_accumulation": 8,
            "lr": 2e-4,
            "lora_r": 16,
            "lora_alpha": 32,
            "save_steps": 200,
        },
    },
    "a100_40g": {
        "vram_min_go": 36,
        "description": (
            "A100 40 Go / A100 80 Go — LoRA r32/a64, séquences 8192 tokens "
            "(pages web complètes), batch 4 x accum 4, lr 2.5e-4"
        ),
        "code": {
            "max_length": 8192,
            "batch": 4,
            "gradient_accumulation": 4,
            "lr": 2.5e-4,
            "lora_r": 32,
            "lora_alpha": 64,
            "save_steps": 150,
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
            raise ErreurProfil(
                "GPU CUDA introuvable malgré cuda.is_available() — environnement incohérent."
            )
        if vram >= PROFILS_PERFORMANCE["a100_40g"]["vram_min_go"]:
            return "a100_40g", PROFILS_PERFORMANCE["a100_40g"]
        if vram >= PROFILS_PERFORMANCE["l4"]["vram_min_go"]:
            return "l4", PROFILS_PERFORMANCE["l4"]
        raise ErreurProfil(
            f"GPU détecté avec {vram} Go VRAM : inférieur au plancher l4 "
            f"({PROFILS_PERFORMANCE['l4']['vram_min_go']} Go). Réduisez --max-length "
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

    p = argparse.ArgumentParser(description="Affiche le profil gen3 code choisi pour ce GPU.")
    p.add_argument("--profil", choices=[*NIVEAUX_TRIS, "auto"], default="auto")
    args = p.parse_args()
    try:
        nom, profil = select_profile(args.profil)
        print(f"Profil retenu : {nom} — {profil['description']}")
    except ErreurProfil as erreur:
        print(f"REFUS : {erreur}")
        raise SystemExit(2)

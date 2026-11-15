#!/usr/bin/env python3
"""Inférence gen3 code : génère des sites et du code à partir d'une instruction.

Charge le modèle de base + l'adaptateur LoRA entraîné par train_gen3_code.py,
reconstruit le MÊME gabarit de prompt (format_prompt.build_prompt) puis génère.

Exemples :
  python infer_gen3_code.py --model-path Qwen/Qwen2.5-Coder-7B-Instruct \
      --adapter ./gen3-code-lora \
      --instruction "Crée une page de contact HTML avec formulaire accessible" \
      --language html --output contact.html

  python infer_gen3_code.py --model-path ... --adapter ...   # mode interactif

GPU obligatoire (refus propre sans CUDA). L'adaptateur n'est PAS un modèle
autonome : le modèle de base d'origine est requis.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

sys.path.insert(0, str(Path(__file__).resolve().parent))
from format_prompt import build_prompt  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Génération de code/sites avec l'adaptateur gen3 (GPU requis)."
    )
    parser.add_argument("--model-path", required=True,
                        help="Modèle de BASE (identique à l'entraînement).")
    parser.add_argument("--adapter", default="./gen3-code-lora",
                        help="Répertoire de l'adaptateur LoRA (défaut ./gen3-code-lora).")
    parser.add_argument("--instruction", default=None,
                        help="Instruction (absent => mode interactif).")
    parser.add_argument("--language", default="html", help="Langage cible (défaut html).")
    parser.add_argument("--task", default="programming", help="Type de tâche (défaut programming).")
    parser.add_argument("--max-new-tokens", type=int, default=2048)
    parser.add_argument("--temperature", type=float, default=0.2,
                        help="Code : température basse recommandée (défaut 0.2).")
    parser.add_argument("--top-p", type=float, default=0.9)
    parser.add_argument("--repetition-penalty", type=float, default=1.05)
    parser.add_argument("--output", default=None, help="Fichier où écrire le code généré.")
    parser.add_argument("--merge-and-save", default=None, metavar="DIR",
                        help="Fusionner l'adaptateur dans la base et exporter le modèle complet (gros).")
    parser.add_argument("--trust-remote-code", action="store_true")
    parser.add_argument("--hf-token", default=None,
                        help="Token HF pour les bases gated ; défaut : variable HF_TOKEN.")
    return parser.parse_args()


def load_model(args: argparse.Namespace):
    """Charge base + adaptateur sur le GPU ; refus propre sans CUDA."""
    if not torch.cuda.is_available():
        print("REFUS : aucun GPU CUDA détecté. L'inférence gen3 s'exécute sur GPU "
              "(Colab / L4 / A100).")
        raise SystemExit(2)
    hf_token = args.hf_token or os.environ.get("HF_TOKEN") or None

    tokenizer = AutoTokenizer.from_pretrained(
        args.model_path, trust_remote_code=args.trust_remote_code, token=hf_token)
    model = AutoModelForCausalLM.from_pretrained(
        args.model_path,
        torch_dtype=torch.float16,
        device_map={"": 0},
        trust_remote_code=args.trust_remote_code,
        token=hf_token,
    )
    model = PeftModel.from_pretrained(model, args.adapter, token=hf_token)
    model.eval()
    return tokenizer, model


def generate(tokenizer, model, instruction: str, language: str, task: str,
             args: argparse.Namespace) -> str:
    prompt = build_prompt(instruction, language, task)
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=args.max_new_tokens,
            do_sample=args.temperature > 0,
            temperature=max(args.temperature, 1e-5),
            top_p=args.top_p,
            repetition_penalty=args.repetition_penalty,
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
            eos_token_id=tokenizer.eos_token_id,
        )
    nouvel = output_ids[0][inputs["input_ids"].shape[1]:]
    return tokenizer.decode(nouvel, skip_special_tokens=True).strip()


def main() -> None:
    args = parse_args()
    tokenizer, model = load_model(args)

    if args.merge_and_save:
        print(f"Fusion de l'adaptateur dans la base → {args.merge_and_save} "
              "(export complet, plusieurs Go)...")
        model = model.merge_and_unload()
        model.save_pretrained(args.merge_and_save)
        tokenizer.save_pretrained(args.merge_and_save)
        print(f"Modèle fusionné sauvegardé : {args.merge_and_save}")
        return

    if args.instruction:
        code = generate(tokenizer, model, args.instruction, args.language, args.task, args)
        print("──────────── code généré ────────────")
        print(code)
        print("─────────────────────────────────────")
        if args.output:
            Path(args.output).write_text(code, encoding="utf-8")
            print(f"Code écrit dans : {args.output}")
        return

    # Mode interactif (REPL) : une instruction par ligne, 'quit' pour sortir.
    print("Mode interactif gen3 code — instruction + [Entrée] ; 'quit' pour sortir.")
    while True:
        try:
            instruction = input("gen3> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not instruction:
            continue
        if instruction.lower() in {"quit", "exit", "q"}:
            break
        langue = input("langage [html]> ").strip() or "html"
        code = generate(tokenizer, model, instruction, langue, args.task, args)
        print(code)
        print()


if __name__ == "__main__":
    main()

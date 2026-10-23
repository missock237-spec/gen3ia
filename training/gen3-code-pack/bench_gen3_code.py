#!/usr/bin/env python3
"""Benchmark gen3 code : latence réelle et débit de génération de sites.

Mesure, sur un jeu fixe d'instructions de création de sites :
  * latence du premier token (TTFT, s),
  * temps total de génération (s),
  * tokens générés et débit (tokens/s),
  * facteur de remplissage (tokens générés / max_new_tokens).

Aucun chiffre inventé : tout vient de l'exécution réelle sur le GPU présent.
Résultats écrits en JSON (--output, défaut bench_code_results.json).

GPU obligatoire. Le modèle doit être chargé avec l'adaptateur entraîné.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer
from peft import PeftModel

sys.path.insert(0, str(Path(__file__).resolve().parent))
from format_prompt import build_prompt  # noqa: E402


PROMPTS_BENCH = [
    ("html", "programming",
     "Crée une landing page HTML complète (hero, 3 fonctionnalités, footer) "
     "avec CSS intégré dans une seule page."),
    ("html", "web",
     "Crée un formulaire de contact HTML accessible (labels, aria-describedby, "
     "champs requis) prêt à brancher sur une API."),
    ("css", "web",
     "Écris le CSS d'une grille portfolio responsive en auto-fill/minmax "
     "avec cartes et effet au survol."),
    ("javascript", "frontend",
     "Écris le JavaScript d'un formulaire : validation email + mot de passe "
     "fort, messages d'erreur sous chaque champ."),
    ("javascript", "frontend",
     "Écris une to-do list JavaScript complète : ajouter, cocher, supprimer, "
     "persistance localStorage."),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark latence/débit de génération de code gen3 (GPU requis)."
    )
    parser.add_argument("--model-path", required=True, help="Modèle de BASE.")
    parser.add_argument("--adapter", default="./gen3-code-lora", help="Adaptateur LoRA.")
    parser.add_argument("--max-new-tokens", type=int, default=1024)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--output", default="bench_code_results.json")
    parser.add_argument("--trust-remote-code", action="store_true")
    parser.add_argument("--hf-token", default=None,
                        help="Token HF pour les bases gated ; défaut : variable HF_TOKEN.")
    return parser.parse_args()


def bench_one(tokenizer, model, language: str, task: str, instruction: str,
              args: argparse.Namespace) -> dict:
    prompt = build_prompt(instruction, language, task)
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    streamer = TextIteratorStreamer(
        tokenizer, skip_prompt=True, skip_special_tokens=True)

    params = dict(
        **inputs,
        max_new_tokens=args.max_new_tokens,
        do_sample=args.temperature > 0,
        temperature=max(args.temperature, 1e-5),
        top_p=0.9,
        repetition_penalty=1.05,
        pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        eos_token_id=tokenizer.eos_token_id,
        streamer=streamer,
    )
    thread = threading.Thread(target=lambda: model.generate(**params))
    t0 = time.perf_counter()
    thread.start()

    ttft = None
    tokens = 0
    for _morceau in streamer:
        if ttft is None:
            ttft = time.perf_counter() - t0
        tokens += 1

    thread.join()
    total = time.perf_counter() - t0
    remplissage = tokens / args.max_new_tokens
    return {
        "language": language,
        "instruction": instruction,
        "ttft_s": round(ttft, 3) if ttft is not None else None,
        "total_s": round(total, 3),
        "tokens_generes": tokens,
        "tokens_par_s": round(tokens / total, 2) if total > 0 else None,
        "fill_ratio": round(remplissage, 3),
    }


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        print("REFUS : aucun GPU CUDA détecté. Le benchmark s'exécute sur GPU.")
        raise SystemExit(2)
    hf_token = args.hf_token or os.environ.get("HF_TOKEN") or None

    props = torch.cuda.get_device_properties(0)
    gpu_nom = props.name
    vram_go = round(props.total_memory / (1024 ** 3), 1)
    print(f"GPU : {gpu_nom} ({vram_go} Go) — chargement {args.model_path} + {args.adapter}")

    tokenizer = AutoTokenizer.from_pretrained(
        args.model_path, trust_remote_code=args.trust_remote_code, token=hf_token)
    model = AutoModelForCausalLM.from_pretrained(
        args.model_path, torch_dtype=torch.float16, device_map={"": 0},
        trust_remote_code=args.trust_remote_code, token=hf_token)
    model = PeftModel.from_pretrained(model, args.adapter, token=hf_token)
    model.eval()

    resultats = []
    for language, task, instruction in PROMPTS_BENCH:
        print(f"  ▶ [{language}] {instruction[:60]}...")
        ligne = bench_one(tokenizer, model, language, task, instruction, args)
        print(f"    TTFT {ligne['ttft_s']} s · total {ligne['total_s']} s · "
              f"{ligne['tokens_generes']} tokens · {ligne['tokens_par_s']} tok/s")
        resultats.append(ligne)

    valides = [r for r in resultats if r["tokens_par_s"]]
    rapport = {
        "gpu": {"nom": gpu_nom, "vram_go": vram_go},
        "model_path": args.model_path,
        "adapter": str(Path(args.adapter).resolve()),
        "max_new_tokens": args.max_new_tokens,
        "temperature": args.temperature,
        "mesures": resultats,
        "resume": {
            "ttft_s_moyen": round(sum(r["ttft_s"] for r in resultats if r["ttft_s"] is not None)
                                  / max(len([r for r in resultats if r["ttft_s"] is not None]), 1), 3),
            "tokens_par_s_moyen": round(sum(r["tokens_par_s"] for r in valides)
                                        / max(len(valides), 1), 2),
            "fill_ratio_moyen": round(sum(r["fill_ratio"] for r in resultats)
                                      / max(len(resultats), 1), 3),
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    Path(args.output).write_text(json.dumps(rapport, indent=2, ensure_ascii=False),
                                 encoding="utf-8")
    print(f"Résultats écrits : {args.output}")
    print(f"Moyennes : TTFT {rapport['resume']['ttft_s_moyen']} s · "
          f"{rapport['resume']['tokens_par_s_moyen']} tok/s · "
          f"remplissage {rapport['resume']['fill_ratio_moyen']}")


if __name__ == "__main__":
    main()

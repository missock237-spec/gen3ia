#!/usr/bin/env python3
"""Inférence gen3 — Gemma 3 + adaptateur LoRA, avec mesure de latence.

Charge le modèle de base (4-bit NF4) + l'adaptateur entraîné, répond à une
instruction (texte seul ou texte+image) et affiche les temps de réponse :
latence de pré-remplissage, latence de génération, jetons/s.

Exemples :
  python infer_multimodal.py --adapter outputs/gen3-core-lora/final_adapter \
      --task plan --instruction "Prépare un plan pour une cantine scolaire"
  python infer_multimodal.py --adapter ... --image data/images/ui_login_demo.png \
      --task image_analysis --instruction "Analyse cette interface"
"""
import argparse
import time
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoProcessor, BitsAndBytesConfig, Gemma3ForConditionalGeneration
from peft import PeftModel


def main():
    ap = argparse.ArgumentParser(description="Inférence gen3 (Gemma 3 + LoRA)")
    ap.add_argument("--adapter", required=True, help="Dossier de l'adaptateur (final_adapter)")
    ap.add_argument("--base_model", default=None,
                    help="Modèle de base (défaut : déduit de la taille de l'adaptateur → gemma-3-4b-it)")
    ap.add_argument("--task", default="generique")
    ap.add_argument("--instruction", required=True)
    ap.add_argument("--input_text", default="")
    ap.add_argument("--image", default=None, help="Chemin d'image optionnel")
    ap.add_argument("--max_new_tokens", type=int, default=512)
    ap.add_argument("--repetitions", type=int, default=1,
                    help="Répète la génération pour des latences fiables (p50/p95)")
    args = ap.parse_args()

    if not torch.cuda.is_available():
        raise RuntimeError(
            "GPU CUDA requis : gen3 est conçue pour fonctionner avec les "
            "ressources GPU à sa disposition (L4, A100...), pas sur CPU."
        )

    base = args.base_model or "google/gemma-3-4b-it"
    compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    qconfig = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=compute_dtype,
    )
    print(f"Chargement de {base} (4-bit NF4)…", flush=True)
    t0 = time.time()
    model = Gemma3ForConditionalGeneration.from_pretrained(
        base, quantization_config=qconfig, torch_dtype=compute_dtype, device_map="auto",
    )
    model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()
    processor = AutoProcessor.from_pretrained(args.adapter)
    print(f"Modèle prêt en {time.time() - t0:.1f} s.")

    im = Image.open(args.image).convert("RGB") if args.image else None
    user_content = []
    if im is not None:
        user_content.append({"type": "image"})
    blocs = [f"Tâche: {args.task}", f"Instruction: {args.instruction}"]
    if args.input_text:
        blocs.append(f"Entrée: {args.input_text}")
    user_content.append({"type": "text", "text": "\n".join(blocs)})
    msgs = [{"role": "user", "content": user_content}]

    prompt = processor.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)

    latences_prefill, latences_gen, vitesses = [], [], []
    reponse = ""
    for rep in range(max(1, args.repetitions)):
        inputs = processor(text=[prompt], images=[im] if im is not None else None,
                           return_tensors="pt").to(model.device)
        torch.cuda.synchronize()
        t1 = time.time()
        with torch.no_grad():
            _ = model(**inputs)
        torch.cuda.synchronize()
        t2 = time.time()
        with torch.no_grad():
            sortie = model.generate(
                **inputs,
                max_new_tokens=args.max_new_tokens,
                do_sample=True,
                temperature=0.7,
                top_p=0.9,
            )
        torch.cuda.synchronize()
        t3 = time.time()
        nouvelle = sortie[0][inputs["input_ids"].shape[1]:]
        n_tokens = int(nouvelle.shape[0])
        latences_prefill.append(t2 - t1)
        latences_gen.append(t3 - t2)
        vitesses.append(n_tokens / max(t3 - t2, 1e-6))
        reponse = processor.decode(nouvelle, skip_special_tokens=True)
        print(f"  passage {rep + 1}: préremplissage {t2 - t1:.2f} s, "
              f"génération {t3 - t2:.2f} s ({n_tokens} jetons, {vitesses[-1]:.1f} jetons/s)")

    latences_prefill.sort()
    latences_gen.sort()
    vitesses.sort()

    def pct(vals, p):
        if not vals:
            return 0.0
        return vals[min(len(vals) - 1, int(round(p / 100 * len(vals))) - 1)] if len(vals) > 1 else vals[0]

    print("\n=== Temps de réponse gen3 ===")
    print(f"  préremplissage : p50 {pct(latences_prefill, 50):.2f} s | p95 {pct(latences_prefill, 95):.2f} s")
    print(f"  génération     : p50 {pct(latences_gen, 50):.2f} s | p95 {pct(latences_gen, 95):.2f} s")
    print(f"  débit          : p50 {pct(vitesses, 50):.1f} jetons/s | p95 {pct(vitesses, 95):.1f} jetons/s")
    print("\n=== Réponse gen3 ===")
    print(reponse)


if __name__ == "__main__":
    main()

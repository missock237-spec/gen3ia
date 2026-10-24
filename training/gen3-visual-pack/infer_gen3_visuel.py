#!/usr/bin/env python3
"""Inférence visuelle de gen3 — l'élève décrit une image (GPU requis).

Charge le modèle de base Gemma 3 + l'adaptateur LoRA du cours visuel, puis :
  - décrit une image passée en argument, ou
  - répond à une question sur cette image, ou
  - lance une session interactive (une ligne = une question).

Usage :
    python infer_gen3_visuel.py --adaptateur outputs/gen3-visual-lora/final_adapter \
        --image chemin/vers/image.jpg
    python infer_gen3_visuel.py --adaptateur ... --image ... \
        --question "Combien d'aras voit-on ?"
"""
import argparse
from pathlib import Path

import torch
from PIL import Image
from transformers import (
    AutoProcessor,
    BitsAndBytesConfig,
    Gemma3ForConditionalGeneration,
)
from peft import PeftModel

PROFILS = {
    "l4": "google/gemma-3-4b-it",
    "a100_40g": "google/gemma-3-12b-it",
}


def charger(adaptateur: str, modele: str | None):
    if not torch.cuda.is_available():
        raise RuntimeError(
            "GPU CUDA requis pour l'inférence visuelle de gen3 (pas de CPU)."
        )
    chemin = Path(adaptateur)
    if chemin.exists() and (chemin / "adapter_config.json").exists():
        cfg = (chemin / "adapter_config.json").read_text(encoding="utf-8")
        base = modele
        if base is None:
            for nom, repo in PROFILS.items():
                if nom in cfg or repo in cfg:
                    base = repo
                    break
            base = base or PROFILS["l4"]
        print(f"[infer] adaptateur : {chemin} (base {base})")
        compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        qconfig = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=compute_dtype,
        )
        model = Gemma3ForConditionalGeneration.from_pretrained(
            base, quantization_config=qconfig,
            torch_dtype=compute_dtype, device_map="auto",
        )
        model = PeftModel.from_pretrained(model, chemin)
        processor = AutoProcessor.from_pretrained(chemin)
    else:
        if modele is None:
            raise SystemExit(
                f"Adaptateur introuvable : {adaptateur} — passe --modele.")
        print(f"[infer] modèle de base sans adaptateur : {modele}")
        model = Gemma3ForConditionalGeneration.from_pretrained(modele)
        processor = AutoProcessor.from_pretrained(modele)
    model.eval()
    return model, processor


def repondre(model, processor, image: Image.Image, question: str,
             max_nouveaux: int = 320) -> str:
    msgs = [
        {"role": "user", "content": [
            {"type": "image"},
            {"type": "text", "text": question},
        ]},
    ]
    prompt = processor.apply_chat_template(msgs, tokenize=False,
                                           add_generation_prompt=True)
    ins = processor(text=[prompt], images=[image], return_tensors="pt").to(model.device)
    with torch.no_grad():
        sortie = model.generate(
            **ins, max_new_tokens=max_nouveaux, do_sample=False,
            repetition_penalty=1.1,
        )
    nouvelle = sortie[0][ins["input_ids"].shape[1]:]
    return processor.decode(nouvelle, skip_special_tokens=True).strip()


def main():
    ap = argparse.ArgumentParser(description="gen3 décrit une image (cours visuel)")
    ap.add_argument("--adaptateur", default="outputs/gen3-visual-lora/final_adapter")
    ap.add_argument("--modele", default=None, help="base si pas d'adaptateur")
    ap.add_argument("--image", default=None)
    ap.add_argument("--question", default=None,
                    help="défaut : « Décris cette image en français… »")
    ap.add_argument("--max_nouveaux", type=int, default=320)
    ap.add_argument("--interactif", action="store_true")
    args = ap.parse_args()

    model, processor = charger(args.adaptateur, args.modele)
    instruction_defaut = ("Décris cette image en français, de façon précise "
                          "et organisée.")

    if args.image:
        image = Image.open(args.image).convert("RGB")
        question = args.question or instruction_defaut
        print("\n" + repondre(model, processor, image, question,
                              args.max_nouveaux) + "\n")
        return

    if not args.interactif:
        raise SystemExit("Passe --image PATH, ou --interactif pour une session.")

    print("Session visuelle gen3 — Ctrl+C pour quitter. "
          "Tape une question, gen3 répond à propos de l'image.")
    image = None
    while True:
        try:
            ligne = input("gen3> ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nÀ bientôt !")
            return
        if not ligne:
            continue
        if ligne.lower().startswith(("image:", "photo:")):
            chemin = ligne.split(":", 1)[1].strip()
            try:
                image = Image.open(chemin).convert("RGB")
                print(f"[image chargée : {chemin}]")
            except Exception as exc:
                print(f"[erreur image : {exc}]")
            continue
        if image is None:
            print("[charge d'abord une image : image: chemin/vers/photo.jpg]")
            continue
        print(repondre(model, processor, image, ligne, args.max_nouveaux))


if __name__ == "__main__":
    main()

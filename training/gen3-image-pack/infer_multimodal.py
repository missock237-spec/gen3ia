#!/usr/bin/env python3
"""Inférence gen3 vision — modèle de base Qwen3-VL + adaptateur LoRA entraîné.

gen3 fonctionne sur les ressources GPU disponibles (L4, A100...) — le CPU
n'est pas une cible supportée.
"""
import argparse

import torch
from PIL import Image
from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
from peft import PeftModel

p = argparse.ArgumentParser()
p.add_argument("--model_name", default="Qwen/Qwen3-VL-4B-Instruct")
p.add_argument("--adapter_dir", required=True)
p.add_argument("--task", default="image_analysis")
p.add_argument("--image")
p.add_argument("--instruction", required=True)
p.add_argument("--max_new_tokens", type=int, default=700)
args = p.parse_args()

if not torch.cuda.is_available():
    raise RuntimeError(
        "GPU CUDA requis : gen3 fonctionne avec les ressources GPU à sa "
        "disposition (L4, A100...), pas sur CPU."
    )
proc = AutoProcessor.from_pretrained(args.adapter_dir)
dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
model = Qwen3VLForConditionalGeneration.from_pretrained(
    args.model_name, torch_dtype=dtype, device_map="auto"
)
model = PeftModel.from_pretrained(model, args.adapter_dir)
content = []
im = Image.open(args.image).convert("RGB") if args.image else None
if im is not None:
    content.append({"type": "image", "image": im})
content.append({"type": "text", "text": f"Tâche: {args.task}\nInstruction: {args.instruction}"})
prompt = proc.apply_chat_template(
    [{"role": "user", "content": content}], tokenize=False, add_generation_prompt=True
)
inputs = proc(text=[prompt], images=[im] if im else None, return_tensors="pt").to(model.device)
with torch.no_grad():
    out = model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
print(proc.batch_decode(out[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0])

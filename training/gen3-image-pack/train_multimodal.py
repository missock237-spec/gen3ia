#!/usr/bin/env python3
"""Entraînement de gen3 (vision + code) — QLoRA sur Qwen3-VL-4B-Instruct.

Conception gen3 : l'IA est conçue pour fonctionner avec les ressources GPU
qu'elle a à sa disposition — le CPU n'est pas une cible supportée. Deux
niveaux de performance officiels :

- ``l4``       : Niveau 1 — NVIDIA L4 (24 Go) : économe et rapide, aussi sûr
                 sur tout GPU d'au moins 22 Go ;
- ``a100_40g`` : Niveau 2 — NVIDIA A100 40 Go : rang LoRA supérieur et
                 résolution d'image plus haute pour la qualité maximale.

``--profil auto`` (défaut) lit la VRAM réelle du GPU détecté et choisit le
niveau approprié. Un GPU de transition (ex. T4 16 Go) exécute le niveau ``l4``
en mode économe ; en dessous de 14 Go, l'entraînement refuse de démarrer.
"""
import argparse
import json
from pathlib import Path

import torch
from PIL import Image
from datasets import Dataset
from transformers import (
    AutoProcessor,
    BitsAndBytesConfig,
    Qwen3VLForConditionalGeneration,
    Trainer,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

# ---------------------------------------------------------------------------
# Les 2 niveaux de performance gen3 — ressources GPU uniquement, jamais CPU.
# ---------------------------------------------------------------------------
PROFILS_PERFORMANCE = {
    "l4": {
        "label": "Niveau 1 — NVIDIA L4 (24 Go)",
        "lora_r": 16,
        "lora_alpha": 32,
        "max_pixels": 401408,  # ~512 x 784
        "gradient_accumulation_steps": 8,
        "learning_rate": 1e-4,
        "vram_min_gb": 22,
    },
    "a100_40g": {
        "label": "Niveau 2 — NVIDIA A100 40 Go",
        "lora_r": 32,
        "lora_alpha": 64,
        "max_pixels": 786432,  # ~768 x 1024
        "gradient_accumulation_steps": 4,
        "learning_rate": 1.5e-4,
        "vram_min_gb": 36,
    },
}

#: Sous ce plancher (Go de VRAM), l'entraînement refuse de démarrer :
#: gen3 fonctionne sur les GPU disponibles, pas sur CPU ni sur micro-GPU.
VRAM_PLANCHER_GO = 14.0


def select_profile(nom_demande: str):
    """Résout le niveau de performance à partir de la VRAM réelle détectée.

    Retourne ``(nom, profil, nom_gpu, vram_go)``. Lève ``RuntimeError`` si
    aucun GPU CUDA n'est disponible — volontaire : gen3 est une IA GPU.
    """
    if not torch.cuda.is_available():
        raise RuntimeError(
            "GPU CUDA requis : gen3 est conçue pour fonctionner avec les "
            "ressources GPU à sa disposition (L4, A100...), pas sur CPU. "
            "Lancez l'entraînement sur un runtime GPU (Colab L4 ou A100)."
        )
    props = torch.cuda.get_device_properties(0)
    vram_go = props.total_memory / (1024**3)
    if nom_demande != "auto":
        profil = PROFILS_PERFORMANCE[nom_demande]
        if vram_go < profil["vram_min_gb"]:
            raise RuntimeError(
                f"GPU détecté : {props.name} ({vram_go:.0f} Go) — insuffisant "
                f"pour le niveau « {nom_demande} » "
                f"({profil['vram_min_gb']} Go requis). "
                "Utilisez --profil auto ou changez de runtime GPU."
            )
        return nom_demande, profil, props.name, vram_go
    if vram_go >= PROFILS_PERFORMANCE["a100_40g"]["vram_min_gb"]:
        nom = "a100_40g"
    elif vram_go >= PROFILS_PERFORMANCE["l4"]["vram_min_gb"]:
        nom = "l4"
    else:
        if vram_go < VRAM_PLANCHER_GO:
            raise RuntimeError(
                f"GPU détecté : {props.name} ({vram_go:.0f} Go) — sous le "
                f"plancher gen3 ({VRAM_PLANCHER_GO:.0f} Go). Choisissez un "
                "runtime L4 ou A100 40 Go."
            )
        nom = "l4"
    return nom, PROFILS_PERFORMANCE[nom], props.name, vram_go


def describe_profile(nom, profil, gpu_nom, vram_go) -> str:
    return (
        f"Niveau de performance gen3 : {profil['label']} (profil « {nom} »)\n"
        f"  GPU détecté          : {gpu_nom} — {vram_go:.1f} Go de VRAM\n"
        f"  LoRA r / alpha       : {profil['lora_r']} / {profil['lora_alpha']}\n"
        f"  max_pixels           : {profil['max_pixels']}\n"
        f"  accumulation         : {profil['gradient_accumulation_steps']}\n"
        f"  learning rate        : {profil['learning_rate']}"
    )


def load_jsonl(p):
    rows = [json.loads(x) for x in Path(p).read_text(encoding="utf-8").splitlines() if x.strip()]
    if not rows:
        raise ValueError(f"Aucun exemple dans {p}")
    for i, r in enumerate(rows, 1):
        for k in ("task", "instruction", "response"):
            if not r.get(k):
                raise ValueError(f"{p}:{i}: {k} manquant")
    return rows


def main():
    ap = argparse.ArgumentParser(description="Entraînement gen3 vision (QLoRA) — 2 niveaux : l4 / a100_40g")
    ap.add_argument("--model_name", default="Qwen/Qwen3-VL-4B-Instruct")
    ap.add_argument("--train_file", default="data/train.jsonl")
    ap.add_argument("--eval_file", default="data/validation.jsonl")
    ap.add_argument("--data_dir", default="data")
    ap.add_argument("--output_dir", default="outputs/gen3ia-vlm-lora")
    ap.add_argument("--profil", default="auto", choices=["auto", "l4", "a100_40g"],
                    help="Niveau de performance gen3 (auto = selon la VRAM détectée)")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--batch_size", type=int, default=1,
                    help="Le collator de référence exige 1 (batching multimodal à adapter avant de changer)")
    ap.add_argument("--gradient_accumulation_steps", type=int, default=None,
                    help="Défaut : valeur du niveau de performance choisi")
    ap.add_argument("--learning_rate", type=float, default=None,
                    help="Défaut : valeur du niveau de performance choisi")
    ap.add_argument("--lora_r", type=int, default=None,
                    help="Défaut : valeur du niveau de performance choisi")
    ap.add_argument("--lora_alpha", type=int, default=None,
                    help="Défaut : valeur du niveau de performance choisi")
    ap.add_argument("--max_pixels", type=int, default=None,
                    help="Défaut : valeur du niveau de performance choisi")
    ap.add_argument("--save_steps", type=int, default=20)
    ap.add_argument("--resume_from_checkpoint", default=None,
                    help="Chemin checkpoint-* pour reprendre après une coupure")
    ap.add_argument("--dry_run", action="store_true")
    args = ap.parse_args()

    train = load_jsonl(args.train_file)
    valid = load_jsonl(args.eval_file) if args.eval_file and Path(args.eval_file).exists() else []
    root = Path(args.data_dir)
    for r in train + valid:
        if r.get("image") and not (root / r["image"]).exists():
            raise FileNotFoundError(root / r["image"])

    # Résolution du niveau de performance. En dry_run sans GPU (vérification
    # structurelle sur un hôte sans CUDA), on présélectionne « l4 » pour
    # l'affichage ; l'entraînement réel, lui, exige CUDA sans exception.
    if torch.cuda.is_available():
        nom_profil, profil, gpu_nom, vram_go = select_profile(args.profil)
    elif args.dry_run:
        nom_profil, profil = "l4", PROFILS_PERFORMANCE["l4"]
        gpu_nom, vram_go = "(aucun GPU sur cet hôte — entraînement réel : GPU requis)", 0.0
    else:
        raise RuntimeError(
            "GPU CUDA requis : gen3 est conçue pour fonctionner avec les "
            "ressources GPU à sa disposition (L4, A100...), pas sur CPU."
        )

    # Les paramètres explicites du CLI priment sur le niveau choisi.
    accum = args.gradient_accumulation_steps or profil["gradient_accumulation_steps"]
    lr = args.learning_rate or profil["learning_rate"]
    lora_r = args.lora_r or profil["lora_r"]
    lora_alpha = args.lora_alpha or profil["lora_alpha"]
    max_pixels = args.max_pixels or profil["max_pixels"]

    print(describe_profile(nom_profil, profil, gpu_nom, vram_go))
    print(f"  données              : {len(train)} train / {len(valid)} validation")

    if args.dry_run:
        print(f"DRY RUN OK: {len(train)} train, {len(valid)} validation — "
              f"profil « {nom_profil} » pressenti.")
        return

    processor = AutoProcessor.from_pretrained(args.model_name, max_pixels=max_pixels)
    compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    qconfig = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=compute_dtype,
    )
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        args.model_name,
        quantization_config=qconfig,
        torch_dtype=compute_dtype,
        device_map="auto",
    )
    model = prepare_model_for_kbit_training(model)
    model.config.use_cache = False
    model = get_peft_model(
        model,
        LoraConfig(
            r=lora_r,
            lora_alpha=lora_alpha,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        ),
    )
    model.print_trainable_parameters()

    # Encodage échantillon par échantillon. Les clés tensorielles visuelles
    # varient selon les versions de Transformers : lancez un smoke test et
    # adaptez le collator à la sortie du processor Qwen3-VL installé.
    def encode(r):
        image_path = root / r["image"] if r.get("image") else None
        im = Image.open(image_path).convert("RGB") if image_path else None
        user_content = []
        if im is not None:
            user_content.append({"type": "image", "image": im})
        user_content.append({
            "type": "text",
            "text": f"Tâche: {r['task']}\nInstruction: {r['instruction']}",
        })
        msgs = [
            {"role": "user", "content": user_content},
            {"role": "assistant", "content": [{"type": "text", "text": r["response"]}]},
        ]
        full = processor.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
        ins = processor(text=[full], images=[im] if im is not None else None, return_tensors="pt")
        ids = ins["input_ids"][0]
        labels = ids.clone()
        prompt = processor.apply_chat_template(msgs[:1], tokenize=False, add_generation_prompt=True)
        pinputs = processor(text=[prompt], images=[im] if im is not None else None, return_tensors="pt")
        labels[: min(pinputs["input_ids"].shape[1], len(labels))] = -100
        out = {"input_ids": ids, "labels": labels, "attention_mask": ins["attention_mask"][0]}
        for k, v in ins.items():
            if k not in out and isinstance(v, torch.Tensor):
                out[k] = v
        return out

    train_feats = [encode(r) for r in train]
    eval_feats = [encode(r) for r in valid] if valid else []

    class Collator:
        def __call__(self, features):
            # Fiabilité d'abord : batch_size=1. Certains champs visuels exigent
            # un traitement spécifique au modèle ; adapter avant de batcher.
            if len(features) == 1:
                return {
                    k: (v if k in ("input_ids", "labels", "attention_mask")
                        else (v.squeeze(0) if isinstance(v, torch.Tensor) and v.shape[0] == 1 else v))
                    for k, v in features[0].items()
                }
            raise ValueError("Ce collator de référence exige batch_size=1; adapter pour le batching multimodal.")

    targs = TrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=1,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=accum,
        learning_rate=lr,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        logging_steps=5,
        eval_strategy="steps" if eval_feats else "no",
        eval_steps=args.save_steps if eval_feats else None,
        save_strategy="steps",
        save_steps=args.save_steps,
        save_total_limit=2,
        bf16=torch.cuda.is_bf16_supported(),
        fp16=not torch.cuda.is_bf16_supported(),
        gradient_checkpointing=True,
        remove_unused_columns=False,
        report_to="none",
    )
    trainer = Trainer(
        model=model,
        args=targs,
        train_dataset=Dataset.from_list(train_feats),
        eval_dataset=Dataset.from_list(eval_feats) if eval_feats else None,
        data_collator=Collator(),
    )
    trainer.train(resume_from_checkpoint=args.resume_from_checkpoint)
    out = Path(args.output_dir) / "final_adapter"
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out)
    processor.save_pretrained(out)
    print(f"Adaptateur enregistré : {out}")


if __name__ == "__main__":
    main()

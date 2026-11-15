#!/usr/bin/env python3
"""Entraînement de gen3 — QLoRA sur Gemma 3 (Google), GPU uniquement.

gen3 est conçue pour fonctionner avec les ressources GPU à sa disposition —
le CPU n'est pas une cible supportée. Deux niveaux de performance officiels :

- ``l4``       : Niveau 1 — NVIDIA L4 (24 Go) : Gemma 3 4B, économe et rapide ;
- ``a100_40g`` : Niveau 2 — NVIDIA A100 40 Go : Gemma 3 12B, rang LoRA supérieur.

``--profil auto`` (défaut) lit la VRAM réelle du GPU détecté et choisit le
niveau approprié. Sous 14 Go de VRAM, l'entraînement refuse de démarrer.

Entraînement longue durée (sessions Colab successives) :
  - checkpoints fréquents (``--save_steps``) + reprise ``--resume_from_checkpoint`` ;
  - budget temps ``--max_hours`` : arrêt propre à l'échéance, adaptateur final
    enregistré même sans finir toutes les époques ;
  - synchronisation automatique vers Google Drive si monté
    (``/content/drive``) après chaque sauvegarde ;
  - ``--max_train_samples`` pour fractionner le corpus en sessions.

Base de données : schéma unifié gen3 — ``train_core.jsonl.gz`` (corpus 792k
curaté) fusionné avec ``train_images.jsonl`` (exemples ancrés image).
"""
import argparse
import gzip
import json
import shutil
import time
from pathlib import Path

import torch
from PIL import Image
from datasets import Dataset
from transformers import (
    AutoProcessor,
    BitsAndBytesConfig,
    Gemma3ForConditionalGeneration,
    Trainer,
    TrainingArguments,
    TrainerCallback,
)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

# ---------------------------------------------------------------------------
# Niveaux de performance gen3 — GPU uniquement, jamais CPU. Base Gemma 3.
# ---------------------------------------------------------------------------
PROFILS_PERFORMANCE = {
    "l4": {
        "label": "Niveau 1 — NVIDIA L4 (24 Go)",
        "base_model": "google/gemma-3-4b-it",
        "lora_r": 16,
        "lora_alpha": 32,
        "gradient_accumulation_steps": 8,
        "learning_rate": 1e-4,
        "vram_min_gb": 22,
    },
    "a100_40g": {
        "label": "Niveau 2 — NVIDIA A100 40 Go",
        "base_model": "google/gemma-3-12b-it",
        "lora_r": 32,
        "lora_alpha": 64,
        "gradient_accumulation_steps": 4,
        "learning_rate": 1.5e-4,
        "vram_min_gb": 36,
    },
}

#: Sous ce plancher (Go de VRAM), l'entraînement refuse de démarrer.
VRAM_PLANCHER_GO = 14.0

DRIVE_DIR = Path("/content/drive/MyDrive/gen3ia-entrainement")  # si Colab + Drive


def select_profile(nom_demande: str):
    """Résout le niveau de performance à partir de la VRAM réelle détectée."""
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
        f"  Modèle de base       : {profil['base_model']} (lignée Google)\n"
        f"  LoRA r / alpha       : {profil['lora_r']} / {profil['lora_alpha']}\n"
        f"  accumulation         : {profil['gradient_accumulation_steps']}\n"
        f"  learning rate        : {profil['learning_rate']}"
    )


def _open_jsonl(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, "r", encoding="utf-8")


def load_jsonl(p) -> list:
    rows = []
    with _open_jsonl(Path(p)) as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            for k in ("task", "instruction", "response"):
                if not r.get(k):
                    raise ValueError(f"{p}:{i}: {k} manquant")
            rows.append(r)
    if not rows:
        raise ValueError(f"Aucun exemple dans {p}")
    return rows


def charger_corpus(data_dir: str, max_samples: int = 0) -> tuple:
    """Fusionne corpus core (792k curaté) + exemples image, schéma unifié."""
    d = Path(data_dir)
    train = load_jsonl(d / "train_core.jsonl.gz") + load_jsonl(d / "train_images.jsonl")
    valid_files = [d / "validation_core.jsonl.gz", d / "validation_images.jsonl"]
    valid = []
    for f in valid_files:
        if f.exists():
            valid.extend(load_jsonl(f))
    if max_samples and max_samples > 0:
        train = train[:max_samples]
    return train, valid


class BudgetTempsCallback(TrainerCallback):
    """Arrêt propre quand le budget temps est atteint (sessions longues)."""

    def __init__(self, max_hours: float):
        self.max_seconds = max_hours * 3600 if max_hours and max_hours > 0 else None
        self.t0 = None
        self.stop_demande = False

    def on_train_begin(self, args, state, control, **kwargs):
        self.t0 = time.time()

    def on_step_end(self, args, state, control, **kwargs):
        if self.max_seconds is None or self.t0 is None:
            return control
        ecoule = time.time() - self.t0
        if ecoule >= self.max_seconds:
            pct = 100.0 * ecoule / self.max_seconds
            print(
                f"\n[budget-temps] {self.max_seconds/3600:.2f} h atteinte "
                f"({pct:.0f}% du budget) — arrêt propre, checkpoint en cours…",
                flush=True,
            )
            self.stop_demande = True
            control.should_training_stop = True
            control.should_save = True
        return control


class SyncDriveCallback(TrainerCallback):
    """Copie les derniers checkpoints + logs vers Drive si monté (Colab)."""

    def on_save(self, args, state, control, **kwargs):
        if not DRIVE_DIR.exists():
            return control
        try:
            src = Path(args.output_dir)
            dst = DRIVE_DIR / Path(args.output_dir).name
            dst.mkdir(parents=True, exist_ok=True)
            checkpoints = sorted(
                [p for p in src.glob("checkpoint-*") if p.is_dir()],
                key=lambda p: int(p.name.split("-")[-1]),
            )
            for cp in checkpoints[-1:]:
                cible = dst / cp.name
                if cible.exists():
                    shutil.rmtree(cible)
                shutil.copytree(cp, cible, dirs_exist_ok=True)
            print(f"[drive] checkpoint {cp.name} synchronisé → {cible}", flush=True)
        except Exception as exc:  # Drive absent/pline pleine : ne pas casser l'entraînement
            print(f"[drive] synchronisation ignorée : {exc}", flush=True)
        return control


def main():
    ap = argparse.ArgumentParser(
        description="Entraînement gen3 (QLoRA Gemma 3) — 2 niveaux : l4 / a100_40g"
    )
    ap.add_argument("--model_name", default=None,
                    help="Défaut : celui du niveau de performance (gemma-3-4b-it / 12b-it)")
    ap.add_argument("--train_file", default=None,
                    help="Fichier JSONL(.gz) unique — sinon corpus complet du data_dir")
    ap.add_argument("--eval_file", default=None)
    ap.add_argument("--data_dir", default="data")
    ap.add_argument("--output_dir", default="outputs/gen3-core-lora")
    ap.add_argument("--profil", default="auto", choices=["auto", "l4", "a100_40g"],
                    help="Niveau de performance gen3 (auto = selon la VRAM détectée)")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--batch_size", type=int, default=1,
                    help="Le collator de référence exige 1 (batching à adapter avant de changer)")
    ap.add_argument("--gradient_accumulation_steps", type=int, default=None)
    ap.add_argument("--learning_rate", type=float, default=None)
    ap.add_argument("--lora_r", type=int, default=None)
    ap.add_argument("--lora_alpha", type=int, default=None)
    ap.add_argument("--save_steps", type=int, default=100)
    ap.add_argument("--max_hours", type=float, default=0,
                    help="Budget temps en heures (0 = illimité). Arrêt propre à l'échéance.")
    ap.add_argument("--max_train_samples", type=int, default=0,
                    help="Tronque le corpus fusionné (0 = tout). Utile pour fractionner en sessions.")
    ap.add_argument("--resume_from_checkpoint", default=None,
                    help="Chemin checkpoint-* pour reprendre après une coupure")
    ap.add_argument("--dry_run", action="store_true")
    args = ap.parse_args()

    if args.train_file:
        train = load_jsonl(args.train_file)
        valid = load_jsonl(args.eval_file) if args.eval_file and Path(args.eval_file).exists() else []
    else:
        train, valid = charger_corpus(args.data_dir, args.max_train_samples)
    root = Path(args.data_dir)
    for r in train + valid:
        if r.get("image") and not (root / r["image"]).exists():
            raise FileNotFoundError(root / r["image"])

    # Niveau de performance. En dry_run sans GPU : présélection l4 pour l'affichage.
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

    accum = args.gradient_accumulation_steps or profil["gradient_accumulation_steps"]
    lr = args.learning_rate or profil["learning_rate"]
    lora_r = args.lora_r or profil["lora_r"]
    lora_alpha = args.lora_alpha or profil["lora_alpha"]
    model_name = args.model_name or profil["base_model"]

    print(describe_profile(nom_profil, profil, gpu_nom, vram_go))
    print(f"  données              : {len(train)} train / {len(valid)} validation")
    if args.max_hours > 0:
        print(f"  budget temps         : {args.max_hours} h (arrêt propre automatique)")
    if DRIVE_DIR.exists():
        print(f"  synchronisation Drive: {DRIVE_DIR}")

    if args.dry_run:
        print(f"DRY RUN OK: {len(train)} train, {len(valid)} validation — "
              f"profil « {nom_profil} » pressenti.")
        return

    processor = AutoProcessor.from_pretrained(model_name)
    compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    qconfig = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=compute_dtype,
    )
    model = Gemma3ForConditionalGeneration.from_pretrained(
        model_name,
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
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                            "gate_proj", "up_proj", "down_proj"],
        ),
    )
    model.print_trainable_parameters()

    def construire_texte(r) -> str:
        blocs = [f"Tâche: {r['task']}"]
        blocs.append(f"Instruction: {r['instruction']}")
        if r.get("input_text"):
            blocs.append(f"Entrée: {r['input_text']}")
        return "\n".join(blocs)

    # Encodage échantillon par échantillon (fiabilité d'abord, batch=1).
    def encode(r):
        image_path = root / r["image"] if r.get("image") else None
        im = Image.open(image_path).convert("RGB") if image_path else None
        user_content = []
        if im is not None:
            user_content.append({"type": "image"})
        user_content.append({"type": "text", "text": construire_texte(r)})
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
            if len(features) == 1:
                return {
                    k: (v if k in ("input_ids", "labels", "attention_mask")
                        else (v.squeeze(0) if isinstance(v, torch.Tensor) and v.shape[0] == 1 else v))
                    for k, v in features[0].items()
                }
            raise ValueError("Ce collator de référence exige batch_size=1; adapter pour le batching.")

    targs = TrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        max_steps=-1,
        per_device_train_batch_size=1,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=accum,
        learning_rate=lr,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        logging_steps=10,
        eval_strategy="steps" if eval_feats else "no",
        eval_steps=max(args.save_steps, 50) if eval_feats else None,
        save_strategy="steps",
        save_steps=args.save_steps,
        save_total_limit=3,
        bf16=torch.cuda.is_bf16_supported(),
        fp16=not torch.cuda.is_bf16_supported(),
        gradient_checkpointing=True,
        remove_unused_columns=False,
        report_to="none",
        save_safetensors=True,
    )
    trainer = Trainer(
        model=model,
        args=targs,
        train_dataset=Dataset.from_list(train_feats),
        eval_dataset=Dataset.from_list(eval_feats) if eval_feats else None,
        data_collator=Collator(),
        callbacks=[BudgetTempsCallback(args.max_hours), SyncDriveCallback()],
    )
    trainer.train(resume_from_checkpoint=args.resume_from_checkpoint)
    out = Path(args.output_dir) / "final_adapter"
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out)
    processor.save_pretrained(out)
    if DRIVE_DIR.exists():
        try:
            dst = DRIVE_DIR / Path(args.output_dir).name / "final_adapter"
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(out, dst)
            print(f"[drive] adaptateur final synchronisé → {dst}")
        except Exception as exc:
            print(f"[drive] copie finale ignorée : {exc}")
    print(f"Adaptateur enregistré : {out}")


if __name__ == "__main__":
    main()

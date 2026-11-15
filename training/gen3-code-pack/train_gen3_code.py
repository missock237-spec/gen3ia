#!/usr/bin/env python3
"""Fine-tune (LoRA) d'un modèle de langage causal pour apprendre à gen3 à CODER
— créer des sites web, des interfaces et des programmes.

Version gen3 officielle du script d'entraînement code :
  * profils de performance l4 / a100_40g avec détection auto de VRAM (--profil),
  * GPU obligatoire par conception (le CPU n'est jamais une capacité d'IA gen3 ;
    l'option --allow-cpu du script d'origine est remplacée par --dry-run,
    qui valide données + prompt sans entraîner),
  * reprise après interruption (--resume, dernier checkpoint automatique),
  * token Hugging Face (--hf-token ou env HF_TOKEN) pour les bases gated,
  * jeu d'évaluation optionnel (--eval-dataset) → eval_loss périodique,
  * journal fichier + garde-fou OOM avec conseils concrets,
  * publication optionnelle de l'adaptateur sur le Hub (--push-to-hub).

Format JSONL attendu : une ligne = un objet JSON :
  {"instruction": "...", "language": "html", "response": "...", "task": "web"}

Important :
- Le modèle de base doit être chargeable via AutoModelForCausalLM (ex. bases
  codeuses open-weights). Ce script n'entraîne PAS un modèle à partir de zéro
  et n'implémente pas d'architecture gen3 propriétaire : il produit un
  ADAPTATEUR LoRA à charger sur la base d'origine.
- Les couches LoRA par défaut (q_proj,k_proj,v_proj,o_proj) sont courantes
  mais pas universelles : ajustez --target-modules si besoin.
- N'utilisez que des données/code dont la licence autorise votre usage.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
from datasets import load_dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    Trainer,
    TrainerCallback,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model

sys.path.insert(0, str(Path(__file__).resolve().parent))
from format_prompt import SUPPORTED_LANGUAGES, build_prompt, normalize_language  # noqa: E402
from profils import ErreurProfil, PROFILS_PERFORMANCE, select_profile  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="LoRA fine-tuning gen3 pour la création de sites et de code "
                    "(Transformers causal LM, GPU obligatoire)."
    )
    parser.add_argument("--model-path", required=True,
                        help="Chemin local ou ID Hub du modèle de BASE (AutoModelForCausalLM).")
    parser.add_argument("--dataset", required=True,
                        help="JSONL avec champs instruction/language/response (+ task optionnel).")
    parser.add_argument("--eval-dataset", default=None,
                        help="JSONL d'évaluation optionnel (eval_loss périodique).")
    parser.add_argument("--output-dir", default="./gen3-code-lora",
                        help="Répertoire de sortie de l'adaptateur LoRA + tokenizer.")
    parser.add_argument("--profil", default="auto", choices=[*PROFILS_PERFORMANCE, "auto"],
                        help="Niveau de performance gen3 ; auto = détection par VRAM (défaut).")
    # Réglages : None = valeur du profil (les options explicites gagnent toujours)
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--max-length", type=int, default=None,
                        help="Défaut : valeur du profil (4096 en l4, 8192 en a100_40g).")
    parser.add_argument("--batch-size", type=int, default=None)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=None)
    parser.add_argument("--learning-rate", type=float, default=None)
    parser.add_argument("--logging-steps", type=int, default=10)
    parser.add_argument("--save-steps", type=int, default=None)
    parser.add_argument("--save-total-limit", type=int, default=3)
    parser.add_argument("--lora-rank", type=int, default=None)
    parser.add_argument("--lora-alpha", type=int, default=None)
    parser.add_argument("--lora-dropout", type=float, default=0.05)
    parser.add_argument("--target-modules", default="q_proj,k_proj,v_proj,o_proj",
                        help="Suffixes LoRA séparés par virgules ; adaptez à l'architecture.")
    parser.add_argument("--load-in-4bit", action="store_true",
                        help="Charger la base en 4 bits NF4 (CUDA + bitsandbytes requis).")
    parser.add_argument("--trust-remote-code", action="store_true",
                        help="Autoriser le code de modèle custom du dépôt (source fiable uniquement).")
    parser.add_argument("--hf-token", default=None,
                        help="Token HF pour les bases gated ; défaut : variable HF_TOKEN.")
    parser.add_argument("--resume", action="store_true",
                        help="Reprendre depuis le dernier checkpoint présent dans --output-dir.")
    parser.add_argument("--push-to-hub", default=None, metavar="REPO_ID",
                        help="Publier l'adaptateur sur le Hub HF (ex. utilisateur/gen3-code-lora).")
    parser.add_argument("--private", action="store_true", help="Dépôt Hub privé.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Valider données + prompt + profil SANS charger le modèle ni entraîner.")
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def resolve_settings(args: argparse.Namespace, profil: dict) -> None:
    """Complète les réglages non explicités avec les valeurs du profil."""
    code = profil["code"]
    if args.max_length is None:
        args.max_length = code["max_length"]
    if args.batch_size is None:
        args.batch_size = code["batch"]
    if args.gradient_accumulation_steps is None:
        args.gradient_accumulation = code["gradient_accumulation"]
    else:
        args.gradient_accumulation = args.gradient_accumulation_steps
    if args.learning_rate is None:
        args.learning_rate = code["lr"]
    if args.save_steps is None:
        args.save_steps = code["save_steps"]
    if args.lora_rank is None:
        args.lora_rank = code["lora_r"]
    if args.lora_alpha is None:
        args.lora_alpha = code["lora_alpha"]


def validate_jsonl(dataset_path: Path) -> int:
    """Validation stricte du JSONL. Retourne le nombre d'exemples valides."""
    if not dataset_path.is_file():
        raise FileNotFoundError(f"Dataset introuvable : {dataset_path}")

    valid = 0
    problems: list[str] = []
    with dataset_path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                problems.append(f"ligne {line_no}: JSON invalide ({exc.msg})")
                continue
            missing = [key for key in ("instruction", "response") if not str(row.get(key, "")).strip()]
            if missing:
                problems.append(f"ligne {line_no}: champ(s) vide(s) : {', '.join(missing)}")
                continue
            valid += 1

    if problems:
        preview = "\n".join(problems[:10])
        raise ValueError(f"Validation du dataset échouée :\n{preview}")
    if valid == 0:
        raise ValueError("Le dataset ne contient aucun exemple valide.")
    print(f"Dataset validé : {valid} exemples.")
    return valid


def dataset_languages(dataset_path: Path) -> dict[str, int]:
    """Distribution des langages (normalisés) — pour le manifeste."""
    compte: dict[str, int] = {}
    with dataset_path.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            langue = normalize_language(row.get("language"))
            compte[langue] = compte.get(langue, 0) + 1
    return dict(sorted(compte.items(), key=lambda kv: -kv[1]))


def find_target_modules(model: torch.nn.Module, suffixes: list[str]) -> list[str]:
    available = {name.rsplit(".", 1)[-1] for name, _ in model.named_modules()}
    matches = [suffix for suffix in suffixes if suffix in available]
    if not matches:
        candidates = sorted(
            name.rsplit(".", 1)[-1]
            for name, module in model.named_modules()
            if isinstance(module, torch.nn.Linear)
        )
        unique_candidates = list(dict.fromkeys(candidates))[:40]
        raise ValueError(
            "Aucun module LoRA cible trouvé : "
            f"{suffixes}. Adaptez --target-modules à l'architecture. "
            f"Couches Linear trouvées (extrait) : {unique_candidates}"
        )
    if len(matches) != len(suffixes):
        missing = sorted(set(suffixes) - set(matches))
        print(f"Attention : module(s) cible(s) absents, ignorés : {missing}", file=sys.stderr)
    return matches


class CodingCollator:
    """Pad dynamique avec labels à -100 : le padding n'affecte pas la loss."""
    def __init__(self, tokenizer: Any):
        self.tokenizer = tokenizer

    def __call__(self, features: list[dict[str, list[int]]]) -> dict[str, torch.Tensor]:
        max_len = max(len(row["input_ids"]) for row in features)
        pad_id = self.tokenizer.pad_token_id
        padded_ids, padded_masks, padded_labels = [], [], []
        for row in features:
            ids = list(row["input_ids"])
            mask = list(row["attention_mask"])
            labels = list(row["labels"])
            padding = max_len - len(ids)
            if self.tokenizer.padding_side == "left":
                padded_ids.append([pad_id] * padding + ids)
                padded_masks.append([0] * padding + mask)
                padded_labels.append([-100] * padding + labels)
            else:
                padded_ids.append(ids + [pad_id] * padding)
                padded_masks.append(mask + [0] * padding)
                padded_labels.append(labels + [-100] * padding)
        return {
            "input_ids": torch.tensor(padded_ids, dtype=torch.long),
            "attention_mask": torch.tensor(padded_masks, dtype=torch.long),
            "labels": torch.tensor(padded_labels, dtype=torch.long),
        }


class JournalCallback(TrainerCallback):
    """Journal double : console + fichier (survit à la déconnexion Colab)."""

    def __init__(self, log_path: Path):
        self.log_path = log_path
        self.t0 = time.time()

    def _write(self, message: str) -> None:
        ligne = f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')} +{time.time() - self.t0:.0f}s] {message}"
        print(ligne, flush=True)
        try:
            with self.log_path.open("a", encoding="utf-8") as f:
                f.write(ligne + "\n")
        except OSError:
            pass

    def on_train_begin(self, args=None, state=None, control=None, **kwargs):
        self._write(f"Entraînement démarré — {state.global_step if state else '?'} pas prévus.")

    def on_log(self, args=None, state=None, logs=None, control=None, **kwargs):
        if logs:
            self._write(f"pas {state.global_step if state else '?'} : {logs}")

    def on_train_end(self, args=None, state=None, control=None, **kwargs):
        self._write("Entraînement terminé.")


def tokenize_dataset(dataset, tokenizer, args):
    """Tokenisation partagée train/eval avec masquage du prompt dans les labels."""

    def tokenize_example(example: dict[str, Any]) -> dict[str, list[int]]:
        instruction = str(example.get("instruction", "")).strip()
        language = normalize_language(example.get("language"))
        response = str(example.get("response", "")).strip()
        task = str(example.get("task", "programming")).strip()

        if not instruction or not response:
            return {"input_ids": [], "attention_mask": [], "labels": []}

        prompt = build_prompt(instruction, language, task)
        full_text = prompt + response + (tokenizer.eos_token or "")

        encoded = tokenizer(
            full_text,
            truncation=True,
            max_length=args.max_length,
            add_special_tokens=True,
        )
        prompt_encoded = tokenizer(prompt, add_special_tokens=True)
        prompt_len = min(len(prompt_encoded["input_ids"]), len(encoded["input_ids"]))
        labels = list(encoded["input_ids"])
        # On entraîne sur la réponse, pas sur la répétition de l'instruction.
        labels[:prompt_len] = [-100] * prompt_len
        encoded["labels"] = labels
        return encoded

    tokenized = dataset.map(
        tokenize_example,
        remove_columns=dataset.column_names,
        desc="Tokenisation des exemples de code",
    )
    return tokenized.filter(lambda row: len(row["input_ids"]) > 1)


def main() -> None:
    args = parse_args()
    dataset_path = Path(args.dataset).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    hf_token = args.hf_token or os.environ.get("HF_TOKEN") or None

    if args.max_length is not None and args.max_length < 64:
        raise ValueError("--max-length doit être au moins 64 tokens.")
    if args.epochs <= 0 or args.batch_size is not None and args.batch_size <= 0:
        raise ValueError("Epochs et batch size doivent être positifs.")
    if args.learning_rate is not None and args.learning_rate <= 0:
        raise ValueError("Learning rate doit être positif.")

    # — Profil gen3 : GPU obligatoire, détection VRAM, refus propre sans CUDA —
    try:
        nom_profil, profil = select_profile(args.profil)
    except ErreurProfil as erreur:
        if args.dry_run:
            print(f"[dry-run] Profil non résoluble ici ({erreur}) — on continue en l4 pour la validation.")
            nom_profil, profil = "l4", PROFILS_PERFORMANCE["l4"]
        else:
            print(f"REFUS : {erreur}")
            raise SystemExit(2)
    resolve_settings(args, profil)
    print(f"Profil gen3 : {nom_profil} — {profil['description']}")
    print(f"Réglages : max_length={args.max_length}, batch={args.batch_size}, "
          f"accum={args.gradient_accumulation}, lr={args.learning_rate}, "
          f"LoRA r={args.lora_rank}/a={args.lora_alpha}")

    validate_jsonl(dataset_path)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Chargement du tokenizer : {args.model_path}")
    tokenizer = AutoTokenizer.from_pretrained(
        args.model_path,
        trust_remote_code=args.trust_remote_code,
        token=hf_token,
    )
    if tokenizer.pad_token_id is None:
        if tokenizer.eos_token_id is None:
            raise ValueError("Le tokenizer n'a ni pad_token ni eos_token configuré.")
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    # — Mode dry-run : validation complète SANS GPU ni modèle —
    if args.dry_run:
        dataset = load_dataset("json", data_files=str(dataset_path), split="train")
        exemple = dataset[0]
        prompt = build_prompt(
            exemple.get("instruction", ""),
            exemple.get("language", "unknown"),
            exemple.get("task", "programming"),
        )
        n_tokens_est = sum(len(str(r.get("instruction", ""))) + len(str(r.get("response", "")))
                           for r in dataset) // 4
        print("[dry-run] Aperçu du prompt formaté :")
        print(prompt)
        print(f"[dry-run] OK — {len(dataset)} exemples, ~{n_tokens_est} tokens estimés, "
              f"langages : {dataset_languages(dataset_path)}")
        print("[dry-run] Aucun modèle chargé, aucun entraînement lancé.")
        return

    torch.manual_seed(args.seed)

    model_kwargs: dict[str, Any] = {
        "trust_remote_code": args.trust_remote_code,
    }
    if torch.cuda.is_available():
        model_kwargs["torch_dtype"] = torch.float16
    if args.load_in_4bit:
        try:
            from transformers import BitsAndBytesConfig
        except ImportError as exc:
            raise RuntimeError("Mettez à jour transformers et installez bitsandbytes pour le 4-bit.") from exc
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.float16,
        )
        model_kwargs["device_map"] = {"": 0}

    print(f"Chargement du modèle : {args.model_path}")
    model = AutoModelForCausalLM.from_pretrained(args.model_path, **model_kwargs)
    model.config.use_cache = False

    target_suffixes = [item.strip() for item in args.target_modules.split(",") if item.strip()]
    if not target_suffixes:
        raise ValueError("Fournissez au moins un module dans --target-modules.")
    matched_targets = find_target_modules(model, target_suffixes)

    if args.load_in_4bit:
        try:
            from peft import prepare_model_for_kbit_training
            model = prepare_model_for_kbit_training(model)
        except ImportError as exc:
            raise RuntimeError("Votre version de PEFT manque prepare_model_for_kbit_training.") from exc

    model.gradient_checkpointing_enable()
    if hasattr(model, "enable_input_require_grads"):
        model.enable_input_require_grads()

    lora_config = LoraConfig(
        r=args.lora_rank,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=matched_targets,
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    dataset = load_dataset("json", data_files=str(dataset_path), split="train")
    tokenized = tokenize_dataset(dataset, tokenizer, args)
    if len(tokenized) == 0:
        raise ValueError("Aucun exemple exploitable après tokenisation. Vérifiez le dataset.")

    eval_tokenized = None
    if args.eval_dataset:
        eval_path = Path(args.eval_dataset).expanduser().resolve()
        validate_jsonl(eval_path)
        eval_dataset = load_dataset("json", data_files=str(eval_path), split="train")
        eval_tokenized = tokenize_dataset(eval_dataset, tokenizer, args)
        print(f"Jeu d'évaluation : {len(eval_tokenized)} exemples.")

    bf16_supported = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    training_args = TrainingArguments(
        output_dir=str(output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation,
        learning_rate=args.learning_rate,
        fp16=bool(torch.cuda.is_available() and not bf16_supported),
        bf16=bool(bf16_supported),
        gradient_checkpointing=True,
        logging_steps=args.logging_steps,
        save_steps=args.save_steps,
        save_total_limit=args.save_total_limit,
        eval_strategy="steps" if eval_tokenized else "no",
        eval_steps=args.save_steps if eval_tokenized else None,
        per_device_eval_batch_size=args.batch_size if eval_tokenized else None,
        report_to="none",
        dataloader_num_workers=0,
        remove_unused_columns=False,
        seed=args.seed,
        optim="adamw_torch",
    )

    journal = JournalCallback(output_dir / "train_log.txt")
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized,
        eval_dataset=eval_tokenized,
        data_collator=CodingCollator(tokenizer),
        callbacks=[journal],
    )

    resume_from = None
    if args.resume:
        try:
            from transformers.trainer_utils import get_last_checkpoint
            resume_from = get_last_checkpoint(str(output_dir))
            if resume_from:
                print(f"Reprise depuis le checkpoint : {resume_from}")
        except ImportError:
            print("transformers trop ancien pour get_last_checkpoint — démarrage à zéro.")

    print(f"Début de l'entraînement : {len(tokenized)} exemples, "
          f"{args.epochs} epochs, effectif réel par pas = "
          f"{args.batch_size * args.gradient_accumulation}.")
    try:
        trainer.train(resume_from_checkpoint=resume_from)
    except torch.cuda.OutOfMemoryError as exc:  # type: ignore[attr-defined]
        print(
            "\nOOM CUDA pendant l'entraînement. Pistes concrètes, dans l'ordre :\n"
            "  1) réduire --max-length (ex. 4096 -> 2048) — le plus efficace ;\n"
            "  2) réduire --batch-size (ex. 2 -> 1) et doubler "
            "--gradient-accumulation-steps ;\n"
            "  3) vérifier --load-in-4bit (obligatoire pour une base 7-8B sur L4) ;\n"
            f"  4) erreur d'origine : {exc}\n"
            "Relancez avec --resume : les checkpoints sauvegardés ne sont pas perdus."
        )
        raise SystemExit(2) from exc

    print("Sauvegarde de l'adaptateur LoRA et du tokenizer...")
    trainer.save_model(str(output_dir))
    tokenizer.save_pretrained(str(output_dir))

    manifest = {
        "base_model": args.model_path,
        "dataset": str(dataset_path),
        "eval_dataset": str(Path(args.eval_dataset).resolve()) if args.eval_dataset else None,
        "output_dir": str(output_dir),
        "profil": nom_profil,
        "profil_description": profil["description"],
        "epochs": args.epochs,
        "max_length": args.max_length,
        "batch_size": args.batch_size,
        "gradient_accumulation": args.gradient_accumulation,
        "learning_rate": args.learning_rate,
        "lora": {"r": args.lora_rank, "alpha": args.lora_alpha,
                 "dropout": args.lora_dropout, "target_modules": matched_targets},
        "train_examples": len(tokenized),
        "languages_distribution": dataset_languages(dataset_path),
        "languages_in_scope": sorted(SUPPORTED_LANGUAGES),
        "pushed_to_hub": args.push_to_hub,
        "artifact_type": "Adaptateur PEFT LoRA ; nécessite le modèle de base pour l'inférence",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    with (output_dir / "training_manifest.json").open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    if args.push_to_hub:
        try:
            model.push_to_hub(args.push_to_hub, private=args.private, token=hf_token)
            tokenizer.push_to_hub(args.push_to_hub, private=args.private, token=hf_token)
            print(f"Adaptateur publié sur le Hub : {args.push_to_hub}")
        except Exception as exc:  # noqa: BLE001 — publication optionnelle, jamais fatale
            print(f"Publication Hub échouée (adaptateur local conservé) : {exc}")

    print(f"Terminé. Adaptateur LoRA sauvegardé dans : {output_dir}")
    print("L'adaptateur n'est PAS un modèle autonome : chargez-le sur le modèle de base "
          "(voir infer_gen3_code.py).")


if __name__ == "__main__":
    main()

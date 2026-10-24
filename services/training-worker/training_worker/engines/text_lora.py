"""Moteur ``text-lora`` — fine-tuning LoRA / QLoRA d'un LLM Transformers.

Exécution **réelle** (torch + transformers + peft) : chargement du modèle de
base, application d'adaptateurs LoRA, entraînement sur le split ``train``,
sauvegarde de l'adaptateur et téléversement des artefacts vers R2.

Limites honnêtes (documentées dans le README) :
- QLoRA exige ``bitsandbytes`` et un GPU CUDA (échec clair sinon) ;
- un fichier de poids seul (safetensors sans config) ne peut pas être chargé ;
- pas de fusion adaptateur → modèle complet en v1 (à la charge de l'export v2).
"""

from __future__ import annotations

from typing import Any

from ..schemas import SubmitJobPayload
from .base import BaseEngine, EngineContext, EngineError, JobCancelledError, require_number
from .dataset_io import select_split, texts_from_refs
from .model_loading import load_base_model


class TextLoraEngine(BaseEngine):
    """Fine-tuning LoRA/QLoRA — méthodes ``lora``, ``qlora`` et ``adapter``."""

    engine_id = "text-lora"
    methods = ("lora", "qlora", "adapter")

    def run(self, payload: SubmitJobPayload, ctx: EngineContext) -> None:
        if payload.method not in self.methods:
            raise EngineError(
                f"La méthode « {payload.method} » n'est pas supportée par le moteur "
                f"text-lora (méthodes : {', '.join(self.methods)})."
            )

        # Paramètres — bornes identiques au registre des moteurs de la plateforme.
        learning_rate = require_number(payload.parameters, "learningRate", 2e-4, 1e-6, 1e-2)
        epochs = require_number(payload.parameters, "epochs", 3, 1, 20, integer=True)
        batch_size = require_number(payload.parameters, "batchSize", 4, 1, 32, integer=True)
        lora_rank = require_number(payload.parameters, "loraRank", 16, 4, 128, integer=True)
        lora_alpha = require_number(payload.parameters, "loraAlpha", 32, 1, 256, integer=True)
        lora_dropout = require_number(payload.parameters, "loraDropout", 0.05, 0.0, 0.5)
        max_sequence_length = require_number(
            payload.parameters, "maxSequenceLength", 1024, 128, 8192, integer=True
        )
        gradient_accumulation = require_number(
            payload.parameters, "gradientAccumulation", 2, 1, 32, integer=True
        )

        ctx.report(
            1.0,
            current_step="Chargement des dépendances d'entraînement",
            log_message=f"Moteur text-lora — méthode « {payload.method} ».",
        )

        # Dépendances lourdes : importées ICI, jamais au niveau module.
        try:
            import torch
            from peft import LoraConfig, get_peft_model
            from transformers import (
                DataCollatorForLanguageModeling,
                Trainer,
                TrainerCallback,
                TrainingArguments,
            )
        except ImportError as exc:
            raise EngineError(
                f"Dépendance d'entraînement manquante ({exc}) — installez "
                "requirements.txt sur le worker (torch, transformers, peft, accelerate)."
            ) from exc

        use_cuda = torch.cuda.is_available()
        torch_dtype = torch.float16 if use_cuda else torch.float32

        # QLoRA : quantification 4 bits — bitsandbytes OBLIGATOIRE (échec honnête sinon).
        quantization_config = None
        optimizer = "adamw_torch"
        if payload.method == "qlora":
            try:
                import bitsandbytes  # noqa: F401 — présence réellement vérifiée
                from transformers import BitsAndBytesConfig
            except ImportError as exc:
                raise EngineError(
                    "bitsandbytes requis pour QLoRA (quantification 4 bits) — "
                    "installez-le sur le worker GPU."
                ) from exc
            if not use_cuda:
                raise EngineError(
                    "QLoRA (quantification 4 bits) exige un GPU CUDA — aucun GPU "
                    "détecté sur ce worker."
                )
            quantization_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.float16,
            )
            optimizer = "paged_adamw_8bit"

        # ---- Données d'entraînement (split « train » uniquement) ----------------
        train_refs = select_split(payload.datasets, ("train",))
        if not train_refs:
            raise EngineError(
                "Aucun dataset avec split « train » : l'entraînement LoRA exige des "
                "données d'entraînement (les splits validation/test sont exclus)."
            )
        ctx.report(10.0, current_step="Téléchargement et lecture des datasets")
        train_texts = texts_from_refs(train_refs, ctx)
        if not train_texts:
            raise EngineError(
                "Aucun exemple d'entraînement exploitable extrait des datasets "
                "(champs prompt/completion, instruction/output, text/label ou text attendus)."
            )

        # ---- Modèle de base ------------------------------------------------------
        model, tokenizer = load_base_model(
            payload, ctx, torch_dtype=torch_dtype, quantization_config=quantization_config
        )
        if tokenizer.pad_token is None:
            # Pratique standard pour les tokenizers sans PAD (ex. Llama) :
            # réutiliser le token EOS pour le padding de batch.
            tokenizer.pad_token = tokenizer.eos_token
            ctx.report(log_message="Tokenizer sans PAD : EOS utilisé pour le padding de batch.")

        # ---- Adaptateurs LoRA (PEFT) --------------------------------------------
        lora_config = LoraConfig(
            r=lora_rank,
            lora_alpha=lora_alpha,
            lora_dropout=lora_dropout,
            target_modules=["q_proj", "v_proj"],
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(model, lora_config)
        trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
        ctx.report(
            18.0,
            current_step="Adaptateurs LoRA installés",
            epochs_total=epochs,
            log_message=f"Paramètres entraînables : {trainable:,} (adaptateurs LoRA).",
        )

        # ---- Tokenisation --------------------------------------------------------
        ctx.report(
            20.0,
            current_step=f"Tokenisation de {len(train_texts)} exemples",
            epochs_total=epochs,
        )
        eos = tokenizer.eos_token or ""
        encodings = [
            tokenizer(text + eos, truncation=True, max_length=max_sequence_length)
            for text in train_texts
        ]

        class _PairDataset(torch.utils.data.Dataset):  # type: ignore[name-defined]
            """Dataset torch minimal — encodages pré-calculés."""

            def __init__(self, items: list[dict[str, Any]]) -> None:
                self._items = items

            def __len__(self) -> int:
                return len(self._items)

            def __getitem__(self, index: int) -> dict[str, Any]:
                return self._items[index]

        dataset = _PairDataset(encodings)
        collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

        # ---- Boucle d'entraînement ------------------------------------------------
        class _ReportCallback(TrainerCallback):  # type: ignore[misc]
            """Relais honnête Trainer → ctx : progression, perte, annulation."""

            def __init__(self) -> None:
                self.total_steps = 1

            def on_train_begin(self, args, state, control, **kwargs) -> None:
                self.total_steps = max(1, int(state.max_steps or 1))
                ctx.report(
                    25.0,
                    current_step="Entraînement en cours",
                    epochs_total=epochs,
                    log_message=(
                        f"Entraînement démarré : {self.total_steps} étapes prévues "
                        f"({epochs} époques, batch {batch_size} × {gradient_accumulation})."
                    ),
                )

            def _check_cancel(self) -> None:
                if ctx.is_cancelled():
                    raise JobCancelledError("Annulé par la plateforme.")

            def on_step_end(self, args, state, control, **kwargs) -> None:
                self._check_cancel()

            def on_log(self, args, state, control, logs=None, **kwargs) -> None:
                self._check_cancel()
                if not logs:
                    return
                loss = logs.get("loss")
                progress = 25.0 + 70.0 * min(1.0, state.global_step / self.total_steps)
                message = None
                train_loss = None
                if isinstance(loss, (int, float)):
                    train_loss = float(loss)
                    message = (
                        f"Étape {state.global_step}/{self.total_steps} — perte {train_loss:.4f}"
                    )
                ctx.report(
                    progress,
                    current_step=f"Étape {state.global_step}/{self.total_steps}",
                    epochs_done=min(epochs, int(state.epoch or 0)),
                    epochs_total=epochs,
                    train_loss=train_loss,
                    log_message=message,
                )

        training_args = TrainingArguments(
            output_dir=str(ctx.workdir / "checkpoints"),
            learning_rate=learning_rate,
            num_train_epochs=epochs,
            per_device_train_batch_size=batch_size,
            gradient_accumulation_steps=gradient_accumulation,
            logging_steps=1,  # journal à chaque étape (contrat)
            save_strategy="no",  # seul l'adaptateur final est conservé
            report_to="none",  # aucun tracker externe : rien de caché
            fp16=use_cuda,
            optim=optimizer,
        )
        trainer = Trainer(
            model=model,
            args=training_args,
            train_dataset=dataset,
            data_collator=collator,
            callbacks=[_ReportCallback()],
        )
        trainer.train()

        # Perte finale d'entraînement (rapportée par Trainer), sinon dernière de step.
        final_loss: float | None = None
        for entry in reversed(trainer.state.log_history):
            if "train_loss" in entry and isinstance(entry["train_loss"], (int, float)):
                final_loss = float(entry["train_loss"])
                break
        if final_loss is None:
            for entry in reversed(trainer.state.log_history):
                if isinstance(entry.get("loss"), (int, float)):
                    final_loss = float(entry["loss"])
                    break

        # ---- Sauvegarde de l'adaptateur + tokenizer -------------------------------
        ctx.report(95.0, current_step="Sauvegarde de l'adaptateur")
        adapter_dir = ctx.workdir / "adapter"
        adapter_dir.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(str(adapter_dir))
        tokenizer.save_pretrained(str(adapter_dir))

        ctx.report(97.0, current_step="Téléversement des artefacts")
        artifact_files: list[tuple[str, str]] = [
            ("adapter.safetensors", "adapter_model.safetensors"),
            ("adapter-config.json", "adapter_config.json"),
        ]
        for label, filename in artifact_files:
            candidate = adapter_dir / filename
            if candidate.is_file():
                ctx.upload_artifact(label, candidate)
        tokenizer_json = adapter_dir / "tokenizer.json"
        if tokenizer_json.is_file():
            ctx.upload_artifact("tokenizer.json", tokenizer_json)
        else:  # tokenizers lents : repli honnête sur la config
            tokenizer_config = adapter_dir / "tokenizer_config.json"
            if tokenizer_config.is_file():
                ctx.upload_artifact("tokenizer-config.json", tokenizer_config)

        metrics: dict[str, float] = {}
        if final_loss is not None:
            metrics["train_loss"] = final_loss
        ctx.report(
            100.0,
            current_step="Entraînement terminé",
            epochs_done=epochs,
            epochs_total=epochs,
            train_loss=final_loss,
            metrics=metrics,
            log_message=(
                "Entraînement terminé — adaptateur LoRA sauvegardé"
                + (f" (perte finale : {final_loss:.4f})" if final_loss is not None else "")
                + "."
            ),
        )

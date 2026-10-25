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

import random
from typing import Any

from ..schemas import SubmitJobPayload
from .base import BaseEngine, EngineContext, EngineError, JobCancelledError, require_number
from .dataset_io import select_split, texts_from_refs
from .model_loading import load_base_model


def _param_bool(parameters: Any, key: str, default: bool) -> bool:
    """Paramètre booléen tolérant (bool/int/str) — jamais bloquant."""
    value = parameters.get(key, default) if isinstance(parameters, dict) else default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "vrai", "on", "yes", "y"}
    return default


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
        # EARLY STOPPING (2026-10-25) : activé par défaut dès qu'un split de
        # validation est disponible — évite le sur-apprentissage et économise
        # les minutes GPU facturées. Désactivable via parameters.earlyStopping=false.
        early_stopping_wanted = _param_bool(payload.parameters, "earlyStopping", True)

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

        # ---- Split de validation déterministe -------------------------------------
        # Dès 40 exemples : 10 % réservés à la validation (mélange à graine
        # fixe — reproductible), ce qui active l'early stopping et la métrique
        # eval_loss par époque. En dessous, tout part en train (honnêteté : un
        # eval de 2 exemples ne mesure rien).
        eval_texts: list[str] = []
        if len(train_texts) >= 40:
            melange = list(train_texts)
            random.Random(42).shuffle(melange)
            taille_eval = max(4, int(len(melange) * 0.1))
            eval_texts = melange[:taille_eval]
            train_texts = melange[taille_eval:]
            ctx.report(
                log_message=(
                    f"Split de validation : {len(eval_texts)} exemples réservés "
                    f"({len(train_texts)} restent en train) — early stopping actif."
                )
            )
        early_stopping_active = early_stopping_wanted and bool(eval_texts)

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
            """Relais honnête Trainer → ctx : progression, perte, annulation
            + HISTORIQUE PAR ÉPOQUE (train_loss / eval_loss) — le suivi
            d'expériences minimal sans tracker externe."""

            def __init__(self) -> None:
                self.total_steps = 1
                self.historique: list[dict[str, float]] = []
                self.perte_train_epoch: float | None = None
                self.meilleure_eval: float | None = None

            def on_train_begin(self, args, state, control, **kwargs) -> None:
                self.total_steps = max(1, int(state.max_steps or 1))
                ctx.report(
                    25.0,
                    current_step="Entraînement en cours",
                    epochs_total=epochs,
                    log_message=(
                        f"Entraînement démarré : {self.total_steps} étapes prévues "
                        f"({epochs} époques, batch {batch_size} × {gradient_accumulation})"
                        + (" — early stopping actif." if early_stopping_active else ".")
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
                if isinstance(loss, (int, float)):
                    self.perte_train_epoch = float(loss)
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

            def on_evaluate(self, args, state, control, metrics=None, **kwargs) -> None:
                # metrics contient eval_loss (+ éventuellement eval_runtime…).
                if not metrics:
                    return
                eval_loss = metrics.get("eval_loss")
                if not isinstance(eval_loss, (int, float)):
                    return
                eval_loss = float(eval_loss)
                if self.meilleure_eval is None or eval_loss < self.meilleure_eval:
                    self.meilleure_eval = eval_loss
                epoch_courante = int(state.epoch or 0)
                entree = {
                    "epoch": float(epoch_courante),
                    "eval_loss": eval_loss,
                }
                if self.perte_train_epoch is not None:
                    entree["train_loss"] = self.perte_train_epoch
                self.historique.append(entree)
                ctx.report(
                    log_message=(
                        f"Époque {epoch_courante} — eval_loss {eval_loss:.4f} "
                        f"(meilleur : {min(self.meilleure_eval, eval_loss):.4f})"
                    ),
                    metrics={
                        f"eval_loss_epoch_{epoch_courante}": eval_loss,
                        **(
                            {f"train_loss_epoch_{epoch_courante}": self.perte_train_epoch}
                            if self.perte_train_epoch is not None
                            else {}
                        ),
                        "best_eval_loss": self.meilleure_eval,
                    },
                )

        training_args = TrainingArguments(
            output_dir=str(ctx.workdir / "checkpoints"),
            learning_rate=learning_rate,
            num_train_epochs=epochs,
            per_device_train_batch_size=batch_size,
            gradient_accumulation_steps=gradient_accumulation,
            logging_steps=1,  # journal à chaque étape (contrat)
            save_strategy="epoch" if eval_texts else "no",
            save_total_limit=2,  # borné : load_best_model_at_end exige des checkpoints
            report_to="none",  # aucun tracker externe : rien de caché
            fp16=use_cuda,
            optim=optimizer,
            **(
                {
                    "eval_strategy": "epoch",
                    "load_best_model_at_end": True,
                    "metric_for_best_model": "eval_loss",
                    "greater_is_better": False,
                }
                if eval_texts
                else {}
            ),
        )
        callbacks: list[Any] = [rapport_callback := _ReportCallback()]
        if early_stopping_active:
            from transformers import EarlyStoppingCallback

            callbacks.append(
                EarlyStoppingCallback(
                    early_stopping_patience=2, early_stopping_threshold=0.01
                )
            )
        trainer = Trainer(
            model=model,
            args=training_args,
            train_dataset=dataset,
            eval_dataset=_PairDataset([
                tokenizer(texte + eos, truncation=True, max_length=max_sequence_length)
                for texte in eval_texts
            ]) if eval_texts else None,
            data_collator=collator,
            callbacks=callbacks,
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
        # Suivi d'expériences (sans tracker externe) : historique par époque,
        # meilleur eval_loss, arrêt anticipé éventuel — tout est plat et lisible.
        epochs_effectuees = epochs
        arret_anticipe = False
        try:
            if trainer.state is not None and trainer.state.epoch is not None:
                epochs_effectuees = min(epochs, max(1, int(round(float(trainer.state.epoch)))))
                arret_anticipe = epochs_effectuees < epochs
        except Exception:
            pass
        if arret_anticipe:
            metrics["early_stopped"] = 1.0
            metrics["epochs_effectuees"] = float(epochs_effectuees)
        for entree in rapport_callback.historique:
            numero = int(entree.get("epoch", 0))
            if "eval_loss" in entree:
                metrics[f"eval_loss_epoch_{numero}"] = entree["eval_loss"]
            if "train_loss" in entree:
                metrics[f"train_loss_epoch_{numero}"] = entree["train_loss"]
        if rapport_callback.meilleure_eval is not None:
            metrics["best_eval_loss"] = rapport_callback.meilleure_eval
        if rapport_callback.historique:
            metrics["n_evaluations"] = float(len(rapport_callback.historique))
        ctx.report(
            100.0,
            current_step="Entraînement terminé",
            epochs_done=epochs_effectuees,
            epochs_total=epochs,
            train_loss=final_loss,
            metrics=metrics,
            log_message=(
                "Entraînement terminé — adaptateur LoRA sauvegardé"
                + (f" (perte finale : {final_loss:.4f})" if final_loss is not None else "")
                + (
                    f" — ARRÊT ANTICIPÉ à l'époque {epochs_effectuees}/{epochs} "
                    "(sur-apprentissage évité, GPU économisé)."
                    if arret_anticipe
                    else ""
                )
                + (
                    f" Meilleur eval_loss : {rapport_callback.meilleure_eval:.4f}."
                    if rapport_callback.meilleure_eval is not None
                    else ""
                )
            ),
        )

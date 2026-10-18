"""Moteur ``text-eval`` — évaluation d'un LLM sans modifier les poids.

Charge le modèle de base (catalogue ou upload), l'évalue sur le dataset de
split ``test`` (repli ``validation``) et rapporte la perte d'évaluation,
l'exactitude par token et le nombre d'exemples. Aucun artefact, aucun
changement de poids — mesure honnête uniquement.
"""

from __future__ import annotations

from typing import Any

from ..schemas import SubmitJobPayload
from .base import BaseEngine, EngineContext, EngineError, JobCancelledError, require_number
from .dataset_io import select_split, texts_from_refs
from .model_loading import load_base_model


class TextEvalEngine(BaseEngine):
    """Évaluation seule — méthode ``eval-only``."""

    engine_id = "text-eval"
    methods = ("eval-only",)

    def run(self, payload: SubmitJobPayload, ctx: EngineContext) -> None:
        if payload.method not in self.methods:
            raise EngineError(
                f"La méthode « {payload.method} » n'est pas supportée par le moteur "
                f"text-eval (méthode : eval-only)."
            )

        batch_size = require_number(payload.parameters, "batchSize", 8, 1, 64, integer=True)
        max_sequence_length = require_number(
            payload.parameters, "maxSequenceLength", 1024, 128, 8192, integer=True
        )

        ctx.report(
            1.0,
            current_step="Chargement des dépendances d'évaluation",
            log_message="Moteur text-eval — évaluation seule, aucun poids modifié.",
        )

        try:
            import torch
            from transformers import DataCollatorForLanguageModeling
        except ImportError as exc:
            raise EngineError(
                f"Dépendance d'évaluation manquante ({exc}) — installez "
                "requirements.txt sur le worker (torch, transformers)."
            ) from exc

        eval_refs = select_split(payload.datasets, ("test", "validation"))
        if not eval_refs:
            raise EngineError(
                "Aucun dataset d'évaluation : un split « test » (ou à défaut "
                "« validation ») est requis pour mesurer le modèle."
            )

        use_cuda = torch.cuda.is_available()
        torch_dtype = torch.float16 if use_cuda else torch.float32
        model, tokenizer = load_base_model(payload, ctx, torch_dtype=torch_dtype)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
            ctx.report(log_message="Tokenizer sans PAD : EOS utilisé pour le padding de batch.")

        ctx.report(15.0, current_step="Téléchargement et lecture du jeu d'évaluation")
        eval_texts = texts_from_refs(eval_refs, ctx)
        if not eval_texts:
            raise EngineError(
                "Aucun exemple exploitable dans le jeu d'évaluation "
                "(champs prompt/completion, instruction/output, text/label ou text attendus)."
            )

        ctx.report(25.0, current_step=f"Tokenisation de {len(eval_texts)} exemples")
        encodings = [
            tokenizer(text, truncation=True, max_length=max_sequence_length)
            for text in eval_texts
        ]

        class _PairDataset(torch.utils.data.Dataset):  # type: ignore[name-defined]
            """Dataset torch minimal — encodages pré-calculés."""

            def __init__(self, items: list[dict[str, Any]]) -> None:
                self._items = items

            def __len__(self) -> int:
                return len(self._items)

            def __getitem__(self, index: int) -> dict[str, Any]:
                return self._items[index]

        collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)
        loader = torch.utils.data.DataLoader(
            _PairDataset(encodings),
            batch_size=batch_size,
            collate_fn=collator,
            shuffle=False,
        )
        device = "cuda" if use_cuda else "cpu"
        model.to(device)
        model.eval()

        total_batches = max(1, len(loader))
        total_loss = 0.0
        total_examples = 0
        correct_tokens = 0
        total_tokens = 0

        with torch.no_grad():
            for index, batch in enumerate(loader):
                if ctx.is_cancelled():
                    raise JobCancelledError("Annulé par la plateforme.")
                batch = {key: value.to(device) for key, value in batch.items()}
                outputs = model(**batch)
                examples = int(batch["input_ids"].shape[0])
                total_loss += float(outputs.loss) * examples
                total_examples += examples

                # Exactitude par token : le modèle prédit le token suivant
                # (décalage d'une position, labels de padding -100 exclus).
                logits = outputs.logits[:, :-1, :]
                labels = batch["labels"][:, 1:]
                mask = labels != -100
                if bool(mask.any()):
                    predictions = logits.argmax(dim=-1)
                    correct_tokens += int(((predictions == labels) & mask).sum().item())
                    total_tokens += int(mask.sum().item())

                ctx.report(
                    25.0 + 70.0 * (index + 1) / total_batches,
                    current_step=f"Évaluation du batch {index + 1}/{total_batches}",
                )

        eval_loss = total_loss / max(1, total_examples)
        token_accuracy = correct_tokens / max(1, total_tokens)
        metrics = {
            "eval_loss": eval_loss,
            "token_accuracy": token_accuracy,
            "samples": float(total_examples),
        }
        ctx.report(
            100.0,
            current_step="Évaluation terminée",
            metrics=metrics,
            log_message=(
                f"Évaluation terminée : perte {eval_loss:.4f}, exactitude par token "
                f"{token_accuracy:.4f} sur {total_examples} exemples."
            ),
        )

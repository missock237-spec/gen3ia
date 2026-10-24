"""Registre des moteurs du worker — miroir de ``lib/training/engines/registry.ts``.

Moteurs réellement exécutables : ``text-lora`` (LoRA/QLoRA), ``text-eval``
(évaluation seule) et ``rag-index`` (indexation vectorielle, aucune poids
modifié). Le moteur ``fake`` est réservé aux tests et n'est résolu que si
``allow_fake=True`` (c'est-à-dire ``WORKER_ALLOW_FAKE_ENGINE=true``).
"""

from __future__ import annotations

from .base import BaseEngine, EngineContext, EngineError, JobCancelledError, require_number
from .dataset_io import (
    chunk_text,
    load_records,
    record_to_pair,
    record_to_text,
    select_split,
    texts_from_refs,
)
from .fake import FakeEngine
from .model_loading import load_base_model
from .rag_index import RagIndexEngine
from .text_eval import TextEvalEngine
from .text_lora import TextLoraEngine

#: Moteurs d'exécution réelle (identifiants = côté plateforme).
ENGINE_REGISTRY: dict[str, type[BaseEngine]] = {
    "text-lora": TextLoraEngine,
    "text-eval": TextEvalEngine,
    "rag-index": RagIndexEngine,
}

FAKE_ENGINE_ID = "fake"


def resolve(engine_id: str, *, allow_fake: bool = False) -> BaseEngine | None:
    """Résout un moteur — ``None`` si inconnu (ou ``fake`` non autorisé)."""
    if engine_id == FAKE_ENGINE_ID:
        return FakeEngine() if allow_fake else None
    engine_class = ENGINE_REGISTRY.get(engine_id)
    if engine_class is None:
        return None
    return engine_class()


__all__ = [
    "ENGINE_REGISTRY",
    "FAKE_ENGINE_ID",
    "BaseEngine",
    "EngineContext",
    "EngineError",
    "JobCancelledError",
    "require_number",
    "resolve",
    "chunk_text",
    "load_records",
    "record_to_pair",
    "record_to_text",
    "select_split",
    "texts_from_refs",
    "load_base_model",
    "FakeEngine",
    "RagIndexEngine",
    "TextEvalEngine",
    "TextLoraEngine",
]

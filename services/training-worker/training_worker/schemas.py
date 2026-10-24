"""Schémas pydantic — miroir exact du contrat TypeScript.

Référence côté plateforme : ``lib/training/providers/types.ts`` (SubmitJobPayload,
ProviderJobState, GpuInfo). Les noms de champs sont conservés en camelCase pour
coller au contrat JSON, sans transformation côté worker.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- #
# Soumission (corps de POST /jobs)                                             #
# --------------------------------------------------------------------------- #


class BaseModelRef(BaseModel):
    """Modèle de base : soit une référence catalogue HF, soit un upload R2."""

    kind: Literal["upload", "catalog"]
    ref: str = Field(min_length=1)
    storageKey: str | None = None


class DatasetRef(BaseModel):
    """Un dataset déjà stocké dans R2 par le studio.

    NB : la plateforme envoie aussi ``unassigned`` comme split (datasets non
    encore affectés) — on garde une chaîne libre, les moteurs sélectionnent les
    splits qu'ils savent exploiter (train / test / validation).
    """

    storageKey: str = Field(min_length=1)
    split: str = Field(min_length=1)
    format: Literal["json", "jsonl", "csv", "txt"]


class SubmitJobPayload(BaseModel):
    """Charge utile de soumission d'une tâche (entrée du worker)."""

    jobId: str = Field(min_length=1)
    engineId: str = Field(min_length=1)
    method: str = Field(min_length=1)
    parameters: dict[str, Any] = Field(default_factory=dict)
    baseModel: BaseModelRef
    datasets: list[DatasetRef] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Capacités (réponse de GET /capabilities)                                     #
# --------------------------------------------------------------------------- #


class GpuInfo(BaseModel):
    """Un accélérateur déclaré — VRAM réelle, disponibilité réelle."""

    name: str
    vramGb: float
    available: bool


class CapabilitiesResponse(BaseModel):
    """Capacités du worker (filtrées telles quelles par la plateforme)."""

    gpus: list[GpuInfo]
    maxDurationMinutes: int | None


# --------------------------------------------------------------------------- #
# Tâches                                                                      #
# --------------------------------------------------------------------------- #


class JobAccepted(BaseModel):
    """Accusé de soumission (201) — l'exécution démarre en arrière-plan."""

    externalId: str


class LogLine(BaseModel):
    """Une ligne de journal (la plateforme n'affiche que les 50 dernières)."""

    at: str
    level: Literal["info", "warn", "error"]
    message: str


class Artifact(BaseModel):
    """Un artefact produit par un moteur, téléversé vers R2."""

    label: str
    storageKey: str
    sizeBytes: int


class ProviderJobState(BaseModel):
    """État complet d'une tâche (réponse de GET /jobs/{externalId})."""

    externalId: str
    status: Literal["running", "completed", "failed"]
    progressPercent: float | None = None
    currentStep: str | None = None
    epochsDone: int | None = None
    epochsTotal: int | None = None
    trainLoss: float | None = None
    metrics: dict[str, float] = Field(default_factory=dict)
    logs: list[LogLine] = Field(default_factory=list)
    error: str | None = None
    artifacts: list[Artifact] = Field(default_factory=list)

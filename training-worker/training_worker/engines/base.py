"""Socle des moteurs : contexte d'exécution, erreurs, bornage des paramètres.

Un moteur reçoit (payload, ctx) et exécute le travail **réel**. Le contexte
fournit tout ce dont il a besoin :

- ``ctx.report(...)``    : progression/perte/métriques/journal (verrouillé côté manager) ;
- ``ctx.is_cancelled()`` : annulation demandée par la plateforme (Event) ;
- ``ctx.workdir``        : répertoire de travail temporaire de la tâche ;
- ``ctx.download(key)``  : téléchargement d'un objet R2 (dataset/modèle) ;
- ``ctx.upload_artifact(label, path)`` : téléversement d'un artefact.

Aucune bibliothèque lourde (torch, transformers, peft, sentence-transformers,
boto3) n'est importée au niveau module : uniquement au moment de ``run()``.
"""

from __future__ import annotations

import abc
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from ..schemas import Artifact, SubmitJobPayload


class EngineError(RuntimeError):
    """Échec honnête d'un moteur — le message est destiné à l'utilisateur."""


class JobCancelledError(EngineError):
    """Levée quand la plateforme a demandé l'annulation (ou délai max atteint)."""


class BaseEngine(abc.ABC):
    """Contrat d'un moteur : identifiant, méthodes supportées, exécution réelle."""

    #: Identifiant stable (identique à celui du registre côté plateforme).
    engine_id: str = ""
    #: Méthodes réellement exécutables (vide = toutes acceptées — moteurs de test).
    methods: tuple[str, ...] = ()

    @abc.abstractmethod
    def run(self, payload: SubmitJobPayload, ctx: "EngineContext") -> None:
        """Exécute la tâche. Lève :class:`EngineError` en cas d'échec honnête."""


class EngineContext:
    """Contexte d'exécution fourni par le JobManager à un moteur."""

    def __init__(
        self,
        report: Callable[..., None],
        is_cancelled: Callable[[], bool],
        workdir: Path,
        download: Callable[[str], Path],
        upload_artifact: Callable[[str, Path], Artifact],
    ) -> None:
        self.report = report
        self.is_cancelled = is_cancelled
        self.workdir = workdir
        self.download = download
        self.upload_artifact = upload_artifact


def require_number(
    parameters: Mapping[str, Any],
    key: str,
    default: float,
    minimum: float,
    maximum: float,
    *,
    integer: bool = False,
) -> float | int:
    """Extrait un paramètre numérique borné — erreur honnête si invalide.

    Les bornes reflètent les capacités déclarées par le registre des moteurs
    côté plateforme (``lib/training/engines/registry.ts``) : le worker refuse
    ce qu'il ne peut pas exécuter correctement plutôt que d'accepter en silence.
    """
    value = parameters.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EngineError(
            f"Paramètre « {key} » invalide : nombre attendu, reçu {type(value).__name__}."
        )
    if value < minimum or value > maximum:
        raise EngineError(
            f"Paramètre « {key} » hors bornes : {value} (attendu entre {minimum} et {maximum})."
        )
    if integer:
        return int(value)
    return float(value)

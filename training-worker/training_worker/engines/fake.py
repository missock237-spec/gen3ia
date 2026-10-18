"""Moteur ``fake`` — SIMULATION réservée aux tests (``WORKER_ALLOW_FAKE_ENGINE=true``).

Ce moteur termine instantanément avec un artefact minuscule. Il N'EST JAMAIS
accepté en production : la valeur par défaut de ``WORKER_ALLOW_FAKE_ENGINE``
est ``false`` et la soumission d'un job ``fake`` est alors rejetée en 400.

Sans R2 configuré (cas des tests), l'artefact est conservé localement sous le
répertoire de travail — jamais présenté comme un téléversement de production.
"""

from __future__ import annotations

from ..schemas import SubmitJobPayload
from .base import BaseEngine, EngineContext, JobCancelledError


class FakeEngine(BaseEngine):
    """Moteur de test : aucune méthode imposée (n'importe laquelle est acceptée)."""

    engine_id = "fake"
    methods: tuple[str, ...] = ()

    def run(self, payload: SubmitJobPayload, ctx: EngineContext) -> None:
        ctx.report(
            10.0,
            current_step="[SIMULATION] Démarrage du moteur de test",
            log_message=(
                "[SIMULATION] Moteur fake : exécution immédiate, AUCUN entraînement réel "
                "(WORKER_ALLOW_FAKE_ENGINE=true)."
            ),
        )
        if ctx.is_cancelled():
            raise JobCancelledError("Annulé par la plateforme.")
        artifact_path = ctx.workdir / "fake-artifact.txt"
        artifact_path.write_text(
            "Artefact de test généré par le moteur fake (WORKER_ALLOW_FAKE_ENGINE=true).\n",
            encoding="utf-8",
        )
        ctx.upload_artifact("fake-artifact.txt", artifact_path)
        ctx.report(
            100.0,
            current_step="[SIMULATION] Terminé",
            metrics={"fake_metric": 1.0},
            log_message="[SIMULATION] Moteur fake terminé.",
        )

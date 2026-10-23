"""Application FastAPI du worker GPU — contrat ``worker-http`` de la plateforme.

Routes (contrat exact, cf. ``lib/training/providers/worker-http.ts``) :

- ``GET  /healthz``                  : ``{"ok": true}`` — SANS authentification ;
- ``GET  /capabilities``             : GPU CUDA réels (``torch.cuda``) — jamais de CPU ;
- ``POST /jobs``                     : 201 ``{"externalId": "..."}`` (tâche en arrière-plan) ;
- ``GET  /jobs/{externalId}``        : état complet (ProviderJobState) ;
- ``POST /jobs/{externalId}/cancel`` : 200 — annulation au prochain point de contrôle.

Toutes les routes protégées exigent ``Authorization: Bearer <WORKER_TOKEN>``
(comparaison à temps constant). Sans ``WORKER_TOKEN`` : 503.
"""

from __future__ import annotations

import logging
import os

from fastapi import Depends, FastAPI, HTTPException

from . import __version__  # import relatif — `python -m training_worker.app` est le lancement documenté
from .auth import require_worker_token
from .config import Settings, load_settings
from .job_manager import JobManager, JobSubmissionError
from .schemas import (
    CapabilitiesResponse,
    GpuInfo,
    JobAccepted,
    ProviderJobState,
    SubmitJobPayload,
)

logger = logging.getLogger("training_worker")


def _ensure_log_handler() -> None:
    """Garantit une sortie console pour la bannière (uvicorn ne configure pas le root)."""
    if not logger.handlers and not logging.getLogger().handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s [training_worker] %(message)s")
        )
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False


def detect_gpus() -> list[GpuInfo]:
    """Détecte les GPU **réels** via ``torch.cuda`` — import paresseux, jamais requis.

    Sans torch (ou sans CUDA) : aucune entrée GPU — aucune capacité inventée.
    """
    try:
        import torch
    except ImportError:
        return []
    try:
        if not torch.cuda.is_available():
            return []
        gpus: list[GpuInfo] = []
        for index in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(index)
            gpus.append(
                GpuInfo(
                    name=str(props.name),
                    vramGb=round(props.total_memory / (1024**3), 2),
                    available=True,
                )
            )
        return gpus
    except Exception as exc:  # pragma: no cover — pilotes exotiques
        logger.warning("Détection CUDA échouée : %s", exc)
        return []


def create_app(settings: Settings | None = None) -> FastAPI:
    """Construit l'application (usine — tests et ``uvicorn --factory``)."""
    _ensure_log_handler()
    settings = settings or load_settings()
    app = FastAPI(
        title="Gen3ia — Worker GPU d'entraînement",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    manager = JobManager(settings)
    app.state.settings = settings
    app.state.manager = manager

    logger.info(
        "Worker GPU Gen3ia v%s — token : %s | R2 : %s | moteurs : text-lora, text-eval, "
        "rag-index%s | concurrence : %d | durée max : %s | work : %s",
        __version__,
        "configuré" if settings.worker_token else "ABSENT (routes protégées → 503)",
        "configuré" if settings.r2_configured else "NON configuré (échec honnête si requis)",
        " + fake (TESTS UNIQUEMENT)" if settings.allow_fake_engine else "",
        settings.max_concurrent_jobs,
        f"{settings.max_duration_minutes} min" if settings.max_duration_minutes else "illimitée",
        settings.work_dir,
    )

    @app.get("/healthz")
    def healthz() -> dict[str, bool]:
        """Sonde de vie — SANS authentification (monitoring)."""
        return {"ok": True}

    @app.get("/capabilities", dependencies=[Depends(require_worker_token)])
    def capabilities() -> CapabilitiesResponse:
        """Capacités réelles : GPU CUDA détectés — jamais de CPU déclaré.

        gen3 est conçu pour exploiter les ressources GPU disponibles (L4, A100…).
        Le CPU n'est pas une capacité de calcul pour l'IA : un hôte sans GPU
        déclare une liste vide et ne reçoit jamais de tâche d'entraînement.
        """
        return CapabilitiesResponse(
            gpus=detect_gpus(), maxDurationMinutes=settings.max_duration_minutes
        )

    @app.post("/jobs", status_code=201, dependencies=[Depends(require_worker_token)])
    def submit_job(payload: SubmitJobPayload) -> JobAccepted:
        """Accepte une tâche — l'exécution démarre en arrière-plan (file bornée)."""
        try:
            external_id = manager.submit(payload)
        except JobSubmissionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return JobAccepted(externalId=external_id)

    @app.get("/jobs/{external_id}", dependencies=[Depends(require_worker_token)])
    def job_state(external_id: str) -> ProviderJobState:
        """État complet de la tâche (404 si identifiant inconnu)."""
        try:
            return manager.state(external_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Tâche inconnue : {external_id}") from exc

    @app.post("/jobs/{external_id}/cancel", dependencies=[Depends(require_worker_token)])
    def cancel_job(external_id: str) -> dict[str, bool]:
        """Annulation : la tâche échouera « Annulé par la plateforme. » au prochain contrôle."""
        if not manager.cancel(external_id):
            raise HTTPException(status_code=404, detail=f"Tâche inconnue : {external_id}")
        return {"ok": True}

    return app


#: Instance module-level pour ``uvicorn training_worker.app:app``.
app: FastAPI = create_app()


def main() -> None:
    """Lancement direct : ``python -m training_worker.app``."""
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(
        "training_worker.app:app",
        host=os.environ.get("WORKER_HOST", "0.0.0.0"),
        port=int(os.environ.get("WORKER_PORT", "8000")),
    )


if __name__ == "__main__":  # pragma: no cover
    main()

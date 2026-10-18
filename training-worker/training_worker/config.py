"""Configuration du worker — 100 % variables d'environnement, rien de codé en dur.

Toutes les valeurs sont lues au moment de l'appel à :func:`load_settings`
(jamais à l'import du module) : les tests peuvent ainsi injecter leur propre
environnement avant de construire une application.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("training_worker")

_TRUTHY = ("1", "true", "yes", "on")


def _env_bool(name: str, default: bool) -> bool:
    """Lit un booléen d'environnement (absent/vide → valeur par défaut)."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in _TRUTHY


def _env_int(name: str) -> int | None:
    """Lit un entier d'environnement — ``None`` si absent ou invalide (avertissement honnête)."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return None
    try:
        return int(raw.strip())
    except ValueError:
        logger.warning("Variable %s=%r ignorée : entier attendu.", name, raw)
        return None


def _env_str(name: str) -> str | None:
    """Lit une chaîne non vide d'environnement (``None`` sinon)."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return None
    return raw.strip()


@dataclass(frozen=True)
class Settings:
    """Réglages immuables du worker (chargés depuis l'environnement)."""

    #: Jeton partagé avec la plateforme (TRAINING_WORKER_TOKEN côté Next.js).
    #: Absent → toutes les routes protégées répondent 503 (jamais d'accès ouvert).
    worker_token: str | None
    #: Durée maximale d'une tâche (annoncée dans /capabilities ET appliquée par watchdog).
    max_duration_minutes: int | None
    #: Nombre de tâches exécutées réellement en parallèle (les autres attendent en file).
    max_concurrent_jobs: int
    #: Déclarer honnêtement une entrée « cpu » dans /capabilities (rag-index seulement).
    declare_cpu: bool
    #: Autoriser le moteur « fake » (TESTS UNIQUEMENT — défaut : faux).
    allow_fake_engine: bool
    #: Répertoire de travail (téléchargements, artefacts locaux, une dir par tâche).
    work_dir: Path
    #: Fichier d'état persistant (reprise honnête après redémarrage du worker).
    jobs_state_file: Path
    # Stockage R2 (S3-compatible, même bucket que le studio).
    r2_account_id: str | None
    r2_access_key_id: str | None
    r2_secret_access_key: str | None
    r2_bucket: str | None

    @property
    def r2_configured(self) -> bool:
        """R2 est-il prêt ? Sinon, toute tâche nécessitant le stockage échoue honnêtement."""
        return all(
            (
                self.r2_account_id,
                self.r2_access_key_id,
                self.r2_secret_access_key,
                self.r2_bucket,
            )
        )


def load_settings() -> Settings:
    """Charge la configuration depuis l'environnement au moment de l'appel."""
    duration = _env_int("MAX_DURATION_MINUTES")
    if duration is not None and duration <= 0:
        logger.warning(
            "MAX_DURATION_MINUTES=%d ignoré : valeur strictement positive attendue.",
            duration,
        )
        duration = None
    concurrency = _env_int("MAX_CONCURRENT_JOBS") or 1
    if concurrency < 1:
        concurrency = 1
    return Settings(
        worker_token=_env_str("WORKER_TOKEN"),
        max_duration_minutes=duration,
        max_concurrent_jobs=concurrency,
        declare_cpu=_env_bool("WORKER_DECLARE_CPU", True),
        allow_fake_engine=_env_bool("WORKER_ALLOW_FAKE_ENGINE", False),
        work_dir=Path(os.environ.get("WORK_DIR") or "./work").expanduser(),
        jobs_state_file=Path(os.environ.get("JOBS_STATE_FILE") or "./jobs-state/jobs.json").expanduser(),
        r2_account_id=_env_str("R2_ACCOUNT_ID"),
        r2_access_key_id=_env_str("R2_ACCESS_KEY_ID"),
        r2_secret_access_key=_env_str("R2_SECRET_ACCESS_KEY"),
        r2_bucket=_env_str("R2_BUCKET"),
    )

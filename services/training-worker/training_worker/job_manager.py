"""Gestion des tâches : soumission, file à concurrence bornée, annulation, état.

Garanties d'honnêteté :

- une tâche en file (au-delà de ``MAX_CONCURRENT_JOBS``) rapporte le statut
  ``running`` avec ``progressPercent`` à ``null`` jusqu'à son démarrage réel ;
- tout échec devient un statut ``failed`` avec un message clair — jamais de
  succès simulé ;
- au démarrage du worker, les tâches précédemment ``running`` (interrompues par
  un redémarrage) sont marquées en échec : « Worker redémarré pendant
  l'exécution. » — aucun entraînement fantôme ;
- les journaux sont plafonnés en mémoire (500 lignes ; la plateforme n'affiche
  que les 50 dernières) et l'état persiste dans ``JOBS_STATE_FILE``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import Settings
from .engines import resolve
from .engines.base import EngineContext, EngineError, JobCancelledError
from .schemas import Artifact, LogLine, ProviderJobState, SubmitJobPayload
from .storage import R2Storage, StorageError

logger = logging.getLogger("training_worker")

#: Plafond mémoire de journaux par tâche (la plateforme garde les 50 dernières).
MAX_LOG_LINES = 500
#: Nombre maximal de tâches conservées dans le fichier d'état (les plus anciennes sont oubliées).
MAX_PERSISTED_JOBS = 200

#: Base32 de Crockford (ULID : 10 caractères temporels + 16 aléatoires).
_ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")


class JobSubmissionError(ValueError):
    """Soumission refusée (moteur/méthode inconnu) → HTTP 400."""


def _now_iso() -> str:
    """Horodatage ISO 8601 (UTC) pour les lignes de journal."""
    return datetime.now(timezone.utc).isoformat()


def _new_external_id() -> str:
    """Identifiant ULID-like : triable par création, sans dépendance externe."""

    def encode(value: int, length: int) -> str:
        chars: list[str] = []
        for _ in range(length):
            chars.append(_ULID_ALPHABET[value & 31])
            value >>= 5
        return "".join(reversed(chars))

    now_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    return encode(now_ms, 10) + encode(secrets.randbits(80), 16)


def _safe_artifact_name(label: str) -> str:
    """Nom d'artefact sûr pour une clé R2 — repli « artifact » si vide."""
    cleaned = _SAFE_NAME.sub("-", label).strip("-") or "artifact"
    return cleaned[:120]


@dataclass
class JobRecord:
    """État interne d'une tâche (protégé par le verrou du JobManager)."""

    external_id: str
    payload: SubmitJobPayload
    #: Statut vu par la plateforme : les files internes rapportent aussi « running ».
    status: str = "running"
    #: La tâche a réellement été prise en charge par l'exécuteur (vs en file).
    started: bool = False
    progress_percent: float | None = None
    current_step: str | None = None
    epochs_done: int | None = None
    epochs_total: int | None = None
    train_loss: float | None = None
    metrics: dict[str, float] = field(default_factory=dict)
    logs: list[LogLine] = field(default_factory=list)
    error: str | None = None
    artifacts: list[Artifact] = field(default_factory=list)
    #: Motif d'annulation (plateforme ou durée maximale dépassée).
    cancel_reason: str | None = None


class JobManager:
    """File de tâches à concurrence bornée + persistance + annulation."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._lock = threading.RLock()
        #: Verrou d'E/S dédié à l'écriture sérialisée du fichier d'état.
        self._io_lock = threading.Lock()
        self._jobs: dict[str, JobRecord] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._storage = R2Storage(settings)
        self._executor = ThreadPoolExecutor(
            max_workers=settings.max_concurrent_jobs,
            thread_name_prefix="gen3ia-job",
        )
        self._load_previous_state()

    # ------------------------------------------------------------------ #
    # Cycle de vie public                                                 #
    # ------------------------------------------------------------------ #

    def submit(self, payload: SubmitJobPayload) -> str:
        """Valide puis accepte une tâche → ``externalId`` (exécution en arrière-plan)."""
        engine = resolve(payload.engineId, allow_fake=self._settings.allow_fake_engine)
        if engine is None:
            hint = (
                " (moteur de test : WORKER_ALLOW_FAKE_ENGINE=true requis)"
                if payload.engineId == "fake"
                else ""
            )
            raise JobSubmissionError(
                f"Moteur inconnu ou non autorisé : « {payload.engineId} »{hint}."
            )
        if engine.methods and payload.method not in engine.methods:
            raise JobSubmissionError(
                f"La méthode « {payload.method} » n'est pas supportée par le moteur "
                f"« {engine.engine_id} » (méthodes : {', '.join(engine.methods)})."
            )
        external_id = _new_external_id()
        record = JobRecord(
            external_id=external_id,
            payload=payload,
            current_step="En file d'attente du worker",
        )
        with self._lock:
            self._jobs[external_id] = record
            self._cancel_events[external_id] = threading.Event()
        self._persist()
        # L'exécuteur applique MAX_CONCURRENT_JOBS ; les tâches en surnombre
        # attendent en file (statut « running », progressPercent null).
        self._executor.submit(self._run_job, external_id)
        return external_id

    def state(self, external_id: str) -> ProviderJobState:
        """Instantané complet de la tâche (404 côté route si inconnue)."""
        with self._lock:
            record = self._jobs.get(external_id)
            if record is None:
                raise KeyError(external_id)
            return ProviderJobState(
                externalId=record.external_id,
                status=record.status,  # type: ignore[arg-type]
                progressPercent=record.progress_percent,
                currentStep=record.current_step,
                epochsDone=record.epochs_done,
                epochsTotal=record.epochs_total,
                trainLoss=record.train_loss,
                metrics=dict(record.metrics),
                logs=list(record.logs),
                error=record.error,
                artifacts=list(record.artifacts),
            )

    def cancel(self, external_id: str) -> bool:
        """Demande l'annulation (Event) — la tâche échouera « Annulé par la plateforme. »."""
        with self._lock:
            record = self._jobs.get(external_id)
            if record is None:
                return False
            if record.status == "running":
                record.cancel_reason = "Annulé par la plateforme."
                event = self._cancel_events.get(external_id)
                if event is not None:
                    event.set()
                self._append_log(record, "warn", "Annulation demandée par la plateforme.")
            else:
                self._append_log(
                    record, "warn", "Annulation demandée mais la tâche est déjà terminée."
                )
        self._persist()
        return True

    def shutdown(self) -> None:
        """Arrêt : les tâches en cours seront marquées en échec au prochain démarrage."""
        self._executor.shutdown(wait=False)

    # ------------------------------------------------------------------ #
    # Exécution                                                           #
    # ------------------------------------------------------------------ #

    def _run_job(self, external_id: str) -> None:
        """Exécute une tâche dans l'exécuteur — capture TOUS les échecs honnêtement."""
        with self._lock:
            record = self._jobs.get(external_id)
            if record is None or record.started:
                return
            record.started = True
        timer = self._start_duration_watchdog(external_id)
        workdir = self._job_workdir(external_id)
        ctx = self._make_context(external_id, workdir)
        engine = resolve(
            record.payload.engineId, allow_fake=self._settings.allow_fake_engine
        )
        self._log(
            external_id,
            "info",
            f"Tâche démarrée (moteur « {record.payload.engineId} », "
            f"méthode « {record.payload.method} »).",
        )
        try:
            if engine is None:  # Déjà validé à la soumission — échec honnête sinon.
                raise EngineError(
                    f"Moteur « {record.payload.engineId} » indisponible à l'exécution."
                )
            engine.run(record.payload, ctx)
        except JobCancelledError:
            reason = self._take_cancel_reason(external_id) or "Annulé par la plateforme."
            self._finish(external_id, "failed", error=reason, level="warn")
        except StorageError as exc:
            self._finish(external_id, "failed", error=f"Stockage indisponible : {exc}", level="error")
        except EngineError as exc:
            self._finish(external_id, "failed", error=str(exc), level="error")
        except ImportError as exc:
            self._finish(
                external_id, "failed", error=f"Dépendance manquante sur le worker : {exc}", level="error"
            )
        except Exception as exc:  # Aucun échec masqué — jamais de succès simulé.
            logger.exception("Erreur non prévue pendant la tâche %s", external_id)
            self._finish(external_id, "failed", error=f"Erreur interne du worker : {exc}", level="error")
        else:
            self._finish(external_id, "completed")
        finally:
            if timer is not None:
                timer.cancel()

    def _finish(
        self,
        external_id: str,
        status: str,
        error: str | None = None,
        level: str = "info",
    ) -> None:
        """Terminalise une tâche et journalise le résultat."""
        with self._lock:
            record = self._jobs.get(external_id)
            if record is None:
                return
            record.status = status
            record.error = error
            if status == "completed":
                # Les moteurs rapportent 100.0 eux-mêmes ; repli si oubli.
                if record.progress_percent is None:
                    record.progress_percent = 100.0
                self._append_log(record, "info", "Tâche terminée.")
            else:
                self._append_log(record, level, f"Tâche échouée : {error}")
        self._persist()

    # ------------------------------------------------------------------ #
    # Contexte moteur                                                     #
    # ------------------------------------------------------------------ #

    def _make_context(self, external_id: str, workdir: Path) -> EngineContext:
        """Construit le contexte d'exécution (fermetures verrouillées)."""
        event = self._cancel_events.get(external_id)
        if event is None:  # Tâche rechargée d'un état antérieur : Event neuf.
            event = threading.Event()
            self._cancel_events[external_id] = event

        def report(
            progress_percent: float | None = None,
            current_step: str | None = None,
            epochs_done: int | None = None,
            epochs_total: int | None = None,
            train_loss: float | None = None,
            metrics: dict[str, float] | None = None,
            log_message: str | None = None,
        ) -> None:
            with self._lock:
                record = self._jobs.get(external_id)
                if record is None or record.status != "running":
                    return  # Rapport tardif d'une tâche terminée : ignoré.
                if progress_percent is not None:
                    record.progress_percent = float(progress_percent)
                if current_step is not None:
                    record.current_step = str(current_step)
                if epochs_done is not None:
                    record.epochs_done = int(epochs_done)
                if epochs_total is not None:
                    record.epochs_total = int(epochs_total)
                if train_loss is not None:
                    record.train_loss = float(train_loss)
                if metrics:
                    record.metrics.update(
                        {str(key): float(value) for key, value in metrics.items()}
                    )
                if log_message:
                    self._append_log(record, "info", str(log_message))
            self._persist()

        def is_cancelled() -> bool:
            return event.is_set()

        download_sequence = 0

        def download(storage_key: str) -> Path:
            """Télécharge un objet R2 dans le répertoire de travail de la tâche."""
            nonlocal download_sequence
            download_sequence += 1
            name = storage_key.rsplit("/", 1)[-1] or "dataset"
            safe = _safe_artifact_name(name)
            dest = workdir / "downloads" / f"{download_sequence:04d}-{safe}"
            return self._storage.download(storage_key, dest)

        def upload_artifact(label: str, path: Path) -> Artifact:
            return self._upload_artifact(external_id, label, path)

        return EngineContext(
            report=report,
            is_cancelled=is_cancelled,
            workdir=workdir,
            download=download,
            upload_artifact=upload_artifact,
        )

    def _upload_artifact(self, external_id: str, label: str, path: Path) -> Artifact:
        """Téléverse un artefact vers R2 (échec honnête si R2 absent)."""
        with self._lock:
            record = self._jobs.get(external_id)
            if record is None:
                raise StorageError(f"Tâche inconnue : {external_id}")
            payload = record.payload
        safe_label = _safe_artifact_name(label)
        key = self._artifact_key(payload, safe_label)
        if self._storage.configured:
            size = self._storage.upload(key, path)
        elif payload.engineId == "fake":
            # MOTEUR DE TEST UNIQUEMENT (WORKER_ALLOW_FAKE_ENGINE=true) : sans R2,
            # l'artefact reste local — jamais présenté comme un upload de production.
            local = self._settings.work_dir / "artifacts" / key
            local.parent.mkdir(parents=True, exist_ok=True)
            if path.resolve() != local.resolve():
                shutil.copyfile(path, local)
            size = local.stat().st_size
            self._log(
                external_id,
                "warn",
                f"[MOTEUR DE TEST] R2 non configuré : artefact « {label} » conservé "
                f"localement ({local}).",
            )
        else:
            raise StorageError(
                f"R2 non configuré : impossible de téléverser l'artefact « {label} » "
                f"(clé {key})."
            )
        artifact = Artifact(label=label, storageKey=key, sizeBytes=int(size))
        with self._lock:
            record = self._jobs.get(external_id)
            if record is not None:
                record.artifacts.append(artifact)
        self._persist()
        return artifact

    def _artifact_key(self, payload: SubmitJobPayload, safe_label: str) -> str:
        """Dérive ``users/{uid}/training-files/{projectId}/{jobId}/{label}``.

        Le préfixe provient du PREMIER dataset de la tâche (tout ce qui précède
        ``training-files/{projectId}/``).
        """
        datasets = payload.datasets
        if not datasets:
            raise StorageError(
                "Impossible de dériver le préfixe d'artefacts : aucun dataset dans la tâche."
            )
        first = datasets[0].storageKey
        marker = "training-files/"
        index = first.find(marker)
        if index < 0:
            raise StorageError(
                f"Clé de dataset inattendue (sans « {marker} ») : {first}"
            )
        project_id = first[index + len(marker) :].split("/", 1)[0]
        if not project_id:
            raise StorageError(f"Clé de dataset sans identifiant de projet : {first}")
        return f"{first[: index + len(marker)]}{project_id}/{payload.jobId}/{safe_label}"

    def _job_workdir(self, external_id: str) -> Path:
        """Répertoire de travail temporaire (un par tâche)."""
        workdir = self._settings.work_dir / f"job-{external_id}"
        workdir.mkdir(parents=True, exist_ok=True)
        return workdir

    def _start_duration_watchdog(self, external_id: str) -> threading.Timer | None:
        """Applique MAX_DURATION_MINUTES : interruption au prochain point de contrôle."""
        minutes = self._settings.max_duration_minutes
        if not minutes:
            return None
        timer = threading.Timer(minutes * 60.0, self._expire_job, args=(external_id, minutes))
        timer.daemon = True
        timer.start()
        return timer

    def _expire_job(self, external_id: str, minutes: int) -> None:
        """Durée maximale atteinte : la tâche échouera au prochain contrôle du moteur."""
        with self._lock:
            record = self._jobs.get(external_id)
            if record is None or record.status != "running":
                return
            record.cancel_reason = (
                f"Durée maximale dépassée ({minutes} minutes) : tâche interrompue par le worker."
            )
            self._append_log(
                record,
                "error",
                f"Durée maximale dépassée ({minutes} minutes) — interruption demandée.",
            )
            event = self._cancel_events.get(external_id)
        if event is not None:
            event.set()
        self._persist()

    def _take_cancel_reason(self, external_id: str) -> str | None:
        with self._lock:
            record = self._jobs.get(external_id)
            if record is None:
                return None
            reason = record.cancel_reason
            record.cancel_reason = None
            return reason

    # ------------------------------------------------------------------ #
    # Journal + persistance                                               #
    # ------------------------------------------------------------------ #

    def _log(self, external_id: str, level: str, message: str) -> None:
        with self._lock:
            record = self._jobs.get(external_id)
            if record is None:
                return
            self._append_log(record, level, message)
        self._persist()

    def _append_log(self, record: JobRecord, level: str, message: str) -> None:
        """Ajoute une ligne de journal (plafonnée à MAX_LOG_LINES) — verrou requis."""
        record.logs.append(LogLine(at=_now_iso(), level=level, message=message))  # type: ignore[arg-type]
        if len(record.logs) > MAX_LOG_LINES:
            del record.logs[:-MAX_LOG_LINES]

    def _serialize(self, record: JobRecord) -> dict[str, Any]:
        return {
            "externalId": record.external_id,
            "payload": record.payload.model_dump(),
            "status": record.status,
            "started": record.started,
            "progressPercent": record.progress_percent,
            "currentStep": record.current_step,
            "epochsDone": record.epochs_done,
            "epochsTotal": record.epochs_total,
            "trainLoss": record.train_loss,
            "metrics": dict(record.metrics),
            "logs": [log.model_dump() for log in record.logs],
            "error": record.error,
            "artifacts": [artifact.model_dump() for artifact in record.artifacts],
        }

    def _persist(self) -> None:
        """Écrit le fichier d'état (atomique, borné à MAX_PERSISTED_JOBS).

        Sérialisé par un verrou d'E/S dédié : plusieurs threads (moteur,
        requêtes HTTP, watchdog) peuvent persister simultanément — sans ce
        verrou, deux écritures se disputeraient le même fichier temporaire.
        Un échec d'écriture est journalisé mais n'interrompt JAMAIS une tâche.
        """
        with self._io_lock:
            with self._lock:
                if len(self._jobs) > MAX_PERSISTED_JOBS:
                    # Les identifiants ULID-like sont triables par création :
                    # on oublie les plus anciennes tâches.
                    keep = sorted(self._jobs)[-MAX_PERSISTED_JOBS:]
                    for old in sorted(self._jobs):
                        if old not in keep:
                            self._jobs.pop(old, None)
                            self._cancel_events.pop(old, None)
                entries = [self._serialize(record) for record in self._jobs.values()]
                state = {"version": 1, "jobs": entries}
            path = self._settings.jobs_state_file
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(path.suffix + ".tmp")
                tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
                os.replace(tmp, path)
            except OSError as exc:
                logger.error("Écriture du fichier d'état impossible (%s) : %s", path, exc)

    def _load_previous_state(self) -> None:
        """Recharge l'état précédent — les « running » deviennent des échecs honnêtes."""
        path = self._settings.jobs_state_file
        if not path.is_file():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Fichier d'état %s illisible — ignoré (%s).", path, exc)
            return
        entries = raw.get("jobs") if isinstance(raw, dict) else None
        if not isinstance(entries, list):
            logger.warning("Fichier d'état %s de format inattendu — ignoré.", path)
            return
        interrupted = 0
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            try:
                payload = SubmitJobPayload(**entry["payload"])
                record = JobRecord(
                    external_id=str(entry["externalId"]),
                    payload=payload,
                    started=True,
                    progress_percent=entry.get("progressPercent"),
                    current_step=entry.get("currentStep"),
                    epochs_done=entry.get("epochsDone"),
                    epochs_total=entry.get("epochsTotal"),
                    train_loss=entry.get("trainLoss"),
                    metrics={
                        str(key): float(value)
                        for key, value in (entry.get("metrics") or {}).items()
                    },
                    logs=[LogLine(**log) for log in (entry.get("logs") or [])],
                    error=entry.get("error"),
                    artifacts=[Artifact(**a) for a in (entry.get("artifacts") or [])],
                )
            except Exception as exc:  # Entrée illisible : ignorée honnêtement.
                logger.warning("Entrée d'état ignorée (illisible) : %s", exc)
                continue
            previous = entry.get("status")
            if previous == "running":
                record.status = "failed"
                record.error = "Worker redémarré pendant l'exécution."
                record.logs.append(
                    LogLine(
                        at=_now_iso(),
                        level="error",
                        message="Worker redémarré pendant l'exécution.",
                    )
                )
                if len(record.logs) > MAX_LOG_LINES:
                    del record.logs[:-MAX_LOG_LINES]
                interrupted += 1
            elif previous in ("completed", "failed"):
                record.status = previous
            else:
                continue
            self._jobs[record.external_id] = record
        if interrupted:
            logger.warning(
                "%d tâche(s) interrompue(s) par le redémarrage — marquées en échec.",
                interrupted,
            )
            self._persist()

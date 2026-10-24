"""Stockage R2 (compatible S3) — boto3 importé paresseusement, jamais au chargement.

Le worker partage le bucket du studio : les datasets et modèles de base sont
lus depuis ``users/{uid}/training-files/{projectId}/{assetId}``, les artefacts
y sont écrits par le :class:`~training_worker.job_manager.JobManager`.

Règle d'honnêteté : si R2 n'est pas configuré (ou boto3 absent), toute
opération échoue avec un :class:`StorageError` au message clair — jamais de
succès simulé.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .config import Settings

logger = logging.getLogger("training_worker")


class StorageError(RuntimeError):
    """Erreur de stockage — message destiné à l'utilisateur, jamais de succès simulé."""


class R2Storage:
    """Accès au bucket R2 du studio (datasets, modèles de base, artefacts)."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: Any | None = None

    @property
    def configured(self) -> bool:
        """True si les quatre variables R2 sont présentes."""
        return self._settings.r2_configured

    def _client(self) -> Any:
        """Client boto3 (créé à la demande — boto3 peut ne pas être installé)."""
        if not self.configured:
            raise StorageError(
                "Stockage R2 non configuré : R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, "
                "R2_SECRET_ACCESS_KEY et R2_BUCKET sont requis pour accéder aux "
                "datasets, modèles et artefacts."
            )
        try:
            import boto3
        except ImportError as exc:  # pragma: no cover — dépend du déploiement
            raise StorageError(
                "boto3 n'est pas installé sur ce worker : impossible d'accéder au stockage R2."
            ) from exc
        if self._client is None:
            self._client = boto3.client(
                "s3",
                endpoint_url=f"https://{self._settings.r2_account_id}.r2.cloudflarestorage.com",
                aws_access_key_id=self._settings.r2_access_key_id,
                aws_secret_access_key=self._settings.r2_secret_access_key,
                region_name="auto",
            )
        return self._client

    def download(self, storage_key: str, dest: Path) -> Path:
        """Télécharge un objet R2 vers ``dest`` (fichier local) et renvoie son chemin."""
        client = self._client()
        dest.parent.mkdir(parents=True, exist_ok=True)
        logger.info("Téléchargement R2 : %s", storage_key)
        try:
            response = client.get_object(Bucket=self._settings.r2_bucket, Key=storage_key)
            body = response["Body"]
            with open(dest, "wb") as handle:
                for chunk in body.iter_chunks(1024 * 1024):
                    handle.write(chunk)
        except Exception as exc:
            code = ""
            error_response = getattr(exc, "response", None)
            if isinstance(error_response, dict):
                code = str(error_response.get("Error", {}).get("Code", ""))
            if code == "NoSuchKey":
                raise StorageError(f"Objet R2 introuvable : « {storage_key} ».") from exc
            raise StorageError(
                f"Échec du téléchargement R2 de « {storage_key} » : {exc}"
            ) from exc
        return dest

    def upload(self, key: str, path: Path) -> int:
        """Téléverse un fichier local vers R2, renvoie sa taille en octets."""
        client = self._client()
        if not path.is_file():
            raise StorageError(f"Fichier local introuvable à téléverser : {path}")
        size = path.stat().st_size
        logger.info("Téléversement R2 : %s (%d octets)", key, size)
        try:
            client.upload_file(str(path), self._settings.r2_bucket, key)
        except Exception as exc:
            raise StorageError(f"Échec du téléversement R2 vers « {key} » : {exc}") from exc
        return int(size)

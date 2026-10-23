"""Fixtures des tests — moteur fake autorisé, R2 volontairement ABSENT.

Les tests doivent passer SANS torch ni boto3 : le worker importe paresseusement
toutes ses dépendances lourdes. Le moteur ``fake`` (``WORKER_ALLOW_FAKE_ENGINE=true``)
sert à valider le contrat complet (soumission → exécution → état → artefacts).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from training_worker.app import create_app

#: En-tête d'authentification valide pour tous les tests.
AUTH = {"Authorization": "Bearer test-token"}


def fake_payload(**overrides: Any) -> dict[str, Any]:
    """Charge utile minimale valide (moteur fake — aucune dépendance lourde)."""
    payload: dict[str, Any] = {
        "jobId": "job-1",
        "engineId": "fake",
        "method": "fake",
        "parameters": {},
        "baseModel": {"kind": "catalog", "ref": "test/tiny-model"},
        "datasets": [
            {
                "storageKey": "users/u-test/training-files/proj-1/asset-1",
                "split": "train",
                "format": "txt",
            }
        ],
    }
    payload.update(overrides)
    return payload


@pytest.fixture()
def worker_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Environnement de test : token, moteur fake, répertoires temporaires, R2 absent."""
    monkeypatch.setenv("WORKER_TOKEN", "test-token")
    monkeypatch.setenv("WORKER_ALLOW_FAKE_ENGINE", "true")
    monkeypatch.setenv("WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("JOBS_STATE_FILE", str(tmp_path / "state" / "jobs.json"))
    # R2 volontairement NON configuré : les tests doivent passer sans boto3.
    for var in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        monkeypatch.delenv(var, raising=False)
    return tmp_path


@pytest.fixture()
def client(worker_env: Path) -> Iterator[TestClient]:
    """Client de test — l'application lit l'environnement au moment de la création."""
    with TestClient(create_app()) as test_client:
        yield test_client

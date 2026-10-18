"""Contrat complet : capacités, soumission, état, artefacts, annulation, redémarrage."""

from __future__ import annotations

import json
import os
import time

from fastapi.testclient import TestClient

from training_worker.app import create_app

from .conftest import AUTH, fake_payload


def _poll_state(client: TestClient, external_id: str, timeout: float = 5.0) -> dict:
    """Sonde la tâche jusqu'à un statut terminal (le faux moteur est instantané)."""
    deadline = time.monotonic() + timeout
    state: dict | None = None
    while time.monotonic() < deadline:
        response = client.get(f"/jobs/{external_id}", headers=AUTH)
        assert response.status_code == 200
        state = response.json()
        if state["status"] != "running":
            return state
        time.sleep(0.02)
    assert state is not None, "aucun état récupéré"
    return state


def test_capabilities_forme_complete(client: TestClient) -> None:
    """/capabilities : forme exacte — GPU réels + entrée cpu + maxDurationMinutes."""
    response = client.get("/capabilities", headers=AUTH)
    assert response.status_code == 200
    body = response.json()
    assert set(body.keys()) == {"gpus", "maxDurationMinutes"}
    # Aucun MAX_DURATION_MINUTES dans l'environnement de test → null (honnête).
    assert body["maxDurationMinutes"] is None
    gpus = body["gpus"]
    assert isinstance(gpus, list)
    cpu_entries = [gpu for gpu in gpus if gpu["name"] == "cpu"]
    assert len(cpu_entries) == 1, "l'entrée cpu déclarée doit être présente et unique"
    assert cpu_entries[0]["vramGb"] == 0.0
    assert cpu_entries[0]["available"] is True
    for gpu in gpus:
        assert set(gpu.keys()) == {"name", "vramGb", "available"}
        assert isinstance(gpu["name"], str)
        assert isinstance(gpu["vramGb"], (int, float))
        assert isinstance(gpu["available"], bool)


def test_capabilities_max_duration_minutes(worker_env, monkeypatch) -> None:
    """MAX_DURATION_MINUTES est annoncé tel quel dans /capabilities."""
    monkeypatch.setenv("MAX_DURATION_MINUTES", "60")
    with TestClient(create_app()) as client:
        body = client.get("/capabilities", headers=AUTH).json()
        assert body["maxDurationMinutes"] == 60


def test_soumission_puis_etat_complet(client: TestClient) -> None:
    """POST /jobs (fake) → 201 ; GET /jobs/{id} → ProviderJobState complet et terminé."""
    response = client.post("/jobs", headers=AUTH, json=fake_payload())
    assert response.status_code == 201, response.text
    external_id = response.json()["externalId"]
    assert isinstance(external_id, str) and external_id

    state = _poll_state(client, external_id)
    assert state["status"] == "completed", state

    # Forme EXACTE du ProviderJobState (miroir de lib/training/providers/types.ts).
    assert set(state.keys()) == {
        "externalId",
        "status",
        "progressPercent",
        "currentStep",
        "epochsDone",
        "epochsTotal",
        "trainLoss",
        "metrics",
        "logs",
        "error",
        "artifacts",
    }
    assert state["externalId"] == external_id
    assert state["status"] in ("running", "completed", "failed")
    assert state["error"] is None
    assert state["progressPercent"] == 100.0
    assert isinstance(state["metrics"], dict)
    assert all(isinstance(value, (int, float)) for value in state["metrics"].values())

    # Journal : lignes bien formées.
    assert state["logs"], "au moins une ligne de journal attendue"
    for log in state["logs"]:
        assert set(log.keys()) == {"at", "level", "message"}
        assert log["level"] in ("info", "warn", "error")
        assert isinstance(log["message"], str) and log["message"]

    # Artefacts : présents, avec clé de stockage dérivée du premier dataset.
    assert state["artifacts"], "artefacts attendus pour le moteur fake"
    artifact = state["artifacts"][0]
    assert set(artifact.keys()) == {"label", "storageKey", "sizeBytes"}
    assert artifact["label"] == "fake-artifact.txt"
    assert artifact["storageKey"] == "users/u-test/training-files/proj-1/job-1/fake-artifact.txt"
    assert isinstance(artifact["sizeBytes"], int) and artifact["sizeBytes"] > 0


def test_etat_tache_inconnue_404(client: TestClient) -> None:
    """GET /jobs/{id} inconnu → 404."""
    response = client.get("/jobs/01TACHEINCONNUE0000000000000000", headers=AUTH)
    assert response.status_code == 404


def test_annulation_tache_inconnue_404(client: TestClient) -> None:
    """POST /jobs/{id}/cancel inconnu → 404 (toléré par la plateforme)."""
    response = client.post("/jobs/01TACHEINCONNUE0000000000000000/cancel", headers=AUTH)
    assert response.status_code == 404


def test_annulation_tache_connue(client: TestClient) -> None:
    """L'annulation d'une tâche CONNUE répond 200 (déjà terminée : journal honnête)."""
    external_id = client.post("/jobs", headers=AUTH, json=fake_payload()).json()["externalId"]
    state = _poll_state(client, external_id)
    assert state["status"] == "completed"
    response = client.post(f"/jobs/{external_id}/cancel", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    state_after = client.get(f"/jobs/{external_id}", headers=AUTH).json()
    assert state_after["status"] == "completed"
    assert any("déjà terminée" in log["message"] for log in state_after["logs"])


def test_redemarrage_marque_les_taches_running_en_echec(worker_env) -> None:
    """Au démarrage, une tâche « running » persistée devient un échec honnête."""
    state_file = str(os.environ["JOBS_STATE_FILE"])
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    with open(state_file, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "version": 1,
                "jobs": [
                    {
                        "externalId": "01TESTRESTART0000000000000000",
                        "payload": fake_payload(jobId="job-restart"),
                        "status": "running",
                        "started": True,
                        "progressPercent": 42.0,
                        "currentStep": "Entraînement en cours",
                        "epochsDone": 1,
                        "epochsTotal": 3,
                        "trainLoss": 1.5,
                        "metrics": {"train_loss": 1.5},
                        "logs": [{"at": "2025-01-01T00:00:00+00:00", "level": "info", "message": "Tâche démarrée."}],
                        "error": None,
                        "artifacts": [],
                    }
                ],
            },
            handle,
        )
    with TestClient(create_app()) as client:
        response = client.get("/jobs/01TESTRESTART0000000000000000", headers=AUTH)
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "failed"
        assert body["error"] == "Worker redémarré pendant l'exécution."
        assert any(
            "Worker redémarré" in log["message"] for log in body["logs"]
        )


def test_etat_persiste_entre_deux_instances(worker_env) -> None:
    """Une tâche terminée reste consultable après recréation du worker (même fichier d'état)."""
    with TestClient(create_app()) as first_client:
        external_id = first_client.post("/jobs", headers=AUTH, json=fake_payload()).json()["externalId"]
        state = _poll_state(first_client, external_id)
        assert state["status"] == "completed"
    with TestClient(create_app()) as second_client:
        response = second_client.get(f"/jobs/{external_id}", headers=AUTH)
        assert response.status_code == 200
        assert response.json()["status"] == "completed"

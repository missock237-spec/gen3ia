"""Validation des schémas et garde-fous de soumission (422 / 400)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from training_worker.app import create_app

from .conftest import AUTH, fake_payload


def test_job_id_manquant_422(client: TestClient) -> None:
    """Sans jobId : pydantic refuse (422)."""
    payload = fake_payload()
    payload.pop("jobId")
    response = client.post("/jobs", headers=AUTH, json=payload)
    assert response.status_code == 422


def test_moteur_inconnu_400(client: TestClient) -> None:
    """EngineId inconnu → 400 avec détail (contrat : jamais accepté en silence)."""
    response = client.post(
        "/jobs", headers=AUTH, json=fake_payload(engineId="does-not-exist", method="lora")
    )
    assert response.status_code == 400
    assert "does-not-exist" in response.json()["detail"]


def test_base_model_sans_kind_422(client: TestClient) -> None:
    """baseModel sans champ kind → 422."""
    payload = fake_payload(baseModel={"ref": "test/tiny-model"})
    response = client.post("/jobs", headers=AUTH, json=payload)
    assert response.status_code == 422


def test_base_model_kind_invalide_422(client: TestClient) -> None:
    """kind hors de {upload, catalog} → 422."""
    payload = fake_payload(baseModel={"kind": "internet", "ref": "test/tiny-model"})
    response = client.post("/jobs", headers=AUTH, json=payload)
    assert response.status_code == 422


def test_format_dataset_invalide_422(client: TestClient) -> None:
    """Un format de dataset hors json/jsonl/csv/txt → 422."""
    payload = fake_payload(
        datasets=[{"storageKey": "users/u/training-files/p/a", "split": "train", "format": "parquet"}]
    )
    response = client.post("/jobs", headers=AUTH, json=payload)
    assert response.status_code == 422


def test_datasets_vides_acceptes_pour_rag(client: TestClient) -> None:
    """Une liste de datasets VIDE est un payload valide pour rag-index (201).

    Le moteur échouera ensuite HONNÊTEMENT (« rien à indexer ») — la validation
    de charge utile et l'exécution sont deux étages distincts.
    """
    response = client.post(
        "/jobs",
        headers=AUTH,
        json=fake_payload(engineId="rag-index", method="rag", datasets=[]),
    )
    assert response.status_code == 201
    external_id = response.json()["externalId"]

    deadline = 5.0
    import time

    end = time.monotonic() + deadline
    state = None
    while time.monotonic() < end:
        state = client.get(f"/jobs/{external_id}", headers=AUTH).json()
        if state["status"] != "running":
            break
        time.sleep(0.02)
    assert state is not None and state["status"] == "failed"
    assert state["error"] and "dataset" in state["error"].lower()
    assert state["artifacts"] == []


def test_moteur_fake_rejete_quand_desactive(worker_env, monkeypatch) -> None:
    """WORKER_ALLOW_FAKE_ENGINE=false (défaut production) → engine « fake » refusé 400."""
    monkeypatch.setenv("WORKER_ALLOW_FAKE_ENGINE", "false")
    with TestClient(create_app()) as client:
        response = client.post("/jobs", headers=AUTH, json=fake_payload())
        assert response.status_code == 400
        assert "fake" in response.json()["detail"].lower()


def test_methode_non_supportee_400(client: TestClient) -> None:
    """Une méthode non supportée par le moteur → 400 (échec rapide honnête)."""
    response = client.post(
        "/jobs",
        headers=AUTH,
        json=fake_payload(engineId="rag-index", method="lora", datasets=[]),
    )
    assert response.status_code == 400
    assert "méthode" in response.json()["detail"].lower()


def test_moteurs_reels_sont_soumis_sans_executer(client: TestClient) -> None:
    """text-lora est ACCEPTÉ (201) même sans torch installé — l'échec viendra de l'exécution."""
    response = client.post(
        "/jobs",
        headers=AUTH,
        json=fake_payload(
            engineId="text-lora",
            method="lora",
            datasets=[
                {"storageKey": "users/u/training-files/p/a", "split": "train", "format": "jsonl"}
            ],
        ),
    )
    assert response.status_code == 201
    external_id = response.json()["externalId"]

    # Sans torch ni R2, la tâche doit échouer HONNÊTEMENT (jamais de succès simulé).
    import time

    end = time.monotonic() + 5.0
    state = None
    while time.monotonic() < end:
        state = client.get(f"/jobs/{external_id}", headers=AUTH).json()
        if state["status"] != "running":
            break
        time.sleep(0.02)
    assert state is not None and state["status"] == "failed"
    assert state["error"]

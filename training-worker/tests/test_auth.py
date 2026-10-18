"""Authentification : /healthz libre, routes protégées par Bearer (temps constant)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from training_worker.app import create_app

from .conftest import AUTH


def test_healthz_sans_authentification(client: TestClient) -> None:
    """La sonde de vie répond 200 SANS jeton (monitoring)."""
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_capabilities_sans_token(client: TestClient) -> None:
    """Route protégée sans jeton → 401."""
    response = client.get("/capabilities")
    assert response.status_code == 401


def test_capabilities_avec_bon_token(client: TestClient) -> None:
    """Route protégée avec le bon jeton → 200."""
    response = client.get("/capabilities", headers=AUTH)
    assert response.status_code == 200


def test_capabilities_mauvais_token(client: TestClient) -> None:
    """Route protégée avec un jeton invalide → 401."""
    response = client.get("/capabilities", headers={"Authorization": "Bearer wrong-token"})
    assert response.status_code == 401


def test_en_tete_mal_formee(client: TestClient) -> None:
    """En-tête Authorization sans schéma Bearer → 401."""
    response = client.get("/capabilities", headers={"Authorization": "test-token"})
    assert response.status_code == 401


def test_worker_token_absent_repond_503(worker_env, monkeypatch) -> None:
    """Sans WORKER_TOKEN configuré : 503 (mauvaise configuration, jamais d'accès ouvert)."""
    monkeypatch.delenv("WORKER_TOKEN", raising=False)
    with TestClient(create_app()) as test_client:
        for method, path in (
            ("get", "/capabilities"),
            ("post", "/jobs"),
            ("get", "/jobs/01EXEMPLE"),
            ("post", "/jobs/01EXEMPLE/cancel"),
        ):
            response = getattr(test_client, method)(path, headers=AUTH)
            assert response.status_code == 503, f"{method.upper()} {path} → {response.status_code}"
        # /healthz reste libre même mal configuré.
        assert test_client.get("/healthz").status_code == 200

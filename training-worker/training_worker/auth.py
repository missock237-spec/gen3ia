"""Authentification du worker — Bearer token en comparaison à temps constant.

La plateforme appelle le worker avec ``Authorization: Bearer <TRAINING_WORKER_TOKEN>``.
Le worker valide ce jeton contre sa propre variable ``WORKER_TOKEN`` :

- ``WORKER_TOKEN`` absent → **503** : mauvaise configuration, jamais d'accès ouvert ;
- jeton manquant/mal formé → **401** ;
- jeton invalide → **401** (comparaison à temps constant via ``hmac.compare_digest``).

Seule ``/healthz`` échappe à cette protection (sonde de monitoring).
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request


def require_worker_token(request: Request) -> None:
    """Dépendance FastAPI protégeant les routes du contrat (tout sauf /healthz)."""
    settings = request.app.state.settings
    expected = settings.worker_token
    if not expected:
        raise HTTPException(
            status_code=503,
            detail=(
                "WORKER_TOKEN non configuré sur le worker — accès refusé par précaution "
                "(503 : mauvaise configuration, jamais d'accès ouvert)."
            ),
        )
    header = request.headers.get("authorization") or ""
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        raise HTTPException(
            status_code=401,
            detail="Jeton d'authentification manquant ou mal formé (Authorization: Bearer <token>).",
        )
    if not hmac.compare_digest(value.strip().encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Jeton d'authentification invalide.")

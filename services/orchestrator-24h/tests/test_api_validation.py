"""Validation des requêtes de l'API (sans serveur Redis)."""

import pytest
from pydantic import ValidationError

from api import JobRequest, stream_for


class TestJobRequest:
    def test_requete_valide(self):
        req = JobRequest(modality="image", payload={"prompt": "ville futuriste"}, priority=2)
        assert req.modality == "image" and req.priority == 2

    def test_modality_invalide_refusee(self):
        with pytest.raises(ValidationError):
            JobRequest(modality="musique", payload={"x": 1})

    def test_champ_supplementaire_refuse(self):
        with pytest.raises(ValidationError):
            JobRequest(modality="image", payload={"x": 1}, intrusion="non")

    def test_priority_hors_bornes(self):
        for bad in (0, 11, -3):
            with pytest.raises(ValidationError):
                JobRequest(modality="image", payload={"x": 1}, priority=bad)

    def test_priority_defaut_5(self):
        assert JobRequest(modality="data", payload={"records": [1]}).priority == 5

    def test_payload_requis(self):
        with pytest.raises(ValidationError):
            JobRequest(modality="image")


class TestRoutageVoies:
    def test_voie_rapide_pour_priorites_hautes(self):
        for p in (1, 2, 3):
            assert stream_for("audio", p) == "gen3ia:queue:audio:fast"

    def test_voie_normale_pour_priorites_basses(self):
        for p in (4, 7, 10):
            assert stream_for("video", p) == "gen3ia:queue:video"

    def test_seuil_dynamique(self, monkeypatch):
        import api

        monkeypatch.setattr(api, "FAST_LANE_MAX_PRIORITY", 6)
        assert stream_for("image", 6) == "gen3ia:queue:image:fast"
        assert stream_for("image", 7) == "gen3ia:queue:image"

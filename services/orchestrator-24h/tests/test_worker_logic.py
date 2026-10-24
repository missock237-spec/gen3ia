"""Logique pure du worker : URLs, qualité, contrôle data, voies de priorité."""

import json
from pathlib import Path

import pytest

import worker


class TestSafeUrl:
    def test_http_et_https_valides(self):
        assert worker.safe_url("https://example.com/a.jpg") is True
        assert worker.safe_url("http://cdn.example.org/file.mp4") is True

    def test_schemas_interdits(self):
        assert worker.safe_url("ftp://example.com/f") is False
        assert worker.safe_url("javascript:alert(1)") is False
        assert worker.safe_url("data:image/png;base64,AAAA") is False

    def test_non_chaine_et_sans_netloc(self):
        assert worker.safe_url(None) is False
        assert worker.safe_url(42) is False
        assert worker.safe_url("http://") is False
        assert worker.safe_url("example.com/f") is False


class TestAssessResult:
    def test_score_haut_termine(self):
        status, score, note = worker.assess_result({"quality": {"score": 0.91}})
        assert status == "completed" and score == 0.91 and note is None

    def test_score_sous_seuil_en_revue(self):
        status, score, note = worker.assess_result({"quality": {"score": 0.5}})
        assert status == "review_required" and score == 0.5 and note

    def test_passed_true_sans_score_termine(self):
        status, score, note = worker.assess_result({"quality_passed": True})
        assert status == "completed" and score is None and note is None

    def test_passed_false_dominant_meme_avec_bon_score(self):
        status, _, note = worker.assess_result({"quality": {"score": 0.95, "passed": False}})
        assert status == "review_required" and "quality_passed=false" in note

    def test_score_non_numerique_en_revue(self):
        status, score, note = worker.assess_result({"quality_score": "excellent"})
        assert status == "review_required" and score is None

    def test_aucun_signal_en_revue_jamais_certifie(self):
        status, score, note = worker.assess_result({"output_url": "https://x/y.png"})
        assert status == "review_required" and score is None and "score" in note


class TestRunDataQuality:
    @pytest.fixture()
    def data_dir(self, tmp_path, monkeypatch):
        target = tmp_path / "data"
        monkeypatch.setattr(worker, "DATA_DIR", target)
        return target

    def _write(self, result):
        return json.loads(Path(result["cleaned_file"]).read_text().splitlines()[0])

    def test_lot_vide_erreur_permanente(self):
        with pytest.raises(worker.PermanentJobError, match="vide"):
            worker.run_data_quality({"records": []}, "job-empty")

    def test_records_absents_erreur_permanente(self):
        with pytest.raises(worker.PermanentJobError, match="liste"):
            worker.run_data_quality({}, "job-none")

    def test_normalisation_et_acceptation(self, data_dir):
        result = worker.run_data_quality(
            {"records": [{"caption": "  Un   chat  noir  ", "asset_url": "https://x/cat.jpg"}]},
            "job-ok",
        )
        assert result["counts"] == {"received": 1, "accepted": 1, "rejected": 0, "duplicates_detected": 0}
        assert self._write(result)["caption"] == "Un chat noir"

    def test_rejets_conserves_pas_supprimes(self, data_dir):
        rows = [
            {"caption": "   "},                                        # texte vide
            {"caption": "x" * 20001},                                  # trop long
            {"caption": "ok", "asset_url": "ftp://x/f"},               # URL interdite
            {"caption": "ok", "asset_url": "https://x/a.jpg"},         # référence
            {"caption": "ok", "asset_url": "https://x/a.jpg"},         # doublon exact
            "pas_un_objet",                                            # ligne non objet
        ]
        result = worker.run_data_quality({"records": rows}, "job-mix")
        assert result["counts"]["accepted"] == 1
        assert result["counts"]["rejected"] == 5
        assert result["counts"]["duplicates_detected"] == 1
        rejected = json.loads((data_dir / "rejected" / "job-mix.jsonl").read_text().splitlines()[0])
        assert rejected["reason"] == ["missing_text_or_caption"]

    def test_score_ratio_acceptation_explicite(self, data_dir):
        result = worker.run_data_quality(
            {"records": [{"caption": "a"}, {"caption": "b"}, {"caption": " "}]}, "job-ratio"
        )
        assert result["quality"]["score"] == round(2 / 3, 4)
        assert "not_semantic_quality" in result["quality"]["score_type"]


class TestVoiesPriorite:
    def test_route_voie_rapide(self):
        assert worker.stream_for("image", 1) == "gen3ia:queue:image:fast"
        assert worker.stream_for("video", 3) == "gen3ia:queue:video:fast"

    def test_route_voie_normale(self):
        assert worker.stream_for("image", 4) == "gen3ia:queue:image"
        assert worker.stream_for("data", 10) == "gen3ia:queue:data"

    def test_seuil_coherent_avec_api(self):
        import api

        assert api.FAST_LANE_MAX_PRIORITY == worker.FAST_LANE_MAX_PRIORITY
        for modality in ("image", "audio", "video", "data"):
            for priority in range(1, 11):
                assert api.stream_for(modality, priority) == worker.stream_for(modality, priority)

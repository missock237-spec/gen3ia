"""Hygiène d'import : le package ne doit JAMAIS exiger torch/boto3 au chargement.

Le worker importe paresseusement toutes ses dépendances lourdes (torch,
transformers, peft, sentence-transformers, numpy, boto3) : les tests — et le
service sur un hôte CPU seul pour rag-index — doivent fonctionner sans elles.
"""

from __future__ import annotations

import sys

#: Modules lourds interdits au chargement du package.
_HEAVY_MODULES = (
    "torch",
    "transformers",
    "peft",
    "datasets",
    "sentence_transformers",
    "numpy",
    "boto3",
    "botocore",
    "s3transfer",
)


def test_import_ne_tire_aucune_dependance_lourde(worker_env) -> None:
    """`import training_worker.app` ne tire AUCUN module lourd dans sys.modules."""
    # Purge défensive (au cas où un autre plugin les aurait chargés).
    for name in list(sys.modules):
        if name in _HEAVY_MODULES or any(
            name.startswith(f"{heavy}.") for heavy in _HEAVY_MODULES
        ):
            del sys.modules[name]
    # Ré-import réel du module applicatif (pas la copie en cache).
    sys.modules.pop("training_worker.app", None)
    import training_worker.app  # noqa: F401

    pulled = [name for name in _HEAVY_MODULES if name in sys.modules]
    assert not pulled, f"modules lourds importés au chargement : {pulled}"


def test_detection_gpu_sans_torch_est_vide(worker_env) -> None:
    """Sans torch : detect_gpus() ne lève pas et ne déclare aucun GPU (honnêteté)."""
    for name in list(sys.modules):
        if name == "torch" or name.startswith("torch."):
            del sys.modules[name]
    sys.modules.pop("training_worker.app", None)
    import training_worker.app as worker_app

    gpus = worker_app.detect_gpus()
    assert gpus == []

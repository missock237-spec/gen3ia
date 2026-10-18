"""Chargement du modèle de base — catalogue Hugging Face ou upload R2.

- ``kind = "catalog"`` : ``ref`` est un identifiant HF (ex. ``Qwen/Qwen2.5-1.5B-Instruct``),
  chargé directement via ``from_pretrained`` (téléchargement depuis le hub) ;
- ``kind = "upload"``  : l'objet R2 ``storageKey`` est téléchargé puis préparé —
  archive ZIP d'un dossier de modèle (extraction sécurisée), ou fichier de poids
  seul (voir les limites honnêtes ci-dessous).
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

from ..schemas import SubmitJobPayload
from .base import EngineContext, EngineError


def _safe_extract_zip(archive: Path, dest: Path) -> None:
    """Extrait une archive en refusant les chemins malveillants (path traversal)."""
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    try:
        with zipfile.ZipFile(archive) as zf:
            for member in zf.infolist():
                target = (dest / member.filename).resolve()
                if root not in target.parents and target != root:
                    raise EngineError(
                        f"Archive modèle invalide : chemin dangereux « {member.filename} » rejeté."
                    )
            zf.extractall(dest)
    except zipfile.BadZipFile as exc:
        raise EngineError(
            f"Archive modèle illisible (ZIP invalide) : « {archive.name} » — {exc}"
        ) from exc


def _find_model_dir(extract_dir: Path) -> Path:
    """Localise le dossier contenant ``config.json`` (racine ou unique sous-dossier)."""
    if (extract_dir / "config.json").is_file():
        return extract_dir
    children = [child for child in extract_dir.iterdir() if child.is_dir()]
    for child in children:
        if (child / "config.json").is_file():
            return child
    raise EngineError(
        "config.json introuvable dans l'archive du modèle : un dossier de modèle "
        "Hugging Face complet (config.json, tokenizer, poids) est requis."
    )


def load_base_model(
    payload: SubmitJobPayload,
    ctx: EngineContext,
    *,
    torch_dtype: Any = None,
    quantization_config: Any = None,
) -> tuple[Any, Any]:
    """Charge ``(model, tokenizer)`` — jamais de succès simulé.

    Lève :class:`EngineError` avec un message actionnable si le modèle est
    incomplet ou dans un format impossible à entraîner.
    """
    from transformers import AutoModelForCausalLM, AutoTokenizer  # import paresseux

    kwargs: dict[str, Any] = {}
    if torch_dtype is not None:
        kwargs["torch_dtype"] = torch_dtype
    if quantization_config is not None:
        kwargs["quantization_config"] = quantization_config

    if payload.baseModel.kind == "catalog":
        ref = payload.baseModel.ref
        ctx.report(
            5.0,
            current_step=f"Chargement du modèle de base « {ref} » (Hugging Face)",
            log_message=f"Téléchargement du modèle de base depuis le hub : {ref}",
        )
        tokenizer = AutoTokenizer.from_pretrained(ref)
        model = AutoModelForCausalLM.from_pretrained(ref, **kwargs)
        return model, tokenizer

    # kind == "upload" : l'objet R2 doit être téléchargé puis préparé.
    storage_key = payload.baseModel.storageKey
    if not storage_key:
        raise EngineError(
            "Modèle de base « upload » sans storageKey : la plateforme doit fournir "
            "la clé R2 du fichier téléversé."
        )
    ctx.report(5.0, current_step=f"Téléchargement du modèle uploadé ({storage_key})")
    downloaded = ctx.download(storage_key)
    suffix = downloaded.suffix.lower()
    if suffix == ".zip":
        extract_dir = ctx.workdir / "model-extract"
        _safe_extract_zip(downloaded, extract_dir)
        model_dir = _find_model_dir(extract_dir)
        ctx.report(
            12.0,
            current_step="Chargement du modèle extrait",
            log_message=f"Archive modèle extraite : {model_dir.name}",
        )
    elif suffix in (".safetensors", ".bin"):
        # Limite honnête : un fichier de poids seul ne contient ni configuration
        # d'architecture ni tokenizer — impossible à charger via Transformers.
        raise EngineError(
            "Un fichier de poids seul ne suffit pas pour l'entraînement : ni "
            "configuration d'architecture ni tokenizer. Téléversez une archive ZIP "
            "du dossier de modèle complet (config.json, tokenizer, poids)."
        )
    elif suffix == ".gguf":
        raise EngineError(
            "Le format GGUF (llama.cpp) n'est pas supporté pour l'entraînement "
            "Transformers — fournissez un dossier/ZIP de modèle Hugging Face."
        )
    else:
        raise EngineError(
            f"Format de modèle uploadé non reconnu : « {downloaded.name} » "
            "(archive ZIP d'un dossier de modèle attendue)."
        )
    tokenizer = AutoTokenizer.from_pretrained(str(model_dir))
    model = AutoModelForCausalLM.from_pretrained(str(model_dir), **kwargs)
    return model, tokenizer

"""Lecture des datasets (json / jsonl / csv / txt) — partagé par les moteurs.

Formats acceptés (identiques à la validation côté plateforme) :

- ``json``  : tableau d'objets (ou objet unique) ;
- ``jsonl`` : un objet JSON par ligne non vide ;
- ``csv``   : en-tête + lignes (valeurs chaînes) ;
- ``txt``   : un document par ligne non vide → ``{"text": ligne}``.

Champs reconnus par enregistrement : ``prompt``/``completion``,
``instruction``/``output``, ``text``/``label``, ou ``text`` seul.
"""

from __future__ import annotations

import csv
import json
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any

from ..schemas import DatasetRef
from .base import EngineContext, EngineError

#: Paires de champs reconnues, dans l'ordre de priorité.
_PAIR_FIELDS: tuple[tuple[str, str], ...] = (
    ("prompt", "completion"),
    ("instruction", "output"),
    ("text", "label"),
)


def load_records(path: Path, fmt: str) -> list[dict[str, Any]]:
    """Lit un fichier dataset en liste d'enregistrements (dictionnaires)."""
    try:
        if fmt == "json":
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                if all(isinstance(item, dict) for item in data):
                    return data
                raise EngineError(
                    f"JSON inattendu dans « {path.name} » : tableau d'objets attendu."
                )
            if isinstance(data, dict):
                return [data]
            raise EngineError(
                f"JSON inattendu dans « {path.name} » : objet ou tableau d'objets attendu."
            )
        if fmt == "jsonl":
            records: list[dict[str, Any]] = []
            for line_number, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    item = json.loads(stripped)
                except json.JSONDecodeError as exc:
                    raise EngineError(
                        f"Ligne {line_number} invalide (JSONL) dans « {path.name} » : {exc}"
                    ) from exc
                if not isinstance(item, dict):
                    raise EngineError(
                        f"Ligne {line_number} de « {path.name} » : objet JSON attendu."
                    )
                records.append(item)
            return records
        if fmt == "csv":
            with open(path, newline="", encoding="utf-8") as handle:
                return [dict(row) for row in csv.DictReader(handle)]
        if fmt == "txt":
            return [
                {"text": line.strip()}
                for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
    except OSError as exc:
        raise EngineError(f"Lecture impossible de « {path.name} » : {exc}") from exc
    raise EngineError(
        f"Format de dataset non supporté : « {fmt} » (attendus : json, jsonl, csv, txt)."
    )


def record_to_pair(record: dict[str, Any]) -> tuple[str | None, str] | None:
    """Extrait une paire (gauche, droite) d'un enregistrement — ``None`` si inexploitable.

    ``gauche`` est ``None`` pour un texte brut (champ ``text`` seul).
    """
    for left_key, right_key in _PAIR_FIELDS:
        left = record.get(left_key)
        right = record.get(right_key)
        if isinstance(left, str) and isinstance(right, str) and left.strip() and right.strip():
            return left, right
    text = record.get("text")
    if isinstance(text, str) and text.strip():
        return None, text
    return None


def record_to_text(record: dict[str, Any]) -> str:
    """Texte d'un enregistrement pour l'indexation RAG (aplatissement clé/valeur en repli)."""
    pair = record_to_pair(record)
    if pair is not None:
        left, right = pair
        return f"{left}\n{right}" if left else right
    parts = [
        f"{key}: {value}"
        for key, value in record.items()
        if value is not None and str(value).strip()
    ]
    return "\n".join(parts)


def chunk_text(text: str, size: int, overlap: int) -> Iterator[str]:
    """Découpe un texte en morceaux de ``size`` caractères avec recouvrement ``overlap``."""
    step = max(1, size - overlap)
    start = 0
    length = len(text)
    while start < length:
        chunk = text[start : start + size].strip()
        if chunk:
            yield chunk
        if start + size >= length:
            break
        start += step


def select_split(payload_datasets: Sequence[DatasetRef], splits: Sequence[str]) -> list[DatasetRef]:
    """Sélectionne les datasets du premier split disponible (test → validation, etc.)."""
    for split in splits:
        refs = [d for d in payload_datasets if d.split == split]
        if refs:
            return refs
    return []


def texts_from_refs(refs: Sequence[DatasetRef], ctx: EngineContext) -> list[str]:
    """Télécharge et extrait les textes d'entraînement/évaluation des datasets donnés.

    Les enregistrements sans champ exploitable sont ignorés (comptés et journalisés).
    """
    texts: list[str] = []
    skipped = 0
    for ref in refs:
        path = ctx.download(ref.storageKey)
        records = load_records(path, ref.format)
        for record in records:
            pair = record_to_pair(record)
            if pair is None:
                skipped += 1
                continue
            left, right = pair
            texts.append(f"{left}\n{right}" if left else right)
        ctx.report(
            log_message=(
                f"Dataset « {ref.storageKey} » chargé (split {ref.split}, format "
                f"{ref.format}) : {len(records)} enregistrements."
            )
        )
    if skipped:
        ctx.report(
            log_message=(
                f"{skipped} enregistrement(s) ignoré(s) — champs non reconnus "
                "(prompt/completion, instruction/output, text/label ou text attendus)."
            )
        )
    return texts

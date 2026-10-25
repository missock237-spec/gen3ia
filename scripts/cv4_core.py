#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Curriculum Gen3ia v4 « tous domaines » — noyau partagé.

Propriétés héritées de v3 :
  - seed fixe → reproductible bit-à-bit ;
  - dédup stricte par hash de contenu (task_type + language + input + output) ;
  - bilingue FR/EN (~55 % / 45 %) ;
  - schéma : id, domain, task_type, language, instruction, input, output,
    metadata{difficulty, timestamp, quality_score, safety_label, license},
    content_hash.

Particularité v4 : les données COMPLÈTES partent sur Hugging Face
(Kings237/gen3ia-media-engine, préfixe v4/<domaine>/) — le dépôt GitHub ne
versionne que MANIFEST.json + sample.jsonl (200 lignes) pour rester léger
(le VPS de prod fait `git fetch` à chaque déploiement : +550 Mo de JSONL
serait hostile à son disque 2 Go).
"""

from __future__ import annotations

import hashlib
import json
import random
from datetime import datetime, timezone
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
DOSSIERS_DATASETS = RACINE / "datasets"
SEED = 20261026
VERSION = 4

# ═════════════════════════ Utilitaires cœur ═════════════════════════

def h16(texte: str) -> str:
    return hashlib.sha256(texte.encode("utf-8")).hexdigest()[:16]

def ts_aleatoire(rng: random.Random) -> str:
    secondes = rng.randint(1_704_067_200, 1_791_100_800)
    return datetime.fromtimestamp(secondes, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def contenu(texte: str, limite: int = 240) -> str:
    t = " ".join(texte.split())
    return t if len(t) <= limite else t[: limite - 1] + "…"

def pioche(rng: random.Random, liste):
    return rng.choice(liste)

def lang(rng: random.Random) -> str:
    return "fr" if rng.random() < 0.55 else "en"

def diff(rng: random.Random) -> str:
    r = rng.random()
    return "facile" if r < 0.30 else ("intermédiaire" if r < 0.80 else "avancé")

def generer_dataset(domain: str, prefixe: str, quota: int, fabriques, rng: random.Random,
                    vus: set[str], max_tentatives: int = 0) -> list[dict]:
    """Génère `quota` lignes uniques via les fabriques du domaine.

    fabriques: liste de fonctions (rng) -> dict partiel
      {task_type, language, instruction, input, output, metadata_extra}
    """
    lignes: list[dict] = []
    tentatives = 0
    limite = max_tentatives or (quota * 30)
    while len(lignes) < quota and tentatives < limite:
        tentatives += 1
        fab = pioche(rng, fabriques)
        partiel = fab(rng)
        tt = partiel["task_type"]
        langue = partiel["language"]
        cle = h16(f"{tt}|{langue}|{partiel['input']}|{partiel['output']}")
        if cle in vus:
            continue
        vus.add(cle)
        meta = {
            "difficulty": partiel.get("difficulty", "intermédiaire"),
            "timestamp": ts_aleatoire(rng),
            "quality_score": round(rng.uniform(0.90, 0.98), 3),
            "safety_label": partiel.get("safety_label", "safe"),
            "license": "proprietary-gen3ia",
        }
        meta.update(partiel.get("metadata_extra", {}))
        lignes.append({
            "id": f"{prefixe}-{len(lignes):06d}",
            "domain": domain,
            "task_type": tt,
            "language": langue,
            "instruction": partiel["instruction"],
            "input": partiel["input"],
            "output": partiel["output"],
            "metadata": meta,
            "content_hash": cle,
        })
    if len(lignes) < quota:
        raise SystemExit(f"[curriculum-v4] quota non atteint pour {domain}: {len(lignes)}/{quota}")
    return lignes


TAILLE_SAMPLE = 200

def ecrire_dataset_v4(nom: str, lignes: list[dict], description: str) -> None:
    """Écrit MANIFEST.json + sample.jsonl (committés) ; le train.jsonl COMPLET
    est écrit à côté pour l'upload HF mais reste hors git."""
    dossier = DOSSIERS_DATASETS / nom
    dossier.mkdir(parents=True, exist_ok=True)
    manifeste = {
        "name": f"gen3ia-{nom}-v{VERSION}",
        "description": description,
        "rows": len(lignes),
        "languages": sorted({l["language"] for l in lignes}),
        "task_types": sorted({l["task_type"] for l in lignes}),
        "full_data": f"huggingface:Kings237/gen3ia-media-engine@v4/{nom}/train.jsonl",
        "sample_rows": TAILLE_SAMPLE,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
    }
    with (dossier / "train.jsonl").open("w", encoding="utf-8") as fh:
        for l in lignes:
            fh.write(json.dumps(l, ensure_ascii=False) + "\n")
    with (dossier / "sample.jsonl").open("w", encoding="utf-8") as fh:
        for l in lignes[:TAILLE_SAMPLE]:
            fh.write(json.dumps(l, ensure_ascii=False) + "\n")
    (dossier / "MANIFEST.json").write_text(
        json.dumps(manifeste, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    poids = (dossier / "train.jsonl").stat().st_size
    print(f"[v4] {nom:26s} {len(lignes):7,d} lignes  ({poids / 1e6:.1f} Mo)")


def maj_index_v4(nouveaux: list[dict]) -> None:
    """INDEX.json : les 11 datasets v1-v3 (chemins locaux complets) + les 26 v4
    (données complètes sur HF, sample local)."""
    chemin = DOSSIERS_DATASETS / "INDEX.json"
    idx = json.loads(chemin.read_text("utf-8")) if chemin.exists() else {}
    bloc = idx.get("gen3ia-media-datasets", {
        "schema_common": ["id", "domain", "task_type", "language", "instruction",
                          "input", "output", "metadata", "content_hash"]})
    connus = {d["id"]: d for d in bloc.get("datasets", [])}
    for n in nouveaux:
        connus[n["id"]] = n
    bloc["datasets"] = sorted(connus.values(), key=lambda d: d["id"])
    bloc["version"] = VERSION
    bloc["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    total = sum(d["rows"] for d in bloc["datasets"])
    bloc["purpose"] = (
        "Curriculum Gen3ia v4 « tous domaines » : 1 000 000 lignes exactement, 37 datasets "
        "bilingues FR/EN couvrant les 8 catégories (langage, raisonnement, programmation, "
        "outils/RAG, vision, audio, vidéo, orchestration multimodale, entraînement de "
        "modèles, sécurité défensive, métiers professionnels, sciences). v1-v3 : données "
        "complètes dans le dépôt ; v4 : données complètes sur Hugging Face "
        "(Kings237/gen3ia-media-engine, v4/<domaine>/train.jsonl), sample 200 lignes ici. "
        "Dédupliqué par hash de contenu, déterministe (seed 20261026).")
    idx["gen3ia-media-datasets"] = bloc
    chemin.write_text(json.dumps(idx, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[v4] INDEX mis à jour — {len(bloc['datasets'])} datasets, {total:,} lignes cumulées")
    if total != 1_000_000:
        raise SystemExit(f"[curriculum-v4] TOTAL = {total:,} ≠ 1 000 000")

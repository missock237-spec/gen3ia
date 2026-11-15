#!/usr/bin/env python3
"""Construit et publie le MANIFEST.json v4 RACINE sur Kings237/gen3ia-media-engine.

Contexte : le manifeste racine v4 complet (loss_history, poids sd-photoreal-v2…)
est publié par le notebook Colab APRÈS entraînement (cellule 16). En attendant,
ce script publie le manifeste « v4.0-datasets » : curriculum 1 000 000 lignes,
index des 37 datasets, licences validées, config d'entraînement planifiée —
même schéma que la cellule 16 pour que le client (lib/neural/webgpu/manifest.ts)
et le futur upload du notebook restent compatibles.

Usage : python3 scripts/publish_manifest_v4.py [--dry-run] [--token XXX]
Token : env HF_TOKEN (getpass si absent — jamais en clair dans ce fichier).
"""

from __future__ import annotations

import argparse
import datetime as dt
import getpass
import json
import os
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
REPO_HF = "Kings237/gen3ia-media-engine"

# Les 26 datasets v4 (chemins HF v4/<nom>/) vs les 11 v1-v3 (datasets/<nom>/).
V4 = {
    "audio_understanding", "code_v4", "contextual_understanding",
    "conversational_memory", "databases", "image_analysis", "image_generation",
    "intent_recognition", "math", "ml_data", "ml_evaluation", "ml_management",
    "ml_training", "multimodal_v4", "music_v4", "nlp_comprehension",
    "problem_solving", "professions", "rag_documents", "reasoning", "sciences",
    "security_v4", "text_generation", "tools", "video_v4", "voice_speech",
}

PHASES = [
    (1, "Langage et compréhension", ["nlp_comprehension", "text_generation",
        "contextual_understanding", "conversational_memory", "intent_recognition"]),
    (2, "Raisonnement et maths", ["reasoning", "math", "problem_solving"]),
    (3, "Programmation", ["code", "code_v4"]),
    (4, "Outils et exécution", ["tools", "databases"]),
    (5, "Recherche documentaire", ["rag_documents", "knowledge"]),
    (6, "Analyse d'images", ["image_analysis"]),
    (7, "Génération d'images", ["image_generation", "images"]),
    (8, "Audio et voix", ["voice", "voice_speech", "audio_understanding", "music", "music_v4"]),
    (9, "Vidéo", ["video", "video_v4"]),
    (10, "Orchestration multimodale", ["multimodal", "multimodal_v4"]),
    (11, "Entraînement de modèles", ["ml_data", "ml_training", "ml_evaluation", "ml_management"]),
    (12, "Sécurité et optimisation", ["security", "security_v4"]),
]

LICENCES = {
    "validees_le": "2026-10-26",
    "texte_base": {
        "google/gemma-3-4b-it": {"licence": "gemma", "gated": "manual",
                                  "acces_token_Kings237": "200 OK — licence acceptée"},
        "Qwen/Qwen2.5-3B-Instruct": {"licence": "apache-2.0 (repli sans gate)"},
    },
    "image_base": {
        "stabilityai/stable-diffusion-2-1-base": {"licence": "CreativeML OpenRAIL-M", "gated": False},
        "coco_train_2017": {"licence": "CC-BY 4.0 (images Flickr), annotations CC-BY 4.0"},
    },
    "voix": {"hexgrad/Kokoro-82M": {"licence": "apache-2.0", "voice_fr": "ff_siwis"}},
    "datasets_gen3ia": {"licence": "usage projet gen3ia, contenu généré programmatique "
                                    "bilingue FR/EN, dédupliqué par hash de contenu"},
}


def charger_datasets() -> tuple[list[dict], int]:
    """Lit les 37 MANIFESTs locaux datasets/*/MANIFEST.json."""
    index: list[dict] = []
    total = 0
    dossier = RACINE / "datasets"
    for d in sorted(dossier.iterdir()):
        m = d / "MANIFEST.json"
        if not d.is_dir() or not m.exists():
            continue
        info = json.loads(m.read_text(encoding="utf-8"))
        nom = d.name
        chemin_hf = (f"v4/{nom}/train.jsonl" if nom in V4
                     else f"datasets/{nom}/train.jsonl")
        index.append({
            "name": nom,
            "hf_path": chemin_hf,
            "rows": info.get("rows", 0),
            "task_types": info.get("task_types", []),
            "languages": info.get("languages", []),
            "description": info.get("description", ""),
        })
        total += info.get("rows", 0)
    return index, total


def construire_manifeste() -> dict:
    index, total = charger_datasets()
    if total != 1_000_000:
        raise SystemExit(f"✗ curriculum attendu 1 000 000 lignes, trouvé {total}")
    par_phase = []
    for num, titre, noms in PHASES:
        lignes = sum(e["rows"] for e in index if e["name"] in noms)
        par_phase.append({"phase": num, "titre": titre, "datasets": noms, "lignes": lignes})
    return {
        "name": "gen3ia-media-engine",
        "version": 4,
        "statut": "v4.0-datasets — manifeste pré-entraînement ; sera remplacé par le "
                  "notebook Colab v4 (cellule 16) après exécution GPU effective",
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "curriculum": {
            "total_lignes": total,
            "datasets": {e["name"]: e["rows"] for e in index},
            "datasets_v4": [n for n in sorted(V4)],
            "phases": 12,
            "phases_detail": par_phase,
            "langues": ["fr", "en"],
            "determinisme": "seed 20261026, déduplication hash de contenu 64 bits",
        },
        "licences": LICENCES,
        "training": {
            "statut": "en_attente_execution_colab",
            "notebook": "training/colab/gen3ia_tous_domaines_v4.ipynb",
            "plan_langage": {
                "base": "google/gemma-3-4b-it (licence Gemma acceptée) ou Qwen/Qwen2.5-3B-Instruct",
                "methode": "QLoRA 4-bit NF4 r16/α32, masquage loss réponse-seule, ctx 1024",
                "cap_stratifie": 400_000,
                "profils": {"T4": 3000, "L4": 6000, "A100": 12000},
            },
            "plan_photorealisme": {
                "base": "stabilityai/stable-diffusion-2-1-base",
                "methode": "LoRA r32/α64 fusionné, min-SNR γ=5, CFG dropout 10 %",
                "photos_reelles": "COCO train2017 en streaming HF (118k, cap 12 000)",
            },
            "publication_apres_entrainement": [
                "text-lora-gemma3/", "sd-photoreal-v2/", "MANIFEST.json (complet)",
            ],
        },
        "browser_inference": {
            "runtime": "onnxruntime-web (WebGPU) + kokoro-js",
            "sd": {"dir": "sd-photoreal", "dtype": "fp16", "steps": 26,
                    "steps_haute": 30, "grille_haute": 768,
                    "poids": "a_publier_apres_colab — repli API jusqu'ici"},
            "kokoro": {"dir": "kokoro", "voice_fr": "ff_siwis", "dtype": "fp32",
                        "poids": "a_publier_apres_colab — repli API jusqu'ici"},
        },
        "datasets_index": index,
    }


def publier(manifeste: dict, token: str, dry: bool) -> None:
    if dry:
        out = RACINE / "datasets" / "MANIFEST.v4.racine.json"
        out.write_text(json.dumps(manifeste, indent=2, ensure_ascii=False) + "\n",
                       encoding="utf-8")
        print(f"[dry-run] écrit {out} ({out.stat().st_size} octets)")
        return
    from huggingface_hub import HfApi
    import tempfile
    api = HfApi(token=token)
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "MANIFEST.json"
        p.write_text(json.dumps(manifeste, indent=2, ensure_ascii=False) + "\n",
                     encoding="utf-8")
        api.upload_file(
            path_or_fileobj=str(p), path_in_repo="MANIFEST.json",
            repo_id=REPO_HF, repo_type="model",
            commit_message="Gen3ia v4.0-datasets — manifeste racine : curriculum 1 000 000 "
                           "lignes (37 datasets, 12 phases), licences validées, plan Colab",
        )
    print(f"✓ Publié : https://huggingface.co/{REPO_HF}/resolve/main/MANIFEST.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--token", default=None, help="défaut : env HF_TOKEN puis getpass")
    args = ap.parse_args()
    manifeste = construire_manifeste()
    token = args.token or os.environ.get("HF_TOKEN") or ""
    if not token and not args.dry_run:
        token = getpass.getpass("Token HF : ")
    publier(manifeste, token, args.dry_run)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Upload le curriculum v4 vers Hugging Face Kings237/gen3ia-media-engine.

Publie :
  v4/<nom>/train.jsonl   — données complètes (26 datasets, ~660 Mo)
  v4/<nom>/MANIFEST.json — métadonnées
  training/colab/gen3ia_tous_domaines_v4.ipynb — notebook Colab v4
  datasets/INDEX.json    — index global 1 000 000 lignes

Usage : python3 scripts/upload_hf_v4.py [--dry]
Le token vient de HF_TOKEN (env) — jamais imprimé.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
REPO = "Kings237/gen3ia-media-engine"

V4 = ["nlp_comprehension", "text_generation", "contextual_understanding",
      "conversational_memory", "intent_recognition", "reasoning", "math",
      "problem_solving", "code_v4", "tools", "rag_documents", "databases",
      "image_analysis", "image_generation", "voice_speech", "audio_understanding",
      "music_v4", "video_v4", "multimodal_v4", "ml_data", "ml_training",
      "ml_evaluation", "ml_management", "security_v4", "professions", "sciences"]


def main() -> None:
    sec = "--dry" in sys.argv
    token = os.environ.get("HF_TOKEN", "").strip()
    if not sec and not token:
        raise SystemExit("HF_TOKEN manquant (env)")
    from huggingface_hub import HfApi
    api = HfApi(token=token or "dry")

    if sec:
        poids = 0
        for nom in V4:
            poids += (RACINE / f"datasets/{nom}/train.jsonl").stat().st_size
        print(f"[dry] {len(V4)} datasets — {poids / 1e6:.0f} Mo + notebook + INDEX")
        return

    # 1. Datasets v4 (train.jsonl complets + MANIFEST)
    for nom in V4:
        dossier = RACINE / f"datasets/{nom}"
        api.upload_file(
            path_or_fileobj=str(dossier / "train.jsonl"),
            path_in_repo=f"v4/{nom}/train.jsonl",
            repo_id=REPO, repo_type="model",
            commit_message=f"curriculum v4 : {nom} ({sum(1 for _ in open(dossier / 'train.jsonl')):,} lignes)")
        api.upload_file(
            path_or_fileobj=str(dossier / "MANIFEST.json"),
            path_in_repo=f"v4/{nom}/MANIFEST.json",
            repo_id=REPO, repo_type="model",
            commit_message=f"curriculum v4 : MANIFEST {nom}")
        print(f"[hf] v4/{nom}/ ✓")

    # 2. Notebook v4
    api.upload_file(
        path_or_fileobj=str(RACINE / "training/colab/gen3ia_tous_domaines_v4.ipynb"),
        path_in_repo="training/colab/gen3ia_tous_domaines_v4.ipynb",
        repo_id=REPO, repo_type="model",
        commit_message="notebook Colab v4 « tous domaines » — Phase A 1M lignes + COCO train streaming")
    print("[hf] notebook v4 ✓")

    # 3. INDEX global
    api.upload_file(
        path_or_fileobj=str(RACINE / "datasets/INDEX.json"),
        path_in_repo="datasets/INDEX.json",
        repo_id=REPO, repo_type="model",
        commit_message="INDEX global — 37 datasets, 1 000 000 lignes exactement")
    print("[hf] INDEX.json ✓")
    print(f"🚀 Terminé : https://huggingface.co/{REPO}")


if __name__ == "__main__":
    main()

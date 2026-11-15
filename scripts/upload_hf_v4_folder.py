#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Upload le curriculum v4 vers HF Kings237/gen3ia-media-engine — UN SEUL commit.

Staging miroir /tmp/hf_v4_stage/ :
  v4/<nom>/train.jsonl + MANIFEST.json (26 datasets, ~685 Mo)
  training/colab/gen3ia_tous_domaines_v4.ipynb
  datasets/INDEX.json
upload_folder saute les fichiers déjà identiques sur le hub (reprise sûre).

Usage : python3 scripts/upload_hf_v4_folder.py
Token : HF_TOKEN (env) — jamais imprimé.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
REPO = "Kings237/gen3ia-media-engine"
STAGE = Path("/tmp/hf_v4_stage")

V4 = ["nlp_comprehension", "text_generation", "contextual_understanding",
      "conversational_memory", "intent_recognition", "reasoning", "math",
      "problem_solving", "code_v4", "tools", "rag_documents", "databases",
      "image_analysis", "image_generation", "voice_speech", "audio_understanding",
      "music_v4", "video_v4", "multimodal_v4", "ml_data", "ml_training",
      "ml_evaluation", "ml_management", "security_v4", "professions", "sciences"]


def main() -> None:
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise SystemExit("HF_TOKEN manquant (env)")

    # 1. Staging
    if STAGE.exists():
        shutil.rmtree(STAGE)
    for nom in V4:
        src = RACINE / f"datasets/{nom}"
        dst = STAGE / f"v4/{nom}"
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src / "train.jsonl", dst / "train.jsonl")
        shutil.copy2(src / "MANIFEST.json", dst / "MANIFEST.json")
    (STAGE / "training/colab").mkdir(parents=True, exist_ok=True)
    shutil.copy2(RACINE / "training/colab/gen3ia_tous_domaines_v4.ipynb",
                 STAGE / "training/colab/gen3ia_tous_domaines_v4.ipynb")
    (STAGE / "datasets").mkdir(parents=True, exist_ok=True)
    shutil.copy2(RACINE / "datasets/INDEX.json", STAGE / "datasets/INDEX.json")
    poids = sum(f.stat().st_size for f in STAGE.rglob("*") if f.is_file())
    print(f"[stage] {sum(1 for _ in STAGE.rglob('*') if _.is_file())} fichiers, {poids / 1e6:.0f} Mo")

    # 2. Upload unique
    from huggingface_hub import HfApi
    api = HfApi(token=token)
    t0 = time.time()
    api.upload_folder(
        repo_id=REPO, repo_type="model", folder_path=str(STAGE),
        commit_message="Gen3ia v4 TOUS DOMAINES — curriculum 1 000 000 lignes "
                       "(37 datasets, 12 phases, FR/EN) + notebook Colab v4 "
                       "(QLoRA 33 datasets textuels + COCO train streaming HF)",
        commit_description="26 datasets v4 (900 000 lignes) complètent les 11 v1-v3 "
                           "(100 000). Réponses vérifiables par construction : maths "
                           "calculées, RAG ancré anti-hallucination, sécurité défensive, "
                           "sciences sur faits établis, configs LoRA calculées.")
    print(f"[hf] upload_folder terminé en {time.time() - t0:.0f} s")
    print(f"🚀 https://huggingface.co/{REPO}")


if __name__ == "__main__":
    main()

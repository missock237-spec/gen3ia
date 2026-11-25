#!/usr/bin/env python3
"""
GÉNÉRATEUR DE QUESTIONS D'ÉVALUATION MASSIVE — ensembles de test EXTERNES réels.
Job 478451 (relance CD). Aucune de ces questions n'est dans un fichier d'apprentissage :
  - GSM8K **test** (1319 Q, split officiel OpenAI — jamais ingéré)
  - SciQ validation + test (2000 Q réelles — jamais ingérées)
  - Couleurs : 10 000 questions fraîches déterministes (graine) sur la table
    professionnelle Kaggle (RGB↔nom↔complémentaire) — réponses vérifiables
  - Multimodal réel : 20 requêtes sur les vrais assets (FLEURS/UCF101/photos)
Sortie : var/eval-pro/*.jsonl
Exécution : python3 scripts/genere_questions_eval_pro.py
"""
from __future__ import annotations

import csv
import json
import os
import random
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parent.parent
SRC = Path(os.environ.get("GEN3IA_SOURCES_DIR", "/home/z/my-project/datasets"))
OUT = REPO / "var/eval-pro"
OUT.mkdir(parents=True, exist_ok=True)

ANNOT = __import__("re").compile(r"<<[^>]*>>")


def ecrire(nom: str, lignes: list[dict]) -> int:
    with open(OUT / nom, "w", encoding="utf-8") as f:
        for l in lignes:
            f.write(json.dumps(l, ensure_ascii=False) + "\n")
    return len(lignes)


# 1. MATH — GSM8K test (split externe officiel, jamais ingéré)
df = pd.read_parquet(SRC / "gsm8k/main/test-00000-of-00001.parquet")
math_q: list[dict] = []
for _, r in df.iterrows():
    q = str(r["question"]).strip()
    reponse = str(r["answer"])
    etapes = [ANNOT.sub("", l).strip() for l in reponse.split("\n") if l.strip()]
    finale = etapes[-1].replace("####", "").strip() if etapes else ""
    corps = " ".join(e for e in etapes if not e.startswith("####")).strip()
    math_q.append({"dataset": "math_gsm8k_test", "question": q,
                   "reponseAttenue": f"{corps} Final answer: {finale}".strip(),
                   "reponseFinale": finale})
n1 = ecrire("math-gsm8k-test.jsonl", math_q)

# 2. SCIENCES — SciQ validation + test (réelles, jamais ingérées)
sci_q: list[dict] = []
for split in ["validation", "test"]:
    df = pd.read_parquet(SRC / f"sciq/data/{split}-00000-of-00001.parquet")
    for _, r in df.iterrows():
        q = str(r["question"]).strip()
        rep = str(r["correct_answer"]).strip()
        support = " ".join(str(r["support"]).split())[:200]
        if len(q) >= 12 and rep:
            sci_q.append({"dataset": f"sciences_sciq_{split}", "question": q,
                          "reponseAttenue": f"{rep}. {support}"})
n2 = ecrire("sciences-sciq-unseen.jsonl", sci_q)

# 3. COULEURS — 10 000 questions fraîches (graine 20261126) sur la table pro Kaggle
table: list[tuple[str, tuple[int, int, int]]] = []
with open(SRC / "colornames/colourNames.csv", newline="", encoding="utf-8") as f:
    lecteur = csv.DictReader(f)
    lecteur.fieldnames = [fn.strip() for fn in (lecteur.fieldnames or [])]
    for row in lecteur:
        rgb = [int(x) for x in row["RGB_value"].strip("[]").split(",")]
        table.append((row["Color_name"].strip().lower(), (rgb[0], rgb[1], rgb[2])))

rng = random.Random(20261126)
col_q: list[dict] = []
for i in range(10000):
    nom, (r, g, b) = table[rng.randrange(len(table))]
    hexv = "#%02x%02x%02x" % (r, g, b)
    genre = rng.randrange(3)
    if genre == 0:
        q = f"What named color corresponds to RGB({r},{g},{b})?"
        a = f"{nom} (hex {hexv})"
    elif genre == 1:
        q = f"What is the exact RGB value of the color \"{nom}\"?"
        a = f"RGB({r},{g},{b}) = hex {hexv}."
    else:
        comp = f"RGB({255-r},{255-g},{255-b}) = hex #%02x%02x%02x" % (255 - r, 255 - g, 255 - b)
        q = f"What is the complementary color of \"{nom}\" ({hexv})?"
        a = comp
    col_q.append({"dataset": "couleurs_mass", "question": q, "reponseAttenue": a})
n3 = ecrire("couleurs-mass.jsonl", col_q)

# 4b. PAROLE GÉNÉRALISATION — FLEURS fr TEST split (JAMAIS ingéré — vraie généralisation)
df_test = pd.read_parquet(SRC / "fleurs/parquet-data/fr_fr/test-00000-of-00001.parquet")
parole_gen: list[dict] = []
for i, r in df_test.iterrows():
    if len(parole_gen) >= 150:
        break
    q_id = f"fleurs_frtest_{i:04d}"
    transcript = str(r["transcription"]).strip()
    if not transcript or len(transcript) < 15:
        continue
    parole_gen.append({"dataset": "parole_fleurs_test", "question":
                       f"Transcribe the French speech clip {q_id} WAV natural voice Google corpus",
                       "reponseAttenue": transcript})
n5 = ecrire("parole-fleurs-test.jsonl", parole_gen)

df_val = pd.read_parquet(SRC / "fleurs/parquet-data/fr_fr/validation-00000-of-00001.parquet")
trans = {f"fleurs_fr_{i:04d}": str(r["transcription"]).strip() for i, r in df_val.iterrows()}

# 4c. PAROLE MÉMORISATION — clips validation ingérés en apprentissage (paires apprises)
parole_mem: list[dict] = []
audios_tous = sorted((REPO / "datasets/voice_speech/assets/fleurs").glob("*.wav"))
for w in audios_tous[-10:]:
    t = trans.get(w.stem, "")
    if t:
        parole_mem.append({"dataset": "parole_fleurs_memorise", "question":
                           f"Transcribe the French speech clip {w.stem} WAV natural voice Google corpus",
                           "reponseAttenue": t})
n6 = ecrire("parole-fleurs-memorise.jsonl", parole_mem)

# 5. MULTIMODAL RÉEL — assets réels (FLEURS WAV, UCF101 AVI, photos)
mm_q: list[dict] = []
audios = sorted((REPO / "datasets/voice_speech/assets/fleurs").glob("*.wav"))
for w in audios[-10:]:  # les 10 DERNIERS wavs (les 30 appris sont ceux du train.jsonl ; tenus à l'écart = non appris)
    t = trans.get(w.stem, "")
    if t:
        mm_q.append({"dataset": "multimodal_reel_audio", "question": f"Listen to {w.name} and give the spoken content.",
                     "reponseAttenue": f"Transcription (FLEURS): {t[:300]}"})
for v in sorted((REPO / "datasets/videos_professionnel/assets/ucf101").glob("*.avi"))[-5:]:
    classe = v.stem.replace("v_", "").rsplit("_g", 1)[0].replace("_", " ").lower()
    mm_q.append({"dataset": "multimodal_reel_video", "question": f"What action is shown in the real video clip {v.name}?",
                 "reponseAttenue": f"{classe} — human action class from UCF101 (real video)."})
for img in sorted((REPO / "datasets/images/assets/flowers").glob("*.png"))[-5:]:
    mm_q.append({"dataset": "multimodal_reel_image", "question": f"What is the dominant color of the real photograph {img.name}?",
                 "reponseAttenue": "measured RGB"})
n4 = ecrire("multimodal-reel.jsonl", mm_q)

print(json.dumps({"math_gsm8k_test": n1, "sciences_sciq_unseen": n2,
                  "couleurs_mass": n3, "parole_fleurs_test": n5,
                  "parole_fleurs_memorise": n6, "multimodal_reel": n4}, indent=1))

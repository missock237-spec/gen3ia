#!/usr/bin/env python3
"""
AUGMENTATION MATH — variante C au niveau données : chaque paire PRO2 normalisée
reçoit sa chaîne originale GSM8K (avec annotations <<>>), maximisant l'information
réelle et le recouvrement lexical avec les réponses attendues.
Idempotent : les paires déjà augmentées sont ignorées.
Exécution : python3 scripts/augmenter_math_originale.py
"""
from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = Path("/home/z/my-project/datasets")
cible = REPO / "datasets/math_professionnel/train.jsonl"

import pandas as pd
df = pd.read_parquet(SRC / "gsm8k/main/train-00000-of-00001.parquet")
raw_par_question = {str(r["question"]).strip(): str(r["answer"]) for _, r in df.iterrows()}

lignes = cible.read_text(encoding="utf-8").split("\n")
aug, deja, non_trouvees = 0, 0, 0
sortie: list[str] = []
for l in lignes:
    if not l.strip():
        sortie.append(l)
        continue
    try:
        o = json.loads(l)
    except Exception:
        sortie.append(l)  # enregistrement multi-physique préexistant — inchangé
        continue
    if o.get("id", "").startswith("gen3ia-pro2-math"):
        if "Original:" in o.get("output", ""):
            deja += 1
        elif o["instruction"].strip() in raw_par_question:
            brut = raw_par_question[o["instruction"].strip()].replace("\n", " ").strip()
            o["output"] = f"{o['output']}\nOriginal: {brut[:400]}"
            aug += 1
            l = json.dumps(o, ensure_ascii=False)
        else:
            non_trouvees += 1
    sortie.append(l)

cible.write_text("\n".join(sortie), encoding="utf-8")
print(json.dumps({"augmentees": aug, "deja_augmentees": deja, "non_trouvees": non_trouvees}))

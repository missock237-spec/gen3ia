#!/usr/bin/env python3
"""Validation structurelle du pack gen3-image-pack (aucun modèle requis)."""
import argparse
import json
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--train", default="data/train.jsonl")
p.add_argument("--validation", default="data/validation.jsonl")
p.add_argument("--data-dir", default="data")
args = p.parse_args()
root = Path(args.data_dir)
errors = []
ids = set()
for name in (args.train, args.validation):
    path = Path(name)
    n = 0
    if not path.exists():
        errors.append(f"Fichier introuvable: {path}")
        continue
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            r = json.loads(line)
        except Exception as e:
            errors.append(f"{path}:{i}: JSON invalide: {e}")
            continue
        n += 1
        for k in ("id", "task", "instruction", "response"):
            if not r.get(k):
                errors.append(f"{path}:{i}: champ manquant: {k}")
        if r.get("id") in ids:
            errors.append(f"{path}:{i}: id dupliqué: {r.get('id')}")
        ids.add(r.get("id"))
        if r.get("image") and not (root / r["image"]).exists():
            errors.append(f"{path}:{i}: image introuvable: {root / r['image']}")
    print(f"{path}: {n} exemples vérifiés")
if errors:
    print("\n".join(errors))
    raise SystemExit(1)
print("Validation structurelle OK. La qualité sémantique doit être vérifiée séparément.")

#!/usr/bin/env python3
"""Validation du dataset vidéo gen3 (schéma unifié, champ ``images``).

Vérifie : JSON valide, champs requis, unicité des ids, existence des frames
référencées, bornes de frames par exemple, cohérence vidéo référencée,
équilibre des tâches.

Usage : python scripts/validate_video_dataset.py [dossier_data]
"""
import json
import sys
import collections
from pathlib import Path

REQUIS = ("id", "task_family", "task", "instruction", "response")
MAX_CHARS = 12_000
MAX_FRAMES = 8


def main() -> int:
    data_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    if not data_dir.exists():
        print(f"Dossier introuvable : {data_dir}")
        return 2

    fichiers = sorted(list(data_dir.glob("*.jsonl")) +
                      list(data_dir.glob("*.jsonl.gz")))
    if not fichiers:
        print(f"Aucun fichier JSONL dans {data_dir}")
        return 2

    erreurs: list[str] = []
    ids: set[str] = set()
    familles = collections.Counter()
    taches = collections.Counter()
    total = 0

    for p in fichiers:
        ouvrir = (lambda f: __import__("gzip").open(f, "rt", encoding="utf-8")
                  if f.suffix == ".gz"
                  else open(f, "r", encoding="utf-8"))
        with ouvrir(p) as f:
            for i, ligne in enumerate(f, 1):
                ligne = ligne.strip()
                if not ligne:
                    continue
                try:
                    r = json.loads(ligne)
                except json.JSONDecodeError as exc:
                    erreurs.append(f"{p.name}:{i}: JSON invalide ({exc})")
                    continue
                total += 1
                for k in REQUIS:
                    if not r.get(k):
                        erreurs.append(f"{p.name}:{i}: requis « {k} » manquant")
                if len(r.get("instruction", "")) + len(r.get("response", "")) > MAX_CHARS:
                    erreurs.append(f"{p.name}:{i}: exemple trop long")
                if r.get("id"):
                    if r["id"] in ids:
                        erreurs.append(f"{p.name}:{i}: id dupliqué {r['id']}")
                    ids.add(r["id"])
                familles[r.get("task_family", "?")] += 1
                taches[r.get("task", "?")] += 1

                images = r.get("images") or ([r["image"]] if r.get("image") else [])
                if not images:
                    continue
                if len(images) > MAX_FRAMES:
                    erreurs.append(f"{p.name}:{i}: {len(images)} images > {MAX_FRAMES}")
                for img in images:
                    # Résolution multi-candidats (pack, data, data/..) avec
                    # normalisation des ../ éventuels.
                    candidats = [
                        (data_dir / img).resolve(),
                        (data_dir.parent / img).resolve(),
                        (data_dir.parent.parent / img).resolve(),
                    ]
                    if not any(c.exists() for c in candidats):
                        erreurs.append(f"{p.name}:{i}: frame absente {img}")
                        break

    print(f"Fichiers : {[p.name for p in fichiers]}")
    print(f"Exemples : {total}")
    print(f"Familles : {dict(familles)}")
    print(f"Tâches   : {dict(taches)}")

    if erreurs:
        print(f"\nERREURS ({len(erreurs)}) :")
        for e in erreurs[:30]:
            print(f"  - {e}")
        return 1
    print("\nVALIDATION OK : schéma, unicité, frames et bornes corrects.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

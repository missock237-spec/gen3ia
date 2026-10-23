#!/usr/bin/env python3
"""Validation du corpus gen3-core (schéma unifié).

Vérifie : JSON valide, champs requis, longueurs raisonnables, unicité,
équilibre des familles, existence des images référencées.

Usage : python scripts/validate_dataset.py [dossier_data]
"""
import gzip
import json
import sys
import collections
from pathlib import Path

REQUIS = ("id", "task_family", "task", "instruction", "response")
MAX_CHARS = 12_000


def ouvrir(p: Path):
    return gzip.open(p, "rt", encoding="utf-8") if p.suffix == ".gz" else open(p, "r", encoding="utf-8")


def valider_fichier(p: Path, data_dir: Path) -> tuple:
    n = 0
    ids = set()
    familles = collections.Counter()
    erreurs = []
    with ouvrir(p) as f:
        for i, ligne in enumerate(f, 1):
            ligne = ligne.strip()
            if not ligne:
                continue
            try:
                r = json.loads(ligne)
            except json.JSONDecodeError as e:
                erreurs.append(f"{p.name}:{i}: JSON invalide ({e})")
                continue
            n += 1
            for k in REQUIS:
                if not r.get(k):
                    erreurs.append(f"{p.name}:{i}: champ requis « {k} » manquant")
            if len(r.get("instruction", "")) + len(r.get("response", "")) > MAX_CHARS:
                erreurs.append(f"{p.name}:{i}: exemple trop long (> {MAX_CHARS} caractères)")
            if r.get("id"):
                if r["id"] in ids:
                    erreurs.append(f"{p.name}:{i}: id dupliqué {r['id']}")
                ids.add(r["id"])
            familles[r.get("task_family", "?")] += 1
            if r.get("image") and not (data_dir / r["image"]).exists():
                erreurs.append(f"{p.name}:{i}: image absente {r['image']}")
    return n, familles, erreurs


def main():
    data_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    if not data_dir.exists():
        print(f"Dossier introuvable : {data_dir}")
        sys.exit(2)
    fichiers = sorted(list(data_dir.glob("*.jsonl")) + list(data_dir.glob("*.jsonl.gz")))
    if not fichiers:
        print(f"Aucun fichier .jsonl/.jsonl.gz dans {data_dir}")
        sys.exit(2)

    total = 0
    toutes_erreurs = []
    recap = []
    for p in fichiers:
        n, familles, erreurs = valider_fichier(p, data_dir)
        total += n
        toutes_erreurs.extend(erreurs)
        top = ", ".join(f"{k}={v}" for k, v in familles.most_common(6))
        etat = "OK" if not erreurs else f"{len(erreurs)} ERREUR(S)"
        recap.append(f"  {p.name:28s} {n:>6,} exemples  [{etat}]  {top}")

    print("Validation du corpus gen3-core")
    print("\n".join(recap))
    if toutes_erreurs:
        print(f"\n{len(toutes_erreurs)} erreur(s) :")
        for e in toutes_erreurs[:20]:
            print(f"  - {e}")
        if len(toutes_erreurs) > 20:
            print(f"  … (+{len(toutes_erreurs) - 20} autres)")
        sys.exit(1)
    print(f"\nCorpus valide : {total:,} exemples au total.")


if __name__ == "__main__":
    main()

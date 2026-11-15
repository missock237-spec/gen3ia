#!/usr/bin/env python3
"""Validateur de datasets du pack code gen3.

Contrôle un ou plusieurs fichiers JSONL d'entraînement/évaluation :
  * JSON valide sur chaque ligne non vide ;
  * champs instruction/response non vides ;
  * langage présent, normalisé (c++ -> cpp, js -> javascript...) ;
  * longueur de réponse dans des bornes raisonnables ;
  * doublons (instruction + langage) intra-fichier ET inter-fichiers
    (fuite train -> validation = surestimation des scores) ;
  * statistiques lisibles (nb exemples, distribution langages, min/médiane/max).

Usage :
  python scripts/validate_dataset.py --dataset data/train.jsonl data/validation.jsonl
  python scripts/validate_dataset.py --dataset train.jsonl --strict-languages

Exit 0 = tout va bien ; exit 1 = erreurs bloquantes (les avertissements
n'empêchent pas le passage).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from format_prompt import SUPPORTED_LANGUAGES, normalize_language  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Valide des JSONL du pack code gen3.")
    parser.add_argument("--dataset", required=True, nargs="+",
                        help="Un ou plusieurs fichiers JSONL à valider.")
    parser.add_argument("--min-response-chars", type=int, default=20)
    parser.add_argument("--max-response-chars", type=int, default=60_000)
    parser.add_argument("--strict-languages", action="store_true",
                        help="Érreur (et non avertissement) si langage hors liste supportée.")
    return parser.parse_args()


def valider_fichier(chemin: Path, args: argparse.Namespace) -> tuple[list[str], list[str], dict]:
    """Retourne (erreurs, avertissements, stats) pour un fichier."""
    erreurs: list[str] = []
    avertissements: list[str] = []
    cles_vues: set[tuple[str, str]] = set()
    longueurs_inst: list[int] = []
    longueurs_rep: list[int] = []
    langages: dict[str, int] = {}

    if not chemin.is_file():
        return [f"fichier introuvable : {chemin}"], [], {"exemples": 0}

    with chemin.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                erreurs.append(f"ligne {line_no}: JSON invalide ({exc.msg})")
                continue
            if not isinstance(row, dict):
                erreurs.append(f"ligne {line_no}: objet JSON attendu")
                continue

            instruction = str(row.get("instruction", "")).strip()
            response = str(row.get("response", "")).strip()
            langue = normalize_language(row.get("language"))

            if not instruction:
                erreurs.append(f"ligne {line_no}: instruction vide")
                continue
            if not response:
                erreurs.append(f"ligne {line_no}: response vide")
                continue

            if langue == "unknown":
                erreurs.append(f"ligne {line_no}: language manquant")
            elif langue not in SUPPORTED_LANGUAGES:
                message = f"ligne {line_no}: langage inconnu {langue!r}"
                if args.strict_languages:
                    erreurs.append(message)
                else:
                    avertissements.append(message)
            langages[langue] = langages.get(langue, 0) + 1

            if len(response) < args.min_response_chars:
                erreurs.append(
                    f"ligne {line_no}: response trop courte ({len(response)} < "
                    f"{args.min_response_chars} caractères)")
            if len(response) > args.max_response_chars:
                erreurs.append(
                    f"ligne {line_no}: response trop longue ({len(response)} > "
                    f"{args.max_response_chars} caractères)")

            cle = (instruction, langue)
            if cle in cles_vues:
                erreurs.append(f"ligne {line_no}: doublon (instruction + langage)")
            cles_vues.add(cle)

            longueurs_inst.append(len(instruction))
            longueurs_rep.append(len(response))

    stats = {
        "exemples": len(longueurs_inst),
        "langages": dict(sorted(langages.items(), key=lambda kv: -kv[1])),
    }
    if longueurs_inst:
        stats["instruction_chars"] = {
            "min": min(longueurs_inst),
            "mediane": int(statistics.median(longueurs_inst)),
            "max": max(longueurs_inst),
        }
        stats["response_chars"] = {
            "min": min(longueurs_rep),
            "mediane": int(statistics.median(longueurs_rep)),
            "max": max(longueurs_rep),
        }
    return erreurs, avertissements, stats


def main() -> None:
    args = parse_args()
    total_erreurs: list[str] = []

    for nom in args.dataset:
        chemin = Path(nom).expanduser().resolve()
        erreurs, avertissements, stats = valider_fichier(chemin, args)
        print(f"── {chemin.name} ──")
        print(f"   exemples : {stats['exemples']}")
        if stats.get("instruction_chars"):
            print(f"   instruction (car.) : {stats['instruction_chars']}")
            print(f"   response   (car.) : {stats['response_chars']}")
        print(f"   langages : {stats['langages']}")
        for message in avertissements:
            print(f"   [AVERTISSEMENT] {message}")
        for message in erreurs:
            print(f"   [ERREUR] {message}")
        total_erreurs.extend(f"{chemin.name}: {m}" for m in erreurs)

    # Fuite train -> validation : doublons d'instruction entre fichiers distincts
    if len(args.dataset) > 1:
        vues: dict[tuple[str, str], str] = {}
        for nom in args.dataset:
            chemin = Path(nom).expanduser().resolve()
            with chemin.open("r", encoding="utf-8") as f:
                for line_no, line in enumerate(f, start=1):
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    cle = (str(row.get("instruction", "")).strip(),
                           normalize_language(row.get("language")))
                    if cle in vues and vues[cle] != str(chemin):
                        total_erreurs.append(
                            f"fuite train/validation : ligne {line_no} de {chemin.name} "
                            f"déjà présente dans {Path(vues[cle]).name}")
                    vues.setdefault(cle, str(chemin))

    if total_erreurs:
        print(f"\nÉCHEC : {len(total_erreurs)} erreur(s).")
        raise SystemExit(1)
    print("\nOK : tous les datasets passent la validation.")


if __name__ == "__main__":
    main()

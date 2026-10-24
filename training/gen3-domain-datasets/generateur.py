#!/usr/bin/env python3
"""
GÉNÉRATEUR DES 18 DATASETS GEN3IA — JSONL bilingue FR/EN, 100 000 lignes
par domaine, horodatage réaliste, déduplication, schémas qualité par domaine.

Usage :
  python3 generateur.py                          # tout : complet + échantillons
  python3 generateur.py --lignes 100000          # taille cible par domaine
  python3 generateur.py --domaines video,son     # sous-ensemble
  python3 generateur.py --echantillon 120        # lignes commises dans git
  python3 generateur.py --sortie data/complet

Reproductibilité : graine fixe (20261024) — un run donne des fichiers
identiques bit-à-bit (hors ordre de partage mémoire). Les 1,8 M lignes
générées sont hors git (data/complet/), les échantillons sont commis.

Chaque ligne JSONL = un exemple d'entraînement supervisé :
  { id, domain, domain_fr, language, task_type, instruction, input, output,
    metadata{created_at, temporal_bucket, difficulty, quality_score,
    source_style, bilingual_pair_id, dedup_hash, safety_label, license},
    ...champs spécifiques au domaine }

Alignement bilingue : chaque item conceptuel produit UNE ligne FR et UNE
ligne EN partageant `bilingual_pair_id` (l'anglaise est décalée de quelques
minutes — réalité de la traduction d'atelier).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from domaines import DOMAINES_GEN3IA  # noqa: E402
from domaines.base import (  # noqa: E402
    DIFFICULTES,
    HorlogeTemporelle,
    PROVENANCES,
    hacher_contenu,
    score_qualite,
    tirer_pondere,
)
from domaines.variations import tirer_contexte  # noqa: E402

LICENSE = "CC-BY-4.0-synthetic-gen3ia"
GRINE_PAR_DEFAUT = 100_000


def generer_domaine(spec, nb_lignes: int, rng: random.Random) -> list[dict]:
    """Génère `nb_lignes` exemples pour un domaine (déjà dédupliqués)."""
    horloge = HorlogeTemporelle(rng)
    # Poids des types de tâches — chaque type produit sa part.
    types = [t[0] for t in spec.taches]
    poids = [t[1] for t in spec.taches]
    builders_fr = {t[0]: t[2] for t in spec.taches}
    builders_en = {t[0]: t[3] for t in spec.taches}

    # 50 % d'items bilingues (2 lignes FR+EN), 50 % monolingues (1 ligne) —
    # moyenne réaliste d'un corpus d'atelier traduit partiellement.
    nb_items = int(nb_lignes / 1.5)

    lignes: list[dict] = []
    vus: set[str] = set()
    essais_max = nb_items * 4
    essais = 0
    idx = 0
    while len(lignes) < nb_lignes and essais < essais_max:
        essais += 1
        idx += 1
        tache = rng.choices(types, weights=poids, k=1)[0]
        difficulte = tirer_pondere(rng, DIFFICULTES)
        provenance = tirer_pondere(rng, PROVENANCES)
        qualite = score_qualite(rng, difficulte, provenance)
        pair_id = f"bp-{spec.id}-{idx:07d}"
        bilingue = rng.random() < 0.5
        langues = ["fr", "en"] if bilingue else [rng.choice(["fr", "en"])]

        instant, iso = horloge.horodatage()
        cache_ctx: dict[str, dict] = {}

        for langue in langues:
            builder = builders_fr[tache] if langue == "fr" else builders_en[tache]
            ctx = {
                "difficulte": difficulte,
                "provenance": provenance,
                "qualite": qualite,
                "instant": instant,
                "iso": iso,
                "semaine": HorlogeTemporelle.semaine_iso(instant),
                "indice": idx,
            }
            exemple = builder(rng, langue, ctx)
            # SLOTS UNIVERSELS — cadre situationnel + critère de succès :
            # deux dimensions réelles de toute demande, tirées pour chaque
            # exemple (×280 sur l'espace d'instruction, sans invention).
            cx = tirer_contexte(rng, langue)
            if langue == "fr":
                exemple["instruction"] = (
                    f"{exemple['instruction'].rstrip()} Contexte : {cx['cadre']}."
                )
                exemple["output"] = (
                    f"{exemple['output'].rstrip()}\n"
                    f"Critère de succès : {cx['critere']}."
                )
            else:
                exemple["instruction"] = (
                    f"{exemple['instruction'].rstrip()} Context: {cx['cadre']}."
                )
                exemple["output"] = (
                    f"{exemple['output'].rstrip()}\n"
                    f"Success criterion: {cx['critere']}."
                )
            exemple["cadre"] = cx["cadre"]
            exemple["critere_succes"] = cx["critere"]
            dedup = hacher_contenu(exemple["instruction"], exemple["output"])
            if dedup in vus:
                cache_ctx[langue] = None
                continue
            vus.add(dedup)
            ligne = {
                "id": f"gen3ia-{spec.id}-{len(lignes) + 1:08d}",
                "domain": spec.id,
                "domain_fr": spec.nom_fr,
                "language": langue,
                "task_type": exemple["task_type"],
                "instruction": exemple["instruction"],
                "input": exemple.get("input", ""),
                "output": exemple["output"],
                "metadata": {
                    "created_at": iso,
                    "temporal_bucket": ctx["semaine"],
                    "difficulty": difficulte,
                    "quality_score": qualite,
                    "source_style": provenance,
                    "bilingual_pair_id": pair_id,
                    "dedup_hash": dedup,
                    "safety_label": exemple.get(
                        "safety_label", spec.safety_label
                    ),
                    "license": LICENSE,
                },
            }
            # Champs spécifiques du domaine (tout sauf les clés communes).
            communes = {"instruction", "input", "output", "task_type", "safety_label"}
            extras = {
                k: v
                for k, v in exemple.items()
                if k not in communes
            }
            if extras:
                ligne["domain_fields"] = extras
            lignes.append(ligne)

    if len(lignes) < nb_lignes:
        print(
            f"  ⚠ {spec.id} : {len(lignes)}/{nb_lignes} lignes "
            f"(déduplication : {len(vus)} contenus uniques)",
            file=sys.stderr,
        )
    return lignes[:nb_lignes]


def ecrire_jsonl(chemin: Path, lignes: list[dict]) -> None:
    chemin.parent.mkdir(parents=True, exist_ok=True)
    with chemin.open("w", encoding="utf-8") as fh:
        for ligne in lignes:
            fh.write(json.dumps(ligne, ensure_ascii=False, separators=(",", ":")) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--lignes", type=int, default=GRINE_PAR_DEFAUT,
        help="lignes cibles par domaine (défaut 100000)",
    )
    parser.add_argument(
        "--domaines", type=str, default="",
        help="ids séparés par virgule (défaut : les 18)",
    )
    parser.add_argument(
        "--echantillon", type=int, default=120,
        help="lignes d'échantillon commises par domaine (défaut 120)",
    )
    parser.add_argument(
        "--graine", type=int, default=20261024,
        help="graine globale (défaut 20261024)",
    )
    parser.add_argument(
        "--sans-complet", action="store_true",
        help="générer uniquement les échantillons commis",
    )
    args = parser.parse_args()

    selection = (
        [d for d in DOMAINES_GEN3IA if d.id in set(args.domaines.split(","))]
        if args.domaines
        else list(DOMAINES_GEN3IA)
    )
    base = Path(__file__).parent
    complet = base / "data" / "complet"
    echantillons = base / "data" / "echantillons"

    manifest = {
        "generator": "gen3ia/gen3-domain-datasets/generateur.py",
        "seed": args.graine,
        "target_lines_per_domain": args.lignes,
        "window_months": 24,
        "anchor": "2026-10-24T18:00:00Z",
        "languages": ["fr", "en"],
        "license": LICENSE,
        "domains": [],
    }

    total_debut = time.time()
    for position, spec in enumerate(selection):
        t0 = time.time()
        rng = random.Random(args.graine + position * 7919)
        lignes = generer_domaine(spec, args.lignes, rng)
        if not args.sans_complet:
            ecrire_jsonl(complet / f"{spec.id}.jsonl", lignes)
        # Échantillon commis : premier pas régulier du fichier complet
        # (régulier = reproductible, représentatif des types de tâches).
        pas = max(1, len(lignes) // max(1, args.echantillon))
        echantillon = lignes[::pas][: args.echantillon]
        ecrire_jsonl(echantillons / f"{spec.id}.jsonl", echantillon)

        types_stats: dict[str, int] = {}
        langues_stats: dict[str, int] = {}
        for ligne in lignes:
            types_stats[ligne["task_type"]] = types_stats.get(ligne["task_type"], 0) + 1
            langues_stats[ligne["language"]] = langues_stats.get(ligne["language"], 0) + 1

        manifest["domains"].append({
            "id": spec.id,
            "nom_fr": spec.nom_fr,
            "nom_en": spec.nom_en,
            "lignes": len(lignes),
            "mots_cles": spec.mots_cles,
            "taches": {
                t[0]: {"poids": t[1], "generees": types_stats.get(t[0], 0)}
                for t in spec.taches
            },
            "langues": langues_stats,
            "safety_label": spec.safety_label,
            "duree_s": round(time.time() - t0, 1),
        })
        print(
            f"  ✔ {spec.id:<24} {len(lignes):>7,} lignes "
            f"({round(time.time() - t0, 1)} s) "
            f"fr={langues_stats.get('fr', 0):,} en={langues_stats.get('en', 0):,}",
            flush=True,
        )

    manifest_chemin = base / "manifest.json"
    manifest_chemin.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    total = round(time.time() - total_debut, 1)
    print(f"\nTerminé en {total} s — {len(selection)} domaine(s).")
    print(f"  complet     : {complet}")
    print(f"  échantillons: {echantillons}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

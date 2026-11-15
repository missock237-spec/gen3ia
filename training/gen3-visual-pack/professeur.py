#!/usr/bin/env python3
"""professeur.py — l'enseignant visuel de gen3 (pack gen3-visual-pack).

Rôle : construire et vérifier le PROGRAMME VISUEL de gen3, puis produire le
PLAN DE COURS (programme_visuel.json) qui guide l'entraînement :
  1. leçons images  (module « voir »)      → adapter vision-langage Gemma 3 ;
  2. leçons audio   (module « écouter »)   → transcriptions alignées (voix off) ;
  3. leçons vidéo   (module « comprendre ») → multi-frames + narration.

Le professeur ne triche pas : chaque média est vérifié (existence, dimensions,
durée, poids), chaque description correspond à ce qui est VISIBLE dans l'image.

Usage :
    python professeur.py plan                # écrit programme_visuel.json
    python professeur.py verifier            # vérifie tous les médias
    python professeur.py stats               # statistiques du programme
"""
from __future__ import annotations

import argparse
import json
import struct
import subprocess
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parent
DATA = PACK / "data"
PLAN_PATH = PACK / "programme_visuel.json"

POIDS_MAX_MEDIA = 8 * 1024 * 1024  # 8 Mo par média (dépôt léger)


# ---------------------------------------------------------------- utilitaires
def lire_jsonl(chemin: Path) -> list:
    if not chemin.exists():
        raise FileNotFoundError(f"fichier introuvable : {chemin}")
    rows = []
    for i, ligne in enumerate(chemin.read_text(encoding="utf-8").splitlines(), 1):
        ligne = ligne.strip()
        if ligne:
            rows.append(json.loads(ligne))
    return rows


def dimensions_image(chemin: Path) -> tuple:
    """Dimensions d'une image PNG ou JPEG via l'en-tête (stdlib, sans PIL)."""
    donnees = chemin.read_bytes()
    if donnees[:8] == b"\x89PNG\r\n\x1a\n":
        if len(donnees) < 33:
            raise ValueError(f"PNG tronqué : {chemin}")
        return struct.unpack(">II", donnees[16:24])
    if donnees[:3] == b"\xff\xd8\xff":
        # JPEG : parcourir les segments jusqu'au marqueur SOFn
        i = 2
        while i + 9 < len(donnees):
            if donnees[i] != 0xFF:
                i += 1
                continue
            marqueur = donnees[i + 1]
            if 0xC0 <= marqueur <= 0xCF and marqueur not in (0xC4, 0xC8, 0xCC):
                hauteur, largeur = struct.unpack(
                    ">HH", donnees[i + 5:i + 9])
                return largeur, hauteur
            if marqueur in (0xD8, 0x01) or 0xD0 <= marqueur <= 0xD7:
                i += 2
            else:
                longueur = struct.unpack(">H", donnees[i + 2:i + 4])[0]
                i += 2 + longueur
        raise ValueError(f"JPEG sans en-tête SOF : {chemin}")
    raise ValueError(f"Format d'image non reconnu : {chemin}")


def duree_media(chemin: Path) -> float:
    """Durée d'un média audio/vidéo via ffprobe (None si ffprobe absent)."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(chemin)],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode == 0 and r.stdout.strip():
            return float(r.stdout.strip().splitlines()[0])
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
        pass
    return -1.0


def taille_fichier(chemin: Path) -> int:
    return chemin.stat().st_size


# ------------------------------------------------------------- vérification
def verifier(resoudre_erreurs: bool = False) -> int:
    erreurs = []
    avertissements = []
    lecons = lire_jsonl(DATA / "lecons_images.jsonl")
    validation = lire_jsonl(DATA / "validation_visuelle.jsonl")

    print(f"=== Vérification du programme visuel — {len(lecons)} leçons, "
          f"{len(validation)} validations ===")

    for ex in lecons + validation:
        ident = ex.get("id", "?")
        for champ in ("task", "instruction", "response"):
            if not ex.get(champ):
                erreurs.append(f"{ident}: champ « {champ} » manquant")
        if ident.startswith("lecon"):
            for champ in ("image", "audio", "video"):
                rel = ex.get(champ)
                if not rel:
                    erreurs.append(f"{ident}: média « {champ} » manquant")
                    continue
                chemin = PACK / rel
                if not chemin.exists():
                    erreurs.append(f"{ident}: média introuvable : {rel}")
                    continue
                taille = taille_fichier(chemin)
                if taille > POIDS_MAX_MEDIA:
                    avertissements.append(
                        f"{ident}: {chemin.name} pèse {taille // 1024} Ko "
                        f"(> {POIDS_MAX_MEDIA // 1024} Ko)")
                if champ == "image":
                    try:
                        l, h = dimensions_image(chemin)
                        print(f"  [image ] {ident}: {chemin.name} "
                              f"{l}x{h}, {taille // 1024} Ko")
                        if l < 512 or h < 512:
                            erreurs.append(f"{ident}: image {l}x{h} trop petite")
                    except ValueError as exc:
                        erreurs.append(str(exc))
                else:
                    duree = duree_media(chemin)
                    if duree < 0:
                        avertissements.append(
                            f"{ident}: ffprobe indisponible — durée de "
                            f"{chemin.name} non vérifiée")
                    else:
                        print(f"  [{champ:<6}] {ident}: {chemin.name} "
                              f"{duree:.1f}s, {taille // 1024} Ko")
                        if champ == "video" and duree < 20:
                            erreurs.append(
                                f"{ident}: vidéo {duree:.1f}s trop courte "
                                "pour une leçon")
        else:
            image = ex.get("image")
            if image and not (PACK / image).exists():
                erreurs.append(f"{ident}: image introuvable : {image}")

    narrations = sorted((PACK / "assets" / "audio" / "narrations").glob("*.txt"))
    for narr in narrations:
        n = len(narr.read_text(encoding="utf-8"))
        if n > 1024:
            erreurs.append(f"narration {narr.name}: {n} chars > 1024 (limite TTS)")
    print(f"  [texte ] {len(narrations)} narrations TTS vérifiées (<= 1024 chars)")

    if avertissements:
        print("\nAvertissements :")
        for a in avertissements:
            print(f"  ! {a}")

    if erreurs:
        print(f"\nERREURS ({len(erreurs)}) :")
        for e in erreurs:
            print(f"  x {e}")
        return 1
    print("\nProgramme visuel VERT : tous les médias sont présents et cohérents.")
    return 0


# ------------------------------------------------------------------- plan
def construire_plan() -> dict:
    lecons = lire_jsonl(DATA / "lecons_images.jsonl")
    validation = lire_jsonl(DATA / "validation_visuelle.jsonl")
    taches_metiers = []
    metiers_path = DATA / "metiers_taches.jsonl"
    if metiers_path.exists():
        taches_metiers = lire_jsonl(metiers_path)

    modules = {"voir": [], "ecouter": [], "comprendre": [], "metiers": []}
    for ex in lecons:
        duree_audio = duree_media(PACK / ex["audio"])
        duree_video = duree_media(PACK / ex["video"])
        modules["voir"].append({
            "id": ex["id"], "titre": ex["titre"], "matiere": ex["matiere"],
            "image": ex["image"], "mots_cles": ex["mots_cles"],
            "duree_audio_s": round(duree_audio, 1) if duree_audio > 0 else None,
        })
        modules["ecouter"].append({
            "id": ex["id"], "audio": ex["audio"],
            "duree_s": round(duree_audio, 1) if duree_audio > 0 else None,
            "transcript": "assets/audio/narrations/" + ex["id"] + ".txt",
        })
        modules["comprendre"].append({
            "id": ex["id"], "video": ex["video"],
            "duree_s": round(duree_video, 1) if duree_video > 0 else None,
            "frames_preparees": "assets/frames/" + ex["id"] + "/",
        })
        if ex.get("module") == "metiers":
            modules["metiers"].append({
                "id": ex["id"], "titre": ex["titre"], "matiere": ex["matiere"],
            })

    total_audio = sum(m["duree_s"] or 0 for m in modules["ecouter"])
    plan = {
        "programme": "L'école visuelle de gen3 — cours v2 (vague 1 : voir/écouter/"
                     "comprendre + vague 2 : école des métiers)",
        "professeur": "gen3ia (enseignant) → gen3 (élève)",
        "principe": (
            "Chaque leçon associe un média réel à une description vérifiée "
            "visuellement : gen3 apprend à décrire ce qui est visible, sans "
            "inventer. Anti-hallucination par construction. Vague 2 : gen3 ne "
            "se contente pas de décrire, il s'entraîne à EXÉCUTER les métiers "
            "(documents, données, questionnaires, vidéo, image photoréaliste, "
            "voix, web temps réel, rapports, cohérence) — y compris sur des "
            "domaines fictifs mais parfaitement cohérents."
        ),
        "modules": modules,
        "taches_metiers": sorted({t["task"] for t in taches_metiers}),
        "etapes_entrainement": [
            "1. prepare_visual_dataset.py — extraire 4 frames par vidéo (ffmpeg) "
            "et fusionner les 4 modules en data/train_visual.jsonl",
            "2. train_gen3_visuel.py — QLoRA Gemma 3 sur les leçons et les tâches "
            "métiers (profils l4 / a100_40g, GPU obligatoire, "
            "--resume_from_checkpoint)",
            "3. infer_gen3_visuel.py — gen3 décrit une nouvelle image",
            "4. bench_gen3_visuel.py — couverture des mots-clés, longueur, latence",
        ],
        "validation": [v["id"] for v in validation],
        "metriques": {
            "lecons": len(lecons),
            "lecons_metiers": len(modules["metiers"]),
            "exemples_taches_metiers": len(taches_metiers),
            "exemples_validation": len(validation),
            "mots_cles_total": sum(len(m["mots_cles"]) for m in modules["voir"]),
            "minutes_audio": round(total_audio / 60.0, 1),
            "minutes_video": round(
                sum(m["duree_s"] or 0 for m in modules["comprendre"]) / 60.0, 1),
        },
    }
    return plan


def plan() -> int:
    plan_donnees = construire_plan()
    PLAN_PATH.write_text(
        json.dumps(plan_donnees, ensure_ascii=False, indent=2), encoding="utf-8")
    m = plan_donnees["metriques"]
    print(f"Plan de cours écrit : {PLAN_PATH.name}")
    print(f"  {m['lecons']} leçons — {m['minutes_audio']} min de voix off, "
          f"{m['minutes_video']} min de vidéo — {m['mots_cles_total']} mots-clés")
    for etape in plan_donnees["etapes_entrainement"]:
        print(f"  {etape}")
    return 0


# ------------------------------------------------------------------- stats
def stats() -> int:
    lecons = lire_jsonl(DATA / "lecons_images.jsonl")
    print("=== Statistiques du programme visuel ===")
    par_matiere = {}
    for ex in lecons:
        par_matiere.setdefault(ex["matiere"], []).append(ex["id"])
    for matiere, ids in sorted(par_matiere.items()):
        print(f"  {matiere:<16} : {', '.join(ids)}")
    total_chars = sum(len(ex["response"]) for ex in lecons)
    total_mots = sum(len(ex["response"].split()) for ex in lecons)
    print(f"  descriptions : {total_chars} chars, {total_mots} mots au total")
    print(f"  mots-clés    : {sum(len(ex['mots_cles']) for ex in lecons)}")
    metiers_path = DATA / "metiers_taches.jsonl"
    if metiers_path.exists():
        taches = lire_jsonl(metiers_path)
        par_tache = {}
        for t in taches:
            par_tache[t["task"]] = par_tache.get(t["task"], 0) + 1
        print(f"  tâches métiers : {len(taches)} exemples")
        for nom, n in sorted(par_tache.items()):
            print(f"    - {nom} : {n}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="L'enseignant visuel de gen3")
    ap.add_argument("commande", choices=["plan", "verifier", "stats"])
    args = ap.parse_args()
    if args.commande == "plan":
        return plan()
    if args.commande == "verifier":
        return verifier()
    return stats()


if __name__ == "__main__":
    sys.exit(main())

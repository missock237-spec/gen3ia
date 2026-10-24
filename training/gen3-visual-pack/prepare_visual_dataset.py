#!/usr/bin/env python3
"""prepare_visual_dataset.py — fusionne les 3 modules du cours visuel en un
dataset d'entraînement gen3 (schéma task/instruction/response).

Ce que fait le script (sans GPU, ffmpeg requis pour les frames) :
  1. Pour chaque leçon vidéo : extrait 4 frames clés à 512 px (ffmpeg).
  2. Construit data/train_visual.jsonl :
       - module « voir »      : task=decrire_image   (1 image) ;
       - module « comprendre »: task=decrire_video   (4 frames) ;
       - module « écouter »   : task=expliquer_lecon (texte pur = transcript).
  3. Copie la validation (questions sur les leçons) en data/validation_visual.jsonl.

Le résultat est directement consommable par train_gen3_visuel.py (et par le
pack gen3-video : même schéma).
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parent
DATA = PACK / "data"
FRAMES = PACK / "assets" / "frames"
N_FRAMES = 4
TAILLE_FRAME = 512
# garde-fou anti-hallucination : la réponse d'une leçon vidéo est la
# description VERIFIÉE de la leçon (jamais générée automatiquement).
# Vague 2 (« école des métiers ») : 9 tâches métiers supplémentaires où gen3
# s'entraîne à EXÉCUTER (documents, données, questionnaires, vidéo, image,
# voix, web temps réel, rapports, cohérence).
TACHES = {
    "decrire_image", "decrire_video", "expliquer_lecon",
    "rediger_document", "analyser_donnees", "repondre_questionnaire",
    "planifier_video", "creer_image_photorealiste", "creer_voix",
    "analyser_web_temps_reel", "rediger_rapport", "controler_coherence",
}
TACHES_IMAGE = {"decrire_image", "decrire_video"}


def lire_jsonl(chemin: Path) -> list:
    rows = []
    for i, ligne in enumerate(chemin.read_text(encoding="utf-8").splitlines(), 1):
        ligne = ligne.strip()
        if ligne:
            rows.append(json.loads(ligne))
    return rows


def ecrire_jsonl(chemin: Path, rows: list) -> None:
    with chemin.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def extraire_frames(video: Path, dossier: Path) -> list:
    """Extrait N_FRAMES frames régulières (512 px) via ffmpeg."""
    dossier.mkdir(parents=True, exist_ok=True)
    existantes = sorted(dossier.glob("f*.jpg"))
    if len(existantes) >= N_FRAMES:
        return [str(p.relative_to(PACK)) for p in existantes[:N_FRAMES]]
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(video)],
            capture_output=True, text=True, timeout=30,
        )
        duree = float(r.stdout.strip())
    except (FileNotFoundError, ValueError, subprocess.TimeoutExpired):
        raise RuntimeError("ffmpeg/ffprobe requis pour extraire les frames — "
                           "installe ffmpeg puis relance.")
    pas = max(2.0, duree / (N_FRAMES + 1))
    chemins = []
    for n in range(N_FRAMES):
        t = min(duree - 0.5, round((n + 1) * pas, 2))
        sortie = dossier / f"f{n:02d}.jpg"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", str(t), "-i", str(video),
             "-frames:v", "1", "-vf", f"scale={TAILLE_FRAME}:-2", "-q:v", "4",
             str(sortie)],
            check=True, timeout=120,
        )
        chemins.append(str(sortie.relative_to(PACK)))
    return chemins


def construire(lecons: list, extraire: bool) -> list:
    exemples = []
    for lec in lecons:
        base = {
            "id": lec["id"],
            "module": lec["module"],
            "matiere": lec["matiere"],
            "titre": lec["titre"],
            "langue": "fr",
        }
        # module voir : image → description
        exemples.append({
            **base,
            "task": "decrire_image",
            "image": lec["image"],
            "instruction": "Décris cette image en français, de façon précise et organisée.",
            "response": lec["response"],
            "mots_cles": lec["mots_cles"],
        })
        # module comprendre : 4 frames de la vidéo → description
        frames_rel = f"assets/frames/{lec['id']}"
        if extraire:
            frames = extraire_frames(PACK / lec["video"], PACK / frames_rel)
        else:
            frames = [str(p.relative_to(PACK)) for p in (PACK / frames_rel).glob("f*.jpg")][:N_FRAMES]
            if len(frames) < N_FRAMES:
                raise RuntimeError(
                    f"{lec['id']}: frames absentes — relance avec --extraire")
        exemples.append({
            **base,
            "id": lec["id"] + "_video",
            "task": "decrire_video",
            "images": frames,
            "instruction": (
                "Voici des images clés d'une mini-leçon vidéo. Décris la leçon "
                "en français, de façon précise et organisée."
            ),
            "response": lec["response"],
            "mots_cles": lec["mots_cles"],
        })
        # module écouter : transcript de la voix off (texte pur)
        narr = PACK / "assets" / "audio" / "narrations" / (lec["id"] + ".txt")
        if not narr.exists():
            raise RuntimeError(f"narration manquante : {narr}")
        exemples.append({
            **base,
            "id": lec["id"] + "_audio",
            "task": "expliquer_lecon",
            "instruction": (
                f"Explique la leçon « {lec['titre']} » à un élève, en français, "
                "comme un professeur bienveillant."
            ),
            "response": narr.read_text(encoding="utf-8").strip(),
        })
    return exemples


def main() -> int:
    ap = argparse.ArgumentParser(description="Fusionne le cours visuel en dataset gen3")
    ap.add_argument("--extraire", action="store_true", default=True,
                    help="extraire les frames vidéo (ffmpeg) — défaut")
    ap.add_argument("--pas-extraire", dest="extraire", action="store_false")
    args = ap.parse_args()

    if args.extraire and shutil.which("ffmpeg") is None:
        print("ERREUR : ffmpeg introuvable — installe-le ou passe --pas-extraire.",
              file=sys.stderr)
        return 1

    lecons = lire_jsonl(DATA / "lecons_images.jsonl")
    validation = lire_jsonl(DATA / "validation_visuelle.jsonl")

    train = construire(lecons, args.extraire)

    # vague 2 : exemples de tâches métiers (texte pur, sans média)
    metiers_path = DATA / "metiers_taches.jsonl"
    if metiers_path.exists():
        taches_metiers = lire_jsonl(metiers_path)
        for t in taches_metiers:
            train.append({
                "id": t["id"], "task": t["task"], "module": "metiers",
                "matiere": "metier", "titre": t["task"], "langue": "fr",
                "instruction": t["instruction"], "response": t["response"],
            })

    for ex in train:
        if ex.get("task") not in TACHES:
            raise ValueError(f"tâche inconnue : {ex['task']}")
        for t in TACHES_IMAGE:
            if ex.get("task") == t and not ex.get("image") and not ex.get("images"):
                raise ValueError(f"{ex['id']}: tâche {t} sans image(s)")

    ecrire_jsonl(DATA / "train_visual.jsonl", train)
    ecrire_jsonl(DATA / "validation_visual.jsonl", validation)

    n_frames_total = sum(len(e.get("images", [])) for e in train)
    n_metiers = sum(1 for e in train if e.get("module") == "metiers"
                    and e["task"] not in ("decrire_image", "decrire_video",
                                          "expliquer_lecon"))
    print(f"OK — {len(train)} exemples d'entraînement "
          f"({sum(1 for e in train if e['task']=='decrire_image')} images, "
          f"{sum(1 for e in train if e['task']=='decrire_video')} vidéos "
          f"[{n_frames_total} frames], "
          f"{sum(1 for e in train if e['task']=='expliquer_lecon')} textes, "
          f"{n_metiers} tâches métiers) "
          f"+ {len(validation)} validations.")
    print("Suivant : python train_gen3_visuel.py --profil auto")
    return 0


if __name__ == "__main__":
    sys.exit(main())

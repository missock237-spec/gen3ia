#!/usr/bin/env python3
"""GEN3 — Préparation du dataset vidéo au schéma unifié gen3.

Lit ``gen3_dataset/metadata.jsonl`` (clips Wan status=ok) et construit :

  1. pour chaque clip, un échantillonnage de K images (ffmpeg, réparties
     uniformément, redimensionnées à 512 px) ;
  2. des exemples d'entraînement multi-frames et mono-frame au schéma
     ``{id, task_family, task, instruction, input_text, response, images}``
     où les réponses proviennent des métadonnées françaises de
     ``prompts_gen3.json`` (sujet/action/décor/ambiance/caméra) — la
     description est ancrée dans le prompt de génération, donc sans
     hallucination par construction ;
  3. un découpage train / validation / golden PAR VIDÉO (aucun exemple d'une
     même vidéo ne se retrouve à la fois en train et en validation).

Tâches générées (task_family ``video_understanding``) :
  - ``video_analysis``   : analyse séquence par séquence + résumé global ;
  - ``video_summary``    : résumé en deux phrases ;
  - ``video_scene_qa``   : questions-réponses visuelles (sujet, ambiance,
    caméra, décor) ;
  - ``frame_caption``    : description d'une seule image (chaînon image
    simple, réutilisable par l'entraînement image existant).

Usage :
    python prepare_video_dataset.py \
        --dataset_dir gen3_dataset --frames_per_video 6 --out data
"""
import argparse
import json
import os
import random
import subprocess
import sys
from pathlib import Path

PACK_DIR = Path(__file__).resolve().parent
PROMPTS_FILE = PACK_DIR / "prompts_gen3.json"

MAX_DIM = 512  # px du côté long des frames (économie de tokens visuels)


def relatif_depuis_base(p: Path, base: Path) -> str:
    """Chemin relatif portable (relatif si possible, sinon ../)."""
    try:
        return str(p.relative_to(base))
    except ValueError:
        return os.path.relpath(p, base)


def ffprobe_video(video: Path) -> dict:
    """Lit durée/fps/résolution d'un clip via ffprobe (exit si invalide)."""
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate",
        "-show_entries", "format=duration",
        "-of", "json", str(video),
    ]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True,
                             timeout=60)
        info = json.loads(out.stdout)
        stream = info["streams"][0]
        num, den = stream.get("r_frame_rate", "16/1").split("/")
        fps = float(num) / float(den) if float(den) else 0.0
        duree = float(info.get("format", {}).get("duration", 0) or 0)
        return {"w": int(stream["width"]), "h": int(stream["height"]),
                "fps": round(fps, 2), "duree_s": round(duree, 2)}
    except (subprocess.SubprocessError, KeyError, ValueError, IndexError) as exc:
        raise RuntimeError(f"ffprobe a échoué sur {video.name} : {exc}")


def extraire_frames(video: Path, dossier: Path, k: int) -> list:
    """Extrait k images uniformément réparties (positions anti-bords)."""
    dossier.mkdir(parents=True, exist_ok=True)
    meta = ffprobe_video(video)
    duree = meta["duree_s"] or 1.0
    chemins = []
    for i in range(k):
        t = min(max((i + 0.5) / k * duree, 0.05), max(duree - 0.05, 0.05))
        cible = dossier / f"f{i:02d}.png"
        cmd = [
            "ffmpeg", "-y", "-ss", f"{t:.3f}", "-i", str(video),
            "-frames:v", "1",
            "-vf", f"scale={MAX_DIM}:{MAX_DIM}:force_original_aspect_ratio=decrease",
            "-q:v", "2", str(cible),
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=60)
        if not cible.exists() or cible.stat().st_size == 0:
            raise RuntimeError(f"frame {i} non produite pour {video.name}")
        chemins.append(cible)
    return chemins


def construire_exemples(scene: dict, clip_id: str, video: Path,
                        frames: list, meta: dict, duration_s: int,
                        base_rel: Path) -> list:
    """Génère les exemples gen3 d'un clip à partir de ses métadonnées FR."""
    desc = scene["description_fr"]
    rel = [relatif_depuis_base(p, base_rel) for p in frames]

    def base(ident_suffix: str, task: str, instruction: str, response: str,
             images: list) -> dict:
        return {
            "id": f"vid-{clip_id}-{ident_suffix}",
            "task_family": "video_understanding",
            "task": task,
            "instruction": instruction,
            "input_text": "",
            "response": response,
            "images": images,
            "video": relatif_depuis_base(video, base_rel),
            "meta": {"prompt_ref": scene["id"], "frames": len(images),
                     "duree_s": meta["duree_s"], "fps": meta["fps"],
                     "w": meta["w"], "h": meta["h"],
                     "clip_duration_s": duration_s},
        }

    exemples = []

    exemples.append(base(
        "analysis", "video_analysis",
        "Voici les images clés d'une séquence vidéo, dans l'ordre "
        "chronologique. Analyse la scène : sujet, action, décor, lumière "
        "et mouvement de caméra, puis donne un résumé global.",
        f"Analyse de la séquence :\n"
        f"- Sujet principal : {scene['sujet']}.\n"
        f"- Action observée : {scene['action']}.\n"
        f"- Décor : {scene['decor']}.\n"
        f"- Lumière et ambiance : {scene['ambiance']}.\n"
        f"- Caméra : {scene['camera']}.\n"
        f"Résumé global : {desc}",
        rel,
    ))

    exemples.append(base(
        "summary", "video_summary",
        "Résume cette vidéo (images clés fournies) en deux phrases "
        "précises.",
        f"{scene['sujet'].capitalize()} — {scene['action']}, dans "
        f"{scene['decor']}. L'ambiance est {scene['ambiance']}, filmée "
        f"avec {scene['camera']}.",
        rel,
    ))

    qa = [
        ("video_scene_qa", "Que voit-on comme sujet principal dans cette "
         "vidéo ?", scene["sujet"].capitalize() + "."),
        ("video_scene_qa", "Décris l'ambiance lumineuse et l'atmosphère de "
         "cette séquence.", scene["ambiance"].capitalize() + "."),
        ("video_scene_qa", "Quel mouvement de caméra est utilisé dans cette "
         "vidéo ?", scene["camera"].capitalize() + "."),
        ("video_scene_qa", "Dans quel décor cette scène se déroule-t-elle ?",
         f"La scène se déroule dans {scene['decor']}."),
    ]
    for i, (task, question, reponse) in enumerate(qa):
        exemples.append(base(
            f"qa{i}", task, question, reponse, rel,
        ))

    # Chaînon mono-frame : compatible avec l'entraînement image existant.
    exemples.append(base(
        "caption0", "frame_caption",
        "Décris cette image extraite d'une séquence vidéo.",
        desc, [rel[0]],
    ))
    exemples.append(base(
        "caption1", "frame_caption",
        "Décris cette image extraite d'une séquence vidéo.",
        desc, [rel[len(rel) // 2]],
    ))
    return exemples


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Prépare le dataset vidéo gen3 (schéma unifié)")
    ap.add_argument("--dataset_dir", default=str(PACK_DIR / "gen3_dataset"),
                    help="Dossier contenant metadata.jsonl et videos/")
    ap.add_argument("--frames_per_video", type=int, default=6,
                    help="Images clés extraites par clip (défaut 6)")
    ap.add_argument("--out", default=str(PACK_DIR / "data"),
                    help="Dossier de sortie des JSONL")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    dataset_dir = Path(args.dataset_dir)
    metadata_file = dataset_dir / "metadata.jsonl"
    out_dir = Path(args.out)
    # Base de relativisation des chemins de frames : la racine du pack si le
    # dataset y vit (cas Colab), sinon le dossier de sortie (cas test externe).
    pack_resolu = PACK_DIR.resolve()
    if dataset_dir.resolve().is_relative_to(pack_resolu):
        base_rel = pack_resolu
    else:
        base_rel = out_dir.resolve()
    if not metadata_file.exists():
        raise SystemExit(
            f"{metadata_file} introuvable : lance d'abord gen3_video_dataset.py "
            "(ou pose des clips + metadata.jsonl manuellement)."
        )
    if args.frames_per_video < 2:
        raise SystemExit("--frames_per_video doit valoir au moins 2")

    scenes = json.loads(PROMPTS_FILE.read_text(encoding="utf-8"))
    par_prompt = {s["prompt_en"]: s for s in scenes}

    clips, ignores = [], 0
    with metadata_file.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            if item.get("status") != "ok":
                ignores += 1
                continue
            video = Path(item["video"])
            if not video.is_file():
                ignores += 1
                continue
            scene = par_prompt.get(item.get("prompt", ""))
            if scene is None:
                print(f"[WARN] prompt inconnu pour {video.name} — ignoré")
                ignores += 1
                continue
            clips.append((item, scene, video))

    if not clips:
        raise SystemExit("Aucun clip « ok » dans metadata.jsonl — rien à faire.")
    print(f"[clips] {len(clips)} clip(s) valides, {ignores} entrée(s) ignorée(s)")

    rng = random.Random(args.seed)
    ids_videos = [c[0]["id"] for c in clips]
    rng.shuffle(ids_videos)
    # Répartition : train >= 1 garanti ; validation ~10 % (min 1 si >= 2
    # clips) ; golden = 2 clips max, ce qui reste après train+validation.
    n_train_min = 1
    n_val = 1 if len(ids_videos) >= 2 else 0
    n_golden = min(2, max(0, len(ids_videos) - n_val - n_train_min))
    val_ids = set(ids_videos[:n_val])
    golden_ids = set(ids_videos[n_val:n_val + n_golden])

    out_dir.mkdir(parents=True, exist_ok=True)
    buckets = {"train": [], "validation": [], "golden": []}
    extraits = 0

    for item, scene, video in clips:
        clip_id = item["id"]
        dossier = dataset_dir / "frames" / clip_id
        try:
            frames = extraire_frames(video, dossier, args.frames_per_video)
        except (RuntimeError, subprocess.SubprocessError) as exc:
            print(f"[WARN] {clip_id} ignoré : {exc}")
            continue
        meta = ffprobe_video(video)
        exemples = construire_exemples(scene, clip_id, video, frames, meta,
                                       item.get("duration_seconds", 10),
                                       base_rel)
        if clip_id in val_ids:
            buckets["validation"].extend(exemples)
        elif clip_id in golden_ids:
            buckets["golden"].extend(exemples)
        else:
            buckets["train"].extend(exemples)
        extraits += 1

    fichiers = {"train": "train_video.jsonl",
                "validation": "validation_video.jsonl",
                "golden": "golden_video.jsonl"}
    for cle, nom in fichiers.items():
        chemin = out_dir / nom
        with chemin.open("w", encoding="utf-8") as f:
            for ex in buckets[cle]:
                f.write(json.dumps(ex, ensure_ascii=False) + "\n")
        print(f"[out] {chemin} : {len(buckets[cle])} exemple(s)")

    print(f"Préparation terminée : {extraits} clip(s) traité(s) — "
          f"anti-fuite par vidéo (train/validation/golden disjoints).")


if __name__ == "__main__":
    sys.exit(main())

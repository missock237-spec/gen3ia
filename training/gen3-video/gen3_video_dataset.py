#!/usr/bin/env python3
"""GEN3 — Générateur de dataset vidéo (Wan 2.1 T2V sur Hugging Face).

Amélioration du script fourni par l'utilisateur, orientée sessions longues :

  - poids Wan-AI/Wan2.1-T2V-1.3B téléchargés depuis Hugging Face (HF_TOKEN)
    si ``WAN_CKPT_DIR`` n'existe pas encore ;
  - reprise : ``metadata.jsonl`` consigne chaque tentative (status ok/error)
    et les clips déjà générés sont sautés — plusieurs sessions Colab se
    complètent sans régénérer ;
  - résilience : 3 tentatives par clip, délai entre essais, timeout global
    par clip, vérification d'espace disque et de GPU avant de démarrer ;
  - ``--limit N`` pour fractionner une session (ex. 10 clips/session L4) ;
  - ``--dry-run`` : liste le plan de génération sans GPU ni poids Wan
    (utilisable partout, y compris la sandbox de développement) ;
  - prompts tirés de ``prompts_gen3.json`` (48 scènes décrites avec leurs
    métadonnées françaises réutilisées par ``prepare_video_dataset.py``).

Modèle : Wan2.1-T2V-1.3B (Apache-2.0) — clips 832x480, ~81 images nativement
(≈ 5 s à 16 fps) ; la cible 10 s est atteinte par bouclage fluide ffmpeg
(``--duration`` pour changer la cible ; 5 s = rendu natif sans boucle).

Usage Colab (runtime L4) :
    export WAN_REPO_DIR=/content/Wan2.1
    export WAN_CKPT_DIR=/content/Wan2.1-T2V-1.3B
    python gen3_video_dataset.py --limit 10 --duration 10
"""
import argparse
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

PACK_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = PACK_DIR / "gen3_dataset"
VIDEO_DIR = OUTPUT_DIR / "videos"
RAW_DIR = OUTPUT_DIR / "raw"
PROMPTS_FILE = PACK_DIR / "prompts_gen3.json"
METADATA_FILE = OUTPUT_DIR / "metadata.jsonl"

FPS = 16
WIDTH, HEIGHT = 832, 480
FRAME_NUM = 81          # images générées nativement par Wan t2v (≈ 5 s)
ESPACE_MIN_GO = 20.0    # poids Wan (~11 Go) + marge vidéos

# Bande mémoire minimale pour générer avec Wan2.1-T2V-1.3B (Go de VRAM).
VRAM_MIN_GEN_GO = 14.0


def prompt_id(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]


def charger_prompts() -> list:
    """Charge les 48 scènes de prompts_gen3.json (prompt_en + métadonnées FR)."""
    if not PROMPTS_FILE.exists():
        raise FileNotFoundError(f"Banque de prompts introuvable : {PROMPTS_FILE}")
    data = json.loads(PROMPTS_FILE.read_text(encoding="utf-8"))
    vus = set()
    for entree in data:
        for champ in ("id", "prompt_en", "description_fr"):
            if not entree.get(champ):
                raise ValueError(f"prompts_gen3.json : champ « {champ} » manquant")
        if entree["id"] in vus:
            raise ValueError(f"prompts_gen3.json : id dupliqué {entree['id']}")
        vus.add(entree["id"])
    return data


def verifier_gpu() -> str:
    """Gen3 fonctionne sur les ressources GPU disponibles — jamais sur CPU."""
    try:
        import torch
    except ImportError:
        raise RuntimeError("torch introuvable : installez requirements.txt")
    if not torch.cuda.is_available():
        raise RuntimeError(
            "GPU CUDA requis : la génération Wan ne se fait pas sur CPU "
            "(un clip prendrait des heures). Utilisez un runtime GPU "
            "(Colab L4 ou A100) ou relancez avec --dry-run."
        )
    props = torch.cuda.get_device_properties(0)
    vram_go = props.total_memory / (1024**3)
    if vram_go < VRAM_MIN_GEN_GO:
        raise RuntimeError(
            f"GPU détecté : {props.name} ({vram_go:.0f} Go) — sous le plancher "
            f"de génération ({VRAM_MIN_GEN_GO:.0f} Go). Runtime L4 recommandé."
        )
    return f"{props.name} ({vram_go:.0f} Go)"


def verifier_disque() -> None:
    usage = shutil.disk_usage(PACK_DIR)
    libre_go = usage.free / (1024**3)
    if libre_go < ESPACE_MIN_GO:
        raise RuntimeError(
            f"Espace disque insuffisant : {libre_go:.1f} Go libres "
            f"({ESPACE_MIN_GO:.0f} Go requis pour les poids + clips)."
        )


def telecharger_poids_wan(ckpt_dir: Path, token: str | None) -> None:
    """Télécharge Wan-AI/Wan2.1-T2V-1.3B depuis Hugging Face si nécessaire."""
    marqueur = ckpt_dir / ".download_complete"
    if marqueur.exists():
        print(f"[HF] Poids déjà présents : {ckpt_dir}")
        return
    from huggingface_hub import snapshot_download

    print(f"[HF] Téléchargement Wan-AI/Wan2.1-T2V-1.3B → {ckpt_dir} (~11 Go)…")
    snapshot_download(
        repo_id="Wan-AI/Wan2.1-T2V-1.3B",
        local_dir=str(ckpt_dir),
        token=token or None,
    )
    marqueur.write_text("ok\n", encoding="utf-8")
    print("[HF] Téléchargement terminé.")


def load_completed() -> set:
    """IDs des clips déjà générés avec succès (fichier vidéo toujours présent)."""
    completed = set()
    if METADATA_FILE.exists():
        with METADATA_FILE.open("r", encoding="utf-8") as f:
            for line in f:
                try:
                    item = json.loads(line)
                    if item.get("status") == "ok" and Path(item["video"]).is_file():
                        completed.add(item["id"])
                except (json.JSONDecodeError, KeyError):
                    continue
    return completed


def resoudre_fichier_produit(save_file: Path, t_start: float) -> Path | None:
    """Retrouve la vidéo produite par Wan quel que soit le suffixe appliqué.

    Certaines versions de ``generate.py`` ajoutent « .mp4 » ou créent un
    fichier voisin : on teste le chemin direct, puis les variantes, puis le
    mp4 le plus récent créé dans le dossier depuis le début de la génération.
    """
    candidats = [save_file, save_file.with_suffix(".mp4"),
                 Path(str(save_file) + ".mp4")]
    for c in candidats:
        if c.is_file() and c.stat().st_size > 0:
            return c
    dossier = save_file.parent
    if dossier.is_dir():
        produits = [p for p in dossier.glob("*.mp4")
                    if p.stat().st_mtime >= t_start and p.stat().st_size > 0]
        if produits:
            return max(produits, key=lambda p: p.stat().st_mtime)
    return None


def generate_video(prompt: str, output_path: Path, repo_dir: Path,
                   ckpt_dir: Path, timeout_sec: int) -> Path:
    """Point d'intégration avec le modèle vidéo Wan (pas de vidéo factice).

    Appelle le script officiel ``generate.py`` du dépôt Wan-Video/Wan2.1 et
    renvoie le chemin réel de la vidéo produite.
    """
    generate_py = repo_dir / "generate.py"
    if not generate_py.is_file():
        raise RuntimeError(
            f"generate.py introuvable dans {repo_dir} — clonez le dépôt "
            "Wan-Video/Wan2.1 et positionnez WAN_REPO_DIR."
        )

    command = [
        sys.executable, "generate.py",
        "--task", "t2v-1.3B",
        "--size", f"{WIDTH}*{HEIGHT}",
        "--frame_num", str(FRAME_NUM),
        "--ckpt_dir", str(ckpt_dir),
        "--prompt", prompt,
        "--save_file", str(output_path),
    ]

    t_start = time.time()
    subprocess.run(
        command, check=True, cwd=str(repo_dir),
        timeout=timeout_sec,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )

    produit = resoudre_fichier_produit(output_path, t_start)
    if produit is None:
        raise RuntimeError("Le modèle n'a pas produit de vidéo valide.")
    return produit


def normalize_video(source: Path, destination: Path, duration: int) -> None:
    """Convertit en MP4 H.264 — fps, durée et résolution cibles uniformes.

    Clip plus court que la cible : bouclé fluidement ; plus long : coupé.
    """
    command = [
        "ffmpeg", "-y",
        "-stream_loop", "-1",
        "-i", str(source),
        "-t", str(duration),
        "-vf", f"fps={FPS},scale={WIDTH}:{HEIGHT}",
        "-an",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(destination),
    ]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.PIPE)
    if not destination.exists() or destination.stat().st_size == 0:
        raise RuntimeError("ffmpeg n'a pas produit de vidéo normalisée.")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Génération de clips vidéo Wan 2.1 pour le dataset gen3"
    )
    ap.add_argument("--limit", type=int, default=0,
                    help="Nombre maximum de clips à générer cette session (0 = tous)")
    ap.add_argument("--duration", type=int, default=10,
                    help="Durée cible des clips en secondes (5 = rendu natif Wan)")
    ap.add_argument("--timeout_sec", type=int, default=2700,
                    help="Timeout par clip en secondes (défaut 45 min)")
    ap.add_argument("--retries", type=int, default=2,
                    help="Nouvelles tentatives par clip après un échec")
    ap.add_argument("--repo_dir", default=os.environ.get("WAN_REPO_DIR", ""),
                    help="Dossier du dépôt Wan-Video/Wan2.1 (ou env WAN_REPO_DIR)")
    ap.add_argument("--ckpt_dir", default=os.environ.get("WAN_CKPT_DIR", ""),
                    help="Dossier des poids Wan (ou env WAN_CKPT_DIR)")
    ap.add_argument("--no_download", action="store_true",
                    help="Ne télécharge pas les poids HF même si ckpt_dir vide")
    ap.add_argument("--dry_run", action="store_true",
                    help="Affiche le plan de génération sans GPU ni poids Wan")
    args = ap.parse_args()

    prompts = charger_prompts()
    print(f"[plan] {len(prompts)} scènes disponibles dans prompts_gen3.json")

    if args.dry_run:
        faits = load_completed()
        restants = [p for p in prompts
                    if prompt_id(p["prompt_en"]) not in faits]
        cible = restants if args.limit <= 0 else restants[:args.limit]
        print(f"DRY RUN OK : {len(faits)} clip(s) déjà généré(s), "
              f"{len(cible)} clip(s) planifié(s) — "
              f"{args.duration} s @ {FPS} fps, {WIDTH}x{HEIGHT}")
        for p in cible:
            print(f"  - {prompt_id(p['prompt_en'])} : {p['id']} {p['sujet']}")
        return

    if not args.repo_dir:
        raise RuntimeError("Définissez WAN_REPO_DIR (ou --repo_dir) : dépôt "
                           "Wan-Video/Wan2.1 cloné contenant generate.py.")
    if not args.ckpt_dir:
        raise RuntimeError("Définissez WAN_CKPT_DIR (ou --ckpt_dir) : dossier "
                           "des poids Wan 2.1-T2V-1.3B.")
    repo_dir, ckpt_dir = Path(args.repo_dir), Path(args.ckpt_dir)

    gpu = verifier_gpu()
    print(f"[gpu] {gpu}")
    verifier_disque()

    if not args.no_download:
        telecharger_poids_wan(ckpt_dir, os.environ.get("HF_TOKEN"))
    elif not ckpt_dir.is_dir():
        raise RuntimeError(f"--no_download mais {ckpt_dir} n'existe pas.")

    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    completed = load_completed()
    melange = prompts.copy()
    random.shuffle(melange)
    restants = [p for p in melange if prompt_id(p["prompt_en"]) not in completed]
    if args.limit > 0:
        restants = restants[:args.limit]

    print(f"[session] {len(completed)} clip(s) déjà en stock, "
          f"{len(restants)} à générer")
    ok_n, err_n = 0, 0

    with METADATA_FILE.open("a", encoding="utf-8") as metadata:
        for scene in restants:
            prompt = scene["prompt_en"]
            ident = prompt_id(prompt)
            raw_path = RAW_DIR / f"{ident}_raw.mp4"
            final_path = VIDEO_DIR / f"{ident}.mp4"

            record = {
                "id": ident,
                "prompt_ref": scene["id"],
                "prompt": prompt,
                "video": str(final_path),
                "duration_seconds": args.duration,
                "fps": FPS,
                "width": WIDTH,
                "height": HEIGHT,
                "status": "processing",
            }

            print(f"[GENERATING] {ident} ({scene['id']}) : {scene['sujet']}")
            essais = args.retries + 1
            produit = None
            for tentative in range(1, essais + 1):
                try:
                    produit = generate_video(prompt, raw_path, repo_dir,
                                             ckpt_dir, args.timeout_sec)
                    break
                except subprocess.TimeoutExpired:
                    print(f"[ERROR] {ident} : timeout après "
                          f"{args.timeout_sec} s (essai {tentative}/{essais})")
                except Exception as exc:
                    print(f"[ERROR] {ident} : {exc} "
                          f"(essai {tentative}/{essais})")
                time.sleep(5 * tentative)

            try:
                if produit is None:
                    raise RuntimeError("toutes les tentatives ont échoué")
                normalize_video(produit, final_path, args.duration)
                produit.unlink(missing_ok=True)
                record["status"] = "ok"
                record["created_at"] = int(time.time())
                record["bytes"] = final_path.stat().st_size
                ok_n += 1
                print(f"[OK] {final_path}")
            except Exception as exc:
                record["status"] = "error"
                record["error"] = str(exc)
                err_n += 1
                print(f"[ERROR] {ident} abandonné : {exc}")

            metadata.write(json.dumps(record, ensure_ascii=False) + "\n")
            metadata.flush()

    print(f"Génération terminée : {ok_n} ok, {err_n} erreur(s), "
          f"{len(completed) + ok_n} clip(s) au total dans {VIDEO_DIR}")


if __name__ == "__main__":
    main()

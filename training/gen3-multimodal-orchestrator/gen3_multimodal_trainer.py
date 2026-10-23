#!/usr/bin/env python3
"""
Gen3 multimodal training orchestrator.

This is a SAFE orchestrator, not a universal optimizer for every neural-network
architecture. It dispatches a user's image/audio/video fine-tuning job to a
trusted, server-installed training script (for example, a compatible
Diffusers/Transformers training recipe). Model architectures need different
training code and dataset formats.

Directory layout under --root:
  models/<owner_id>/...
  datasets/<owner_id>/...
  trainers/...
  outputs/<owner_id>/<job_id>/...
  state/<owner_id>/<job_id>.json and .log

Example:
  python gen3_multimodal_trainer.py validate --config job.json --root /srv/gen3
  python gen3_multimodal_trainer.py run      --config job.json --root /srv/gen3
  python gen3_multimodal_trainer.py status   --owner user_123 --job job_001 --root /srv/gen3
  python gen3_multimodal_trainer.py cancel   --owner user_123 --job job_001 --root /srv/gen3

Security notes:
- Never let end users upload or choose the trainer Python file itself.
- Install reviewed trainers under <root>/trainers, owned by the server administrator.
- Give each user a separate OS/container/sandbox in production.
- Do not store API keys or secrets in job JSON files.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VALID_MODALITIES = {"image", "audio", "video"}
VALID_LAUNCHERS = {"python", "accelerate"}
OWNER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
JOB_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")
ALLOWED_PLACEHOLDERS = {
    "owner_id", "job_id", "modality", "task",
    "model_path", "dataset_path", "output_dir",
}

MEDIA_EXTENSIONS = {
    "image": {".jpg", ".jpeg", ".png", ".webp", ".bmp"},
    "audio": {".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac"},
    "video": {".mp4", ".mov", ".mkv", ".webm", ".avi"},
}


class ConfigError(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError(f"Fichier de configuration introuvable : {path}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"JSON invalide ligne {exc.lineno}, colonne {exc.colno}: {exc.msg}") from exc
    if not isinstance(payload, dict):
        raise ConfigError("La configuration doit être un objet JSON.")
    return payload


def safe_child(root: Path, relative: str, label: str) -> Path:
    """Resolve a relative path and refuse paths escaping the configured root."""
    if not isinstance(relative, str) or not relative.strip():
        raise ConfigError(f"'{label}' doit être un chemin relatif non vide.")
    p = Path(relative)
    if p.is_absolute():
        raise ConfigError(f"'{label}' doit être relatif à la racine Gen3, pas absolu.")
    resolved_root = root.resolve()
    resolved = (resolved_root / p).resolve()
    try:
        resolved.relative_to(resolved_root)
    except ValueError as exc:
        raise ConfigError(f"Le chemin '{label}' sort du répertoire autorisé.") from exc
    return resolved


def config_paths(cfg: dict[str, Any], root: Path) -> dict[str, Any]:
    for field in ("owner_id", "job_id", "modality", "task", "model_path",
                  "dataset_path", "output_dir", "trainer_script", "training_args"):
        if field not in cfg:
            raise ConfigError(f"Champ obligatoire absent : {field}")

    owner = str(cfg["owner_id"])
    job = str(cfg["job_id"])
    modality = str(cfg["modality"]).lower()
    task = str(cfg["task"])

    if not OWNER_RE.fullmatch(owner):
        raise ConfigError("owner_id invalide : utilisez lettres, chiffres, point, tiret ou underscore.")
    if not JOB_RE.fullmatch(job):
        raise ConfigError("job_id invalide : utilisez lettres, chiffres, point, tiret ou underscore.")
    if modality not in VALID_MODALITIES:
        raise ConfigError("modality doit être 'image', 'audio' ou 'video'.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", task):
        raise ConfigError("task doit être un identifiant court (lettres, chiffres, _ . -).")

    model_path = safe_child(root / "models" / owner, str(cfg["model_path"]), "model_path")
    dataset_path = safe_child(root / "datasets" / owner, str(cfg["dataset_path"]), "dataset_path")
    output_dir = safe_child(root / "outputs" / owner, str(cfg["output_dir"]), "output_dir")

    # The trainer path is rooted in the server-admin-controlled trainers directory.
    trainer_script = safe_child(root / "trainers", str(cfg["trainer_script"]), "trainer_script")
    if trainer_script.suffix.lower() != ".py":
        raise ConfigError("trainer_script doit pointer vers un fichier .py installé par l'administrateur.")

    launcher = str(cfg.get("launcher", "accelerate")).lower()
    if launcher not in VALID_LAUNCHERS:
        raise ConfigError("launcher doit être 'python' ou 'accelerate'.")

    training_args = cfg["training_args"]
    if not isinstance(training_args, list) or not all(isinstance(x, (str, int, float)) for x in training_args):
        raise ConfigError("training_args doit être une liste d'arguments, chaque élément étant une chaîne ou un nombre.")
    if len(training_args) > 500:
        raise ConfigError("Trop d'arguments dans training_args (maximum 500).")

    runtime_minutes = int(cfg.get("runtime_minutes", 60))
    if not 1 <= runtime_minutes <= 7 * 24 * 60:
        raise ConfigError("runtime_minutes doit être compris entre 1 et 10080.")
    min_gpu_gb = float(cfg.get("min_gpu_memory_gb", 0))
    if min_gpu_gb < 0 or min_gpu_gb > 1024:
        raise ConfigError("min_gpu_memory_gb doit être compris entre 0 et 1024.")

    paths = {
        "owner_id": owner,
        "job_id": job,
        "modality": modality,
        "task": task,
        "model_path": model_path,
        "dataset_path": dataset_path,
        "output_dir": output_dir,
        "trainer_script": trainer_script,
        "launcher": launcher,
        "training_args": [str(x) for x in training_args],
        "runtime_minutes": runtime_minutes,
        "min_gpu_memory_gb": min_gpu_gb,
        "allow_cpu": bool(cfg.get("allow_cpu", False)),
    }
    return paths


def count_media_files(dataset_path: Path, modality: str) -> int:
    if not dataset_path.exists() or not dataset_path.is_dir():
        return 0
    extensions = MEDIA_EXTENSIONS[modality]
    count = 0
    for path in dataset_path.rglob("*"):
        if path.is_file() and path.suffix.lower() in extensions:
            count += 1
    return count


def gpu_info() -> dict[str, Any]:
    info = {"torch_available": False, "cuda_available": False, "gpu_count": 0, "gpus": []}
    try:
        import torch  # Optional dependency; training environment should install it.
        info["torch_available"] = True
        info["cuda_available"] = bool(torch.cuda.is_available())
        if info["cuda_available"]:
            info["gpu_count"] = torch.cuda.device_count()
            for i in range(info["gpu_count"]):
                props = torch.cuda.get_device_properties(i)
                info["gpus"].append({
                    "index": i,
                    "name": props.name,
                    "total_memory_gb": round(props.total_memory / (1024 ** 3), 2),
                })
    except Exception as exc:
        info["torch_error"] = str(exc)
    return info


def status_file(root: Path, owner: str, job: str) -> Path:
    return root / "state" / owner / f"{job}.json"


def log_file(root: Path, owner: str, job: str) -> Path:
    return root / "state" / owner / f"{job}.log"


def write_status(path: Path, status: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def validate_job(cfg: dict[str, Any], root: Path, check_gpu: bool = True) -> tuple[dict[str, Any], list[str]]:
    paths = config_paths(cfg, root)
    problems: list[str] = []

    if not paths["model_path"].exists():
        problems.append(f"Modèle absent : {paths['model_path']}")
    elif paths["model_path"].is_dir() and not any(paths["model_path"].iterdir()):
        problems.append(f"Le dossier du modèle est vide : {paths['model_path']}")

    if not paths["dataset_path"].exists() or not paths["dataset_path"].is_dir():
        problems.append(f"Dataset absent ou non-répertoire : {paths['dataset_path']}")
    else:
        media_count = count_media_files(paths["dataset_path"], paths["modality"])
        if media_count < 1:
            suffixes = ", ".join(sorted(MEDIA_EXTENSIONS[paths["modality"]]))
            problems.append(f"Aucun fichier média {paths['modality']} détecté dans le dataset (extensions attendues : {suffixes}).")

    if not paths["trainer_script"].is_file():
        problems.append(f"Script d'entraînement administrateur introuvable : {paths['trainer_script']}")

    if paths["output_dir"] == root.resolve() or root.resolve() not in paths["output_dir"].parents:
        problems.append("Répertoire de sortie non autorisé.")
    if paths["output_dir"].exists() and any(paths["output_dir"].iterdir()):
        if not bool(cfg.get("allow_overwrite_output", False)):
            problems.append(f"Le répertoire de sortie n'est pas vide : {paths['output_dir']} (utilisez un nouveau job_id ou définissez allow_overwrite_output=true).")

    # Check placeholders before starting any process.
    allowed = ALLOWED_PLACEHOLDERS
    for arg in paths["training_args"]:
        for name in PLACEHOLDER_RE.findall(arg):
            if name not in allowed:
                problems.append(f"Placeholder interdit dans training_args : {{{name}}}")
        # Reject brace expressions that were not recognized cleanly.
        if ("{" in arg or "}" in arg) and not PLACEHOLDER_RE.search(arg):
            problems.append(f"Placeholder mal formé dans un argument : {arg}")

    if check_gpu:
        info = gpu_info()
        if not paths["allow_cpu"] and not info["cuda_available"]:
            problems.append("Aucun GPU CUDA détecté. Installez PyTorch CUDA et attribuez un GPU au serveur, ou définissez allow_cpu=true pour un test très lent.")
        if info["cuda_available"] and paths["min_gpu_memory_gb"] > 0:
            max_memory = max((x["total_memory_gb"] for x in info["gpus"]), default=0)
            if max_memory < paths["min_gpu_memory_gb"]:
                problems.append(
                    f"GPU insuffisant : {max_memory} Go détectés, "
                    f"{paths['min_gpu_memory_gb']} Go demandés au minimum."
                )

    return paths, problems


def build_command(paths: dict[str, Any]) -> list[str]:
    script_path = str(paths["trainer_script"])
    if paths["launcher"] == "accelerate":
        cmd = ["accelerate", "launch", script_path]
    else:
        cmd = [sys.executable, script_path]

    values = {
        "owner_id": paths["owner_id"],
        "job_id": paths["job_id"],
        "modality": paths["modality"],
        "task": paths["task"],
        "model_path": str(paths["model_path"]),
        "dataset_path": str(paths["dataset_path"]),
        "output_dir": str(paths["output_dir"]),
    }
    # Build each argv element separately: no shell and no string command evaluation.
    for raw_arg in paths["training_args"]:
        def replace(match: re.Match) -> str:
            key = match.group(1)
            if key not in ALLOWED_PLACEHOLDERS:
                raise ConfigError(f"Placeholder interdit : {{{key}}}")
            return values[key]
        cmd.append(PLACEHOLDER_RE.sub(replace, raw_arg))
    return cmd


def cmd_validate(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    cfg = load_json(Path(args.config))
    try:
        paths, problems = validate_job(cfg, root, check_gpu=not args.skip_gpu_check)
    except ConfigError as exc:
        print(f"ERREUR CONFIGURATION : {exc}", file=sys.stderr)
        return 2

    print(f"Modality       : {paths['modality']}")
    print(f"Task           : {paths['task']}")
    print(f"Model          : {paths['model_path']}")
    print(f"Dataset        : {paths['dataset_path']}")
    print(f"Output         : {paths['output_dir']}")
    print(f"Trusted trainer: {paths['trainer_script']}")
    print(f"GPU            : {json.dumps(gpu_info(), ensure_ascii=False)}")
    if problems:
        print("\nValidation échouée :")
        for problem in problems:
            print(f" - {problem}")
        return 1
    print("\nConfiguration valide. Cela vérifie les chemins et les ressources, pas la compatibilité du modèle avec le trainer.")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    cfg = load_json(Path(args.config))
    try:
        paths, problems = validate_job(cfg, root, check_gpu=not args.skip_gpu_check)
    except ConfigError as exc:
        print(f"ERREUR CONFIGURATION : {exc}", file=sys.stderr)
        return 2

    if problems:
        print("Entraînement non lancé :")
        for problem in problems:
            print(f" - {problem}", file=sys.stderr)
        return 1

    state_path = status_file(root, paths["owner_id"], paths["job_id"])
    logfile = log_file(root, paths["owner_id"], paths["job_id"])
    state_path.parent.mkdir(parents=True, exist_ok=True)
    if state_path.exists():
        existing = json.loads(state_path.read_text(encoding="utf-8"))
        if existing.get("status") == "running":
            print("Un job portant cet identifiant est déjà marqué comme actif.", file=sys.stderr)
            return 1

    paths["output_dir"].mkdir(parents=True, exist_ok=True)
    command = build_command(paths)
    info = gpu_info()
    status = {
        "owner_id": paths["owner_id"], "job_id": paths["job_id"],
        "modality": paths["modality"], "task": paths["task"],
        "status": "starting", "created_at": now_iso(), "started_at": None,
        "finished_at": None, "return_code": None, "pid": None,
        "model_path": str(paths["model_path"]),
        "dataset_path": str(paths["dataset_path"]),
        "output_dir": str(paths["output_dir"]),
        "trainer_script": str(paths["trainer_script"]),
        "runtime_minutes": paths["runtime_minutes"], "gpu": info,
        "command": command, "log_file": str(logfile),
    }
    write_status(state_path, status)

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["GEN3_OWNER_ID"] = paths["owner_id"]
    env["GEN3_JOB_ID"] = paths["job_id"]
    env["GEN3_MODALITY"] = paths["modality"]

    child = None

    def terminate_child(signum=None, frame=None):
        nonlocal child
        if child is not None and child.poll() is None:
            try:
                child.terminate()
                child.wait(timeout=20)
            except Exception:
                try:
                    child.kill()
                except Exception:
                    pass
        raise SystemExit(128 + int(signum or signal.SIGTERM))

    signal.signal(signal.SIGTERM, terminate_child)
    signal.signal(signal.SIGINT, terminate_child)

    try:
        with logfile.open("a", encoding="utf-8") as log:
            log.write(f"\n[{now_iso()}] Starting Gen3 job {paths['job_id']}\n")
            log.write("Command: " + json.dumps(command, ensure_ascii=False) + "\n")
            log.flush()
            child = subprocess.Popen(
                command,
                cwd=str(root),
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                shell=False,
                start_new_session=True,
            )
            status.update({"status": "running", "started_at": now_iso(), "pid": child.pid})
            write_status(state_path, status)
            try:
                return_code = child.wait(timeout=paths["runtime_minutes"] * 60)
            except subprocess.TimeoutExpired:
                log.write(f"\n[{now_iso()}] Runtime limit reached; terminating job.\n")
                log.flush()
                child.terminate()
                try:
                    return_code = child.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    child.kill()
                    return_code = child.wait()
                status.update({
                    "status": "timeout", "finished_at": now_iso(),
                    "return_code": return_code,
                    "error": f"Limite de durée atteinte ({paths['runtime_minutes']} minutes).",
                })
                write_status(state_path, status)
                print(f"Limite de durée atteinte. Journal : {logfile}")
                return 124

            final_status = "completed" if return_code == 0 else "failed"
            status.update({
                "status": final_status, "finished_at": now_iso(),
                "return_code": return_code,
            })
            write_status(state_path, status)
            print(f"Job {paths['job_id']} : {final_status}")
            print(f"Journal : {logfile}")
            print(f"Sortie : {paths['output_dir']}")
            return int(return_code)
    except FileNotFoundError as exc:
        status.update({
            "status": "failed", "finished_at": now_iso(),
            "error": f"Commande de lancement introuvable : {exc}",
        })
        write_status(state_path, status)
        print(f"Commande introuvable : {exc}", file=sys.stderr)
        return 127
    except SystemExit:
        status.update({"status": "cancelled", "finished_at": now_iso(), "error": "Arrêt demandé."})
        write_status(state_path, status)
        raise
    except Exception as exc:
        status.update({
            "status": "failed", "finished_at": now_iso(),
            "error": str(exc), "traceback": traceback.format_exc(),
        })
        write_status(state_path, status)
        print(f"Échec : {exc}", file=sys.stderr)
        return 1


def cmd_status(args: argparse.Namespace) -> int:
    path = status_file(Path(args.root).resolve(), args.owner, args.job)
    if not path.is_file():
        print(f"État introuvable : {path}", file=sys.stderr)
        return 1
    print(path.read_text(encoding="utf-8"))
    return 0


def cmd_cancel(args: argparse.Namespace) -> int:
    path = status_file(Path(args.root).resolve(), args.owner, args.job)
    if not path.is_file():
        print("Job introuvable.", file=sys.stderr)
        return 1
    status = json.loads(path.read_text(encoding="utf-8"))
    if status.get("status") != "running" or not status.get("pid"):
        print(f"Le job n'est pas actif (statut : {status.get('status')}).")
        return 0
    pid = int(status["pid"])
    try:
        os.kill(pid, signal.SIGTERM)
        print(f"Signal d'arrêt envoyé au processus {pid}.")
        return 0
    except ProcessLookupError:
        status.update({"status": "unknown", "error": "PID absent au moment de l'arrêt.", "finished_at": now_iso()})
        write_status(path, status)
        print("Processus non trouvé; état mis à jour.")
        return 1
    except PermissionError:
        print("Permission insuffisante pour arrêter le processus.", file=sys.stderr)
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Orchestrateur Gen3 pour les jobs d'entraînement d'images, audio et vidéo."
    )
    sub = parser.add_subparsers(dest="action", required=True)

    for action in ("validate", "run"):
        p = sub.add_parser(action)
        p.add_argument("--config", required=True, help="Chemin vers le fichier JSON du job.")
        p.add_argument("--root", default=os.environ.get("GEN3_ROOT", "./gen3_data"),
                       help="Racine serveur contenant models/, datasets/, trainers/, outputs/ et state/.")
        if action == "validate":
            p.add_argument("--skip-gpu-check", action="store_true",
                           help="Vérifier les chemins même si le GPU n'est pas disponible.")
            p.set_defaults(func=cmd_validate)
        else:
            p.add_argument("--skip-gpu-check", action="store_true",
                           help="Désactiver le contrôle GPU (ne rend pas l'entraînement possible sans GPU).")
            p.set_defaults(func=cmd_run)

    for action in ("status", "cancel"):
        p = sub.add_parser(action)
        p.add_argument("--owner", required=True)
        p.add_argument("--job", required=True)
        p.add_argument("--root", default=os.environ.get("GEN3_ROOT", "./gen3_data"))
        p.set_defaults(func=cmd_status if action == "status" else cmd_cancel)

    args = parser.parse_args()
    try:
        return args.func(args)
    except ConfigError as exc:
        print(f"ERREUR : {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

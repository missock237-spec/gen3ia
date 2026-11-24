#!/usr/bin/env python3
"""Publication HF v5 — upload unique du dossier des médias réels.

Contexte (rapport docs/rapports/rapport-v5-2026-11-24.md §1.5) :
l'upload des médias v5 était en attente du quota de commits HF (128/h).
Ce script publie l'intégralité du contenu de datasets/v5-medias.tar.gz en
UN SEUL commit via upload_folder :

  - vision_professionnel/images/  : 600 images réelles CIFAR-10 (32×32 → JPG)
  - parole_professionnelle/       : 30 clips réels LibriSpeech (FLAC 16 kHz)
  - videos_professionnel/         : 40 clips MP4 640×360@25 fps (Ken Burns,
                                    composés par ffmpeg depuis les images réelles)

Usage :
    HF_TOKEN=hf_xxx python3 scripts/publish_hf_v5.py [--repo Kings237/gen3ia-media-engine]

Le jeton n'est jamais imprimé. Idempotent : les fichiers identiques ne
produisent pas de nouveau commit (sauvegarde dédupliquée côté HF).
"""
import argparse
import os
import shutil
import sys
import tarfile
import tempfile

REPO_DEFAUT = "Kings237/gen3ia-media-engine"
CHEMIN_ARCHIVE = os.path.join("datasets", "v5-medias.tar.gz")
PREFIXE_DEST = "v5/medias"

ATTENDUS = {"vision_professionnel/images": 600,
            "parole_professionnelle": 30,
            "videos_professionnel": 40}


def principale() -> int:
    parseur = argparse.ArgumentParser(description=__doc__)
    parseur.add_argument("--repo", default=REPO_DEFAUT)
    args = parseur.parse_args()

    jeton = os.environ.get("HF_TOKEN", "").strip()
    if not jeton:
        print("ECHEC: HF_TOKEN manquant dans l'environnement (jamais imprimé).")
        return 2
    if not os.path.exists(CHEMIN_ARCHIVE):
        print(f"ECHEC: archive introuvable: {CHEMIN_ARCHIVE}")
        return 2

    from huggingface_hub import HfApi

    api = HfApi(token=jeton)
    try:
        qui = api.whoami()
        print(f"HF auth OK: {qui.get('name')} (jeton masqué)")
    except Exception as exc:  # noqa: BLE001
        print(f"ECHEC auth HF: {type(exc).__name__} {str(exc)[:120]}")
        return 2

    # 1. Vérifier la composition de l'archive avant tout upload.
    with tarfile.open(CHEMIN_ARCHIVE, "r:gz") as tar:
        membres = [m for m in tar.getmembers() if m.isfile()]
    par_racine: dict[str, int] = {}
    for m in membres:
        racine = os.path.join(*m.name.split(os.sep)[:2]) if "/" in m.name else m.name
        racine = "/".join(m.name.split("/")[:2]) if "/" in m.name else m.name
        par_racine[racine] = par_racine.get(racine, 0) + 1
    total = len(membres)
    attendu_total = sum(ATTENDUS.values())
    print(f"Archive: {total} fichiers réels (attendu {attendu_total})")
    for racine, n in sorted(par_racine.items()):
        print(f"  {racine}: {n}")
    if total < attendu_total:
        print("ECHEC: archive incomplète — upload annulé (aucune donnée inventée).")
        return 3

    # 2. Extraction dans un dossier temporaire (nettoyé en sortie).
    tmp = tempfile.mkdtemp(prefix="v5medias-")
    try:
        with tarfile.open(CHEMIN_ARCHIVE, "r:gz") as tar:
            tar.extractall(tmp)  # noqa: S202 — archive interne versionnée
        commit = (
            "v5: médias réels — 600 images CIFAR-10, 30 clips LibriSpeech, "
            "40 vidéos ffmpeg (upload unique, quota commits respecté)"
        )
        api.upload_folder(
            folder_path=tmp,
            repo_id=args.repo,
            repo_type="model",
            path_in_repo=PREFIXE_DEST,
            commit_message=commit,
        )
        print(f"Upload dossier terminé → {args.repo}::{PREFIXE_DEST}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # 3. Vérification post-upload (comptage réel côté HF).
    fichiers = api.list_repo_files(repo_id=args.repo, repo_type="model")
    distants = [f for f in fichiers if f.startswith(PREFIXE_DEST + "/")]
    print(f"Vérification: {len(distants)} fichiers sous {PREFIXE_DEST}/ (attendu ≥ {attendu_total})")
    if len(distants) < attendu_total:
        print("ATTENTION: moins de fichiers que prévu côté HF.")
        return 4
    print("OK: médias v5 publiés et vérifiés.")
    return 0


if __name__ == "__main__":
    sys.exit(principale())

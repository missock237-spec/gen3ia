#!/usr/bin/env python3
"""Préparation du dataset IMAGE photoréaliste pour l'entraînement LoRA SDXL de gen3.

Entrée  : un dossier d'images (.jpg/.png/.webp) avec, pour chaque image,
          une légende dans un fichier .txt de même nom (chat.jpg -> chat.txt),
          OU --auto_caption (GPU uniquement) pour légendage automatique BLIP.
Sortie  : data/images/train.jsonl + validation.jsonl
          {"image_path": ..., "caption": ..., "width": ..., "height": ..., "sha256": ...}

Garanties : dédoublonnage par empreinte SHA-256 du CONTENU, légendes non vides,
split déterministe (graine fixe), chemins relatifs au dataset (portable Colab/Drive).
Le noyau (manifest + dédoublonnage + split) est testable SANS torch ni GPU.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from pathlib import Path

EXTENSIONS_IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
MIN_LEGENDE_CAR = 3
MAX_LEGENDE_CAR = 1000


def empreinte(fichier: Path) -> str:
    h = hashlib.sha256()
    with open(fichier, "rb") as f:
        for bloc in iter(lambda: f.read(1 << 20), b""):
            h.update(bloc)
    return h.hexdigest()


def dimensions(fichier: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(fichier) as im:
        return im.size


def lire_legende(image: Path) -> str:
    txt = image.with_suffix(".txt")
    if not txt.exists():
        return ""
    return " ".join(txt.read_text(encoding="utf-8", errors="replace").split()).strip()


def legender_automatiquement(image: Path) -> str:
    """Légendage BLIP (GPU). Import paresseux : jamais exécuté côté sandbox."""
    import torch
    from PIL import Image
    from transformers import BlipForConditionalGeneration, BlipProcessor

    device = "cuda" if torch.cuda.is_available() else "cpu"
    processeur = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-large")
    modele = BlipForConditionalGeneration.from_pretrained(
        "Salesforce/blip-image-captioning-large", torch_dtype=torch.float16
    ).to(device)
    with Image.open(image) as im:
        im = im.convert("RGB")
        entrees = processeur(im, return_tensors="pt").to(device, torch.float16)
    with torch.no_grad():
        ids = modele.generate(**entrees, max_new_tokens=48)
    return processeur.decode(ids[0], skip_special_tokens=True).strip()


def construire_manifest(dossier: Path, auto_caption: bool = False) -> list[dict]:
    """Scanne le dossier, dédoublonne par contenu, retourne les enregistrements."""
    images = sorted(p for p in dossier.rglob("*") if p.suffix.lower() in EXTENSIONS_IMAGE)
    if not images:
        raise SystemExit(f"Aucune image trouvée dans {dossier}")

    vus: dict[str, str] = {}
    records: list[dict] = []
    rejetes = {"doublon": 0, "sans_legende": 0, "legende_courte": 0, "illisible": 0}

    for image in images:
        try:
            cle = empreinte(image)
            largeur, hauteur = dimensions(image)
        except Exception:
            rejetes["illisible"] += 1
            continue
        if cle in vus:
            rejetes["doublon"] += 1
            continue
        legende = lire_legende(image)
        if not legende and auto_caption:
            legende = legender_automatiquement(image).strip()
        if not legende:
            rejetes["sans_legende"] += 1
            continue
        if len(legende) < MIN_LEGENDE_CAR:
            rejetes["legende_courte"] += 1
            continue
        vus[cle] = str(image.relative_to(dossier))
        records.append(
            {
                "image_path": vus[cle],
                "caption": legende[:MAX_LEGENDE_CAR],
                "width": largeur,
                "height": hauteur,
                "sha256": cle,
            }
        )

    if not records:
        raise SystemExit(
            f"Dataset vide après filtrage (rejets : {rejetes}). Ajoutez un fichier .txt de "
            "légende par image, ou lancez avec --auto_caption sur GPU."
        )
    print(f"[images] retenus : {len(records)} | rejets : {rejetes}")
    return records


def split_jsonl(records: list[dict], sortie: Path, ratio_validation: float, graine: int = 42) -> None:
    rng = random.Random(graine)
    melanges = records[:]
    rng.shuffle(melanges)
    n_val = max(1, int(len(melanges) * ratio_validation)) if len(melanges) > 4 else 0
    val, train = melanges[:n_val], melanges[n_val:]
    sortie.mkdir(parents=True, exist_ok=True)
    for nom, part in (("train.jsonl", train), ("validation.jsonl", val)):
        chemin = sortie / nom
        with open(chemin, "w", encoding="utf-8") as f:
            for r in part:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"[images] {chemin} : {len(part)} exemples")


def main() -> None:
    p = argparse.ArgumentParser(description="Prépare le dataset image (JSONL train/validation).")
    p.add_argument("--dossier", required=True, help="Dossier des images (+ .txt de légendes).")
    p.add_argument("--sortie", default="data/images", help="Dossier de sortie JSONL.")
    p.add_argument("--ratio_validation", type=float, default=0.05)
    p.add_argument("--auto_caption", action="store_true",
                   help="Légendage BLIP automatique (GPU requis, plus lent).")
    args = p.parse_args()

    dossier = Path(args.dossier)
    if not dossier.is_dir():
        raise SystemExit(f"Dossier introuvable : {dossier}")

    records = construire_manifest(dossier, auto_caption=args.auto_caption)
    split_jsonl(records, Path(args.sortie), args.ratio_validation)


if __name__ == "__main__":
    main()

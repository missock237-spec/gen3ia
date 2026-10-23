#!/usr/bin/env python3
"""Pont gen3 ↔ modèles multimédia — service FastAPI exécuté SUR la machine GPU.

Rôle honnête : gen3ia.online tourne sur un VPS 2 Go SANS GPU ; les modèles SDXL /
F5-TTS / LTX-Video ne peuvent PAS y tourner. Ce pont expose les trois moteurs
entraînés par ce pack via une API REST, à héberger là où se trouve le GPU
(Colab tunnelé, RunPod, Vast.ai, serveur L4/A100). Le backend gen3 appelle
MEDIA_BRIDGE_URL avec la clé partagée.

Sécurité : clé API comparée en temps constant (secrets.compare_digest), quotas
de taille, GET /capabilities ne déclare QUE ce qui tourne réellement ici
(convention honnêteté gen3 — jamais de capacité CPU).

Lancement : MEDIA_BRIDGE_API_KEY=... python gen3_media_bridge.py --port 8787
"""

from __future__ import annotations

import argparse
import base64
import os
import secrets as pysecrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from profils import ErreurProfil, select_profile, vram_disponible_go

app = FastAPI(title="Gen3 Media Bridge", version="1.0.0")
PACK = Path(__file__).resolve().parent.parent


class DemandeImage(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    largeur: int = Field(default=1024, ge=256, le=2048)
    hauteur: int = Field(default=1024, ge=256, le=2048)
    steps: int = Field(default=30, ge=8, le=80)
    graine: int | None = None


class DemandeTts(BaseModel):
    texte: str = Field(min_length=1, max_length=4000)
    moteur: str = Field(default="f5", pattern="^(f5|kokoro)$")
    ref: str | None = None
    langue: str = "f"
    voix: str = "ff_siwis"


class DemandeVideo(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    largeur: int = Field(default=480, ge=256, le=1024)
    hauteur: int = Field(default=288, ge=256, le=1024)
    frames: int = Field(default=41, ge=9, le=161)
    steps: int = Field(default=40, ge=8, le=80)
    graine: int | None = None


def verifier_cle(authorization: str) -> None:
    attendue = os.environ.get("MEDIA_BRIDGE_API_KEY", "")
    if not attendue:
        raise HTTPException(503, "MEDIA_BRIDGE_API_KEY non configurée sur le pont.")
    fournie = authorization.removeprefix("Bearer ").strip()
    if not fournie or not pysecrets.compare_digest(fournie, attendue):
        raise HTTPException(401, "Clé API invalide.")


def generer(sous_commande: str, arguments: list[str]) -> dict:
    """Exécute infer_media.py en subprocess, borne la durée, retourne le média en base64."""
    sortie = Path(tempfile.mkstemp(suffix={"image": ".png", "tts": ".wav", "video": ".mp4"}[sous_commande])[1])
    cmd = [sys.executable, str(PACK / "infer_media.py"), sous_commande, *arguments, "--out", str(sortie)]
    debut = time.perf_counter()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Génération > 30 min — abandonnée (borne honnête).")
    if proc.returncode != 0:
        raise HTTPException(500, f"Échec génération {sous_commande} : {proc.stderr[-400:]}")
    if not sortie.exists():
        raise HTTPException(500, "Le moteur n'a produit aucun fichier.")
    contenu = base64.b64encode(sortie.read_bytes()).decode("ascii")
    taille = sortie.stat().st_size
    sortie.unlink(missing_ok=True)
    return {"mime": {"image": "image/png", "tts": "audio/wav", "video": "video/mp4"}[sous_commande],
            "base64": contenu, "octets": taille, "gpu_secondes": round(time.perf_counter() - debut, 2)}


@app.get("/capabilities")
def capabilities() -> JSONResponse:
    """Convention honnêteté gen3 : ne déclare QUE les capacités réellement disponibles ici."""
    try:
        nom_profil, profil = select_profile("auto")
        return JSONResponse({
            "gpu": True,
            "profil": nom_profil,
            "vram_go": vram_disponible_go(),
            "capacites": ["image.generate", "tts.speak", "video.generate"],
            "engines": {
                "image": "SDXL 1.0 + LoRA gen3",
                "tts": "F5-TTS (CC-BY-NC) ou Kokoro (Apache-2.0)",
                "video": "LTX-Video 0.9.7 + LoRA gen3",
            },
        })
    except ErreurProfil as erreur:
        return JSONResponse({"gpu": False, "capacites": [], "refus": str(erreur)}, status_code=200)


@app.post("/v1/image")
def image_gen(d: DemandeImage, authorization: str = Header(default="")) -> dict:
    verifier_cle(authorization)
    args = ["--prompt", d.prompt, "--largeur", str(d.largeur), "--hauteur", str(d.hauteur),
            "--steps", str(d.steps)]
    if d.graine is not None:
        args += ["--graine", str(d.graine)]
    return generer("image", args)


@app.post("/v1/tts")
def tts_gen(d: DemandeTts, authorization: str = Header(default="")) -> dict:
    verifier_cle(authorization)
    args = ["--texte", d.texte, "--moteur", d.moteur, "--langue", d.langue, "--voix", d.voix]
    if d.ref:
        args += ["--ref", d.ref]
    return generer("tts", args)


@app.post("/v1/video")
def video_gen(d: DemandeVideo, authorization: str = Header(default="")) -> dict:
    verifier_cle(authorization)
    args = ["--prompt", d.prompt, "--largeur", str(d.largeur), "--hauteur", str(d.hauteur),
            "--frames", str(d.frames), "--steps", str(d.steps)]
    if d.graine is not None:
        args += ["--graine", str(d.graine)]
    return generer("video", args)


if __name__ == "__main__":
    import uvicorn

    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    args = p.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)

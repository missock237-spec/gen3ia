#!/usr/bin/env python3
"""it.99 — Conversion FLEURS WAV → Opus (décision it.98).

Les 20 audios FLEURS fr_fr (WAV PCM 16 bits) pèsent 9,64 Mo sur les
12,81 Mo du module multimodal — le goulot qui empêche la tranche +12 de
passer sous le plafond de 15 Mo. Opus 24 kbps VBR (mono, voix) est
transparent pour la parole : gain attendu ~9 Mo (~10×).

Fait :
  1. convertit public/multimodal-it90/audio/audio_0XX.wav → .opus (ffmpeg
     libopus 24 kbps VBR, fréquence conservée) ;
  2. VÉRIFIE chaque opus (ffprobe : décodable, durée ±0,3 s de l'original) ;
  3. met à jour var/entrainement-multimodal-it90/assets.json ET le miroir
     var-copie/assets.json (file, bytes, sha256, total_octets) ;
  4. supprime les .wav seulement si TOUTES les conversions sont validées.
"""
import hashlib
import json
import os
import subprocess
import sys

AUDIO_DIR = "public/multimodal-it90/audio"
INVENTAIRES = [
    "var/entrainement-multimodal-it90/assets.json",
    "var-copie/assets.json",
]


def sha16(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]


def probe(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, timeout=30,
    )
    return float(out.stdout.strip())


def main() -> int:
    inv = json.load(open(INVENTAIRES[0]))
    audios = [a for a in inv["assets"] if a["modality"] == "audio" and a["file"].endswith(".wav")]
    print(f"{len(audios)} audios WAV à convertir")
    convertis = 0
    for a in audios:
        wav = a["file"]
        opus = wav[:-4] + ".opus"
        if not os.path.exists(wav):
            print(f"  ABSENT: {wav}", file=sys.stderr)
            return 1
        avant = probe(wav)
        r = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", wav, "-c:a", "libopus",
             "-b:a", "24k", "-vbr", "on", "-ar", "16000", "-ac", "1", opus],
            timeout=60,
        )
        if r.returncode != 0:
            print(f"  ffmpeg ÉCHEC: {wav}", file=sys.stderr)
            return 1
        apres = probe(opus)
        if abs(apres - avant) > 0.3:
            print(f"  durée divergente {wav}: {avant:.2f}s → {apres:.2f}s", file=sys.stderr)
            os.remove(opus)
            return 1
        taille_wav = os.path.getsize(wav)
        taille_opus = os.path.getsize(opus)
        if taille_opus >= taille_wav:
            print(f"  opus plus gros (?): {opus}", file=sys.stderr)
            os.remove(opus)
            return 1
        a["file"] = opus
        a["bytes"] = taille_opus
        a["sha256"] = sha16(opus)
        convertis += 1
        print(f"  {os.path.basename(wav)} {taille_wav/1024:.0f} Ko → {taille_opus/1024:.0f} Ko ({taille_wav/taille_opus:.1f}×), durée {avant:.2f}s OK")
    # total_octets recalculé (images/vidéos/TTS inchangés)
    total = 0
    for a in inv["assets"]:
        chemin = a["file"]
        chemin = chemin if os.path.exists(chemin) else ("public" + chemin if os.path.exists("public" + chemin) else None)
        if chemin is None:
            # TTS et autres : conservés tels quels (déjà comptés)
            total += a["bytes"]
        else:
            total += os.path.getsize(chemin)
    inv["total_octets"] = total
    for p in INVENTAIRES:
        json.dump(inv, open(p, "w"), ensure_ascii=False, indent=2)
    # suppression des WAV une fois tout validé
    for a in audios:
        os.remove(a["file"].replace(".opus", ".wav"))
    print(f"CONVERSION OK : {convertis}/20 opus, total inventaire = {total/1e6:.2f} Mo")
    return 0


if __name__ == "__main__":
    sys.exit(main())

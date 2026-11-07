#!/usr/bin/env python3
"""Téléchargement des ASSETS MULTIMODAUX RÉELS — fenêtre it.121.

Sources professionnelles (datasets-server Hugging Face, publics — jeton non
requis pour ces fenêtres) :
  - IMAGES : rafaelpadilla/coco2017 (val) — fenêtre SUIVANTE après it.120
    (offset 564) — 20 images photoréalistes + annotations d'objets RÉELLES.
  - AUDIO  : google/fleurs (fr_fr, validation) — fenêtre SUIVANTE (offset 220)
    — 8 clips de parole française naturelle RÉELLE + transcriptions
    officielles.
  - VIDÉO  : sayakpaul/ucf101-subset (train, offset 4) — la fenêtre est
    ÉPUISÉE depuis it.90 (le split ne contient que 2 lignes, intégrées
    it.90) : la requête est refaite pour la PREUVE du zéro (honnêteté —
    le rapport it.121 comptera 0 vidéo si la fenêtre renvoie 0 ligne).

Chaque fichier est enregistré dans public/multimodal-it121/ avec ses
métadonnées mesurées (octets, sha256, source, légende/annotation réelle)
dans var/entrainement-multimodal-it121/assets.json. Budget ~10 Mo max.
"""

import hashlib
import json
import os
import urllib.parse
import urllib.request

BASE = "https://datasets-server.huggingface.co/rows"
OUT = "public/multimodal-it121"
VAR = "var/entrainement-multimodal-it121"

SOURCES = [
    {
        "modality": "image",
        "dataset": "rafaelpadilla/coco2017",
        "config": "default",
        "split": "val",
        "offset": 584,
        "n": 20,
        "dir": "images",
        "ext": "jpg",
        "champ_media": "image",
        "legende": None,  # construite depuis objects.label (liste « 90 things »)
        "id_champ": "image_id",
    },
    {
        "modality": "audio",
        "dataset": "google/fleurs",
        "config": "fr_fr",
        "split": "validation",
        "offset": 220,
        "n": 8,
        "dir": "audio",
        "ext": "wav",
        "champ_media": "audio",  # champ LISTE : row["audio"][0]["src"]
        "legende": lambda row: row.get("raw_transcription") or row.get("transcription", ""),
        "id_champ": "id",
    },
    {
        "modality": "video",
        "dataset": "sayakpaul/ucf101-subset",
        "config": "default",
        "split": "train",
        "offset": 4,
        "n": 2,
        "dir": "video",
        "ext": "mp4",
        "champ_media": "video",
        "legende": None,  # légende HONNÊTE générique (aucun label inventé)
        "id_champ": "video_id",
    },
]


# Catégories COCO du dataset rafaelpadilla/coco2017 — liste « 90 things »
# (identique aux ticks it.90/94/95/96/97, vérifiée sur pièce).
COCO80 = {
    1: "person", 2: "bicycle", 3: "car", 4: "motorcycle", 5: "airplane", 6: "bus",
    7: "train", 8: "truck", 9: "boat", 10: "traffic light", 11: "fire hydrant",
    12: "street sign", 13: "stop sign", 14: "parking meter", 15: "bench",
    16: "bird", 17: "cat", 18: "dog", 19: "horse", 20: "sheep", 21: "cow",
    22: "elephant", 23: "bear", 24: "zebra", 25: "giraffe", 26: "hat",
    27: "backpack", 28: "umbrella", 29: "shoe", 30: "eye glasses",
    31: "handbag", 32: "tie", 33: "suitcase", 34: "frisbee", 35: "skis",
    36: "snowboard", 37: "sports ball", 38: "kite", 39: "baseball bat",
    40: "baseball glove", 41: "skateboard", 42: "surfboard", 43: "tennis racket",
    44: "bottle", 45: "plate", 46: "wine glass", 47: "cup", 48: "fork",
    49: "knife", 50: "spoon", 51: "bowl", 52: "banana", 53: "apple",
    54: "sandwich", 55: "orange", 56: "broccoli", 57: "carrot", 58: "hot dog",
    59: "pizza", 60: "donut", 61: "cake", 62: "chair", 63: "couch",
    64: "potted plant", 65: "bed", 66: "mirror", 67: "dining table",
    68: "window", 69: "desk", 70: "toilet", 71: "door", 72: "tv", 73: "laptop",
    74: "mouse", 75: "remote", 76: "keyboard", 77: "cell phone", 78: "microwave",
    79: "oven", 80: "toaster", 81: "sink", 82: "refrigerator", 83: "blender",
    84: "book", 85: "clock", 86: "vase", 87: "scissors", 88: "teddy bear",
    89: "hair drier", 90: "toothbrush",
}

FR = {
    "person": "personne", "bicycle": "vélo", "car": "voiture", "motorcycle": "moto",
    "airplane": "avion", "bus": "bus", "train": "train", "truck": "camion",
    "boat": "bateau", "traffic light": "feu tricolore", "fire hydrant": "borne incendie",
    "stop sign": "panneau stop", "parking meter": "parcmètre", "bench": "banc",
    "bird": "oiseau", "cat": "chat", "dog": "chien", "horse": "cheval",
    "sheep": "mouton", "cow": "vache", "elephant": "éléphant", "bear": "ours",
    "zebra": "zèbre", "giraffe": "girafe", "backpack": "sac à dos", "umbrella": "parapluie",
    "handbag": "sac à main", "tie": "cravate", "suitcase": "valise", "frisbee": "frisbee",
    "skis": "skis", "snowboard": "snowboard", "sports ball": "ballon",
    "kite": "cerf-volant", "baseball bat": "batte de baseball",
    "baseball glove": "gant de baseball", "skateboard": "skateboard",
    "surfboard": "planche de surf", "tennis racket": "raquette de tennis",
    "bottle": "bouteille", "wine glass": "verre à vin", "cup": "tasse", "fork": "fourchette",
    "knife": "couteau", "spoon": "cuillère", "bowl": "bol", "banana": "banane",
    "apple": "pomme", "sandwich": "sandwich", "orange": "orange", "broccoli": "brocoli",
    "carrot": "carotte", "hot dog": "hot-dog", "pizza": "pizza", "donut": "donut",
    "cake": "gâteau", "chair": "chaise", "couch": "canapé", "potted plant": "plante en pot",
    "bed": "lit", "dining table": "table", "toilet": "toilettes", "tv": "téléviseur",
    "laptop": "ordinateur portable", "mouse": "souris", "remote": "télécommande",
    "keyboard": "clavier", "cell phone": "téléphone portable", "microwave": "micro-ondes",
    "oven": "four", "toaster": "grille-pain", "sink": "évier", "refrigerator": "réfrigérateur",
    "book": "livre", "clock": "horloge", "vase": "vase", "scissors": "ciseaux",
    "teddy bear": "ours en peluche", "hair drier": "sèche-cheveux", "toothbrush": "brosse à dents",
    "street sign": "panneau de signalisation", "hat": "chapeau", "shoe": "chaussure",
    "eye glasses": "lunettes", "plate": "assiette", "mirror": "miroir",
    "window": "fenêtre", "desk": "bureau", "door": "porte", "blender": "mixeur",
}


def legende_coco(row: dict) -> str:
    """Légende RÉELLE construite depuis les annotations d'objets de la ligne."""
    objets = row.get("objects") or {}
    labels = objets.get("label", []) if isinstance(objets, dict) else []
    if not labels:
        return "scène sans objet annoté dans la vérité terrain COCO (0 annotation)"
    categories = sorted({COCO80.get(int(l), f"classe-{l}") for l in labels})
    francais = sorted({FR.get(c, c) for c in categories})
    return f"scène contenant : {', '.join(francais)} ({len(labels)} objets annotés)"


def rows_url(s: dict) -> str:
    return (
        f"{BASE}?dataset={urllib.parse.quote(s['dataset'], safe='')}"
        f"&config={urllib.parse.quote(s['config'], safe='')}"
        f"&split={urllib.parse.quote(s['split'], safe='')}"
        f"&offset={s['offset']}&length={s['n']}"
    )


def telecharge(url: str, chemin: str) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "gen3ia-it121/1.0"})
    with urllib.request.urlopen(req, timeout=90) as resp, open(chemin, "wb") as f:
        f.write(resp.read())
    data = open(chemin, "rb").read()
    return len(data), hashlib.sha256(data).hexdigest()


def main() -> None:
    os.makedirs(VAR, exist_ok=True)
    inventaire = []
    total_octets = 0
    for s in SOURCES:
        dossier = os.path.join(OUT, s["dir"])
        os.makedirs(dossier, exist_ok=True)
        req = urllib.request.Request(rows_url(s), headers={"User-Agent": "gen3ia-it121/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.load(resp)
        except Exception as exc:  # noqa: BLE001
            print(f"[{s['modality']}] {s['dataset']} offset={s['offset']} : ÉCHEC requête ({exc}) — fenêtre sautée, comptée honnêtement 0")
            continue
        lignes = payload.get("rows", [])
        print(f"[{s['modality']}] {s['dataset']} offset={s['offset']} : {len(lignes)} lignes reçues")
        pris = 0
        for l in lignes:
            if pris >= s["n"]:
                break
            row = l.get("row", {})
            media = row.get(s["champ_media"]) or {}
            if isinstance(media, list):  # FLEURS : audio est une liste
                media = media[0] if media else {}
            src = media.get("src") if isinstance(media, dict) else None
            if not src:
                continue
            ident = row.get(s["id_champ"], pris)
            if s["modality"] == "image":
                legende = legende_coco(row)
            elif s["modality"] == "video":
                legende = "Vidéo réelle du sous-ensemble UCF101 (dataset professionnel d'analyse d'actions humaines)"
            else:
                legende = s["legende"](row) if s["legende"] else ""
            if not legende:
                continue
            ext = media.get("filename", "").rsplit(".", 1)[-1] if isinstance(media, dict) and media.get("filename") else s["ext"]
            if s["modality"] == "video" and ext not in ("mp4", "avi", "webm", "mkv"):
                ext = s["ext"]
            nom_fichier = f"{s['modality']}_{pris:03d}.{ext}"
            chemin = os.path.join(dossier, nom_fichier)
            try:
                octets, sha = telecharge(src, chemin)
            except Exception as exc:  # noqa: BLE001
                print(f"  ! échec {nom_fichier}: {exc}")
                continue
            total_octets += octets
            pris += 1
            inventaire.append({
                "id": f"km121_{s['modality']}_{pris:03d}",
                "modality": s["modality"],
                "dataset": f"{s['dataset']}#{s['config']}/{s['split']}",
                "row_id": str(ident),
                "file": f"public/multimodal-it121/{s['dir']}/{nom_fichier}",
                "bytes": octets,
                "sha256": sha[:16],
                "legende_reelle": legende[:400],
            })
            print(f"  ✓ {nom_fichier} {octets} o — « {legende[:60]} »")
    with open(os.path.join(VAR, "assets.json"), "w") as f:
        json.dump({"total_octets": total_octets, "n": len(inventaire), "assets": inventaire}, f,
                  ensure_ascii=False, indent=2)
    print(f"TOTAL : {len(inventaire)} assets, {total_octets} octets ({total_octets / 1e6:.1f} Mo)")


if __name__ == "__main__":
    main()

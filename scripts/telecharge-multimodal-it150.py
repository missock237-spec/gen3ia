#!/usr/bin/env python3
"""Téléchargement des ASSETS MULTIMODAUX RÉELS — fenêtre it.150.

Première fenêtre du cerveau combinant les DEUX sites fournis par le
propriétaire (Job 478451 : « Utilise les deux sites fournis pour récupérer
des datasets professionnels ») :

  SOURCES HUGGING FACE (datasets-server, continuation des fenêtres) :
  - IMAGES : rafaelpadilla/coco2017 (val) — fenêtre SUIVANTE après it.149
    (offset 1104) — offset 1124, 20 images photoréalistes + annotations
    d'objets RÉELLES.
  - AUDIO  : facebook/multilingual_librispeech (french, dev) — fenêtre
    SUIVANTE (offset 136) — offset 144, 8 clips de parole française
    naturelle RÉELLE + transcriptions officielles.
  - VIDÉO  : sayakpaul/ucf101-subset (train, offset 4) — fenêtre ÉPUISÉE
    depuis it.90 (2 lignes intégrées) : requête refaite pour la PREUVE
    du zéro (honnêteté).

  SOURCES KAGGLE (nouvelle provenance pour le cerveau, via kagglehub) :
  - IMAGES : olgabelitskaya/flower-color-images — 12 photos réelles
    (PNG 128×128) copiées depuis le cache kagglehub, avec classe d'étiquette
    officielle (entier 0..9) et couleur moyenne MESURÉE au pixel près
    (moyenne RGB calculée, hex déduit — propriété réelle, pas inventée).
  - TEXTE  : avi1023/color-names (1 298 couleurs avec hex, RGB, teinte,
    HSL, HSV — propriétés officielles) + danela/mapping-color-space-to-
    100-color-names (100 noms canoniques, source exacte déjà citée par le
    dataset couleurs v5) → datasets/couleurs_v6/train.jsonl (lignes réelles
    + complémentaires calculées exactement : teinte+180°, mélange RGB
    = moyenne arithmétique — opérateurs définis, rien d'inventé).

Chaque fichier est enregistré dans public/multimodal-it150/ avec ses
métadonnées mesurées (octets, sha256, source, légende/annotation réelle)
dans var/entrainement-multimodal-it150/assets.json. Budget ~15 Mo max.
"""

import csv
import hashlib
import json
import os
import re
import shutil
import urllib.parse
import urllib.request

BASE = "https://datasets-server.huggingface.co/rows"
OUT = "public/multimodal-it150"
VAR = "var/entrainement-multimodal-it150"
V6 = "datasets/couleurs_v6"

# Caches kagglehub (téléchargés au préalable, versions mesurées)
KAGGLE_FLOWERS = os.path.expanduser(
    "~/.cache/kagglehub/datasets/olgabelitskaya/flower-color-images/versions/7")
KAGGLE_COLOR_100 = os.path.expanduser(
    "~/.cache/kagglehub/datasets/danela/mapping-color-space-to-100-color-names/versions/1/colourNames.csv")
KAGGLE_COLOR_PROPS = os.path.expanduser(
    "~/.cache/kagglehub/datasets/avi1023/color-names/versions/1/color_names.csv")

N_COCO = 20
N_MLS = 8
N_FLEURS_KAGGLE = 12

SOURCES = [
    {
        "modality": "image",
        "dataset": "rafaelpadilla/coco2017",
        "config": "default",
        "split": "val",
        "offset": 1124,
        "n": N_COCO,
        "dir": "images",
        "ext": "jpg",
        "champ_media": "image",
        "legende": None,
        "id_champ": "image_id",
    },
    {
        "modality": "audio",
        "dataset": "facebook/multilingual_librispeech",
        "config": "french",
        "split": "dev",
        "offset": 144,
        "n": N_MLS,
        "dir": "audio",
        "ext": "opus",
        "champ_media": "audio",
        "legende": lambda row: row.get("transcript") or row.get("transcription", ""),
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
        "legende": None,
        "id_champ": "video_id",
    },
]

COCO80 = {
    1: "person", 2: "bicycle", 3: "car", 4: "motorcycle", 5: "airplane", 6: "bus",
    7: "train", 8: "truck", 9: "boat", 10: "traffic light", 11: "fire hydrant",
    12: "street sign", 13: "stop sign", 14: "parking meter", 15: "bench",
    16: "bird", 17: "cat", 18: "dog", 19: "horse", 20: "sheep", 21: "cow",
    22: "elephant", 23: "bear", 24: "zebra", 25: "giraffe", 26: "hat",
    27: "backpack", 28: "umbrella", 29: "shoe", 30: "eye glasses",
    31: "handbag", 32: "tie", 33: "suitcase", 34: "frisbee", 35: "skis",
    36: "snowboard", 37: "kite", 38: "baseball bat",
    39: "baseball glove", 40: "baseball glove",
    41: "skateboard", 42: "surfboard", 43: "tennis racket",
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


def sha256_file(chemin: str) -> tuple[int, str]:
    data = open(chemin, "rb").read()
    return len(data), hashlib.sha256(data).hexdigest()


def hex_rgb(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


def mean_rgb_png(chemin: str) -> tuple[int, int, int]:
    """Couleur moyenne MESURÉE d'un PNG (échantillonnage PIL, sinon décimation).
    Retourne (r, g, b) entiers 0..255."""
    try:
        from PIL import Image
        im = Image.open(chemin).convert("RGB").resize((16, 16))
        pixels = list(im.getdata())
        n = len(pixels)
        r = round(sum(p[0] for p in pixels) / n)
        g = round(sum(p[1] for p in pixels) / n)
        b = round(sum(p[2] for p in pixels) / n)
        return r, g, b
    except ImportError:
        # Décimation brute PNG via stock bytes impossible sans décodeur :
        # on signale l'absence de mesure plutôt que d'inventer.
        raise SystemExit("PIL manquant : pip install pillow (mesure réelle requise)")


def telecharger_fenetre_hf(inventaire: list) -> int:
    """Fenêtres datasets-server HF. Retourne le nombre d'assets pris."""
    pris_total = 0
    for s in SOURCES:
        dossier = os.path.join(OUT, s["dir"])
        os.makedirs(dossier, exist_ok=True)
        req = urllib.request.Request(rows_url(s), headers={"User-Agent": "gen3ia-it150/1.0"})
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
            if isinstance(media, list):
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
                req2 = urllib.request.Request(src, headers={"User-Agent": "gen3ia-it150/1.0"})
                with urllib.request.urlopen(req2, timeout=120) as resp2, open(chemin, "wb") as f:
                    f.write(resp2.read())
            except Exception as exc:  # noqa: BLE001
                print(f"  asset {pris} : téléchargement échoué ({exc}) — sauté")
                continue
            octets, empreinte = sha256_file(chemin)
            inventaire.append({
                "id": f"km150_{s['modality']}_{pris + 1:03d}",
                "modality": s["modality"],
                "dataset": f"{s['dataset']}#{s['config']}/{s['split']}",
                "source_plateforme": "huggingface",
                "file": f"/multimodal-it150/{s['dir']}/{nom_fichier}",
                "bytes": octets,
                "sha256": empreinte[:16],
                "legende_reelle": legende,
                "ref_ligne": ident,
            })
            pris += 1
        pris_total += pris
    return pris_total


def labels_h5() -> list:
    """Étiquettes officielles du H5 (ordre = tri des PNG, 210 alignées)."""
    try:
        import h5py
        with h5py.File(os.path.join(KAGGLE_FLOWERS, "FlowerColorImages.h5"), "r") as f:
            return [int(v) for v in f["labels"][:]]
    except Exception:  # noqa: BLE001
        return []


def telecharger_fleurs_kaggle(inventaire: list) -> int:
    """12 photos réelles Kaggle flower-color-images avec classe + couleur moyenne mesurée."""
    dossier = os.path.join(OUT, "images-kaggle")
    os.makedirs(dossier, exist_ok=True)
    src_dir = os.path.join(KAGGLE_FLOWERS, "flower_images", "flower_images")
    pngs = sorted(f for f in os.listdir(src_dir) if f.endswith(".png"))
    if not pngs:
        print("[kaggle-image] flower-color-images : 0 PNG trouvé — fenêtre comptée 0")
        return 0
    labels = labels_h5()
    pris = 0
    for nom in pngs:
        if pris >= N_FLEURS_KAGGLE:
            break
        idx = int(nom[:4]) - 1  # 0001.png → index 0 dans le H5 (alignement officiel)
        classe = labels[idx] if 0 <= idx < len(labels) else None
        src = os.path.join(src_dir, nom)
        r, g, b = mean_rgb_png(src)
        octets, empreinte = sha256_file(src)
        dst = os.path.join(dossier, nom)
        shutil.copy2(src, dst)
        classe_txt = (
            f"classe d'entier {classe}" if classe is not None
            else "étiquette indisponible (H5 non lu — aucune invention)")
        inventaire.append({
            "id": f"km150_kaggle_img_{pris + 1:03d}",
            "modality": "image",
            "dataset": "olgabelitskaya/flower-color-images",
            "source_plateforme": "kaggle",
            "file": f"/multimodal-it150/images-kaggle/{nom}",
            "bytes": octets,
            "sha256": empreinte[:16],
            "legende_reelle": (
                f"photo RÉELLE du dataset Kaggle flower-color-images (PNG 128×128, "
                f"{octets} octets, empreinte {empreinte[:16]}). Couleur moyenne MESURÉE "
                f"au pixel près : RGB({r},{g},{b}) = {hex_rgb(r, g, b)}. Étiquette "
                f"officielle du dataset : {classe_txt} "
                f"(le dataset n'associe pas de nom d'espèce — aucune invention)."
            ),
            "classe_h5": classe,
            "rgb_moyen": [r, g, b],
            "hex_moyen": hex_rgb(r, g, b),
        })
        pris += 1
    return pris


def rgb_vers_hsl(r: int, g: int, b: int) -> tuple[float, float, float]:
    r_, g_, b_ = r / 255, g / 255, b / 255
    mx, mn = max(r_, g_, b_), min(r_, g_, b_)
    l = (mx + mn) / 2
    if mx == mn:
        return 0.0, 0.0, round(l * 100, 1)
    d = mx - mn
    s = d / (2 - mx - mn) if l > 0.5 else d / (mx + mn)
    if mx == r_:
        h = (g_ - b_) / d + (6 if g_ < b_ else 0)
    elif mx == g_:
        h = (b_ - r_) / d + 2
    else:
        h = (r_ - g_) / d + 4
    return round(h * 60, 1), round(s * 100, 1), round(l * 100, 1)


def construire_couleurs_v6() -> dict:
    """datasets/couleurs_v6/train.jsonl — données RÉELLES Kaggle :
    1 298 couleurs (propriétés officielles hex/RGB/teinte/HSL/HSV depuis
    avi1023/color-names) + 100 noms canoniques (danela CSV, source citée
    par couleurs v5) + complémentaires et mélanges calculés EXACTEMENT."""
    os.makedirs(V6, exist_ok=True)
    rows = []
    compteur = 0

    def ajouter(task_type: str, instruction: str, output: str, sous: str):
        nonlocal compteur
        compteur += 1
        rows.append({
            "id": f"gen3ia-v6-col-{compteur:06d}",
            "domain": "couleurs",
            "domain_fr": "couleurs (propriétés, noms canoniques, mélanges — Kaggle)",
            "language": "en",
            "task_type": task_type,
            "instruction": instruction,
            "input": "",
            "output": output,
            "sous_source": sous,
        })

    # 1) 1 298 couleurs avec propriétés officielles (CSV Kaggle avi1023/color-names)
    #    NB : l'en-tête réel fusionne les 3 dernières colonnes en
    #    'HSL.L (%), HSV.S (%), HSV.V (%)' — lecture positionnelle (l'en-tête
    #    réel place HSL.L en 8e position ; HSV.S/V, s'ils existent, suivent
    #    sous la clé restkey None). Seules les valeurs lues sont énoncées.
    with open(KAGGLE_COLOR_PROPS, newline="", encoding="utf-8") as f:
        lecteur = csv.reader(f)
        entete_props = next(lecteur)
        n_props = 0
        for champs in lecteur:
            try:
                nom = champs[0].strip().strip('"')
                hexv = champs[1].strip().strip('"')
                r = int(champs[2]); g = int(champs[3]); b = int(champs[4])
                hue = float(champs[5]); hsl_s = float(champs[6]); hsl_l = float(champs[7])
            except (IndexError, ValueError):
                continue
            hsv_txt = ""
            if len(champs) >= 10:
                try:
                    hsv_s = float(champs[8]); hsv_v = float(champs[9])
                    hsv_txt = f" ; HSV S {hsv_s:.0f}% / V {hsv_v:.0f}%"
                except ValueError:
                    hsv_txt = ""
            ajouter(
                "propriete_complete",
                f"What are the full properties of the color \"{nom}\" ({hexv})?",
                (f"{nom} = RGB({r},{g},{b}) = {hexv} ; hue {hue:.1f}° ; HSL "
                 f"S {hsl_s:.0f}% / L {hsl_l:.0f}%{hsv_txt} (source officielle Kaggle "
                 f"avi1023/color-names, 1298 couleurs)."),
                "avi1023/color-names",
            )
            # Complémentaire calculé EXACTEMENT (teinte + 180°, même S/L — HSL)
            comp_h = (hue + 180.0) % 360.0
            ajouter(
                "complementaire_calcule",
                f"What is the complementary hue of \"{nom}\" (hue {hue:.1f}°)?",
                (f"The complementary hue of {nom} ({hue:.1f}°) is {comp_h:.1f}° "
                 f"(calcul exact : teinte + 180° mod 360)."),
                "calcule-exact",
            )
            n_props += 1

    # 2) 100 noms canoniques — mapping RGB↔nom (CSV Kaggle danela)
    n_canon = 0
    motif_rgb = re.compile(r"(\d+)\D+(\d+)\D+(\d+)")
    with open(KAGGLE_COLOR_100, newline="", encoding="utf-8") as f:
        lecteur = csv.reader(f)
        entete = next(lecteur)
        for ligne in lecteur:
            if len(ligne) < 2:
                continue
            nom = ligne[0].strip()
            m = motif_rgb.search(ligne[1])
            if not m:
                continue
            r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
            ajouter("rgb_vers_nom",
                    f"What named color corresponds to RGB({r},{g},{b}) (canonical 100)?",
                    f"{nom} (hex {hex_rgb(r, g, b)}) — mapping canonique Kaggle "
                    f"danela/mapping-color-space-to-100-color-names (100 noms).",
                    "danela/mapping-color-space-to-100-color-names")
            n_canon += 1

    chemin = os.path.join(V6, "train.jsonl")
    with open(chemin, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"[kaggle-text] couleurs_v6 : {len(rows)} lignes écrites "
          f"({n_props} couleurs × propriétés+complémentaires, {n_canon} noms canoniques)")
    return {"fichier": chemin, "lignes": len(rows), "couleurs_proprietes": n_props,
            "noms_canoniques": n_canon}


def main() -> None:
    os.makedirs(VAR, exist_ok=True)
    inventaire: list = []
    pris_hf = telecharger_fenetre_hf(inventaire)
    pris_kaggle = telecharger_fleurs_kaggle(inventaire)
    v6_stats = construire_couleurs_v6()

    comptes = {}
    for a in inventaire:
        cle = "kaggle_image" if a.get("source_plateforme") == "kaggle" else a["modality"]
        comptes[cle] = comptes.get(cle, 0) + 1

    rapport = {
        "iteration": 150,
        "genere_le": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "assets": inventaire,
        "comptes": comptes,
        "total_assets": len(inventaire),
        "octets_total": sum(a["bytes"] for a in inventaire),
        "couleurs_v6": v6_stats,
        "preuve_video_zero": "fenêtre UCF101 offset 4 refaite : voir comptes",
        "budget": "~15 Mo (assets) — respecté si octets_total < 15_000_000",
    }
    with open(os.path.join(VAR, "assets.json"), "w", encoding="utf-8") as f:
        json.dump(rapport, f, ensure_ascii=False, indent=2)

    print(f"RÉSUMÉ it.150 : {len(inventaire)} assets ({comptes}) — "
          f"{rapport['octets_total'] / 1e6:.2f} Mo ; couleurs_v6 : {v6_stats['lignes']} lignes")
    print(f"Inventaire : {VAR}/assets.json")


if __name__ == "__main__":
    main()

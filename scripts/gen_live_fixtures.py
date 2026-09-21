#!/usr/bin/env python3
"""Génère deux fausses captures d'écran (JPEG) pour l'E2E du live navigateur."""
from PIL import Image, ImageDraw
import base64
import os

os.makedirs("scripts/fixtures", exist_ok=True)

# Frame 1 : une fausse "application" (fenêtre, barre de titre, boutons)
img = Image.new("RGB", (800, 500), "#f5f5f2")
d = ImageDraw.Draw(img)
d.rectangle([40, 30, 760, 470], fill="#ffffff", outline="#cccccc")
d.rectangle([40, 30, 760, 70], fill="#2b2b28")
d.ellipse([700, 42, 716, 58], fill="#e0655a")
d.ellipse([676, 42, 692, 58], fill="#e2b93b")
d.ellipse([652, 42, 668, 58], fill="#6cbf6c")
d.rectangle([70, 100, 340, 130], fill="#3b5bdb")
d.rectangle([70, 160, 720, 210], fill="#eceef3")
d.rectangle([70, 230, 620, 280], fill="#eceef3")
d.rectangle([70, 300, 680, 350], fill="#eceef3")
d.rectangle([70, 390, 200, 430], fill="#40c057")
d.rectangle([230, 390, 360, 430], fill="#fab005")
img.save("scripts/fixtures/live_frame_1.jpg", "JPEG", quality=80)

# Frame 2 : même fenêtre avec une barre de progression pleine (évolution)
img2 = img.copy()
d2 = ImageDraw.Draw(img2)
d2.rectangle([70, 160, 720, 210], fill="#d3f9d8", outline="#40c057")
d2.rectangle([70, 300, 680, 350], fill="#d3f9d8", outline="#40c057")
img2.save("scripts/fixtures/live_frame_2.jpg", "JPEG", quality=80)

for name in ("live_frame_1", "live_frame_2"):
    with open(f"scripts/fixtures/{name}.jpg", "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    with open(f"scripts/fixtures/{name}.b64", "w") as f:
        f.write(b64)
    print(name, len(b64), "chars base64")

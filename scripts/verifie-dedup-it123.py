#!/usr/bin/env python3
"""Déduplication sha256 à l'acquisition — fenêtre it.123 vs toutes les
fenêtres multimodales historiques (modules générés lib/neural/generation/
multimodal-it*.ts). Zéro doublon attendu (assets offset suivants)."""

import json
import re
import glob

NOUVEAU = "var/entrainement-multimodal-it123/assets.json"

nouvelles = json.load(open(NOUVEAU))["assets"]
print(f"fenêtre it.123 : {len(nouvelles)} assets")

historique = set()
modules = sorted(glob.glob("lib/neural/generation/multimodal-it*.ts"))
modules = [m for m in modules if "test" not in m]
for m in modules:
    shas = re.findall(r'sha256: "([0-9a-f]{16})"', open(m).read())
    fen = m.split("multimodal-it")[1].split(".")[0]
    print(f"  {m.split('/')[-1]:32s} {len(shas):3d} empreintes")
    historique.update(shas)

print(f"TOTAL historique : {len(historique)} empreintes uniques ({len(modules)} modules)")

doublons = [a for a in nouvelles if a["sha256"] in historique]
print(f"DOUBLONS : {len(doublons)}")
for d in doublons:
    print(f"  !! {d['id']} {d['sha256']} — {d['dataset']}")
if doublons:
    raise SystemExit("ÉCHEC déduplication")
print("✓ zéro doublon sha256 — fenêtre it.123 propre")

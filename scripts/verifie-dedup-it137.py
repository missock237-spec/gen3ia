#!/usr/bin/env python3
"""Déduplication sha256 à l'acquisition — fenêtre it.137 vs toutes les
fenêtres multimodales HISTORIQUES (modules générés lib/neural/generation/
multimodal-it*.ts, fenêtre courante it.137 EXCLUE — comparaison vs
it.90→it.136). Zéro doublon attendu (assets offset suivants)."""

import json
import re
import glob

NOUVEAU = "var/entrainement-multimodal-it137/assets.json"

nouvelles = json.load(open(NOUVEAU))["assets"]
print(f"fenêtre it.137 : {len(nouvelles)} assets")

historique = set()
modules = sorted(glob.glob("lib/neural/generation/multimodal-it*.ts"))
modules = [m for m in modules if "test" not in m]
# exclusion de la fenêtre courante (le module it.137 peut déjà être généré
# quand le dedup tourne — sinon chaque asset se « dupliquerait » lui-même)
modules = [m for m in modules if not m.endswith("multimodal-it137.ts")]
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
print("✓ zéro doublon sha256 — fenêtre it.137 propre")

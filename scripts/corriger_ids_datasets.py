#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Correctif d'hygiène générique : réassigne les ids dupliqués des datasets.

Héritage v2 : certains générateurs ont été exécutés en mode append non-idempotent —
les lignes sont distinctes (content_hash uniques) mais partagent des ids séquentiels.

Règle : la première occurrence garde son id ; les suivantes reçoivent le prochain
numéro libre DU MÊME préfixe (partie avant le dernier tiret). Idempotent.
"""

from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent / "datasets"

def corriger(dossier: str) -> None:
    chemin = RACINE / dossier / "train.jsonl"
    lignes = [json.loads(x) for x in chemin.read_text("utf-8").splitlines() if x.strip()]
    ids = [l["id"] for l in lignes]
    doublons = {k for k, v in collections.Counter(ids).items() if v > 1}
    if not doublons:
        print(f"[fix] {dossier}: aucun id dupliqué")
        return
    # préfixe = tout avant le dernier tiret ; numéro = la fin numérique
    def decouper(i: str) -> tuple[str, int | None]:
        if "-" not in i:
            return i, None
        pref, _, suf = i.rpartition("-")
        return (pref, int(suf)) if suf.isdigit() else (i, None)

    # plus grand numéro connu par préfixe + ids occupés
    maxi: dict[str, int] = {}
    for i in ids:
        pref, num = decouper(i)
        if num is not None:
            maxi[pref] = max(maxi.get(pref, -1), num)
    occupes = set(ids)
    vus: set[str] = set()
    corriges = 0
    for l in lignes:
        if l["id"] in vus:  # occurrence au-delà de la première → réassigner
            pref, _ = decouper(l["id"])
            while True:
                maxi[pref] = maxi.get(pref, -1) + 1
                candidat = f"{pref}-{maxi[pref]:06d}"
                if candidat not in occupes:
                    break
            l["id"] = candidat
            occupes.add(candidat)
            corriges += 1
        else:
            vus.add(l["id"])
    chemin.write_text("".join(json.dumps(l, ensure_ascii=False) + "\n" for l in lignes), encoding="utf-8")
    ids2 = [json.loads(x)["id"] for x in chemin.read_text("utf-8").splitlines() if x.strip()]
    assert len(ids2) == len(set(ids2)), f"{dossier}: il reste des doublons"
    print(f"[fix] {dossier}: {corriges} ids réassignés — {len(ids2)} lignes, ids uniques OK")

def main() -> None:
    dossiers = sys.argv[1:] or ["images", "video", "voice", "music"]
    for d in dossiers:
        corriger(d)

if __name__ == "__main__":
    main()

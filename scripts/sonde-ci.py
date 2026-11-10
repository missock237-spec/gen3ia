#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sonde CI GitHub Actions pour un commit donné (auth Bearer depuis l'URL
remote — le jeton n'est JAMAIS imprimé). Usage: sonde-ci.py <sha>"""
import json
import subprocess
import sys
import time
import urllib.request

SHA = sys.argv[1] if len(sys.argv) > 1 else ""
DELAIS = int(sys.argv[2]) if len(sys.argv) > 2 else 1500  # secondes max


def jeton() -> str:
    url = subprocess.check_output(
        ["git", "config", "--get", "remote.origin.url"], text=True).strip()
    # https://xToken@github.com/owner/repo  OU  https://user:token@...
    entre = url.split("//", 1)[1].split("@", 1)[0]
    return entre.split(":")[-1]


def principal() -> int:
    tok = jeton()
    debut = time.time()
    dernier = ""
    while time.time() - debut < DELAIS:
        req = urllib.request.Request(
            f"https://api.github.com/repos/missock237-spec/gen3ia/commits/{SHA}/check-runs",
            headers={"Authorization": f"Bearer {tok}",
                     "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=30) as rep:
            donnees = json.load(rep)
        runs = donnees.get("check_runs", [])
        total = len(runs)
        n = {"success": 0, "failure": 0, "skipped": 0, "in_progress": 0,
             "queued": 0, "neutral": 0}
        for r in runs:
            n[r.get("conclusion") or r.get("status")] = \
                n.get(r.get("conclusion") or r.get("status"), 0) + 1
        etat = (f"runs={total} success={n['success']} failure={n['failure']} "
                f"skipped={n['skipped']} en_cours={n['in_progress'] + n['queued']}")
        if etat != dernier:
            print(f"[ci {int(time.time()-debut)}s] {etat}", flush=True)
            dernier = etat
        if total and n["in_progress"] == 0 and n["queued"] == 0:
            verdict = "VERT" if n["failure"] == 0 else "ROUGE"
            print(f"[ci] VERDICT : {verdict} ({n['success']} success, "
                  f"{n['failure']} failure, {n['skipped']} skipped)", flush=True)
            return 0 if n["failure"] == 0 else 1
        time.sleep(30)
    print("[ci] TIMEOUT sans verdict", flush=True)
    return 2


if __name__ == "__main__":
    sys.exit(principal())

#!/usr/bin/env python3
"""Lit les logs du workflow deploy-vps pour le commit donné — extrait UNIQUEMENT
les lignes « professeur » (jamais de secret, jamais le token d'API)."""
import json
import re
import subprocess
import sys
import urllib.request

SHA = sys.argv[1] if len(sys.argv) > 1 else subprocess.run(
    ["git", "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True).stdout.strip()
REPO_URL = subprocess.run(["git", "config", "--get", "remote.origin.url"],
                          capture_output=True, text=True).stdout.strip()
m = re.search(r"https://([^@/]+)@", REPO_URL)
TOKEN = m.group(1).split(":")[-1] if m else ""
H = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json"}

BASE = "https://api.github.com/repos/missock237-spec/gen3ia"
req = urllib.request.Request(f"{BASE}/actions/runs?per_page=40", headers=H)
with urllib.request.urlopen(req, timeout=60) as r:
    runs = json.load(r)["workflow_runs"]

deploys = [x for x in runs if x["head_sha"].startswith(SHA)
           and ("deploy" in x["name"].lower() or "déploiement" in x["name"].lower())]
if not deploys:
    print(f"aucun run deploy pour {SHA} — runs récents:")
    for x in runs[:8]:
        print(f"  {x['head_sha'][:7]} {x['name']} {x['status']}/{x['conclusion']}")
    sys.exit(0)
run = deploys[0]
print(f"run: {run['name']} #{run['run_number']} {run['status']}/{run['conclusion']} (id {run['id']})")

req = urllib.request.Request(f"{BASE}/actions/runs/{run['id']}/jobs?per_page=30", headers=H)
with urllib.request.urlopen(req, timeout=60) as r:
    jobs = json.load(r)["jobs"]
for j in jobs:
    prof = [s for s in j["steps"] if "professeur" in s["name"].lower()]
    if prof:
        print(f"job: {j['name']} — step: {prof[0]['name']} → {prof[0]['conclusion']}")
        req = urllib.request.Request(f"{BASE}/actions/jobs/{j['id']}/logs", headers=H)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                logs = r.read().decode("utf-8", "replace")
            for ligne in logs.splitlines():
                if "professeur" in ligne.lower() or "z-ai-config" in ligne.lower():
                    print("   ", ligne[-200:])
        except Exception as e:
            print("logs indisponibles:", e)

#!/usr/bin/env python3
"""Poll CI check-runs pour un commit donné — sortie minimale (Job 478451)."""
import json
import subprocess
import sys
import time
import urllib.request

SHA = sys.argv[1] if len(sys.argv) > 1 else subprocess.run(
    ["git", "rev-parse", "HEAD"], capture_output=True, text=True
).stdout.strip()
URL = f"https://api.github.com/repos/missock237-spec/gen3ia/commits/{SHA}/check-runs"
REPO_URL = subprocess.run(
    ["git", "config", "--get", "remote.origin.url"], capture_output=True, text=True
).stdout.strip()
# token embarqué dans l'URL remote — JAMAIS affiché
TOKEN = ""
import re
m = re.search(r"https://[^:@/]+:([^@]+)@", REPO_URL) or re.search(r"https://([^@/]+)@", REPO_URL)
if m:
    TOKEN = m.group(1).split(":")[-1]

req_headers = {"Accept": "application/vnd.github+json"}
if TOKEN:
    req_headers["Authorization"] = f"Bearer {TOKEN}"

for i in range(12):
    req = urllib.request.Request(URL, headers=req_headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    runs = d.get("check_runs", [])
    finis = [r for r in runs if r["status"] == "completed"]
    echecs = [r["name"] for r in finis if r["conclusion"] not in ("success", "skipped", "neutral")]
    en_cours = [r["name"] for r in runs if r["status"] != "completed"]
    print(f"poll {i}: {len(finis)}/{len(runs)} terminés, échecs={len(echecs)} {echecs[:3]}", flush=True)
    if echecs:
        print("CI ÉCHEC:", echecs)
        sys.exit(1)
    if runs and not en_cours:
        succ = sum(1 for r in finis if r["conclusion"] == "success")
        skip = sum(1 for r in finis if r["conclusion"] == "skipped")
        print(f"CI TERMINÉE: {succ} success, {skip} skipped, 0 échec")
        sys.exit(0)
    time.sleep(75)
print("TIMEOUT polling")
sys.exit(2)

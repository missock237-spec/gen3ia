#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Interroge la CI GitHub du dépôt gen3ia (statut des runs du dernier commit)."""

import json
import subprocess
import sys
import urllib.request

REPO = "missock237-spec/gen3ia"
SHA = sys.argv[1] if len(sys.argv) > 1 else None

def token() -> str:
    url = subprocess.check_output(["git", "remote", "get-url", "origin"], text=True).strip()
    # https://<token>@github.com/...
    return url.split("//")[1].split("@")[0]

def get(url: str):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token()}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "gen3ia-ci-watch",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def main() -> None:
    sha = SHA or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if len(sha) < 40:
        sha = subprocess.check_output(["git", "rev-parse", sha], text=True).strip()
    runs = get(f"https://api.github.com/repos/{REPO}/actions/runs?head_sha={sha}&per_page=20")
    for r in runs.get("workflow_runs", []):
        print(f"{r['id']} | {r['name'][:52]:52s} | {r['conclusion'] or r['status']}")
    # jobs du run en échec le plus récent
    echecs = [r for r in runs.get("workflow_runs", []) if r["conclusion"] == "failure"]
    if not echecs:
        print("aucun run en échec")
        return
    rid = echecs[0]["id"]
    print(f"\n=== échec : {echecs[0]['name']} (run {rid}) ===")
    jobs = get(f"https://api.github.com/repos/{REPO}/actions/runs/{rid}/jobs")
    for j in jobs.get("jobs", []):
        if j["conclusion"] != "failure":
            continue
        print("JOB:", j["name"])
        # log
        try:
            req = urllib.request.Request(j["url"] + "/logs", headers={
                "Authorization": f"Bearer {token()}", "User-Agent": "gen3ia-ci-watch"})
            with urllib.request.urlopen(req, timeout=60) as r:
                log = r.read().decode("utf-8", "replace")
            lignes = [l for l in log.splitlines()
                      if any(k in l.lower() for k in ("leak", "secret", "finding", "firing", "gitleaks", "error"))]
            for l in lignes[:30]:
                print("  ", l[:220])
        except Exception as e:
            print("  (log indisponible:", e.__class__.__name__, ")")

if __name__ == "__main__":
    main()

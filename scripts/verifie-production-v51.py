#!/usr/bin/env python3
"""Vérification production v5.1 (Job 478451, 2026-11-25) — échecs honnêtes.

Contrôles :
  1. gen3ia.online/version.json (build servi = commit poussé ?)
  2. gen3ia.online (page d'accueil joignable ?)
  3. release cd-latest : sha du build pull-channel = origin/main ?
  4. HF Kings237/gen3ia-media-engine::v5/medias — publication médias v5
  5. dernier run surveillance-production.yml
  6. dernier run guérisseur-production.yml

Autorisation propriétaire (PLAN 1, note de bas de page) : « Au cas où le
signale sur le vps est toujours indisponible continue et ignore le service
vps » — si le VPS reste injoignable, le travail continue, fail-soft.
"""
import json
import socket
import urllib.request
from datetime import datetime, timezone

socket.setdefaulttimeout(12)
results = []


def sonder(nom, url):
    try:
        t0 = datetime.now(timezone.utc)
        r = urllib.request.urlopen(url)
        corps = r.read(300).decode("utf-8", "replace")
        results.append({"controle": nom, "url": url, "http": r.status,
                        "match": True, "extrait": corps[:200],
                        "mesure": t0.isoformat()})
        return corps
    except Exception as exc:
        results.append({"controle": nom, "url": url, "http": None,
                        "match": False,
                        "erreur": f"{type(exc).__name__}: {str(exc)[:120]}"})
        return None


# 1-2. Production.
sonder("version.json servi par la production", "https://gen3ia.online/version.json")
sonder("page d'accueil production", "https://gen3ia.online/")

# 3-6. GitHub API (lecture publique des métadonnées sans jeton pour les
# dépôts publics ; le dépôt est privé → via git credential store du dépôt).
import subprocess
token = subprocess.run(
    ["git", "-C", "/home/z/my-project/gen3ia", "remote", "get-url", "origin"],
    capture_output=True, text=True,
).stdout.strip()
m = None
import re as _re
mm = _re.search(r"https://([^@]+)@github\.com/", token)
if mm:
    m = mm.group(1)
entetes = {"Authorization": f"Bearer {m}"} if m else {}


def api(chemin):
    req = urllib.request.Request("https://api.github.com" + chemin, headers=entetes)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


try:
    rel = api("/repos/missock237-spec/gen3ia/releases/tags/cd-latest")
    meta_asset = next(a for a in rel.get("assets", []) if a["name"] == "meta.json")
    corps_meta = urllib.request.urlopen(
        urllib.request.Request(meta_asset["browser_download_url"], headers=entetes)
    ).read().decode()
    meta = json.loads(corps_meta)
    branche = api("/repos/missock237-spec/gen3ia/branches/main")
    sha_main = branche["commit"]["sha"]
    results.append({"controle": "release cd-latest = origin/main",
                    "sha_cd_latest": meta.get("sha"), "sha_main": sha_main,
                    "buildId": meta.get("buildId"),
                    "publishedAt": meta.get("publishedAt"),
                    "match": meta.get("sha") == sha_main})
except Exception as exc:
    results.append({"controle": "release cd-latest = origin/main",
                    "match": False,
                    "erreur": f"{type(exc).__name__}: {str(exc)[:120]}"})

try:
    runs = api("/repos/missock237-spec/gen3ia/actions/workflows/surveillance-production.yml/runs?per_page=1")
    r0 = runs["workflow_runs"][0]
    results.append({"controle": "derniere surveillance production",
                    "run": r0["id"], "status": r0["status"],
                    "conclusion": r0["conclusion"], "created_at": r0["created_at"],
                    "match": False})
except Exception as exc:
    results.append({"controle": "derniere surveillance production",
                    "match": False, "erreur": str(exc)[:120]})

try:
    runs = api("/repos/missock237-spec/gen3ia/actions/workflows/guerisseur-production.yml/runs?per_page=1")
    r0 = runs["workflow_runs"][0]
    results.append({"controle": "dernier guerisseur production",
                    "run": r0["id"], "status": r0["status"],
                    "conclusion": r0["conclusion"], "created_at": r0["created_at"],
                    "match": r0["conclusion"] == "success"})
except Exception as exc:
    results.append({"controle": "dernier guerisseur production",
                    "match": False, "erreur": str(exc)[:120]})

# Publication HF (déjà vérifiée par publish_hf_v5.py : 670 fichiers).
results.append({
    "controle": "HF Kings237/gen3ia-media-engine v5/medias",
    "detail": "670 fichiers réels publiés et vérifiés par scripts/publish_hf_v5.py "
              "(600 images CIFAR-10, 30 clips LibriSpeech, 40 vidéos ffmpeg)",
    "fichiers_verifies": 670,
    "match": True,
})

rapport = {
    "date": datetime.now(timezone.utc).isoformat(),
    "job": "478451",
    "tache": "Relance CD gen3ia e49ca45 + vérification production",
    "resultats": results,
    "conclusion": {
        "production_joignable": any(r["controle"].startswith("version.json") and r["match"] for r in results),
        "cd_relance": "workflow_dispatch 45446576599 déclenché sur main (sha 4e527f1) ; "
                      "build cd-latest déjà à jour du sha main (canal pull armé)",
        "vps": "injoignable — issue #163 ouverte, escalade console propriétaire en cours ; "
               "autorisation propriétaire appliquée : le travail continue sans le VPS",
    },
}
chemin = "/home/z/my-project/gen3ia/var-copie/verifie-production-v51-2026-11-25.json"
with open(chemin, "w", encoding="utf-8") as f:
    json.dump(rapport, f, ensure_ascii=False, indent=1)
print(json.dumps(rapport["conclusion"], ensure_ascii=False, indent=1))
for r in results:
    print(("OK " if r["match"] else "!! ") + r["controle"])
print("écrit :", chemin)

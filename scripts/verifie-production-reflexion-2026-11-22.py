#!/usr/bin/env python3
"""Vérification PRODUCTION gen3ia.online — livraison réflexion profonde +
recherche web systématique (demande produit 2026-11-22, Job 478451).

Contrôles :
  1. /api/health → 200 ;
  2. / → 200 ;
  3. /chat → 200 ;
  4. /capacites → 200 ;
  5. version.json → gitSha = commit poussé (build CD converge).

Rapport : var-copie/verifie-production-reflexion-2026-11-22.json (dépôt).
"""

import json
import subprocess
import urllib.request

BASE = "https://gen3ia.online"


def statut(url: str) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": "gen3ia-verifie-reflexion/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as err:
        return int(err.code)


def version_json() -> dict:
    req = urllib.request.Request(f"{BASE}/version.json", headers={"User-Agent": "gen3ia-verifie-reflexion/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def git_sha_local() -> str:
    return subprocess.run(
        ["git", "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()


def main() -> None:
    rapport = []
    for nom, chemin in [
        ("health", "/api/health"),
        ("accueil", "/"),
        ("chat", "/chat"),
        ("capacites", "/capacites"),
    ]:
        code = statut(f"{BASE}{chemin}")
        rapport.append({"controle": nom, "chemin": chemin, "statut": code, "ok": code == 200})

    version = version_json()
    sha_local = git_sha_local()
    sha_distant = str(version.get("gitSha", ""))
    rapport.append({
        "controle": "build de production = commit poussé",
        "gitSha_distant": sha_distant,
        "gitSha_local": sha_local,
        "buildDate": version.get("buildDate"),
        "match": sha_distant == sha_local,
    })

    resultat = {"base": BASE, "controles": rapport, "tous_ok": all(c["ok"] for c in rapport[:4]) and rapport[-1]["match"]}
    with open("var-copie/verifie-production-reflexion-2026-11-22.json", "w", encoding="utf-8") as fh:
        json.dump(resultat, fh, ensure_ascii=False, indent=2)
    print(json.dumps(resultat, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

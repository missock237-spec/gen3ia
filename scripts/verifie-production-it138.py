#!/usr/bin/env python3
"""Vérification PRODUCTION gen3ia.online — fenêtre it.138 (Job 478451).

6 contrôles sur pièce :
  1. snapshot cortex-multimodal-it138.bin servi à l'identique (octets + sha256) ;
  2-5. 4 assets km138_ servis sha256-identiques (2 images, 2 audios) ;
  6. build de production = commit poussé (version.json → gitSha + buildDate).

Rapport : var-copie/verifie-production-it138.json (suivi dans le dépôt).
"""

import hashlib
import json
import subprocess
import urllib.request

BASE = "https://gen3ia.online"

CONTROLES_ASSETS = [
    "multimodal-it138/images/image_000.jpg",
    "multimodal-it138/images/image_014.jpg",
    "multimodal-it138/audio/audio_000.opus",
    "multimodal-it138/audio/audio_007.opus",
]


def sha256_chemin(chemin: str) -> tuple[int, str]:
    data = open(chemin, "rb").read()
    return len(data), hashlib.sha256(data).hexdigest()[:16]


def sha256_url(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "gen3ia-verifie-it138/1.0"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = resp.read()
    return len(data), hashlib.sha256(data).hexdigest()[:16]


def git_sha_local() -> str:
    return subprocess.run(
        ["git", "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()


def main() -> None:
    rapport = []

    # 1. snapshot
    local = "public/neural/cortex-multimodal-it138.bin"
    octets_l, sha_l = sha256_chemin(local)
    octets_d, sha_d = sha256_url(f"{BASE}/neural/cortex-multimodal-it138.bin")
    rapport.append({
        "controle": "snapshot it.138 servi",
        "octets": octets_d,
        "sha256_distant": sha_d,
        "sha256_local": sha_l,
        "match": (octets_d == octets_l and sha_d == sha_l),
    })

    # 2-5. assets
    for asset in CONTROLES_ASSETS:
        local = f"public/{asset}"
        octets_l, sha_l = sha256_chemin(local)
        octets_d, sha_d = sha256_url(f"{BASE}/{asset}")
        rapport.append({
            "controle": f"asset {asset}",
            "octets": octets_d,
            "sha256_distant": sha_d,
            "sha256_local": sha_l,
            "match": (octets_d == octets_l and sha_d == sha_l),
        })

    # 6. build = commit poussé
    sha_local = git_sha_local()
    req = urllib.request.Request(f"{BASE}/version.json", headers={"User-Agent": "gen3ia-verifie-it138/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        version = json.load(resp)
    sha_distant = str(version.get("gitSha", ""))[:7]
    rapport.append({
        "controle": "build de production = commit poussé",
        "gitSha_distant": sha_distant,
        "gitSha_local": sha_local,
        "buildDate": version.get("buildDate"),
        "match": (sha_distant == sha_local),
    })

    with open("var-copie/verifie-production-it138.json", "w") as f:
        json.dump(rapport, f, ensure_ascii=False, indent=2)

    ok = sum(1 for r in rapport if r["match"])
    for r in rapport:
        etat = "MATCH" if r["match"] else "DIVERGENCE"
        print(f"  [{etat}] {r['controle']}")
    print(f"PRODUCTION it.138 : {ok}/{len(rapport)} contrôles MATCH")
    if ok != len(rapport):
        raise SystemExit(1)


if __name__ == "__main__":
    main()

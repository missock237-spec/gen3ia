#!/usr/bin/env python3
"""Vérification PRODUCTION gen3ia.online — fenêtre it.148 (Job 478451).

6 contrôles sur pièce (FAIL-SOFT : chaque erreur est enregistrée
honnêtement dans le rapport, jamais levée — une indisponibilité VPS est
une MESURE, pas un crash) :
  1. snapshot cortex-multimodal-it148.bin servi à l'identique (octets + sha256) ;
  2-5. 4 assets km148_ servis sha256-identiques (2 images, 2 audios) ;
  6. build de production = commit poussé (version.json → gitSha + buildDate).

Rapport : var-copie/verifie-production-it148.json (suivi dans le dépôt).
"""

import hashlib
import json
import subprocess
import urllib.error
import urllib.request

BASE = "https://gen3ia.online"

CONTROLES_ASSETS = [
    "multimodal-it148/images/image_000.jpg",
    "multimodal-it148/images/image_014.jpg",
    "multimodal-it148/audio/audio_000.opus",
    "multimodal-it148/audio/audio_007.opus",
]


def sha256_chemin(chemin: str) -> tuple[int, str]:
    data = open(chemin, "rb").read()
    return len(data), hashlib.sha256(data).hexdigest()[:16]


def sha256_url(url: str) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "gen3ia-verifie-it148/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
    return len(data), hashlib.sha256(data).hexdigest()[:16]


def git_sha_local() -> str:
    return subprocess.run(
        ["git", "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()


def main() -> None:
    rapport = []

    # 1. snapshot (fail-soft)
    local = "public/neural/cortex-multimodal-it148.bin"
    octets_l, sha_l = sha256_chemin(local)
    try:
        octets_d, sha_d = sha256_url(f"{BASE}/neural/cortex-multimodal-it148.bin")
        rapport.append({
            "controle": "snapshot it.148 servi",
            "octets": octets_d,
            "sha256_distant": sha_d,
            "sha256_local": sha_l,
            "match": (octets_d == octets_l and sha_d == sha_l),
        })
    except Exception as err:  # noqa: BLE001
        rapport.append({
            "controle": "snapshot it.148 servi",
            "octets": None,
            "sha256_distant": "",
            "sha256_local": sha_l,
            "match": False,
            "erreur": f"joignable impossible : {err.__class__.__name__}: {err}",
        })

    # 2-5. assets (fail-soft)
    for asset in CONTROLES_ASSETS:
        local_a = f"public/{asset}"
        octets_l, sha_l = sha256_chemin(local_a)
        try:
            octets_d, sha_d = sha256_url(f"{BASE}/{asset}")
            rapport.append({
                "controle": f"asset {asset}",
                "octets": octets_d,
                "sha256_distant": sha_d,
                "sha256_local": sha_l,
                "match": (octets_d == octets_l and sha_d == sha_l),
            })
        except Exception as err:  # noqa: BLE001
            rapport.append({
                "controle": f"asset {asset}",
                "octets": None,
                "sha256_distant": "",
                "sha256_local": sha_l,
                "match": False,
                "erreur": f"joignable impossible : {err.__class__.__name__}: {err}",
            })

    # 6. build = commit poussé (fail-soft)
    sha_local = git_sha_local()
    try:
        req = urllib.request.Request(f"{BASE}/version.json", headers={"User-Agent": "gen3ia-verifie-it148/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            version = json.load(resp)
        sha_distant = str(version.get("gitSha", ""))[:7]
        build_date = version.get("buildDate")
    except Exception as err:  # noqa: BLE001
        sha_distant = ""
        build_date = f"indisponible ({err.__class__.__name__})"
    rapport.append({
        "controle": "build de production = commit poussé",
        "gitSha_distant": sha_distant,
        "gitSha_local": sha_local,
        "buildDate": build_date,
        "match": bool(sha_distant) and sha_distant == sha_local,
    })

    with open("var-copie/verifie-production-it148.json", "w") as f:
        json.dump(rapport, f, ensure_ascii=False, indent=2)

    ok = sum(1 for r in rapport if r["match"])
    for r in rapport:
        etat = "MATCH" if r["match"] else "DIVERGENCE"
        detail = r.get("erreur", "")
        print(f"  [{etat}] {r['controle']}{' — ' + detail if detail else ''}")
    print(f"PRODUCTION it.148 : {ok}/{len(rapport)} contrôles MATCH")


if __name__ == "__main__":
    main()

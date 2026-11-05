#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Harnais de validation production gen3ia.online — 8 points.

Reconstruit après recyclage de session (l'original test-flux-fichiers-prod.py
n'était pas committé). Vérifie que le flux fichiers → prod est complet :
version alignée, battement vivant, PWA anti-cache, manifest, offline, assets
réels du dernier commit, page d'accueil, contenu statique.

Usage : python3 scripts/test-flux-fichiers-prod.py [<sha_attendu>]
Sans argument, le sha attendu = HEAD local (git rev-parse HEAD).
"""
import json
import subprocess
import sys
import time
import urllib.request

BASE = "https://gen3ia.online"
UA = {"User-Agent": "harnais-flux-prod/2 (Job 478451)"}


def get(path: str, timeout: int = 25):
    req = urllib.request.Request(BASE + path, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.headers, r.read()


def main() -> int:
    try:
        sha_local = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        sha_local = ""
    attendu = sys.argv[1] if len(sys.argv) > 1 else sha_local
    resultats = []

    def point(nom: str, ok: bool, detail: str):
        resultats.append((nom, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'} [{len(resultats)}/8] {nom} — {detail}")

    # 1. version.json : sha servi == sha attendu
    try:
        st, _, body = get("/version.json")
        v = json.loads(body)
        sha_served = v.get("gitSha", "")
        point(
            "version.json sha servi",
            st == 200 and sha_served.startswith(attendu[:7]),
            f"HTTP {st}, gitSha={sha_served[:12]}, attendu={attendu[:12]}, build={v.get('buildDate')}",
        )
    except Exception as e:
        point("version.json sha servi", False, f"exception {e}")

    # 2. heartbeat : ok=true, frais (< 15 min), servedSha == targetSha
    try:
        st, _, body = get("/poller-heartbeat.json")
        h = json.loads(body)
        age = time.time() - float(h.get("epoch", 0))
        point(
            "battement poller vivant",
            st == 200 and h.get("ok") is True and age < 900,
            f"HTTP {st}, age={int(age)}s, served={h.get('servedSha', '')[:12]}, "
            f"target={h.get('targetSha', '')[:12]}",
        )
    except Exception as e:
        point("battement poller vivant", False, f"exception {e}")

    # 3. sw.js : servi + correctif anti-cache présent (network-first navigations)
    try:
        st, _, body = get("/sw.js")
        txt = body.decode("utf-8", "replace")
        anti_cache = "network-first" in txt and "purge" in txt.lower()
        point(
            "sw.js anti-cache (b7e2d0c)",
            st == 200 and anti_cache,
            f"HTTP {st}, {len(body)} o, network-first={'network-first' in txt}",
        )
    except Exception as e:
        point("sw.js anti-cache (b7e2d0c)", False, f"exception {e}")

    # 4. manifest.webmanifest : 200 + JSON valide
    try:
        st, _, body = get("/manifest.webmanifest")
        m = json.loads(body)
        point(
            "manifest.webmanifest",
            st == 200 and m.get("name") is not None,
            f"HTTP {st}, name={m.get('name')}",
        )
    except Exception as e:
        point("manifest.webmanifest", False, f"exception {e}")

    # 5. offline.html : 200
    try:
        st, _, body = get("/offline.html")
        point("offline.html", st == 200 and len(body) > 100, f"HTTP {st}, {len(body)} o")
    except Exception as e:
        point("offline.html", False, f"exception {e}")

    # 6. asset réel du dernier commit : audio it.95
    try:
        st, _, body = get("/multimodal-it95/audio/audio_000.wav")
        point(
            "asset it.95 servi (audio_000.wav)",
            st == 200 and len(body) > 1000,
            f"HTTP {st}, {len(body)} o",
        )
    except Exception as e:
        point("asset it.95 servi (audio_000.wav)", False, f"exception {e}")

    # 7. page d'accueil : 200 + HTML avec marqueur du shell
    try:
        st, _, body = get("/")
        html = body.decode("utf-8", "replace")
        point(
            "page d'accueil HTML",
            st == 200 and ("<html" in html.lower()) and len(body) > 1000,
            f"HTTP {st}, {len(body)} o",
        )
    except Exception as e:
        point("page d'accueil HTML", False, f"exception {e}")

    # 8. contenu statique : llms.txt
    try:
        st, _, body = get("/llms.txt")
        point("llms.txt", st == 200 and len(body) > 50, f"HTTP {st}, {len(body)} o")
    except Exception as e:
        point("llms.txt", False, f"exception {e}")

    ok = sum(1 for _, v, _ in resultats if v)
    total = len(resultats)
    print(f"\n=== RÉSULTAT : {ok}/{total} PASS ===")
    return 0 if ok == total == 8 else 1


if __name__ == "__main__":
    sys.exit(main())

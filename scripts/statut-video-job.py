#!/usr/bin/env python3
"""Lit le statut détaillé (error/warnings) d'un job de production vidéo.
Usage: python3 statut-video-job.py <email> <password> <projectId>"""
import json
import sys
import urllib.request
import http.cookiejar

BASE = "https://www.gen3ia.online"
EMAIL, PASSWORD, PID = sys.argv[1], sys.argv[2], sys.argv[3]

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.addheaders = [("User-Agent",
                      "Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0")]


def post(url: str, data: dict) -> dict:
    req = urllib.request.Request(
        url, json.dumps(data).encode(),
        {"Content-Type": "application/json"})
    with opener.open(req, timeout=60) as r:
        return json.loads(r.read().decode())


def get(url: str) -> dict:
    with opener.open(url, timeout=60) as r:
        return json.loads(r.read().decode())


login = post(BASE + "/api/auth/r2/login",
             {"email": EMAIL, "password": PASSWORD})
print(f"[login] statut={login.get('user', {}).get('email', '?')} "
      f"clés={list(login.keys())}")
if PID == "latest":
    liste = get(BASE + "/api/video/projects")
    projets = liste.get("projects") or []
    print(f"[projets] {len(projets)} projet(s)")
    if not projets:
        sys.exit(1)
    PID = projets[0].get("id") or projets[0].get("projectId")
    print(f"[projet] id={PID} titre={projets[0].get('title')}")
statut = get(BASE + f"/api/video/projects/{PID}/production")
print(json.dumps(statut, ensure_ascii=False, indent=2)[:3000])

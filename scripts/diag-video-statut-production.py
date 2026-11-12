#!/usr/bin/env python3
"""Diagnostic ciblé — statut de production vidéo en production réelle.

Réutilise la séquence d'inscription durcie de la sonde voix/vidéo
(hydration AURORA V2 + 4 réessayages), envoie une demande vidéo courte
explicite, puis imprime la réponse BRUTE de /api/video/projects et de
…/production (status, stage, progress, erreur éventuelle) jusqu'à 6 min.
"""
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
STAMP = str(int(time.time()))
EMAIL = f"diag{STAMP}@e2e-gen3ia.test"
PASSWORD = "E2e!Diag" + STAMP[-4:]

MSG = ("Crée une vidéo de 10 secondes : un chat noir dort au soleil "
       "sur un rebord de fenêtre.")


def inscrire(page) -> None:
    inscrit = False
    for tentative in range(4):
        page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_selector('input[type="email"]', state="visible",
                                   timeout=45000)
            page.wait_for_selector("button:has-text(\"S'inscrire\")",
                                   timeout=20000)
        except Exception:
            print(f"[réessayage inscription {tentative + 1}]", flush=True)
            time.sleep(3)
            continue
        page.click("button:has-text(\"S'inscrire\")", timeout=15000)
        time.sleep(1)
        for sel, val in [
            ('input[placeholder="Prénom"]', "Diag"),
            ('input[placeholder="Nom"]', "Video"),
            ('input[placeholder="Nom d\'utilisateur"]', "diag" + STAMP[-8:]),
            ('input[type="email"]', EMAIL),
            ('input[type="password"] >> nth=0', PASSWORD),
            ('input[type="password"] >> nth=1', PASSWORD),
        ]:
            page.fill(sel, val)
            time.sleep(0.3)
            if page.locator(sel).first.input_value() != val:
                page.fill(sel, val)
                time.sleep(0.5)
        try:
            with page.expect_response(
                lambda r: "/api/auth/r2/signup" in r.url, timeout=20000
            ) as reponse_info:
                page.click('button[type="submit"]', timeout=15000)
            print("[réseau] POST signup →", reponse_info.value.status, flush=True)
            if reponse_info.value.status in (200, 201):
                inscrit = True
                break
        except Exception as e:
            print(f"[inscription exception {tentative + 1}]",
                  type(e).__name__, flush=True)
            time.sleep(2)
    if not inscrit:
        print("INSCRIPTION IMPOSSIBLE", flush=True)
        sys.exit(1)
    try:
        page.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass
    time.sleep(2)


def envoyer_video(page) -> None:
    page.goto(BASE + "/chat", wait_until="domcontentloaded", timeout=60000)
    saisie = page.locator("textarea.nova-saisie")
    saisie.wait_for(state="visible", timeout=60000)
    time.sleep(3)
    saisie.fill(MSG)
    time.sleep(1)
    if page.evaluate("document.querySelector('textarea.nova-saisie')?.value ?? ''") != MSG:
        saisie.fill(MSG)
        time.sleep(1)
    with page.expect_response(
        lambda r: "/messages/stream" in r.url, timeout=30000
    ) as reponse_info:
        saisie.press("Enter")
    print("[réseau] POST stream →", reponse_info.value.status, flush=True)


avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
page.set_default_timeout(60000)

try:
    inscrire(page)
    envoyer_video(page)

    pid = ""
    debut = time.time()
    while time.time() - debut < 90 and not pid:
        try:
            corps = page.evaluate(
                "fetch('/api/video/projects',{credentials:'include',cache:'no-store'})"
                ".then(r => r.status + '|' + r.text())")
            statut_http, _, corps_json = corps.partition("|")
            projets = json.loads(corps_json).get("projects") or []
            if projets:
                pid = str(projets[0].get("id") or projets[0].get("projectId") or "")
                break
            print(f"[projets] HTTP {statut_http} : {corps_json[:140]}", flush=True)
        except Exception as e:
            print(f"[projets] err {type(e).__name__}", flush=True)
        time.sleep(4)
    print("projectId =", pid[:44], flush=True)
    if not pid:
        sys.exit(1)

    debut = time.time()
    while time.time() - debut < 360:
        try:
            corps = page.evaluate(
                "async (pid) => { const r = await fetch("
                "`/api/video/projects/${pid}/production`,"
                "{credentials:'include',cache:'no-store'});"
                " return r.status + '|' + (await r.text()).slice(0, 400); }", pid)
            print(f"[{int(time.time() - debut)}s] {corps[:300]}", flush=True)
            if '"status":"completed"' in corps or '"status":"failed"' in corps:
                break
        except Exception as e:
            print(f"[{int(time.time() - debut)}s] err {type(e).__name__}",
                  flush=True)
        time.sleep(12)
    page.screenshot(path="/tmp/diag-video.png")
    print("[capture] /tmp/diag-video.png", flush=True)
finally:
    nav.close()
    avec.stop()

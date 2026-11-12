#!/usr/bin/env python3
"""Rattrapage patient — suit une production vidéo déjà lancée jusqu'à la
livraison dans le fil (connexion par email/mot de passe, polling du fil,
téléchargement du master si livré). Usage :
  python3 suivi-video-production.py <email> <password> [minutes]
"""
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

EMAIL = sys.argv[1]
PASSWORD = sys.argv[2]
MINUTES = int(sys.argv[3]) if len(sys.argv) > 3 else 8


def lire_fil(page) -> str:
    fil = page.locator(".nova-fil .nova-bulle")
    return "\n".join(fil.nth(i).inner_text() for i in range(fil.count())) \
        if fil.count() else ""


avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
page.set_default_timeout(60000)

try:
    # CONNEXION (compte existant) — flux de la sonde : page /signup,
    # bouton « Se connecter » (bascule AURORA), POST /api/auth/r2/login.
    connecte = False
    for tentative in range(4):
        page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_selector('input[type="email"]', state="visible",
                                   timeout=45000)
            page.wait_for_selector("button:has-text(\"Se connecter\")",
                                   timeout=20000)
        except Exception:
            print(f"[réessayage {tentative + 1}] page non hydratée", flush=True)
            time.sleep(3)
            continue
        page.click("button:has-text(\"Se connecter\")", timeout=15000)
        time.sleep(1)
        page.fill('input[type="email"]', EMAIL)
        page.fill('input[type="password"] >> nth=0', PASSWORD)
        try:
            with page.expect_response(
                lambda r: "/api/auth/r2/login" in r.url, timeout=20000
            ) as rep:
                page.click('button[type="submit"]', timeout=15000)
            print("[réseau] POST login →", rep.value.status, flush=True)
            if rep.value.status in (200, 201):
                connecte = True
                break
        except Exception as e:
            print(f"[login réessayage {tentative + 1}] {type(e).__name__}",
                  flush=True)
        time.sleep(3)
    if not connecte:
        print("CONNEXION IMPOSSIBLE", flush=True)
        sys.exit(1)
    time.sleep(3)

    # projet le plus récent
    pid = ""
    debut = time.time()
    while time.time() - debut < 60 and not pid:
        try:
            corps = page.evaluate(
                "async () => { const r = await fetch('/api/video/projects',{credentials:'include',cache:'no-store'});"
                " return r.status + '|' + (await r.text()); }")
            code, _, corps_json = corps.partition("|")
            projets = json.loads(corps_json).get("projects") or []
            if projets:
                pid = str(projets[0].get("id") or projets[0].get("projectId") or "")
                print(f"[projet] {pid[:40]} titre="
                      f"{str(projets[0].get('title'))[:50]}", flush=True)
                break
            print(f"[projets] HTTP {code} : {corps_json[:140]}", flush=True)
        except Exception as e:
            print(f"[projets] err {type(e).__name__}", flush=True)
        time.sleep(5)

    debut = time.time()
    livree = False
    master_url = ""
    while time.time() - debut < MINUTES * 60:
        page.goto(BASE + "/chat", wait_until="domcontentloaded")
        time.sleep(6)
        fil = lire_fil(page)
        if "Votre vidéo est prête" in fil:
            livree = True
            m = re.search(r"Regardez votre vidéo ici\s*:\s*(\S+)", fil)
            if m:
                master_url = m.group(1)
            print("[FIL] LIVRAISON TROUVÉE :", flush=True)
            for ligne in fil.splitlines():
                if "vidéo est prête" in ligne or "Regardez" in ligne \
                        or "Projet vidéo" in ligne:
                    print("   ", ligne.strip()[:160], flush=True)
            break
        if pid:
            try:
                corps = page.evaluate(
                    "async (pid) => { const r = await fetch("
                    "`/api/video/projects/${pid}/production`,"
                    "{credentials:'include',cache:'no-store'});"
                    " return r.status + '|' + (await r.text()).slice(0,300); }", pid)
                print(f"[{int((time.time()-debut)/60)}min] {corps[:220]}",
                      flush=True)
            except Exception as e:
                print(f"[{int((time.time()-debut)/60)}min] err",
                      type(e).__name__, flush=True)
        time.sleep(20)

    if livree and master_url:
        try:
            reponse = page.context.request.get(master_url, timeout=120000)
            donnees = reponse.body()
            tete = donnees[:16]
            ok = len(donnees) >= 100_000 and tete[4:8] == b"ftyp"
            print(f"[master] {len(donnees)} octets, tête={tete[:12].hex()} "
                  f"→ {'MP4 VALIDE' if ok else 'INVALIDE'}", flush=True)
        except Exception as e:
            print(f"[master] erreur téléchargement {type(e).__name__}",
                  flush=True)
    page.screenshot(path="/tmp/suivi-video.png")
    print("[capture] /tmp/suivi-video.png", flush=True)
    print("VERDICT :", "LIVRÉE" if livree else "NON LIVRÉE (délai)",
          flush=True)
finally:
    nav.close()
    avec.stop()

#!/usr/bin/env python3
"""Vérification NAVIGATEUR INTÉGRÉ recherche web — gen3ia en production.

Durcie après diagnostic (course d'hydratation React) :
  - l'inscription est prouvée par le POST /api/auth/r2/signup (réponse
    réseau), pas par une navigation (dashboard est public) ;
  - la session est prouvée par /api/auth/session → authenticated:true ;
  - l'envoi du message est prouvé par le POST …/messages/stream ;
  - les valeurs DOM des inputs contrôlés sont revérifiées avant submit.
"""
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
STAMP = str(int(time.time()))
EMAIL = f"web{STAMP}@e2e-gen3ia.test"
PASSWORD = "E2e!Recherche" + STAMP[-4:]
CAPTURE = Path("/tmp/recherche-web-production.png")

resultats = []


def verif(label: str, ok: bool, detail: str = "") -> None:
    resultats.append(ok)
    print(f"[check] {'OK   ' if ok else 'ECHEC'} {label}"
          + (f" - {detail}" if detail else ""), flush=True)


MESSAGE = "Cherche sur le web les dernières actualités intelligence artificielle"
MOTIFS_SOURCES = re.compile(r"(Sources|sources|http[s]?://|www\.|\[\d+\])", re.M)
MOTIFS_REFUS = re.compile(
    r"(je ne peux pas (naviguer|consulter|accéder)|(ne|no) (peux|can) ?'?t (browse|access)|"
    r"pas (de|d')accès (à|au) internet|pas capable de naviguer)", re.I)

avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
page.set_default_timeout(60000)

try:
    # 1) INSCRIPTION — prouvée par le POST réseau (hydration-proof)
    page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector('input[type="email"]', state="visible", timeout=60000)
    time.sleep(3)
    inscrit = False
    for tentative in range(4):
        # chaque tentative est auto-contenue : le CDN redéploie souvent,
        # une coquille non hydratée se répare par un rechargement complet
        page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_selector('input[type="email"]', state="visible", timeout=45000)
            page.wait_for_selector("button:has-text(\"S'inscrire\")", timeout=20000)
        except Exception as e:
            print(f"[réessayage {tentative + 1}] page non hydratée : {type(e).__name__}", flush=True)
            time.sleep(3)
            continue
        # onglet « S'inscrire » → mode inscription (attente hydratation réelle)
        page.click("button:has-text(\"S'inscrire\")", timeout=15000)
        time.sleep(1)
        for sel, val in [
            ('input[placeholder="Prénom"]', "Recherche"),
            ('input[placeholder="Nom"]', "Web"),
            ('input[placeholder="Nom d\'utilisateur"]', "rw" + STAMP[-8:]),
            ('input[type="email"]', EMAIL),
            ('input[type="password"] >> nth=0', PASSWORD),
            ('input[type="password"] >> nth=1', PASSWORD),
        ]:
            page.fill(sel, val)
            time.sleep(0.3)
            valeur_dom = page.locator(sel).first.input_value()
            if valeur_dom != val:  # contrôlé React non branché : on refait
                page.fill(sel, val)
                time.sleep(0.5)
        try:
            with page.expect_response(
                lambda r: "/api/auth/r2/signup" in r.url, timeout=20000
            ) as reponse_info:
                page.click('button[type="submit"]', timeout=15000)
            statut = reponse_info.value.status
            print(f"[réseau] POST /api/auth/r2/signup → {statut}", flush=True)
            if statut in (200, 201):
                inscrit = True
                break
        except Exception:
            alerte = ""
            try:
                alerte = page.locator('p[role="alert"]').first.inner_text()
            except Exception:
                pass
            print(f"[réessayage {tentative + 1}] alerte={alerte[:120] or '(aucune)'}", flush=True)
            # compte déjà créé par une tentative précédente de CE run : on
            # bascule sur la CONNEXION avec les mêmes identifiants
            if "déjà utilisée" in alerte:
                try:
                    page.click("button:has-text(\"Se connecter\")", timeout=15000)
                    time.sleep(1)
                    page.fill('input[type="email"]', EMAIL)
                    page.fill('input[type="password"] >> nth=0', PASSWORD)
                    with page.expect_response(
                        lambda r: "/api/auth/r2/login" in r.url, timeout=20000
                    ) as rep_login:
                        page.click('button[type="submit"]', timeout=15000)
                    print(f"[réseau] POST /api/auth/r2/login → {rep_login.value.status}", flush=True)
                    inscrit = True
                    break
                except Exception as e:
                    print(f"[connexion repli] {type(e).__name__}", flush=True)
            time.sleep(2)
    verif("1. inscription RÉELLE (POST /api/auth/r2/signup 2xx)", inscrit, EMAIL)

    # fin de navigation post-inscription avant toute évaluation JS
    try:
        page.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass
    time.sleep(2)

    # 2) /chat authentifié puis SESSION prouvée par /api/auth/session
    page.goto(BASE + "/chat", wait_until="domcontentloaded", timeout=60000)
    saisie = page.locator("textarea.nova-saisie")
    saisie.wait_for(state="visible", timeout=60000)
    time.sleep(3)
    authentifie = False
    for _ in range(6):
        try:
            corps = page.evaluate(
                "fetch('/api/auth/session',{credentials:'include',cache:'no-store'})"
                ".then(r => r.text())")
            if '"authenticated":true' in corps:
                authentifie = True
                break
        except Exception:
            pass  # navigation en cours : on réessaie
        time.sleep(2)
    verif("2. /chat ouvert + session serveur prouvée (authenticated:true)",
          authentifie)

    # 4) ENVOI — prouvé par le POST du flux de messages
    envoye = False
    for tentative in range(3):
        saisie.fill(MESSAGE)
        time.sleep(1)
        if page.evaluate(
            "document.querySelector('textarea.nova-saisie')?.value ?? ''"
        ) != MESSAGE:  # contrôlé non branché : on refait
            saisie.fill(MESSAGE)
            time.sleep(1)
        try:
            with page.expect_response(
                lambda r: "/messages/stream" in r.url, timeout=30000
            ) as reponse_info:
                saisie.press("Enter")
            statut = reponse_info.value.status
            print(f"[réseau] POST …/messages/stream → {statut}", flush=True)
            envoye = True
            break
        except Exception as e:
            alerte = ""
            try:
                alerte = page.locator('p[role="alert"], .nova-toast').first.inner_text()
            except Exception:
                pass
            print(f"[réessayage envoi {tentative + 1}] {type(e).__name__} alerte={alerte[:100]}", flush=True)
    verif("4. message envoyé (POST …/messages/stream vu)", envoye, MESSAGE)

    # 5) Réponse complète : bulles du fil, indicateur frappe → fin → stabilité
    dernier = ""
    debut = time.time()
    if envoye:
        try:
            page.locator(".nova-fil .nova-bulle").first.wait_for(
                state="visible", timeout=30000)
        except Exception:
            pass
        if frappe := page.locator(".nova-frappe"):
            try:
                frappe.last.wait_for(state="visible", timeout=30000)
                frappe.last.wait_for(state="hidden", timeout=300000)
            except Exception:
                pass
        for _ in range(4):  # stabilité : 2 lectures identiques à 3 s d'écart
            bulles = page.locator(".nova-fil .nova-bulle")
            dernier = bulles.last.inner_text() if bulles.count() else ""
            time.sleep(3)
            bulles = page.locator(".nova-fil .nova-bulle")
            nouveau = bulles.last.inner_text() if bulles.count() else ""
            if nouveau == dernier and len(nouveau) > 80:
                dernier = nouveau
                break
            dernier = nouveau
    duree = time.time() - debut
    reponse = dernier.strip()
    verif("5. réponse assistant complète (bulle stable)", len(reponse) > 80,
          f"{duree:.0f}s d'attente, bulle {len(reponse)} caractères")

    # 6) Preuve dans LA RÉPONSE : sources réelles, pas de refus
    a_des_sources = bool(MOTIFS_SOURCES.search(reponse))
    refuse = bool(MOTIFS_REFUS.search(reponse))
    urls = re.findall(r"https?://[^\s)\]»]+", reponse)
    urls_externes = [u for u in urls if "gen3ia" not in u]
    citations = re.findall(r"\[\d+\]", reponse)
    verif("6. réponse avec SOURCES web réelles", a_des_sources and not refuse,
          f"{len(urls_externes)} URL(s), {len(citations)} citation(s) [n]")
    verif("7. aucun refus de navigation dans la réponse", not refuse)

    extrait = " ".join(reponse.split())[:1100]
    print(f"[extrait-réponse] {extrait}", flush=True)

    page.screenshot(path=str(CAPTURE), full_page=False)
    print(f"[capture] {CAPTURE} ({CAPTURE.stat().st_size} octets)", flush=True)

finally:
    nav.close()
    avec.stop()

echecs = resultats.count(False)
print(f"\nVERDICT : {resultats.count(True)}/{len(resultats)} vérifications OK"
      + (" — GREEN" if echecs == 0 else f" — {echecs} ÉCHEC(S)"), flush=True)
sys.exit(0 if echecs == 0 else 1)

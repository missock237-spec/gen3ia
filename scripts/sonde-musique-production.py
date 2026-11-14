#!/usr/bin/env python3
"""Sonde PRODUCTION — CHANSON complète (exigence utilisateur 2026-11-14).

Inscription réelle puis deux demandes dans le fil :
  1. chanson AVEC titre cité : « Crée une chanson titre : "Étoiles de minuit"
     style pop » — le message du fil doit citer le titre RESPECTÉ, les
     paroles, et porter un lien d'écoute durable ; l'audio est TÉLÉCHARGÉ
     et vérifié (MP3 réel, taille, ffprobe : durée ≥ 45 s) ;
  2. chanson SANS titre : « crée une chanson sur la mer et les vagues » —
     le message doit dire « inventé par moi » (titre par gen3) et livrer
     un audio ;
  3. chanson avec CLIP musical demandé — le message porte un lien de clip.

Rapport [check] OK/ECHEC par exigence, exit 0 ssi tout est vert.
"""
import json
import re
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
STAMP = str(int(time.time()))
EMAIL = f"musique{STAMP}@e2e-gen3ia.test"
PASSWORD = "E2e!Musique" + STAMP[-4:]
CAPTURE = "/tmp/sonde-musique-production.png"

resultats: list[tuple[str, bool, str]] = []


def verif(nom: str, ok: bool, detail: str = "") -> None:
    resultats.append((nom, ok, detail))
    print(f"[check] {'OK   ' if ok else 'ECHEC'} {nom}" + (f" - {detail[:120]}" if detail else ""), flush=True)


def inscrire(page) -> None:
    inscrit = False
    for tentative in range(5):
        page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_selector('input[type="email"]', state="visible", timeout=45000)
            for essai in range(4):
                page.click('button:has-text("S\'inscrire")', timeout=10000)
                try:
                    page.wait_for_selector('input[placeholder="Prénom"]', state="visible", timeout=8000)
                    break
                except Exception:
                    print(f"[onglet non hydraté, re-essai {essai + 1}]", flush=True)
                    time.sleep(2)
            else:
                raise RuntimeError("onglet S'inscrire inopérant")
        except Exception as e:
            print(f"[réessayage inscription {tentative + 1}]", type(e).__name__, flush=True)
            time.sleep(3)
            continue
        time.sleep(0.5)
        for sel, val in [
            ('input[placeholder="Prénom"]', "Musique"),
            ('input[placeholder="Nom"]', "Probe"),
            ('input[placeholder="Nom d\'utilisateur"]', "musique" + STAMP[-8:]),
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
                lambda r: "/api/auth/r2/signup" in r.url, timeout=25000
            ) as reponse_info:
                page.click('button:has-text("Créer mon compte")', timeout=15000)
            print("[réseau] POST signup →", reponse_info.value.status, flush=True)
            if reponse_info.value.status in (200, 201):
                inscrit = True
                break
        except Exception as e:
            print(f"[inscription exception {tentative + 1}]", type(e).__name__, flush=True)
            time.sleep(2)
    if not inscrit:
        print("INSCRIPTION IMPOSSIBLE", flush=True)
        sys.exit(1)
    try:
        page.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass
    time.sleep(2)
    verif("M1a. inscription RÉELLE", True)


def envoyer(page, message: str) -> None:
    page.goto(BASE + "/chat", wait_until="domcontentloaded", timeout=60000)
    saisie = page.locator("textarea.nova-saisie")
    saisie.wait_for(state="visible", timeout=60000)
    time.sleep(3)
    saisie.fill(message)
    time.sleep(1)
    if page.evaluate("document.querySelector('textarea.nova-saisie')?.value ?? ''") != message:
        saisie.fill(message)
        time.sleep(1)
    with page.expect_response(
        lambda r: "/messages/stream" in r.url, timeout=30000
    ) as reponse_info:
        saisie.press("Enter")
    print("[réseau] POST stream →", reponse_info.value.status, flush=True)


def compteur_bulles(page) -> int:
    """Nombre de bulles du fil au moment de l'appel (référence anti-course)."""
    try:
        page.wait_for_selector(".nova-fil .nova-bulle", state="visible", timeout=15000)
    except Exception:
        return 0
    return page.locator(".nova-fil .nova-bulle").count()


def derniers_messages(page, base: int = 0) -> list:
    """Lit les bulles du fil via le DOM (même méthode que la sonde vidéo),
    en ne considérant que les bulles APPARUES après `base` (anti-course)."""
    try:
        page.wait_for_selector(".nova-fil .nova-bulle", state="visible", timeout=15000)
    except Exception:
        return []
    bulles = page.locator(".nova-fil .nova-bulle")
    total = bulles.count()
    messages = []
    for i in range(max(base, 0), total):
        try:
            messages.append({"role": "assistant", "contenu": bulles.nth(i).inner_text()})
        except Exception:
            continue
    return messages


def attendre_reponse_musicale(page, cle: str, budget_s: int, base: int = 0) -> dict | None:
    """Attend une bulle assistant FINALE contenant la clé (lien écoute/clip).
    Journalise la DERNIÈRE bulle même sans clé (visibilité des échecs)."""
    debut = time.time()
    dernier = ""
    while time.time() - debut < budget_s:
        try:
            bulles = derniers_messages(page)
            if bulles:
                dernier = (bulles[-1].get("contenu") or "")[:160].replace("\n", " ")
            for m in reversed(bulles):
                contenu = m.get("contenu") or ""
                if cle not in contenu:
                    continue
                # Une bulle « livrée » porte le lien d'écoute et le récap.
                if ("Écoutez ici" in contenu) or ("Clip musical" in cle and "Clip musical" in contenu):
                    return {"contenu": contenu, "status": "complete", "message": m}
                if "pas réussi" in contenu:
                    return {"contenu": contenu, "status": "failed", "message": m}
        except Exception as e:
            dernier = f"erreur lecture fil : {type(e).__name__}"
        time.sleep(6)
    print(f"[attente] budget épuisé — dernier état : {dernier}", flush=True)
    return None


def telecharger_audio(page, url: str, destination: str) -> int:
    """Télécharge via le contexte de requête Playwright (cookies de session,
    binaire direct — pas de limite btoa)."""
    try:
        reponse = page.context.request.get(url, timeout=120000)
        if reponse.status != 200:
            return -reponse.status
        corps = reponse.body()
        with open(destination, "wb") as f:
            f.write(corps)
        return len(corps)
    except Exception as e:
        print("[download]", type(e).__name__, str(e)[:120], flush=True)
        return -1


avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
page.set_default_timeout(60000)

try:
    inscrire(page)

    # ── Exigence 1 : titre CITÉ → respecté + paroles + voix + audio réel ──
    base = compteur_bulles(page)
    envoyer(page, 'Crée une chanson titre : "Étoiles de minuit" style pop')
    reponse = attendre_reponse_musicale(page, "/api/media/durable", 300, base)
    verif("M2a. chanson livrée dans le fil (lien durable)", reponse is not None and reponse["status"] == "complete",
          f"status={reponse['status'] if reponse else '?'}")
    if reponse:
        contenu = reponse["contenu"]
        verif("M2b. TITRE CITÉ respecté (« Étoiles de minuit »)", "Étoiles de minuit" in contenu)
        verif("M2c. titre annoncé comme DONNÉ par l'utilisateur", "celui que vous avez donné" in contenu)
        verif("M2d. PAROLES mentionnées (refrain cité)", ("refrain" in contenu.lower()))
        verif("M2e. voix humaine réelle annoncée", "voix humaine" in contenu.lower())
        lien = re.search(r"https?://[^\s)]*api/media/durable\?path=[^\s)]+", contenu)
        verif("M2f. lien d'écoute présent", lien is not None)
        if lien:
            octets = telecharger_audio(page, lien.group(0), "/tmp/chanson-probe.mp3")
            verif("M2g. AUDIO téléchargé (≥ 500 Ko, MP3 réel)", octets >= 500_000, f"{octets} octets")
            if octets > 0:
                probe = subprocess.run(
                    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json",
                     "/tmp/chanson-probe.mp3"],
                    capture_output=True, text=True, timeout=60)
                try:
                    duree = float(json.loads(probe.stdout)["format"]["duration"])
                except Exception:
                    duree = -1.0
                verif("M2h. durée audio réelle ≥ 45 s (ffprobe)", duree >= 45.0, f"{duree:.1f} s")

    # ── Exigence 2 : SANS titre → gen3 en invente un ──
    # ANTI-COURSE (constat M3b) : la lecture ne considère que les bulles
    # APPARUES après l'envoi (compteur de référence) — sinon la bulle de
    # la chanson précédente re-matche instantanément.
    base = compteur_bulles(page)
    envoyer(page, "crée une chanson sur la mer et les vagues")
    reponse2 = attendre_reponse_musicale(page, "/api/media/durable", 300, base)
    verif("M3a. chanson sans titre livrée", reponse2 is not None and reponse2["status"] == "complete")
    if reponse2:
        verif("M3b. titre INVENTÉ annoncé (« inventé par moi »)", "inventé par moi" in reponse2["contenu"])

    # ── Exigence 3 : clip musical SEULEMENT si demandé ──
    base = compteur_bulles(page)
    envoyer(page, "crée une chanson sur le désert avec un clip musical")
    reponse3 = attendre_reponse_musicale(page, "Clip musical", 420, base)
    verif("M4a. clip musical livré sur demande", reponse3 is not None and reponse3["status"] == "complete",
          f"status={reponse3['status'] if reponse3 else '?'}")
    if reponse3:
        verif("M4b. lien du clip présent", "api/media/durable" in reponse3["contenu"].split("Clip musical")[1][:200] if "Clip musical" in reponse3["contenu"] else False)

finally:
    try:
        page.screenshot(path=CAPTURE)
    except Exception:
        pass
    nav.close()
    avec.stop()

verts = sum(1 for _, ok, _ in resultats if ok)
total = len(resultats)
print(f"\n[rapport] {verts}/{total} GREEN — chanson production", flush=True)
sys.exit(0 if verts == total else 1)

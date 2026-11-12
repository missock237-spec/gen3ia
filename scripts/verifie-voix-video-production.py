#!/usr/bin/env python3
"""Vérification PRODUCTION voix humaine + vidéo réaliste — gen3ia.online.

Deux phases (demande propriétaire 2026-11-11) — lancer séparemment :
  python3 verifie-voix-video-production.py voix    (≈ 4 min)
  python3 verifie-voix-video-production.py video   (≈ 9 min)

  A. VOIX : « Crée un message vocal d'une femme qui se présente devant un
     homme » → réponse SERVEUR (Edge-TTS voix neuronale), PAS un refus
     « TRAITEMENT_REQUETE ». L'URL audio extraite est TÉLÉCHARGÉE et la
     vraie parole est prouvée par taille + octets magiques (ID3/frame mp3).
     Puis DURÉE EXPLICITE : « Crée une vidéo de 20 secondes … » →
     « durée cible 20 s » SANS « estimée selon votre besoin ».
  B. VIDÉO AUTO-DURÉE : demande SANS durée → « durée cible … estimée selon
     votre besoin », job de production lancé, puis POLLING de l'API de
     production jusqu'au master ; livraison « Votre vidéo est prête » +
     lien de lecture téléchargé (HTTP 200, poids > 100 Ko).

Durcie comme la sonde recherche-web : inscription prouvée par le POST
réseau, session prouvée par /api/auth/session, envoi prouvé par le POST
…/messages/stream, valeurs DOM revérifiées avant submit.
"""
import base64
import json
import re
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
STAMP = str(int(time.time()))
EMAIL = f"vv{STAMP}@e2e-gen3ia.test"
PASSWORD = "E2e!VoixVideo" + STAMP[-4:]

MSG_VOIX = "Crée un message vocal d'une femme qui se présente devant un homme"
MSG_VIDEO_AUTO = ("Crée une vidéo : un homme mange du poulet frit et dit "
                  "qu'il lui faut une boisson pétillante pour accompagner "
                  "ce poulet.")
MSG_VIDEO_DUREE = "Crée une vidéo de 20 secondes : un enfant souffle des bougies d'anniversaire."

POLL_MAX_S = 390  # budget honnête de production vidéo (6,5 min)

PHASE = sys.argv[1] if len(sys.argv) > 1 else "voix"
CAPTURE_VOIX = "/tmp/voix-production.png"
CAPTURE_VIDEO = "/tmp/video-production.png"

resultats = []


def verif(label: str, ok: bool, detail: str = "") -> None:
    resultats.append(ok)
    print(f"[check] {'OK   ' if ok else 'ECHEC'} {label}"
          + (f" - {detail}" if detail else ""), flush=True)


def attendre_reponse_stable(page) -> str:
    """Dernière bulle .nova-bulle stable (2 lectures identiques à 3 s)."""
    try:
        page.locator(".nova-fil .nova-bulle").first.wait_for(
            state="visible", timeout=30000)
    except Exception:
        pass
    try:
        frappe = page.locator(".nova-frappe")
        if frappe.count():
            frappe.last.wait_for(state="visible", timeout=45000)
            frappe.last.wait_for(state="hidden", timeout=420000)
    except Exception:
        pass
    dernier = ""
    for _ in range(5):
        bulles = page.locator(".nova-fil .nova-bulle")
        dernier = bulles.last.inner_text() if bulles.count() else ""
        time.sleep(3)
        bulles = page.locator(".nova-fil .nova-bulle")
        nouveau = bulles.last.inner_text() if bulles.count() else ""
        if nouveau == dernier and len(nouveau) > 40:
            return nouveau.strip()
        dernier = nouveau
    return dernier.strip()


def envoyer(page, saisie, message: str) -> bool:
    for tentative in range(3):
        saisie.fill(message)
        time.sleep(1)
        if page.evaluate(
            "document.querySelector('textarea.nova-saisie')?.value ?? ''"
        ) != message:
            saisie.fill(message)
            time.sleep(1)
        try:
            with page.expect_response(
                lambda r: "/messages/stream" in r.url, timeout=30000
            ) as reponse_info:
                saisie.press("Enter")
            print(f"[réseau] POST …/messages/stream → "
                  f"{reponse_info.value.status}", flush=True)
            return True
        except Exception as e:
            print(f"[réessayage envoi {tentative + 1}] {type(e).__name__}",
                  flush=True)
    return False


def telecharger_audio(page, url: str) -> tuple[int, bytes]:
    """Télécharge l'audio : data:URI décodée, sinon fetch navigateur puis
    repli urllib direct (R2 public). Retourne (taille, premiers octets)."""
    if url.startswith("data:"):
        tete, _, corps = url.partition(",")
        if "base64" in tete:
            brut = base64.b64decode(corps)
            return len(brut), brut[:16]
        return len(corps), corps[:16].encode()
    try:
        brut = page.evaluate(
            "async (u) => { const r = await fetch(u, {credentials:'include'});"
            " const b = await r.arrayBuffer();"
            " return Array.from(new Uint8Array(b.slice(0, 1 << 25))); }",
            url)
        donnees = bytes(brut)
        return len(donnees), donnees[:16]
    except Exception:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            donnees = r.read(1 << 25)
        return len(donnees), donnees[:16]


def est_audio(donnees: bytes) -> bool:
    if donnees[:3] == b"ID3":
        return True
    if len(donnees) >= 2 and donnees[0] == 0xFF and (donnees[1] & 0xE0) == 0xE0:
        return True  # frame mp3 sync
    if donnees[:4] == b"RIFF":
        return True  # wav
    if donnees[:4] == b"OggS":
        return True
    if len(donnees) >= 8 and donnees[4:8] == b"ftyp":
        return True
    return False


def inscrire_et_ouvrir_chat(page) -> None:
    """Inscription réelle (prouvée par le POST) puis /chat authentifié."""
    page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector('input[type="email"]', state="visible",
                           timeout=60000)
    time.sleep(3)
    inscrit = False
    for tentative in range(4):
        page.goto(BASE + "/signup", wait_until="domcontentloaded",
                  timeout=60000)
        try:
            page.wait_for_selector('input[type="email"]', state="visible",
                                   timeout=45000)
            page.wait_for_selector("button:has-text(\"S'inscrire\")",
                                   timeout=20000)
        except Exception:
            print(f"[réessayage {tentative + 1}] page non hydratée", flush=True)
            time.sleep(3)
            continue
        page.click("button:has-text(\"S'inscrire\")", timeout=15000)
        time.sleep(1)
        for sel, val in [
            ('input[placeholder="Prénom"]', "Voix"),
            ('input[placeholder="Nom"]', "Video"),
            ('input[placeholder="Nom d\'utilisateur"]', "vv" + STAMP[-8:]),
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
            if "déjà utilisée" in alerte:
                try:
                    page.click("button:has-text(\"Se connecter\")",
                               timeout=15000)
                    time.sleep(1)
                    page.fill('input[type="email"]', EMAIL)
                    page.fill('input[type="password"] >> nth=0', PASSWORD)
                    with page.expect_response(
                        lambda r: "/api/auth/r2/login" in r.url,
                        timeout=20000) as rep_login:
                        page.click('button[type="submit"]', timeout=15000)
                    print(f"[réseau] POST login → {rep_login.value.status}",
                          flush=True)
                    inscrit = True
                    break
                except Exception:
                    pass
            time.sleep(2)
    verif("1. inscription RÉELLE (POST /api/auth/r2/signup 2xx)", inscrit,
          EMAIL)
    try:
        page.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass
    time.sleep(2)
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
            pass
        time.sleep(2)
    verif("2. /chat + session serveur prouvée (authenticated:true)",
          authentifie)


def phase_voix(page, saisie) -> None:
    print("\n──── PHASE A : VOIX ────", flush=True)
    envoye = envoyer(page, saisie, MSG_VOIX)
    verif("A1. message vocal envoyé (POST …/messages/stream)", envoye)
    reponse_voix = attendre_reponse_stable(page) if envoye else ""
    refuse = "TRAITEMENT_REQUETE" in reponse_voix or (
        "je ne sais pas encore exécuter" in reponse_voix)
    a_vocal = "message vocal" in reponse_voix.lower()
    verif("A2. réponse = message vocal LIVRÉ (pas TRAITEMENT_REQUETE)",
          bool(reponse_voix) and a_vocal and not refuse,
          f"{len(reponse_voix)} car.")
    verif("A3. voix FÉMININE choisie selon le personnage (une femme …)",
          "féminine" in reponse_voix.lower(),
          "choisirVoixSelonPersonnage déterministe")
    urls = re.findall(r"https?://[^\s)\]»]+", reponse_voix)
    verif("A4. URL d'écoute présente dans le fil", len(urls) >= 1,
          f"{len(urls)} URL(s)")
    if urls:
        taille, tete = telecharger_audio(page, urls[-1])
        audio_ok = taille >= 15000 and est_audio(tete)
        verif("A5. AUDIO TÉLÉCHARGÉ = vraie parole (≥15 Ko, octets mp3/wav)",
              audio_ok, f"{taille} octets, tête={tete[:8].hex()}")
        print(f"[audio] URL={urls[-1][:120]} taille={taille} "
              f"tête={tete[:8].hex()}", flush=True)
    else:
        verif("A5. AUDIO TÉLÉCHARGÉ (≥15 Ko, octets mp3/wav)", False,
              "aucune URL à télécharger")
    page.screenshot(path=CAPTURE_VOIX)
    print(f"[capture] {CAPTURE_VOIX}", flush=True)
    print(f"[extrait-voix] {' '.join(reponse_voix.split())[:400]}",
          flush=True)

    print("\n──── PHASE C : DURÉE EXPLICITE ────", flush=True)
    envoye_c = envoyer(page, saisie, MSG_VIDEO_DUREE)
    reponse_c = attendre_reponse_stable(page) if envoye_c else ""
    duree_20 = "durée cible 20 s" in reponse_c.lower()
    pas_estimee = "estimée selon votre besoin" not in reponse_c.lower()
    verif("C1. durée EXPLICITE respectée (« durée cible 20 s », sans "
          "« estimée »)", duree_20 and pas_estimee,
          f"{len(reponse_c)} car.")
    print(f"[extrait-duree] {' '.join(reponse_c.split())[:300]}",
          flush=True)


def phase_video(page, saisie) -> None:
    print("\n──── PHASE B : VIDÉO (durée auto) ────", flush=True)
    envoye_b = envoyer(page, saisie, MSG_VIDEO_AUTO)
    verif("B1. demande vidéo envoyée", envoye_b)
    reponse_video = attendre_reponse_stable(page) if envoye_b else ""
    lancee = "production vidéo est lancée" in reponse_video.lower()
    duree_auto = "estimée selon votre besoin" in reponse_video.lower()
    a_duree = "durée cible" in reponse_video.lower()
    verif("B2. production vidéo LANCÉE automatiquement", lancee,
          f"{len(reponse_video)} car.")
    verif("B3. DURÉE ADAPTÉE AU BESOIN (durée cible + estimée selon besoin)",
          lancee and a_duree and duree_auto)
    m_id = None
    pid = ""
    titre_projet = ""
    debut_l = time.time()
    while time.time() - debut_l < 30:
        try:
            corps = page.evaluate(
                "fetch('/api/video/projects',{credentials:'include',cache:'no-store'})"
                ".then(r => r.text())")
            projets = json.loads(corps).get("projects") or []
            if projets:
                projet = projets[0]  # compte neuf : le plus récent = celui-ci
                pid = str(projet.get("id") or projet.get("projectId") or "")
                titre_projet = str(projet.get("title") or "")
                m_id = re.match(r"[A-Za-z0-9-]+", pid)
                break
        except Exception:
            pass
        time.sleep(4)
    verif("B4. projet vidéo créé CÔTÉ SERVEUR (GET /api/video/projects)",
          bool(m_id),
          f"id={pid[:24]} titre={titre_projet[:40]}")
    print(f"[extrait-video] {' '.join(reponse_video.split())[:400]}",
          flush=True)
    if not m_id:
        return

    pid = m_id.group(0)
    debut = time.time()
    statut, stage, progress = None, None, None
    while time.time() - debut < POLL_MAX_S:
        try:
            corps = page.evaluate(
                "async (pid) => { const r = await fetch("
                "`/api/video/projects/${pid}/production`,"
                "{credentials:'include',cache:'no-store'});"
                " return await r.text(); }", pid)
            donnees = json.loads(corps)
            statut = donnees.get("status")
            stage = donnees.get("stage")
            progress = donnees.get("progress")
        except Exception as e:
            print(f"[poll] erreur lecture statut {type(e).__name__}",
                  flush=True)
        if statut in ("completed", "failed", "cancelled"):
            break
        print(f"[poll] {int(time.time() - debut)}s status={statut} "
              f"stage={stage} progress={progress}", flush=True)
        time.sleep(15)
    verif("B5. production vidéo TERMINÉE (status=completed) en ≤6,5 min",
          statut == "completed",
          f"statut final={statut} stage={stage} progress={progress}")

    livree = False
    master_url = ""
    debut_fil = time.time()
    while time.time() - debut_fil < 60:
        fil = page.locator(".nova-fil .nova-bulle")
        texte_fil = "\n".join(
            fil.nth(i).inner_text() for i in range(fil.count())
        ) if fil.count() else ""
        if "Votre vidéo est prête" in texte_fil:
            livree = True
            m_master = re.search(
                r"Regardez votre vidéo ici\s*:\s*(\S+)", texte_fil)
            if m_master:
                master_url = m_master.group(1)
            break
        time.sleep(8)
    verif("B6. vidéo LIVRÉE DANS LE FIL (« Votre vidéo est prête »)",
          livree, master_url[:120] if master_url else "")
    if master_url:
        try:
            req = urllib.request.Request(master_url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                entetes = dict(r.headers)
                taille_video = int(entetes.get("Content-Length", "0") or 0)
                tete_v = r.read(16)
            video_ok = (taille_video >= 100_000 and tete_v[4:8] == b"ftyp")
            verif("B7. MASTER VIDÉO TÉLÉCHARGEABLE (mp4 ≥100 Ko)",
                  video_ok,
                  f"{taille_video} octets, tête={tete_v[:12].hex()}")
        except Exception as e:
            verif("B7. MASTER VIDÉO TÉLÉCHARGEABLE (mp4 ≥100 Ko)",
                  False, f"{type(e).__name__}")
    page.screenshot(path=CAPTURE_VIDEO)
    print(f"[capture] {CAPTURE_VIDEO}", flush=True)


avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
page.set_default_timeout(60000)

try:
    inscrire_et_ouvrir_chat(page)
    saisie = page.locator("textarea.nova-saisie")
    if PHASE == "voix":
        phase_voix(page, saisie)
    elif PHASE == "video":
        phase_video(page, saisie)
    else:
        print(f"phase inconnue : {PHASE} (voix|video)", flush=True)
        sys.exit(2)
finally:
    nav.close()
    avec.stop()

echecs = resultats.count(False)
print(f"\nVERDICT {PHASE.upper()} : {resultats.count(True)}/{len(resultats)} "
      "vérifications OK"
      + (" — GREEN" if echecs == 0 else f" — {echecs} ÉCHEC(S)"), flush=True)
sys.exit(0 if echecs == 0 else 1)

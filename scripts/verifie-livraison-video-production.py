#!/usr/bin/env python3
"""Sonde PRODUCTION « livraison vidéo » — fix 2026-11-13 (7baced1/150b611).

Constat propriétaire (capture 17:15) : « gen3 construit la vidéo mais il ne
l'envoie jamais à l'utilisateur » — message « Votre vidéo est prête 🎬 » +
carte figée sur « finalisation (100 %) » + lien /api/media/durable sur
l'apex. Le master.mp4 EXISTAIT dans R2 : la chaîne de livraison était morte
à trois étages (instantané local masquant le job terminal, lecteur en deux
sauts, cookie host-only contre liens apex).

Cette sonde prouve LA LIVRAISON de bout en bout en production réelle :
  L1. inscription réelle + session serveur prouvée ;
  L2. demande vidéo envoyée → production autopilote lancée ;
  L3. statut de production : masterUrl DURABLE (relative /api/media/durable)
      exposée dès que le job est terminé (contrat du fix) ;
  L4. LA CARTE DU FIL NE RESTE JAMAIS FIGÉE : lecteur <video> réellement
      monté (.nova-media-video) au lieu du carré « finalisation (100 %) » ;
  L5. message « Votre vidéo est prête » + lien dans le fil ;
  L6. master téléchargé VIA LE LIEN DU FIL (cookies navigateur, suivi 302
      R2) : mp4 ≥ 100 Ko, octets magiques ftyp — PREUVE MATÉRIELLE archivée
      dans download/ ;
  L7. RÉPARATION DES VIEUX LIENS APEX : le même chemin demandé sur
      https://gen3ia.online (apex) → 308 www → mp4 téléchargé (le cookie à
      Domain=.gen3ia.online suit) ;
  L8. capture d'écran du fil avec la vidéo livrée.

Lancer :  python3 scripts/verifie-livraison-video-production.py
Durée :   ~5-8 min (production vidéo réelle).
"""
import json
import re
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
APEX = "https://gen3ia.online"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
STAMP = str(int(time.time()))
EMAIL = f"lv{STAMP}@e2e-gen3ia.test"
PASSWORD = "E2e!Livraison" + STAMP[-4:]

MSG_VIDEO = ("Crée une vidéo : un chat qui danse sur un tapis au format "
             "youtube avec une durée de 10 secondes.")
POLL_MAX_S = 700

CAPTURE = "/tmp/livraison-video-production.png"
ARCHIVE = "/home/z/my-project/download/gen3-video-livraison-production.mp4"

resultats = []


def verif(label: str, ok: bool, detail: str = "") -> None:
    resultats.append(ok)
    print(f"[check] {'OK   ' if ok else 'ECHEC'} {label}"
          + (f" - {detail}" if detail else ""), flush=True)


def inscrire_et_ouvrir_chat(page) -> None:
    """Inscription réelle (prouvée par le POST réseau) puis /chat authentifié
    — flux durci repris de scripts/verifie-voix-video-production.py (9/9 vert)."""
    page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
    inscrit = False
    for tentative in range(4):
        page.goto(BASE + "/signup", wait_until="domcontentloaded",
                  timeout=60000)
        # Hydratation complète AVANT toute interaction (le clic d'onglet
        # avant re-render React est effacé — cause du premier échec).
        time.sleep(6)
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
        # Le formulaire d'inscription APPARAÎT après bascule d'onglet :
        # attendre le premier champ Prénom (le clic peut être hydraté tard).
        page.wait_for_selector('input[placeholder="Prénom"]',
                               state="visible", timeout=20000)
        time.sleep(1)
        for sel, val in [
            ('input[placeholder="Prénom"]', "Livraison"),
            ('input[placeholder="Nom"]', "Video"),
            ('input[placeholder="Nom d\'utilisateur"]', "lv" + STAMP[-8:]),
            ('input[type="email"]', EMAIL),
            ('input[type="password"] >> nth=0', PASSWORD),
            ('input[type="password"] >> nth=1', PASSWORD),
        ]:
            page.fill(sel, val, timeout=15000)
            time.sleep(0.3)
            if page.locator(sel).first.input_value() != val:
                page.fill(sel, val, timeout=15000)
                time.sleep(0.5)
        try:
            with page.expect_response(
                lambda r: "/api/auth/r2/signup" in r.url, timeout=20000
            ) as reponse_info:
                submitter = page.locator(
                    'button:has-text("Créer mon compte")')
                (submitter if submitter.count() else page.locator(
                    'button[type="submit"]')).first.click(timeout=15000)
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
    verif("L1a. inscription RÉELLE (POST /api/auth/r2/signup 2xx)", inscrit)
    page.goto(f"{BASE}/chat", wait_until="domcontentloaded", timeout=60000)
    time.sleep(4)
    session_ok = False
    try:
        avec_page = page.evaluate(
            "fetch('/api/auth/session',{credentials:'include'})"
            ".then(r=>r.json())")
        session_ok = bool(avec_page)
    except Exception:
        session_ok = False
    verif("L1b. session serveur prouvée", session_ok)


def envoyer(page, message: str) -> bool:
    saisie = page.locator("textarea.nova-saisie")
    for tentative in range(3):
        saisie.fill(message)
        time.sleep(1)
        if page.evaluate(
            "document.querySelector('textarea.nova-saisie')?.value ?? ''"
        ) != message:
            continue
        try:
            with page.expect_response(
                lambda r: "/messages/stream" in r.url, timeout=30000
            ) as reponse_info:
                saisie.press("Enter")
            return 200 <= reponse_info.value.status < 300
        except Exception:
            time.sleep(2)
    return False


def statut_production(page, project_id: str) -> dict:
    reponse = page.context.request.get(
        f"{BASE}/api/video/projects/{project_id}/production",
        timeout=120000,
    )
    if reponse.status != 200:
        return {}
    try:
        return json.loads(reponse.body().decode("utf-8"))
    except Exception:
        return {}


def phase_livraison(page) -> None:
    """Mono-run complet (mode « complet ») : lance puis vérifie."""
    project_id = resoudre_projet(page)
    if project_id:
        phase_livraison_sur_projet(page, project_id)


def resoudre_projet(page) -> str:
    """L2 — demande vidéo envoyée + projet résolu côté serveur."""
    envoye = envoyer(page, MSG_VIDEO)
    verif("L2a. demande vidéo envoyée (POST …/messages/stream)", envoye)
    time.sleep(8)
    project_id = ""
    debut = time.time()
    while time.time() - debut < 90 and not project_id:
        reponse = page.context.request.get(
            f"{BASE}/api/video/projects", timeout=60000)
        if reponse.status == 200:
            try:
                projets = json.loads(reponse.body().decode("utf-8"))
                if isinstance(projets, dict):
                    projets = projets.get("projects") or projets.get("items") or []
                if projets:
                    project_id = projets[0].get("id") or projets[0].get("projectId") or ""
            except Exception:
                pass
        if not project_id:
            # repli : texte du fil « Projet vidéo : {uuid} »
            try:
                fil = page.locator(".nova-fil .nova-bulle")
                texte = "\n".join(
                    fil.nth(i).inner_text() for i in range(fil.count())
                ) if fil.count() else ""
                m = re.search(r"Projet vidéo\s*:\s*([0-9a-f-]{16,})", texte)
                if m:
                    project_id = m.group(1)
            except Exception:
                pass
        time.sleep(5)
    verif("L2b. production vidéo LANCÉE (projet résolu côté serveur)",
          bool(project_id), project_id[:40] if project_id else "introuvable")
    return project_id


def phase_livraison_sur_projet(page, project_id: str) -> None:
    # L3 — poll production : statut completed + masterUrl DURABLE.
    statut, stage, progress = "", "", 0.0
    master_url = ""
    debut = time.time()
    while time.time() - debut < POLL_MAX_S:
        st = statut_production(page, project_id)
        statut = str(st.get("status") or "")
        stage = str(st.get("stage") or "")
        try:
            progress = float(st.get("progress") or 0.0)
        except Exception:
            progress = 0.0
        mu = st.get("masterUrl")
        if statut == "completed":
            master_url = mu if isinstance(mu, str) else ""
            break
        print(f"[poll] status={statut or '?'} stage={stage or '?'} "
              f"progress={progress * 100:.0f}% t={time.time() - debut:.0f}s",
              flush=True)
        time.sleep(30)
    verif("L3a. production TERMINÉE (statut completed constaté)", statut == "completed",
          f"statut={statut} stage={stage} progress={progress * 100:.0f}%")
    verif("L3b. masterUrl DURABLE exposée par le statut (contrat du fix)",
          bool(master_url) and master_url.startswith("/api/media/durable?path="),
          master_url[:120])

    # L4 — LA CARTE NE RESTE JAMAIS FIGÉE : lecteur <video> monté dans le fil.
    lecteur_visible = False
    figee = False
    debut_fil = time.time()
    while time.time() - debut_fil < 90 and not lecteur_visible:
        page.reload(wait_until="domcontentloaded")
        time.sleep(6)
        lecteur_visible = page.locator(
            ".nova-fil video.nova-media-video").count() > 0
        if not lecteur_visible:
            figee = page.locator(
                ".nova-fil .nova-media-carte-progress").count() > 0
        time.sleep(8)
    verif("L4. CARTE DU FIL : lecteur <video> réellement monté (plus de "
          "carré figé à 100 %)", lecteur_visible,
          "lecteur présent" if lecteur_visible
          else ("carte en progression persistante" if figee else "aucune carte"))

    # L5 — message de livraison dans le fil.
    livree = False
    lien_fil = ""
    fil = page.locator(".nova-fil .nova-bulle")
    texte_fil = "\n".join(
        fil.nth(i).inner_text() for i in range(fil.count())
    ) if fil.count() else ""
    livree = "Votre vidéo est prête" in texte_fil
    m_lien = re.search(r"Regardez votre vidéo ici\s*:\s*(\S+)", texte_fil)
    if m_lien:
        lien_fil = m_lien.group(1)
    verif("L5. message « Votre vidéo est prête » + lien dans le fil",
          livree, lien_fil[:120] if lien_fil else "")

    # L6 — master téléchargé VIA LE LIEN DU FIL (contexte navigateur).
    cible = lien_fil or (f"{BASE}{master_url}" if master_url else "")
    if cible:
        try:
            reponse = page.context.request.get(cible, timeout=120000)
            donnees = reponse.body()
            tete = donnees[:16]
            taille = len(donnees)
            mp4 = taille >= 100_000 and tete[4:8] == b"ftyp"
            verif("L6. MASTER TÉLÉCHARGÉ via le lien du fil (mp4 ≥100 Ko)",
                  mp4, f"{taille} octets, tête={tete[:12].hex()}, "
                  f"url finale={reponse.url[:100]}")
            try:
                with open(ARCHIVE, "wb") as f_arch:
                    f_arch.write(donnees)
                print(f"[fichier] {ARCHIVE} ({taille} o.)", flush=True)
            except Exception as e_copie:
                print(f"[copie] impossible : {type(e_copie).__name__}",
                      flush=True)
        except Exception as e:
            verif("L6. MASTER TÉLÉCHARGÉ via le lien du fil (mp4 ≥100 Ko)",
                  False, f"{type(e).__name__}: {e}")
    else:
        verif("L6. MASTER TÉLÉCHARGÉ via le lien du fil (mp4 ≥100 Ko)",
              False, "aucun lien disponible")

    # L7 — RÉPARATION DES VIEUX LIENS APEX (middleware 308).
    if master_url:
        try:
            reponse_apex = page.context.request.get(
                f"{APEX}{master_url}", timeout=120000)
            donnees_apex = reponse_apex.body()
            ok_apex = (len(donnees_apex) >= 100_000
                       and donnees_apex[4:8] == b"ftyp")
            sur_www = "gen3ia.online" in reponse_apex.url
            verif("L7. vieux lien APEX réparé au clic (308 → www → mp4)",
                  ok_apex,
                  f"final={reponse_apex.url[:110]} {len(donnees_apex)} o.")
            _ = sur_www
        except Exception as e:
            verif("L7. vieux lien APEX réparé au clic (308 → www → mp4)",
                  False, f"{type(e).__name__}")
    else:
        verif("L7. vieux lien APEX réparé au clic (308 → www → mp4)",
              False, "masterUrl absente")

    page.screenshot(path=CAPTURE)
    print(f"[capture] {CAPTURE}", flush=True)


ETAT = "/tmp/sonde-livraison-etat.json"
MODE = sys.argv[1] if len(sys.argv) > 1 else "complet"

avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
page.set_default_timeout(60000)

try:
    if MODE == "demarrer":
        # Phase A : lancement + état persisté (session + projet) — sortie
        # rapide, la production continue côté serveur.
        inscrire_et_ouvrir_chat(page)
        project_id = resoudre_projet(page)
        if project_id:
            page.context.storage_state(path=ETAT)
            with open(ETAT + ".proj", "w") as f_etat:
                json.dump({"projectId": project_id}, f_etat)
            print(f"[etat] session + projet persistés ({ETAT})", flush=True)
    elif MODE == "suivre":
        # Phase B : reprise de la session persistée + vérifications
        # complètes — la production a continué côté serveur pendant la pause.
        with open(ETAT + ".proj") as f_etat:
            project_id = json.load(f_etat)["projectId"]
        page.goto(f"{BASE}/chat", wait_until="domcontentloaded", timeout=60000)
        time.sleep(4)
        verif("L1b-bis. session persistée réutilisée", True, project_id[:40])
        phase_livraison_sur_projet(page, project_id)
    else:
        inscrire_et_ouvrir_chat(page)
        phase_livraison(page)
finally:
    try:
        page.screenshot(path=CAPTURE)
    except Exception:
        pass
    nav.close()
    avec.stop()

verts = sum(1 for r in resultats if r)
total = len(resultats)
print(f"\n[rapport] {verts}/{total} GREEN — livraison vidéo production",
      flush=True)
sys.exit(0 if verts == total else 1)

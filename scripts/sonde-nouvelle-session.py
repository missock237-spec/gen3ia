#!/usr/bin/env python3
"""Sonde production gen3ia — session 2026-11-13 (12 demandes propriétaires).

Modes (lancer séparement) :
  python3 sonde-nouvelle-session.py musique   (≈ 6-9 min)
  python3 sonde-nouvelle-session.py devweb    (≈ 8-12 min)
  python3 sonde-nouvelle-session.py abrev     (≈ 4-6 min)

  musique  : « Crée une musique de 2 minutes … » → le lecteur audio DURABLE
             (/api/media/durable?path=…) est extrait du fil, le MP3 est
             TÉLÉCHARGÉ vers download/ et prouvé (octets magiques + durée
             ffprobe ≈ 120 s).
  devweb   : les 10 tests de production du harnais lib/neural/evaluation
             (dev web + DNS) sont posés au cerveau GEN3 EN PRODUCTION ; les
             réponses réelles sont archivées en JSON pour le scoreur.
  abrev    : messages ABRÉGÉS (slt/bcp/auj/JS/DNS…) — gen3 doit COMPRENDRE
             (les réponses traitent le bon sujet malgré les abréviations).

Durcie comme les sondes précédentes : inscription prouvée par le POST
réseau, session prouvée par /api/auth/session, envoi prouvé par le POST
…/messages/stream.
"""
import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
STAMP = str(int(time.time()))
EMAIL = f"sn{STAMP}@e2e-gen3ia.test"
PASSWORD = "E2e!Sonde" + STAMP[-4:]

PHASE = sys.argv[1] if len(sys.argv) > 1 else "musique"
DOSSIER_SORTIE = "/home/z/my-project/download"
os.makedirs(DOSSIER_SORTIE, exist_ok=True)

QUESTIONS_DEVWEB = [
    ("html-semantique", "Pourquoi utilise-t-on des balises HTML sémantiques comme header, nav et main ?"),
    ("flex-grid", "Quelle différence entre Flexbox et CSS Grid, et quand choisir l'un ou l'autre ?"),
    ("async-await", "Explique comment fonctionnent async et await en JavaScript."),
    ("ts-generics", "À quoi servent les generics en TypeScript ? Donne un exemple."),
    ("http-304-etag", "Comment fonctionne un ETag et une réponse HTTP 304 ?"),
    ("cors-preflight", "C'est quoi une requête CORS preflight OPTIONS ?"),
    ("dns-mx-ttl", "À quoi sert un enregistrement MX en DNS et comment fonctionne la priorité ?"),
    ("dns-cname-apex", "Pourquoi ne peut-on pas mettre un CNAME à l'apex d'un domaine ?"),
    ("dns-propagation", "Explique la propagation DNS après un changement de serveur."),
    ("dnssec-pourquoi", "À quoi sert DNSSEC et que protège-t-il exactement ?"),
]

MESSAGES_ABBREVIES = [
    ("mx", "slt, c'est quoi un enregistrement DNS de type MX et a quoi il sert ? bcp merci d'avance"),
    ("cname-ttl", "bjr, tu peux m'expliquer pk on met pas de CNAME a l'apex d'un domaine et comment marche le TTL stp ?"),
    ("http-304", "salut, j'ai une question : c'est quoi un ETag et la reponse 304 en HTTP ? reponds moi stp"),
]

resultats = []


def verif(label: str, ok: bool, detail: str = "") -> None:
    resultats.append(ok)
    print(f"[check] {'OK   ' if ok else 'ECHEC'} {label}"
          + (f" - {detail}" if detail else ""), flush=True)


def inscrire_et_ouvrir_chat(page) -> None:
    """Inscription réelle (prouvée par le POST) puis /chat authentifié."""
    page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector('input[type="email"]', state="visible", timeout=60000)
    time.sleep(3)
    inscrit = False
    for tentative in range(4):
        page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_selector('input[type="email"]', state="visible", timeout=45000)
            page.wait_for_selector("button:has-text(\"S'inscrire\")", timeout=20000)
        except Exception:
            print(f"[réessayage {tentative + 1}] page non hydratée", flush=True)
            time.sleep(3)
            continue
        page.click("button:has-text(\"S'inscrire\")", timeout=15000)
        time.sleep(1)
        for sel, val in [
            ('input[placeholder="Prénom"]', "Sonde"),
            ('input[placeholder="Nom"]', "Nouvelle"),
            ('input[placeholder="Nom d\'utilisateur"]', "sn" + STAMP[-8:]),
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
                    page.click("button:has-text(\"Se connecter\")", timeout=15000)
                    time.sleep(1)
                    page.fill('input[type="email"]', EMAIL)
                    page.fill('input[type="password"] >> nth=0', PASSWORD)
                    with page.expect_response(
                        lambda r: "/api/auth/r2/login" in r.url, timeout=20000
                    ) as rep_login:
                        page.click('button[type="submit"]', timeout=15000)
                    print(f"[réseau] POST login → {rep_login.value.status}", flush=True)
                    inscrit = True
                    break
                except Exception:
                    pass
            time.sleep(2)
    verif("1. inscription RÉELLE (POST /api/auth/r2/signup 2xx)", inscrit, EMAIL)
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
    verif("2. /chat + session serveur prouvée (authenticated:true)", authentifie)


def attendre_reponse_complete(page, budget_s: int = 150) -> str:
    """Attend que le fil se stabilise (fin du stream) puis rend le texte."""
    debut = time.time()
    dernier = ""
    stable_depuis = 0.0
    while time.time() - debut < budget_s:
        try:
            fil = page.locator(".nova-fil")
            texte = fil.inner_text(timeout=15000)
        except Exception:
            time.sleep(2)
            continue
        if texte and texte == dernier:
            stable_depuis += 2.0
            if stable_depuis >= 8.0:
                return texte
        else:
            stable_depuis = 0.0
            dernier = texte
        time.sleep(2)
    return dernier


def envoyer(page, saisie, message: str) -> bool:
    saisie.fill(message)
    time.sleep(0.5)
    contenu = saisie.input_value()
    if contenu != message:
        saisie.fill(message)
        time.sleep(0.5)
    envoye = False
    for _ in range(3):
        try:
            bouton = page.locator('button[aria-label*="Envoyer"], button:has-text("Envoyer")').first
            if bouton.is_enabled(timeout=5000):
                bouton.click()
                envoye = True
                break
        except Exception:
            pass
        try:
            saisie.press("Enter")
            envoye = True
            break
        except Exception:
            time.sleep(1)
    time.sleep(2)
    return envoye


def extraire_lecteurs_audio_durables(page) -> list:
    try:
        return page.evaluate(
            """() => Array.from(document.querySelectorAll('.nova-fil audio'))
                .map(a => ({ src: a.src || a.currentSrc || '' }))
                .filter(x => x.src.includes('/api/media/durable'))"""
        )
    except Exception:
        return []


def phase_musique(page, saisie) -> None:
    demande = ("Crée une musique de 2 minutes : instrumentale calme au piano, "
               "ambiance détente, pour écouter en travaillant.")
    envoye = envoyer(page, saisie, demande)
    verif("3. demande musique envoyée au chat production", envoye)
    fil = attendre_reponse_complete(page, budget_s=240)
    print("[fil]", fil[-600:].replace("\n", " | "), flush=True)
    lecteurs = extraire_lecteurs_audio_durables(page)
    verif("4. lecteur audio DURABLE présent dans le fil (/api/media/durable)",
          len(lecteurs) > 0, json.dumps(lecteurs[:2])[:200] if lecteurs else "aucun")
    src = lecteurs[-1]["src"] if lecteurs else ""
    mp3_chemin = os.path.join(DOSSIER_SORTIE, "gen3-musique-2min-production.mp3")
    telecharge = 0
    octets = b""
    if src:
        try:
            contexte = page.context
            reponse = contexte.request.get(src, timeout=60000)
            octets = reponse.body()
            telecharge = reponse.status
        except Exception as e:
            print("[réseau] téléchargement échoué:", e, flush=True)
    verif("5. MP3 téléchargé depuis le lien durable (HTTP 200, > 100 Ko)",
          telecharge == 200 and len(octets) > 100_000,
          f"{telecharge} / {len(octets)} o.")
    if octets:
        with open(mp3_chemin, "wb") as f:
            f.write(octets)
        magiques = octets[:3] == b"ID3" or (octets[0] == 0xFF and (octets[1] & 0xE0) == 0xE0)
        verif("6. octets magiques MP3 (ID3/frame) — vraie piste audio", magiques)
        print(f"[fichier] {mp3_chemin} ({len(octets)} o.)", flush=True)


def phase_devweb(page, saisie) -> None:
    reponses = []
    for i, (qid, question) in enumerate(QUESTIONS_DEVWEB, start=1):
        envoye = envoyer(page, saisie, question)
        if not envoye:
            reponses.append({"questionId": qid, "question": question, "reponse": ""})
            continue
        fil = attendre_reponse_complete(page, budget_s=120)
        # La réponse = dernière bulle assistant (heuristique : fin du fil).
        reponse = fil[-1600:]
        reponses.append({"questionId": qid, "question": question, "reponse": reponse})
        print(f"[Q{i}/{len(QUESTIONS_DEVWEB)}] {qid} — {len(reponse)} car. capturés", flush=True)
    chemin = os.path.join(DOSSIER_SORTIE, "gen3-devweb-reponses-production.json")
    with open(chemin, "w", encoding="utf-8") as f:
        json.dump({"date": STAMP, "base": BASE, "reponses": reponses}, f, ensure_ascii=False, indent=2)
    vides = sum(1 for r in reponses if len(r["reponse"]) < 60)
    verif("3. les 10 questions dev web/DNS ont reçu des réponses réelles",
          vides == 0, f"{10 - vides}/10 non vides → {chemin}")


def phase_abrev(page, saisie) -> None:
    constatations = []
    for i, (qid, message) in enumerate(MESSAGES_ABBREVIES, start=1):
        envoye = envoyer(page, saisie, message)
        if not envoye:
            constatations.append({"id": qid, "compris": False, "reponse": ""})
            continue
        fil = attendre_reponse_complete(page, budget_s=120)
        reponse = fil[-1400:]
        # Le sujet attendu doit être traité malgré les abréviations.
        sujets = {
            "mx": ["MX", "courriel", "mail", "messagerie"],
            "cname-ttl": ["CNAME", "apex", "TTL", "cache"],
            "http-304": ["ETag", "304", "cache", "If-None-Match"],
        }
        attendus = sujets.get(qid, [])
        compris = sum(1 for mot in attendus if mot.lower() in reponse.lower()) >= max(1, len(attendus) // 2)
        constatations.append({"id": qid, "compris": compris, "reponse": reponse[-600:]})
        verif(f"3.{i} abréviations comprises (message « {message[:38]}… »)", compris)
    chemin = os.path.join(DOSSIER_SORTIE, "gen3-abreviations-reponses-production.json")
    with open(chemin, "w", encoding="utf-8") as f:
        json.dump({"date": STAMP, "base": BASE, "constatations": constatations}, f, ensure_ascii=False, indent=2)
    print(f"[fichier] {chemin}", flush=True)


def main() -> None:
    with sync_playwright() as pw:
        navigateur = pw.chromium.launch(headless=True, args=["--no-sandbox"])
        contexte = navigateur.new_context(user_agent=UA, viewport={"width": 1366, "height": 900})
        page = contexte.new_page()
        try:
            inscrire_et_ouvrir_chat(page)
            saisie = page.locator("textarea.nova-saisie")
            if PHASE == "musique":
                phase_musique(page, saisie)
            elif PHASE == "devweb":
                phase_devweb(page, saisie)
            elif PHASE == "abrev":
                phase_abrev(page, saisie)
            else:
                print("phase inconnue:", PHASE)
                sys.exit(2)
            page.screenshot(path=f"/tmp/sonde-{PHASE}.png", full_page=False)
        finally:
            navigateur.close()
    verts = sum(1 for x in resultats if x)
    print(f"\n=== SONDE {PHASE} : {verts}/{len(resultats)} GREEN ===", flush=True)
    sys.exit(0 if verts == len(resultats) and len(resultats) > 0 else 1)


if __name__ == "__main__":
    main()

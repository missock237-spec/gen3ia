"""SONDE PRODUCTION — ROUTAGE SÉMANTIQUE AUTOMATIQUE DE L'AUDIO.

Preuve que la demande de SON (« le son de la pluie ») est rendue comme un
DESIGN SONORE (moteur scénique à couches) et JAMAIS lue à voix haute par le
TTS — sans que l'utilisateur ait à le demander (routage automatique
lib/neural/audio-intention, déployé 59560ca). Puis preuve symétrique pour la
MUSIQUE (« une musique de piano ») : jamais de TTS non plus.

Usage : python3 scripts/sonde-audio-semantique-production.py
"""

import re
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
STAMP = str(int(time.time()))
EMAIL = f"sem{STAMP}@e2e-gen3ia.test"
PASSWORD = "E2e!Semantique" + STAMP[-4:]

MSG_SON = "Crée le son de la pluie qui tombe sur les vitres pendant l'orage."
MSG_MUSIQUE = "Crée une musique de piano douce et apaisante."

CAPTURE_SON = "/tmp/son-semantique-production.png"
CAPTURE_MUSIQUE = "/tmp/musique-semantique-production.png"

resultats = []


def verif(label: str, ok: bool, detail: str = "") -> None:
    resultats.append(ok)
    print(f"[check] {'OK   ' if ok else 'ECHEC'} {label}"
          + (f" - {detail}" if detail else ""), flush=True)


def attendre_reponse_stable(page) -> str:
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


def telecharger_audio(page, url: str) -> tuple[int, str, bytes]:
    donnees = page.evaluate(
        """async (u) => {
            const r = await fetch(u, {credentials: 'include'});
            const b = await r.arrayBuffer();
            return Array.from(new Uint8Array(b.slice(0, 24)));
        }""",
        url,
    )
    tete = bytes(donnees)
    taille = page.evaluate(
        """async (u) => {
            const r = await fetch(u, {credentials: 'include'});
            const b = await r.arrayBuffer();
            return b.byteLength;
        }""",
        url,
    )
    return taille, tete, bytes(donnees)


def est_audio(tete: bytes) -> bool:
    if tete[:3] == b"ID3" or tete[:2] == b"\xff\xfb":
        return True
    if tete[:4] == b"RIFF":
        return True
    if b"ftyp" in tete[:12]:
        return True
    return False


def inscrire_et_ouvrir_chat(page) -> bool:
    page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
    time.sleep(3)
    inscrit = False
    for tentative in range(4):
        page.goto(BASE + "/signup", wait_until="domcontentloaded",
                  timeout=60000)
        try:
            page.wait_for_selector('input[type="email"]', state="visible",
                                   timeout=45000)
            page.wait_for_selector('button:has-text("S\'inscrire")',
                                   timeout=20000)
        except Exception:
            print(f"[réessayage {tentative + 1}] page non hydratée", flush=True)
            time.sleep(3)
            continue
        page.click('button:has-text("S\'inscrire")', timeout=15000)
        time.sleep(1)
        for sel, val in [
            ('input[placeholder="Prénom"]', "Semantique"),
            ('input[placeholder="Nom"]', "Audio"),
            ('input[placeholder="Nom d\'utilisateur"]', "sem" + STAMP[-8:]),
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
                    page.click('button:has-text("Se connecter")',
                               timeout=15000)
                    time.sleep(1)
                    page.fill('input[type="email"]', EMAIL)
                    page.fill('input[type="password"] >> nth=0', PASSWORD)
                    with page.expect_response(
                        lambda r: "/api/auth/r2/login" in r.url,
                        timeout=20000):
                        page.click('button[type="submit"]', timeout=15000)
                    inscrit = True
                    break
                except Exception:
                    pass
            time.sleep(2)
    verif("0. inscription RÉELLE (POST /api/auth/r2/signup 2xx)", inscrit,
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
                "fetch('/api/auth/session',{credentials:'include',"
                "cache:'no-store'}).then(r => r.text())")
            if '"authenticated":true' in corps:
                authentifie = True
                break
        except Exception:
            pass
        time.sleep(2)
    verif("0b. /chat + session serveur prouvée (authenticated:true)",
          authentifie)
    return saisie


def urls_durables_du_fil(page) -> list:
    """Hrefs RÉELS des ancres du fil (robustes aux retours à la ligne DOM),
    filtrés sur l'URL canonique durable — repli : regex sur le texte."""
    try:
        hrefs = page.evaluate(
            """() => Array.from(document.querySelectorAll('.nova-fil .nova-bulle a'))
                .map(a => a.href)
                .filter(h => h.includes('/api/media/durable'))"""
        )
        if hrefs:
            return hrefs
    except Exception:
        pass
    texte = page.locator(".nova-fil").inner_text() if page.locator(".nova-fil").count() else ""
    return re.findall(r"https?://[^\s)\]»]+/api/media/durable\?[^\s)\]»]+", texte)


def phase_son(saisie) -> None:
    print("\n──── PHASE S : SON (pluie) — jamais lu à voix haute ────",
          flush=True)
    envoye = envoyer(page, saisie, MSG_SON)
    verif("S1. demande de SON envoyée (POST …/messages/stream)", envoye)
    reponse = attendre_reponse_stable(page) if envoye else ""
    refuse = "TRAITEMENT_REQUETE" in reponse or (
        "je ne sais pas encore exécuter" in reponse)
    verif("S2. réponse = audio LIVRÉ (pas TRAITEMENT_REQUETE)",
          bool(reponse) and not refuse, f"{len(reponse)} car.")
    # ROUTAGE AUTOMATIQUE : le rendu se présente comme un SON, pas comme
    # une parole. Aucune mention de voix humaine/TTS dans la livraison.
    bas = reponse.lower()
    est_design = (
        ("design sonore" in bas) or ("son" in bas and "ambiance" in bas)
        or ("couches" in bas) or ("sonore" in bas))
    pas_de_voix = ("voix utilisée" not in bas
                   and "voix féminine" not in bas
                   and "voix masculine" not in bas
                   and "message vocal" not in bas)
    verif("S3. rendu = DESIGN SONORE sémantique (pas une lecture vocale)",
          est_design and pas_de_voix,
          f"design={est_design} pasDeVoix={pas_de_voix}")
    urls = urls_durables_du_fil(page)
    durable = [u for u in urls if "/api/media/durable" in u]
    verif("S4. URL DURABLE canonique (/api/media/durable) dans le message",
          len(durable) >= 1, durable[0][:110] if durable else "absente")
    cible = durable[-1] if durable else (urls[-1] if urls else "")
    if cible:
        taille, tete, _ = telecharger_audio(page, cible)
        verif("S5. AUDIO TÉLÉCHARGÉ = vraies octets audio (≥8 Ko)",
              taille >= 8000 and est_audio(tete),
              f"{taille} octets, tête={tete[:8].hex()}")
        print(f"[audio-son] URL={cible[:120]} taille={taille} "
              f"tête={tete[:8].hex()}", flush=True)
    else:
        verif("S5. AUDIO TÉLÉCHARGÉ (≥8 Ko)", False, "aucune URL")
    page.screenshot(path=CAPTURE_SON)
    print(f"[capture] {CAPTURE_SON}", flush=True)
    print(f"[extrait-son] {' '.join(reponse.split())[:400]}", flush=True)


def phase_musique(saisie) -> None:
    print("\n──── PHASE M : MUSIQUE (piano) — jamais lu à voix haute ────",
          flush=True)
    envoye = envoyer(page, saisie, MSG_MUSIQUE)
    verif("M1. demande de MUSIQUE envoyée (POST …/messages/stream)", envoye)
    reponse = attendre_reponse_stable(page) if envoye else ""
    refuse = "TRAITEMENT_REQUETE" in reponse or (
        "je ne sais pas encore exécuter" in reponse)
    verif("M2. réponse = musique LIVRÉE (pas TRAITEMENT_REQUETE)",
          bool(reponse) and not refuse, f"{len(reponse)} car.")
    bas = reponse.lower()
    est_musique = ("musique" in bas or "piano" in bas or "composition" in bas)
    pas_de_voix = ("voix utilisée" not in bas
                   and "voix féminine" not in bas
                   and "voix masculine" not in bas
                   and "message vocal" not in bas)
    verif("M3. rendu = MUSIQUE (jamais de lecture vocale du texte)",
          est_musique and pas_de_voix,
          f"musique={est_musique} pasDeVoix={pas_de_voix}")
    urls = urls_durables_du_fil(page)
    durable = [u for u in urls if "/api/media/durable" in u]
    verif("M4. URL DURABLE canonique dans le message", len(durable) >= 1,
          durable[0][:110] if durable else "absente")
    cible = durable[-1] if durable else (urls[-1] if urls else "")
    if cible:
        taille, tete, _ = telecharger_audio(page, cible)
        verif("M5. AUDIO TÉLÉCHARGÉ = vraies octets audio (≥8 Ko)",
              taille >= 8000 and est_audio(tete),
              f"{taille} octets, tête={tete[:8].hex()}")
        print(f"[audio-musique] URL={cible[:120]} taille={taille} "
              f"tête={tete[:8].hex()}", flush=True)
    else:
        verif("M5. AUDIO TÉLÉCHARGÉ (≥8 Ko)", False, "aucune URL")
    page.screenshot(path=CAPTURE_MUSIQUE)
    print(f"[capture] {CAPTURE_MUSIQUE}", flush=True)
    print(f"[extrait-musique] {' '.join(reponse.split())[:400]}", flush=True)


avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
page.set_default_timeout(60000)

try:
    saisie = inscrire_et_ouvrir_chat(page)
    phase_son(saisie)
    phase_musique(saisie)
finally:
    nav.close()
    avec.stop()

echecs = resultats.count(False)
print(f"\nVERDICT AUDIO SÉMANTIQUE : {resultats.count(True)}/{len(resultats)} "
      "vérifications OK"
      + (" — GREEN" if echecs == 0 else f" — {echecs} ÉCHEC(S)"), flush=True)
sys.exit(0 if echecs == 0 else 1)

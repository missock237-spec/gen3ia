#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PREUVE NAVIGATEUR RÉEL — génération d'image PHOTORÉALISTE par Gen3 en
PRODUCTION (demande propriétaire 2026-11-10 : « gen3 ne génère pas d'images
photos réaliste… corrige sa puis assure toi que gen3 le réalise bien en
production »).

Parcours EXACT de l'utilisateur dans un vrai Chromium :
  1. ouverture https://www.gen3ia.online/ + inscription UI (onglet S'inscrire) ;
  2. /chat authentifié ;
  3. demande : « Génère une image photoréaliste : un homme assis sur une
     branche d'arbre dans une forêt ensoleillée » ;
  4. attente de la génération RÉELLE (jusqu'à 240 s — le professeur mesure
     30-90 s, puis persistance R2) ;
  5. VERDICT :
     - une image est bien rendue dans le fil (élément <img> du message) ;
     - l'image est téléchargée (taille > 30 Ko — une scène plate vectorielle
       pèse ~5-15 Ko, une photo > 100 Ko en général) ;
     - le moteur annoncé est le professeur (photoréalisme réel), pas la
       composition abstraite ;
     - AUCUN toast « Erreur de génération », zéro erreur console suspecte.

Rapport : var-copie/verifie-image-photorrealiste.json + captures.
"""
import base64
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
EMAIL = f"image-e2e-{int(time.time())}@gen3ia.test"
PASSWORD = "Gen3iaE2E!2026"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
PROMPT = ("Génère une image photoréaliste : un homme assis sur une branche "
          "d'arbre dans une forêt ensoleillée, lumière du matin.")

RACINE = Path(__file__).resolve().parent.parent
SORTIE = RACINE / "var-copie" / "verifie-image-photorrealiste.json"

verifs = []
erreurs_console = []


def verif(label: str, ok: bool, detail: str = "") -> None:
    verifs.append({"label": label, "ok": ok, "detail": detail})
    print(f"[check] {'OK    ' if ok else 'ECHEC'} {label} {('- ' + detail) if detail else ''}", flush=True)


def main() -> None:
    avec = sync_playwright().start()
    nav = avec.chromium.launch(headless=True)
    page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
    page.on("console", lambda m: erreurs_console.append(m.text) if m.type == "error" else None)
    page.add_init_script("""
        window.__toastErreurVu = false;
        new MutationObserver(() => {
          const t = document.body ? document.body.innerText : '';
          if (t.includes('Erreur de génération')) window.__toastErreurVu = true;
        }).observe(document.documentElement, {childList: true, subtree: true});
    """)
    image_bytes: bytes | None = None
    try:
        # 1) inscription (UI V2 — onglet S'inscrire)
        page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_load_state("networkidle", timeout=60000)
        page.wait_for_selector('input[type="email"]', state="visible", timeout=60000)
        time.sleep(2)
        try:
            page.click('button:has-text("S\'inscrire")', timeout=8000)
            time.sleep(1)
        except Exception:
            pass
        pseudo = "img" + str(int(time.time()) % 10 ** 10)
        page.fill('input[placeholder="Prénom"]', "Image")
        page.fill('input[placeholder="Nom"]', "E2E")
        page.fill('input[placeholder="Nom d\'utilisateur"]', pseudo)
        page.fill('input[type="email"]', EMAIL)
        page.fill('input[type="password"] >> nth=0', PASSWORD)
        page.fill('input[type="password"] >> nth=1', PASSWORD)
        page.click('button[type="submit"]', timeout=15000)
        page.wait_for_url("**/dashboard**", timeout=90000)
        verif("1. inscription UI + session posée (redirection /dashboard)", True, EMAIL)

        # 2) chat authentifié
        page.goto(BASE + "/chat", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_load_state("networkidle", timeout=60000)
        saisie = page.locator("textarea.nova-saisie")
        saisie.wait_for(state="visible", timeout=60000)
        time.sleep(2)
        verif("2. chat authentifié (zone de saisie visible)", True, "/chat")

        # 3) demande photoréaliste
        nb_img_avant = page.locator(".nova-msg img, [class*='message'] img").count()
        saisie.click()
        saisie.press_sequentially(PROMPT, delay=6)
        page.keyboard.press("Enter")
        verif("3. demande photoréaliste envoyée", True, PROMPT[:60])

        # 4) génération — attends la fin (bouton Arrêter → Envoyer)
        arret = page.locator('button.nova-envoi[aria-label="Arrêter la génération"]')
        demarree = True
        try:
            arret.wait_for(state="visible", timeout=30000)
        except Exception:
            demarree = False
        verif("4a. génération démarrée", demarree)
        if demarree:
            try:
                arret.wait_for(state="hidden", timeout=240_000)
                verif("4b. génération terminée (≤240 s — professeur + persistance R2)", True)
            except Exception:
                verif("4b. génération terminée (≤240 s — professeur + persistance R2)", False,
                      "timeout 240 s dépassé")

        # 5) verdicts sur l'image rendue
        time.sleep(3)
        page.screenshot(path="/tmp/image-e2e-resultat.png", full_page=False)
        imgs = page.locator(".nova-msg img, [class*='message'] img")
        n_imgs = imgs.count()
        verif("5a. une image est rendue dans le fil", n_imgs > nb_img_avant, f"{n_imgs} img(s)")
        # télécharge la dernière image rendue (src http) ou capture data URL
        src = imgs.last.get_attribute("src") if n_imgs > 0 else None
        if src and src.startswith("http"):
            import urllib.request
            req = urllib.request.Request(src, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                image_bytes = r.read()
        elif src and src.startswith("data:"):
            image_bytes = base64.b64decode(src.split(",", 1)[1])
        taille_ok = image_bytes is not None and len(image_bytes) > 30_000
        verif("5b. image téléchargée > 30 Ko (une scène plate en fait ~5-15 Ko)",
              taille_ok, f"{len(image_bytes) if image_bytes else 0} octets")
        if image_bytes:
            Path("/tmp/image-e2e-generee.jpg").write_bytes(image_bytes)
        texte_page = page.inner_text("body")
        professeur_annonce = "professeur" in texte_page.lower()
        verif("5c. moteur annoncé = professeur (photoréalisme réel)",
              professeur_annonce,
              "« professeur » absent du fil" if not professeur_annonce else "")
        verif("6. AUCUN toast « Erreur de génération »", not page.evaluate("window.__toastErreurVu"))
        suspectes = [e for e in erreurs_console
                     if "Failed to fetch" in e or "Refused to connect" in e or "Content Security Policy" in e]
        verif("7. zéro erreur console suspecte (fetch/CSP)", len(suspectes) == 0,
              f"{len(erreurs_console)} erreur(s) au total")
        page.screenshot(path="/tmp/image-e2e-final.png", full_page=True)

        ok = sum(1 for v in verifs if v["ok"])
        verdict = "PHOTORÉALISME PRODUCTION OK" if ok == len(verifs) else "PROBLÈME ENCORE PRÉSENT"
        rapport = {
            "demande": "génération d'image photoréaliste par gen3 en production (capture propriétaire : scène plate)",
            "quand": datetime.now(timezone.utc).isoformat(),
            "compte_test": EMAIL,
            "prompt": PROMPT,
            "verifications": verifs,
            "octets_image": len(image_bytes) if image_bytes else 0,
            "erreurs_console": erreurs_console[:12],
            "verdict": verdict,
        }
        SORTIE.write_text(json.dumps(rapport, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n[resume] {ok}/{len(verifs)} vérifications vertes — VERDICT : {verdict}")
        print(f"[rapport] {SORTIE}")
    finally:
        nav.close()
        avec.stop()


if __name__ == "__main__":
    main()

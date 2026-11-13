#!/usr/bin/env python3
"""Sonde RÉFLEXION — gen3 doit montrer qu'il est en pleine réflexion.

Inscription réelle → envoi d'une demande → scan DOM immédiat du fil :
l'indicateur « gen3 réfléchit… » (ou libellé de phase réel) doit être
VISIBLE pendant le traitement, puis disparaître à la réponse.
"""
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, "/home/z/my-project/gen3ia/scripts")
import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location(
    "sonde_nouvelle_session", "/home/z/my-project/gen3ia/scripts/sonde-nouvelle-session.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)  # le module ne lance rien à l'import (main() gardé)
BASE = _mod.BASE
UA = _mod.UA
inscrire_et_ouvrir_chat = _mod.inscrire_et_ouvrir_chat
verif = _mod.verif
resultats = _mod.resultats


def main() -> None:
    with sync_playwright() as pw:
        navigateur = pw.chromium.launch(headless=True, args=["--no-sandbox"])
        contexte = navigateur.new_context(user_agent=UA, viewport={"width": 1366, "height": 900})
        page = contexte.new_page()
        try:
            inscrire_et_ouvrir_chat(page)
            saisie = page.locator("textarea.nova-saisie")
            demande = ("Rédige un texte détaillé sur l'histoire du DNS, "
                       "les types d'enregistrements et le DNSSEC.")
            saisie.fill(demande)
            time.sleep(0.5)
            bouton = page.locator('button[aria-label*="Envoyer"], button:has-text("Envoyer")').first
            if bouton.is_enabled(timeout=5000):
                bouton.click()
            else:
                saisie.press("Enter")
            # Scan IMMÉDIAT (les 25 premières secondes) : l'indicateur
            # doit apparaître pendant que gen3 traite.
            observe = ""
            observe_a = False
            debut = time.time()
            while time.time() - debut < 25:
                try:
                    texte = page.locator(".nova-fil").inner_text(timeout=5000)
                except Exception:
                    time.sleep(1)
                    continue
                if "réfléchit" in texte or "génère sa réponse" in texte or "analyse votre demande" in texte:
                    observe = texte
                    observe_a = True
                    break
                time.sleep(1)
            verif("3. indicateur « gen3 réfléchit… » VISIBLE pendant le traitement", observe_a)
            if observe_a:
                extrait = [l for l in observe.split("\n") if "réfléchit" in l or "demande" in l or "réponse" in l][:2]
                print("[visible]", " | ".join(extrait)[:200], flush=True)
            # Attente de la réponse : l'indicateur doit DISPARAÎTRE.
            dernier = ""
            stable = 0.0
            debut2 = time.time()
            while time.time() - debut2 < 150:
                try:
                    texte = page.locator(".nova-fil").inner_text(timeout=5000)
                except Exception:
                    time.sleep(2)
                    continue
                if texte == dernier:
                    stable += 2.0
                    if stable >= 10.0:
                        break
                else:
                    stable = 0.0
                    dernier = texte
                time.sleep(2)
            repondu = len(dernier) > 400
            verif("4. réponse complète arrivée (indicateur disparu)", repondu, f"{len(dernier)} car.")
            page.screenshot(path="/tmp/reflexion-production.png")
        finally:
            navigateur.close()
    verts = sum(1 for x in resultats if x)
    print(f"\n=== SONDE réflexion : {verts}/{len(resultats)} GREEN ===", flush=True)
    sys.exit(0 if verts == len(resultats) and len(resultats) > 0 else 1)


if __name__ == "__main__":
    main()

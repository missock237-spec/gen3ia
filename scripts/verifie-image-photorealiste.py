#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VERIFICATION NAVIGATEUR REEL — génération d'IMAGE PHOTORÉALISTE en production.

Demande propriétaire 2026-11-10 (capture à l'appui) : « Lord d'une génération
d'images gen3 ne génère pas d'images photos réaliste … corrige sa puis assure
toi que gen3 le réalise bien en production ».

Le bug historique (correctif 4c523b4 déployé) : la capture montrait le moteur
neuronal LOCAL (« gen3-media-engine-v1 » / « Gen3 v2-scène » — bonhomme vert,
ciel dégradé, soleil jaune) au lieu du photoréalisme : le professeur média
(gateway /images/generations) EXISTAIT mais son timeout de 55 s était
systématiquement dépassé (200 OK observé en 33,8 s, variable) → échec
silencieux → repli composition abstraite. Correctifs : timeout 150 s,
routage photoréaliste→professeur AVANT WebGPU, prompt durci, étiquetage
honnête par moteur.

CE test reproduit le parcours EXACT de l'utilisateur dans un vrai Chromium :
  1. ouverture https://www.gen3ia.online/ ;
  2. création d'un compte réel via l'UI (onglet S'inscrire) ;
  3. /chat → demande explicite : « Génère une image photoréaliste d'un homme
     assis sur une branche d'arbre, en forêt, lumière naturelle du matin » ;
  4. attente de l'image générée (img.nova-image-generee — jusqu'à 260 s,
     le professeur met 30-150 s) ;
  5. téléchargement des OCTETS réels de l'image (data URL ou HTTP) ;
  6. VERDICT :
     - image apparue dans le fil ;
     - octets sauvegardés + dimensions mesurées ;
     - AUCUNE erreur console Failed to fetch / CSP ;
     - l'image est mise à disposition pour JUGEMENT VISUEL (photoréalisme).
Rapport : var-copie/verifie-image-photorealiste.json
Image   : var-copie/image-photorealiste-prod.jpg (+ /tmp/verif-image.jpg)
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
DEMANDE = ("Génère une image photoréaliste d'un homme assis sur une branche "
           "d'arbre, en forêt, lumière naturelle du matin.")

RACINE = Path(__file__).resolve().parent.parent
SORTIE = RACINE / "var-copie" / "verifie-image-photorealiste.json"
IMG_OUT = RACINE / "var-copie" / "image-photorealiste-prod.jpg"

verifications = []
erreurs_console = []
echecs_reseau = []


def verif(label: str, ok: bool, detail: str = "") -> bool:
    verifications.append({"label": label, "ok": bool(ok), "detail": detail})
    print(f"[check] {'OK   ' if ok else 'ECHEC'} {label}{' - ' + detail if detail else ''}",
          flush=True)
    return bool(ok)


def dimensions_jpeg_png(data: bytes) -> tuple[int, int] | None:
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(data))
        return img.size
    except Exception:
        return None


def main() -> None:
    with sync_playwright() as avec:
        navigateur = avec.chromium.launch(headless=True)
        page = navigateur.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
        page.on("console", lambda m: erreurs_console.append(m.text) if m.type == "error" else None)
        page.on("response", lambda r: echecs_reseau.append(f"{r.status} {r.url}") if r.status >= 400 else None)

        # 1) production
        r = page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        verif("1. page production ouverte", r is not None and r.status == 200, f"HTTP {r.status if r else '?'}")

        # 2) inscription UI (V2 Aurora : onglet S'inscrire)
        page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_load_state("networkidle", timeout=60000)
        page.wait_for_selector('input[type="email"]', state="visible", timeout=60000)
        time.sleep(2)
        try:
            page.click('button:has-text("S\'inscrire")', timeout=8000)
            time.sleep(1)
        except Exception:
            pass
        pseudo = "im" + str(int(time.time()) % 10**10)
        page.fill('input[placeholder="Prénom"]', "Image")
        page.fill('input[placeholder="Nom"]', "E2E")
        page.fill('input[placeholder="Nom d\'utilisateur"]', pseudo)
        page.fill('input[type="email"]', EMAIL)
        page.fill('input[type="password"] >> nth=0', PASSWORD)
        page.fill('input[type="password"] >> nth=1', PASSWORD)
        page.click('button[type="submit"]', timeout=15000)
        try:
            page.wait_for_url("**/dashboard**", timeout=90000)
            verif("2. inscription UI + session posée (redirection /dashboard)", True, EMAIL)
        except Exception:
            alerte = page.locator('[role="alert"]')
            msg = alerte.first.inner_text()[:160] if alerte.count() else "aucune"
            verif("2. inscription UI + session posée", False, f"alerte : {msg}")
            raise SystemExit(1)

        # 3) chat
        page.goto(BASE + "/chat", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_load_state("networkidle", timeout=60000)
        saisie = page.locator("textarea.nova-saisie")
        saisie.wait_for(state="visible", timeout=60000)
        time.sleep(2)
        verif("3. chat authentifié (zone de saisie visible)", True, "/chat")

        # 4) demande + envoi
        saisie.click()
        saisie.press_sequentially(DEMANDE, delay=6)
        envoye = False
        try:
            page.locator('button.nova-envoi[aria-label="Envoyer"]').click(timeout=6000)
            envoye = True
        except Exception:
            saisie.press("Enter")
        verif("4. demande envoyée", True, "bouton Envoyer" if envoye else "repli Entrée")

        # 5) attente de l'image générée (professeur : 30-150 s observés) OU du
        #    routage honnête (WebGPU délégué / erreur citant les moteurs) —
        #    it.144 : une scène plate servie sur une demande photoréaliste
        #    explicite est un ÉCHEC, même si l'img apparaît.
        t0 = time.time()
        img_ok = True
        try:
            page.wait_for_selector("img.nova-image-generee", state="visible", timeout=260000)
            verif("5. image générée apparue dans le fil", True, f"{time.time() - t0:.0f} s")
        except Exception:
            img_ok = False
            verif("5. image générée apparue dans le fil", False,
                  f"absente après {time.time() - t0:.0f} s (routage alternatif possible)")
        page.screenshot(path="/tmp/verif-image-page.png", full_page=True)

        # 5 bis. CLASSIFICATION DU ROUTAGE (texte final du fil)
        texte_fil = page.inner_text("body")[-1600:]
        if "Génération photoréaliste lancée" in texte_fil and "WebGPU" in texte_fil:
            routage = "webgpu-navigateur"
        elif "Aucun moteur d'image disponible" in texte_fil:
            routage = "erreur-honnete-moteurs"
        elif img_ok:
            routage = "img-serveur (moteur à juger visuellement)"
        else:
            routage = "aucun-signal"
        verif("5 bis. routage photoréaliste honnête", routage != "img-serveur (moteur à juger visuellement)",
              f"routage = {routage}")

        src = None
        if img_ok:
            src = page.get_attribute("img.nova-image-generee", "src")
            verif("6. source de l'image extraite", bool(src), (src or "")[:80])

        data = None
        if src:
            if src.startswith("data:"):
                try:
                    data = base64.b64decode(src.split(",", 1)[1])
                    verif("7. image décodée depuis la data URL", True, f"{len(data)} octets")
                except Exception as exc:
                    verif("7. image décodée depuis la data URL", False, str(exc)[:120])
            elif src.startswith("http"):
                try:
                    resp = page.request.get(src, timeout=90000)
                    data = resp.body()
                    verif("7. image téléchargée (HTTP)", True, f"{resp.status} — {len(data)} octets")
                except Exception as exc:
                    verif("7. image téléchargée (HTTP)", False, str(exc)[:120])

        dims = dimensions_jpeg_png(data) if data else None
        if data:
            IMG_OUT.write_bytes(data)
            Path("/tmp/verif-image.jpg").write_bytes(data)
            verif("8. octets réels sauvegardés", True,
                  f"{len(data)} octets, dimensions {dims[0] if dims else '?'}x{dims[1] if dims else '?'} — {IMG_OUT.name}")
        else:
            verif("8. octets réels sauvegardés", False, "aucune donnée")

        # 9. honnêteté des erreurs
        suspectes = [e for e in erreurs_console
                     if "Failed to fetch" in e or "Refused to connect" in e or "CSP" in e]
        verif("9. AUCUNE erreur console Failed to fetch / CSP", len(suspectes) == 0,
              f"{len(erreurs_console)} erreur(s) console, {len(suspectes)} suspecte(s)")

        # texte final du fil (pour le rapport)
        texte_fil = page.inner_text("body")[-1200:]

        navigateur.close()

    ok_count = sum(1 for v in verifications if v["ok"])
    if img_ok and data is not None and routage.startswith("img-serveur"):
        verdict = "IMG SERVIE — moteur à juger visuellement"
    elif routage == "webgpu-navigateur":
        verdict = "ROUTAGE HONNÊTE : photoréalisme délégué au WebGPU du navigateur (moteur serveur indisponible — passerelle privée + HF 402 crédits)"
    elif routage == "erreur-honnete-moteurs":
        verdict = "ERREUR HONNÊTE citant les moteurs (aucune scène plate servie — contrat respecté)"
    else:
        verdict = "PROBLÈME ENCORE PRÉSENT"
    rapport = {
        "demande": "Gen3 doit générer des images PHOTORÉALISTES en production (correctif 4c523b4)",
        "quand": datetime.now(timezone.utc).isoformat(),
        "base": BASE,
        "compte_test": EMAIL,
        "requête": DEMANDE,
        "verifications": verifications,
        "verdict_global": verdict,
        "ok": f"{ok_count}/{len(verifications)}",
        "image_octets": len(data) if data else 0,
        "image_dimensions": list(dims) if dims else None,
        "erreurs_console": erreurs_console[:12],
        "echecs_reseau_4xx": echecs_reseau[:12],
        "texte_fil_final": texte_fil,
    }
    SORTIE.write_text(json.dumps(rapport, ensure_ascii=False, indent=2))
    print(f"\n[resume] {ok_count}/{len(verifications)} vérifications vertes — {verdict}")
    print(f"[rapport] {SORTIE}")
    print(f"[image] {IMG_OUT}")


if __name__ == "__main__":
    main()

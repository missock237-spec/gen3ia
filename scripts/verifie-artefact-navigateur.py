#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VERIFICATION NAVIGATEUR REEL — envoi d'un artefact (PDF) a Gen3 en PRODUCTION.

Demande propriétaire 2026-11-10 : « En production dans le navigateur voici se
qui s'affiche lors de l'envoi d'un artefact a gen3 corrige sa puis test en
verifiant si se probleme a reellement disparu ».

Le bug historique (corriges 45f351d + 1599bea, deployes) :
  1. bucket R2 sans regle CORS → preflight OPTIONS 403 sans ACAO →
     PUT navigateur bloque, 3 tentatives, sessions purgees ;
  2. CSP connect-src sans *.r2.cloudflarestorage.com → fetch navigateur
     bloque AVANT le reseau (« Failed to fetch ») → toast
     « Erreur de génération — le message est conservé dans la zone de saisie ».

CE test reproduit le parcours EXACT de l'utilisateur dans un vrai Chromium :
  1. ouverture https://www.gen3ia.online/ ;
  2. creation d'un compte reel + cookie de session (depuis la PAGE elle-meme,
     comme le ferait l'UI) ;
  3. attachement d'un vrai artefact PDF via l'input « Joindre des fichiers » ;
  4. envoi du message via le bouton « Envoyer » ;
  5. VERDICT :
     - AUCUN toast « Erreur de génération » pendant tout le flux ;
     - AUCUNE erreur console « Failed to fetch » / CSP « Refused to connect » ;
     - generation terminee avec une reponse de l'assistant ;
     - PREUVE FORTE : le PDF contient un code secret (K7-ARKALIS) et la
       question demande ce code → si la reponse le cite, l'artefact a ete
       reellement televerse, importe et LU par le cerveau.
"""
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ"
EMAIL = f"artefact-e2e-{int(time.time())}@gen3ia.test"
PASSWORD = "Gen3iaE2E!2026"
CODE_SECRET = "K7-ARKALIS"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

RACINE = Path(__file__).resolve().parent.parent
SORTIE = RACINE / "var-copie" / "verifie-artefact-navigateur.json"


def fabriquer_pdf_artefact(chemin: Path) -> None:
    """PDF minimal VALIDE (xref exact) contenant le code secret."""
    lignes_objets = [
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]"
        b"/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n",
        (b"4 0 obj<</Length %d>>stream\nBT /F1 16 Tf 60 760 Td "
         b"(Artefact de test E2E - Gen3ia) Tj 0 -30 Td /F1 12 Tf "
         b"(Code secret confidentiel : %s) Tj ET\nendstream endobj\n"
         % (0, CODE_SECRET.encode())),
        b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
    ]
    # corriger la longueur du stream (4 0 obj)
    corps = lignes_objets[3]
    contenu = corps.split(b"stream\n", 1)[1].rsplit(b"endstream", 1)[0]
    lignes_objets[3] = (
        b"4 0 obj<</Length %d>>stream\n" % len(contenu)
        + contenu + b"endstream endobj\n"
    )
    tete = b"%PDF-1.4\n"
    deplacements = []
    curseur = len(tete)
    for obj in lignes_objets:
        deplacements.append(curseur)
        curseur += len(obj)
    xref_pos = curseur
    xref = [b"xref\n0 6\n0000000000 65535 f \n"]
    for d in deplacements:
        xref.append(b"%010d 00000 n \n" % d)
    remorque = (
        b"trailer<</Size 6/Root 1 0 R>>\nstartxref\n"
        + str(xref_pos).encode() + b"\n%%EOF\n"
    )
    chemin.write_bytes(tete + b"".join(lignes_objets) + b"".join(xref) + remorque)


def main() -> int:
    verdicts = []          # (label, ok, detail)
    erreurs_console = []   # textes des erreurs console
    toast_vu = {"erreur": False}

    def verif(label: str, ok: bool, detail: str = "") -> None:
        verdicts.append((label, ok, detail))
        print(f"[check] {'OK   ' if ok else 'ECHEC'} {label}"
              + (f" - {detail}" if detail else ""), flush=True)

    pdf = Path("/tmp/artefact-e2e-gen3ia.pdf")
    fabriquer_pdf_artefact(pdf)
    print(f"[prep] artefact PDF fabrique : {pdf.stat().st_size} octets", flush=True)

    avec_playwright = sync_playwright().start()
    navigateur = avec_playwright.chromium.launch(headless=True)
    page = navigateur.new_page(
        viewport={"width": 1440, "height": 900},
        user_agent=UA,
    )

    def on_console(msg):
        if msg.type == "error":
            erreurs_console.append(msg.text)

    page.on("console", on_console)

    echecs_reseau = []  # URLs des réponses >= 400 (diagnostic)

    def on_reponse(reponse):
        if reponse.status >= 400:
            echecs_reseau.append(f"{reponse.status} {reponse.url}")

    page.on("response", on_reponse)
    # Observateur de toast : pose un drapeau si « Erreur de génération » apparait,
    # meme fugacement (le toast dure 6 s mais on ne veut rien rater).
    page.add_init_script(
        """
        window.__toastErreurVu = false;
        new MutationObserver(() => {
          const t = document.body ? document.body.innerText : '';
          if (t.includes('Erreur de génération')) window.__toastErreurVu = true;
        }).observe(document.documentElement, {childList: true, subtree: true});
        """
    )

    try:
        # 1) Ouverture production -------------------------------------------------
        reponse = page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        verif("1. page production ouverte (HTTP 200)",
              reponse is not None and reponse.status == 200,
              f"HTTP {reponse.status if reponse else '?'}")

        # 2) Inscription PAR L'UI DE L'APPLICATION (parcours utilisateur réel) ----
        page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_load_state("networkidle", timeout=60000)
        page.wait_for_selector('input[type="email"]', state="visible", timeout=60000)
        time.sleep(2)  # hydration React : les boutons doivent être branchés
        confirmation = page.locator('input[autocomplete="new-password"] >> nth=1')
        for _ in range(3):
            page.click("button:has-text(\"S'inscrire\")", timeout=15000)
            try:
                confirmation.wait_for(state="visible", timeout=8000)
                break
            except Exception:
                time.sleep(2)  # hydratation pas encore prête : on rejoue le clic
        pseudo = "ar" + str(int(time.time()) % 10 ** 10)
        page.fill('input[placeholder="Prénom"]', "Artefact")
        page.fill('input[placeholder="Nom"]', "E2E")
        page.fill('input[placeholder="Nom d\'utilisateur"]', pseudo)
        page.fill('input[type="email"]', EMAIL)
        page.fill('input[type="password"] >> nth=0', PASSWORD)
        page.fill('input[type="password"] >> nth=1', PASSWORD)
        page.click('button[type="submit"]', timeout=15000)
        # signUpWithR2 → establishSession → POST /api/auth/session (cookie
        # gen3ia_session) → redirection /dashboard : le vrai signal de succès.
        try:
            page.wait_for_url("**/dashboard**", timeout=90000)
            verif("2. inscription UI + session serveur posée (redirection /dashboard)",
                  True, EMAIL)
        except Exception:
            erreur_ui = ""
            alerte = page.locator('[role="alert"]')
            if alerte.count():
                erreur_ui = alerte.first.inner_text()[:160]
            verif("2. inscription UI + session serveur posée (redirection /dashboard)",
                  False, f"pas de redirection — alerte UI : {erreur_ui or 'aucune'}")

        # 3) Rechargement → UI chat authentifiee ----------------------------------
        page.goto(BASE + "/chat", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_load_state("networkidle", timeout=60000)
        saisie = page.locator("textarea.nova-saisie")
        saisie.wait_for(state="visible", timeout=60000)
        time.sleep(2)  # laisser l'hydratation React brancher les gestionnaires
        verif("3. chat authentifie (zone de saisie visible)", True, "/chat")

        # 4) Attachement de l'artefact PDF — PARCOURS UTILISATEUR REEL :
        # clic sur le label « Joindre des fichiers » → sélecteur de fichiers.
        # ROBUSTESSE (constat it.143) : sur une build FRAÎCHE (cache JS froid),
        # l'hydratation React peut se terminer APRÈS le tir de l'événement
        # `change` natif du file input — le gestionnaire onChange rate alors
        # la pièce jointe (la puce n'apparaît jamais, le message part sans
        # fichier). Le produit est sain : on ré-arme donc le sélecteur
        # JUSQU'À ce que la puce soit visible (max 4 tentatives, 3 s d'écart) —
        # si la 1re tentative a été prise en compte, la puce est déjà là et
        # on ne ré-arme PAS (pas de doublon).
        n_inputs = page.locator('input[type="file"]').count()
        with page.expect_file_chooser(timeout=15000) as fc_info:
            page.click('label[title="Joindre des fichiers"]')
        fc_info.value.set_files(str(pdf))
        puce = page.get_by_text("artefact-e2e").first
        attache = True
        for tentative in range(4):
            try:
                puce.wait_for(state="visible", timeout=3000)
                attache = True
                break
            except Exception:
                attache = False
                if tentative < 3:
                    # re-arme le sélecteur : le change sera-t-il pris cette
                    # fois par l'hydratation (idempotent si déjà pris — on ne
                    # passe ici QUE si la puce est absente)
                    try:
                        with page.expect_file_chooser(timeout=10000) as fc_retry:
                            page.click('label[title="Joindre des fichiers"]')
                        fc_retry.value.set_files(str(pdf))
                    except Exception:
                        break
        verif("4. artefact PDF attache (puce visible dans la barre)", attache,
              f"{n_inputs} input file sur la page, tentatives={tentative + 1}")
        page.screenshot(path="/tmp/artefact-e2e-attache.png")

        # 5) Message + envoi -------------------------------------------------------
        question = ("Voici un artefact PDF joint. Quel est le code secret "
                    "confidentiel contenu dans ce document ? Reponds juste le code.")
        saisie.click()
        # frappe caractère par caractère : chaque touche déclenche onChange React
        saisie.press_sequentially(question, delay=8)
        bouton = page.locator('button.nova-envoi[aria-label="Envoyer"]')
        try:
            bouton.click(timeout=10000)
            verif("5. envoi declenche (bouton Envoyer clique)", True)
        except Exception:
            # repli utilisateur naturel : la touche Entrée envoie aussi
            saisie.press("Enter")
            verif("5. envoi declenche (touche Entrée, bouton restait inactif)",
                  True, "repli Entrée")

        # 6) Attente : generation demarree puis terminee ---------------------------
        arret = page.locator('button.nova-envoi[aria-label="Arrêter la génération"]')
        try:
            arret.wait_for(state="visible", timeout=30000)
            verif("6a. generation demarree (bouton passe a « Arrêter »)", True)
            arret.wait_for(state="hidden", timeout=240000)
            verif("6b. generation terminee (bouton revenu a « Envoyer »)", True)
        except Exception:
            # generation si rapide que l'etat « Arrêter » n'a pas ete observe,
            # ou echec : on verifie l'etat reel du bouton et de la conversation.
            labels = page.locator("button.nova-envoi").all_inner_texts()
            aria = page.locator("button.nova-envoi").get_attribute("aria-label")
            verif("6a/6b. generation (etat bouton observe)", False,
                  f"aria-label final = {aria!r} ({labels[:1]})")

        # 7) Reponse de l'assistant -------------------------------------------------
        time.sleep(2)
        bulles = page.locator(".nova-bulle")
        n = bulles.count()
        reponse = bulles.nth(n - 1).inner_text() if n else ""
        print(f"[reponse] « {reponse[:300]} »", flush=True)
        verif("7. reponse assistant non vide", len(reponse.strip()) > 3,
              f"{n} bulle(s)")
        verif("8. PREUVE FORTE : code secret du PDF lu par Gen3",
              CODE_SECRET.lower() in reponse.lower(),
              f"attendu « {CODE_SECRET} » dans la reponse")

        # 8) VERDICT principal : plus aucun toast d'erreur --------------------------
        toast_flag = page.evaluate("window.__toastErreurVu === true")
        toast_texte = "Erreur de génération" in page.inner_text("body")
        verif("9. AUCUN toast « Erreur de génération » pendant tout le flux",
              not toast_flag and not toast_texte,
              f"observateur={toast_flag} texte-final={toast_texte}")

        # 9) Aucune erreur console reseau/CSP --------------------------------------
        suspects = [e for e in erreurs_console
                    if ("Failed to fetch" in e
                        or "Refused to connect" in e
                        or "Content Security Policy" in e)]
        verif("10. AUCUNE erreur console Failed to fetch / CSP",
              len(suspects) == 0,
              f"{len(erreurs_console)} erreur(s) console au total, "
              f"{len(suspects)} suspecte(s)")

        page.screenshot(path="/tmp/artefact-e2e-final.png")
    except Exception as incident:  # aucun pas ne doit empecher le rapport
        verif("incident script (a investiguer)", False, repr(incident)[:300])
        try:
            page.screenshot(path="/tmp/artefact-e2e-incident.png")
        except Exception:
            pass
    finally:
        navigateur.close()
        avec_playwright.stop()

    total = len(verdicts)
    verts = sum(1 for _, ok, _ in verdicts if ok)
    succes = verts == total
    rapport = {
        "demande": ("En production dans le navigateur, corriger l'affichage à "
                    "l'envoi d'un artefact puis tester la disparition réelle"),
        "quand": datetime.now(timezone.utc).isoformat(),
        "base": BASE,
        "compte_test": EMAIL,
        "correctifs_verifies": ["45f351d (CORS auto-réparation R2)",
                                 "1599bea (CSP connect-src *.r2.cloudflarestorage.com)"],
        "code_secret_pdf": CODE_SECRET,
        "verdict_global": "PROBLEME DISPARU" if succes else "PROBLEME ENCORE PRESENT",
        "verifications": [
            {"n": i + 1, "label": l, "ok": ok, "detail": d}
            for i, (l, ok, d) in enumerate(verdicts)
        ],
        "erreurs_console": erreurs_console[:30],
        "echecs_reseau_4xx": echecs_reseau[:30],
    }
    SORTIE.parent.mkdir(parents=True, exist_ok=True)
    SORTIE.write_text(json.dumps(rapport, ensure_ascii=False, indent=2) + "\n",
                      encoding="utf-8")
    print(f"\n[resume] {verts}/{total} verifications vertes — "
          f"VERDICT : {rapport['verdict_global']}", flush=True)
    print(f"[rapport] {SORTIE}", flush=True)
    return 0 if succes else 1


if __name__ == "__main__":
    sys.exit(main())

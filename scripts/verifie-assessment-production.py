#!/usr/bin/env python3
"""Vérification PRODUCTION Assessment Engine (système n°15) — gen3ia.online.

Phase ÉVALUATION : « Crée un quiz de 5 questions sur la Révolution
française » → génération automatique (SANS que l'utilisateur ait à le
demander deux fois) :
  - réponse = « Votre évaluation est prête » (pas de clarification si un
    sujet réel est fourni) ;
  - artefact document créé (PDF téléchargeable) ;
  - le fichier est téléchargé et ses octets magiques PDF sont prouvés.
"""
import re
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
STAMP = str(int(time.time()))
EMAIL = f"ass{STAMP}@e2e-gen3ia.test"
PASSWORD = "E2e!Assessment" + STAMP[-4:]

MSG = (
    "Crée un quiz de 5 questions sur ce texte : La photosynthèse est le "
    "processus biologique par lequel les plantes fabriquent leur matière "
    "organique. Ce mécanisme convertit l'énergie lumineuse en énergie "
    "chimique stockée sous forme de glucose. Les chloroplastes contiennent "
    "la chlorophylle qui absorbe la lumière solaire. L'eau absorbe les "
    "photons lors de la phase claire du processus. Le dioxyde de carbone "
    "est ensuite fixé durant la phase sombre. Cette réaction produit du "
    "glucose et libère de l'oxygène dans l'atmosphère."
)

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
            frappe.last.wait_for(state="hidden", timeout=300000)
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


avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
page.set_default_timeout(60000)

try:
    # 1) INSCRIPTION (prouvée par le POST réseau) — même mécanique que la
    # sonde voix/vidéo : chaque tentative est auto-contenue (rechargement).
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
            print(f"[réessayage {tentative + 1}] page non hydratée",
                  flush=True)
            time.sleep(3)
            continue
        page.click("button:has-text(\"S'inscrire\")", timeout=15000)
        time.sleep(1)
        for sel, val in [
            ('input[placeholder="Prénom"]', "Assess"),
            ('input[placeholder="Nom"]', "Engine"),
            ('input[placeholder="Nom d\'utilisateur"]', "as" + STAMP[-8:]),
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

    # 3) ENVOI de la demande d'évaluation
    envoye = False
    for tentative in range(3):
        saisie.fill(MSG)
        time.sleep(1)
        if page.evaluate(
            "document.querySelector('textarea.nova-saisie')?.value ?? ''"
        ) != MSG:
            saisie.fill(MSG)
            time.sleep(1)
        try:
            with page.expect_response(
                lambda r: "/messages/stream" in r.url, timeout=30000
            ) as reponse_info:
                saisie.press("Enter")
            print(f"[réseau] POST …/messages/stream → "
                  f"{reponse_info.value.status}", flush=True)
            envoye = True
            break
        except Exception as e:
            print(f"[réessayage envoi {tentative + 1}] {type(e).__name__}",
                  flush=True)
    verif("3. demande d'évaluation envoyée", envoye, MSG)

    # 4) Réponse : évaluation générée (pas de demande de matière)
    reponse = attendre_reponse_stable(page) if envoye else ""
    prete = "Votre évaluation est prête" in reponse
    clarification = "il me faut une base réelle" in reponse
    verif("4. évaluation GÉNÉRÉE automatiquement (« Votre évaluation est "
          "prête »)", prete,
          "clarification reçue (moteur indisponible)" if clarification
          else f"{len(reponse)} car.")
    n_questions = len(re.findall(r"(?:^|[\s»])[1-9]\d?\.\s", reponse))
    verif("5. aperçu des questions dans le fil (≥1 question numérotée)",
          n_questions >= 1, f"{n_questions} question(s) vues")

    # 5) Artefact document créé côté serveur — vérité via le détail de la
    # conversation (GET /api/workspace/conversations/{sid} → artifacts[]),
    # même contrat que le panneau artefacts de l'UI.
    id_doc = ""
    cle_stockage = ""
    debut_a = time.time()
    while time.time() - debut_a < 75 and not cle_stockage:
        try:
            sid = page.evaluate("""async () => {
              const r = await fetch('/api/workspace/conversations?limit=10',
                {credentials:'include',cache:'no-store'});
              const j = await r.json();
              return (j.conversations || [])[0]?.id ?? null; }""")
            if sid:
                corps = page.evaluate(
                    """async (sid) => {
                      const r = await fetch(`/api/workspace/conversations/${sid}`,
                        {credentials:'include',cache:'no-store'});
                      return await r.text(); }""", sid)
                m_cle = re.search(r'"storagePath"\s*:\s*"([^"]+)"', corps)
                if m_cle:
                    cle_stockage = m_cle.group(1)
                m_id = re.search(r'"id"\s*:\s*"([-A-Za-z0-9_]+)"', corps)
                if m_id:
                    id_doc = m_id.group(1)
        except Exception:
            pass
        if not cle_stockage:
            time.sleep(8)
    verif("6. artefact document créé côté serveur (storagePath résolvable)",
          cle_stockage != "",
          f"clé={cle_stockage[:60]}" if cle_stockage else "aucun artefact listé")

    # 6) Téléchargement RÉEL + octets magiques %PDF — via l'URL signée du
    # stockage permanent (même résolution que la carte artefact de l'UI).
    if cle_stockage:
        ok_pdf = False
        taille = 0
        tete = ""
        try:
            donnees = page.evaluate(
                """async (cle) => {
                    const r1 = await fetch(`/api/storage/permanent?path=${encodeURIComponent(cle)}`,
                      {credentials:'include',cache:'no-store'});
                    const j1 = await r1.json();
                    if (!j1.url) return { erreur: "pas d'URL signée" };
                    const r2 = await fetch(j1.url, {cache:'no-store'});
                    const b = await r2.arrayBuffer();
                    const t = new Uint8Array(b.slice(0, 8));
                    return { statut: r2.status, taille: b.byteLength,
                             tete: Array.from(t).map(x => String.fromCharCode(x)).join('') };
                }""", cle_stockage)
            taille = donnees.get("taille", 0)
            tete = donnees.get("tete", "")
            ok_pdf = tete[:5] == "%PDF-" and taille >= 2000
        except Exception:
            pass
        verif("7. DOCUMENT PDF TÉLÉCHARGÉ (octets %PDF, ≥2 Ko)", ok_pdf,
              f"{taille} octets, tête={tete[:5]!r}")
    else:
        verif("7. DOCUMENT PDF TÉLÉCHARGÉ (octets %PDF, ≥2 Ko)", False,
              "aucun artefact")
    page.screenshot(path="/tmp/assessment-production.png")
    print("[capture] /tmp/assessment-production.png", flush=True)
    print(f"[extrait] {' '.join(reponse.split())[:400]}", flush=True)

finally:
    nav.close()
    avec.stop()

echecs = resultats.count(False)
print(f"\nVERDICT : {resultats.count(True)}/{len(resultats)} vérifications OK"
      + (" — GREEN" if echecs == 0 else f" — {echecs} ÉCHEC(S)"), flush=True)
sys.exit(0 if echecs == 0 else 1)

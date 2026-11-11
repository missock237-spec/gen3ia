#!/usr/bin/env python3
"""Vérification MOTEUR DOCUMENTAIRE — gen3ia en production.

Prouve la chaîne complète exigée (« créer des documents depuis le serveur
neuronal ») : inscription réelle → session → message de création → le
moteur neuronal appelle artifact.create → la réponse annonce le livrable →
TÉLÉCHARGEMENT RÉEL du fichier → signature %PDF- vérifiée sur les octets.

Même squelette durci que la sonde recherche-web (hydration-proof, POST
réseau prouvés, valeurs DOM revérifiées).
"""
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
STAMP = str(int(time.time()))
EMAIL = f"doc{STAMP}@e2e-gen3ia.test"
PASSWORD = "E2e!Document" + STAMP[-4:]
CAPTURE = Path("/tmp/moteur-documentaire-production.png")

resultats = []


def verif(label: str, ok: bool, detail: str = "") -> None:
    resultats.append(ok)
    print(f"[check] {'OK   ' if ok else 'ECHEC'} {label}"
          + (f" - {detail}" if detail else ""), flush=True)


MESSAGE = ('Crée un document PDF intitulé "Rapport café" avec un titre, '
           "un paragraphe et une liste de trois points sur la production "
           "mondiale de café.")
# Livrable : URL d'artifact réelle (route inline authentifiée) ou lien R2
# présigné, ou à défaut une annonce explicite de fichier .pdf téléchargeable.
MOTIFS_LIVRABLE = re.compile(
    r"(/api/files/artifacts/[A-Za-z0-9_-]+|storage\.googleapis\.com|r2\.dev|"
    r"\.pdf\b)", re.I)
MOTIFS_ANNONCE = re.compile(r"(télécharg|download|créé|généré|prêt)", re.I)
MOTIFS_REFUS = re.compile(
    r"(je ne peux pas (créer|générer|produire)|ne peux pas créer de document|"
    r"aucune (capacité|possibilité) de (création|génération)|impossible de (créer|générer))", re.I)

avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
page.set_default_timeout(60000)

try:
    # 1) INSCRIPTION — prouvée par le POST réseau
    inscrit = False
    for tentative in range(4):
        page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_selector('input[type="email"]', state="visible", timeout=45000)
            page.wait_for_selector('button:has-text("S\'inscrire")', timeout=20000)
        except Exception as e:
            print(f"[réessayage {tentative + 1}] page non hydratée : {type(e).__name__}", flush=True)
            time.sleep(3)
            continue
        # Onglet « S'inscrire » — le clic ne mord qu'une fois la page
        # hydratée : on attend le formulaire complet et on re-clique sinon.
        formulaire_ok = False
        for essai_clic in range(4):
            try:
                page.click('button:has-text("S\'inscrire")', timeout=15000)
                page.wait_for_selector(
                    'input[placeholder="Prénom"]', state="visible", timeout=12000)
                formulaire_ok = True
                break
            except Exception:
                print(f"[onglet] re-clic {essai_clic + 1} (hydratation en cours)", flush=True)
                time.sleep(3)
        if not formulaire_ok:
            continue
        time.sleep(1)
        for sel, val in [
            ('input[placeholder="Prénom"]', "Document"),
            ('input[placeholder="Nom"]', "Moteur"),
            ('input[placeholder="Nom d\'utilisateur"]', "dm" + STAMP[-8:]),
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
                    page.click('button:has-text("Se connecter")', timeout=15000)
                    time.sleep(1)
                    page.fill('input[type="email"]', EMAIL)
                    page.fill('input[type="password"] >> nth=0', PASSWORD)
                    with page.expect_response(
                        lambda r: "/api/auth/r2/login" in r.url, timeout=20000
                    ) as rep_login:
                        page.click('button[type="submit"]', timeout=15000)
                    print(f"[réseau] POST /api/auth/r2/login → {rep_login.value.status}", flush=True)
                    inscrit = True
                    break
                except Exception as e:
                    print(f"[connexion repli] {type(e).__name__}", flush=True)
            time.sleep(2)
    verif("1. inscription RÉELLE (POST /api/auth/r2/signup 2xx)", inscrit, EMAIL)

    try:
        page.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass
    time.sleep(2)

    # 2) /chat authentifié puis SESSION prouvée
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
    verif("2. /chat ouvert + session serveur prouvée (authenticated:true)", authentifie)

    # 3) ENVOI — prouvé par le POST du flux + CAPTURE DU FLUX SSE complet :
    # la source de vérité serveur (run_created / step_update /
    # artifact_created / done) — la même que consomme l'interface.
    envoye = False
    corps_flux = ""
    for tentative in range(3):
        saisie.fill(MESSAGE)
        time.sleep(1)
        if page.evaluate(
            "document.querySelector('textarea.nova-saisie')?.value ?? ''"
        ) != MESSAGE:
            saisie.fill(MESSAGE)
            time.sleep(1)
        try:
            with page.expect_response(
                lambda r: "/messages/stream" in r.url, timeout=30000
            ) as reponse_info:
                saisie.press("Enter")
            print(f"[réseau] POST …/messages/stream → {reponse_info.value.status}", flush=True)
            envoye = True
            # Corps SSE complet (bloque jusqu'à la fin du tour du moteur).
            try:
                corps_flux = reponse_info.value.text()
            except Exception as e:
                print(f"[flux] lecture impossible : {type(e).__name__}", flush=True)
            break
        except Exception as e:
            print(f"[réessayage envoi {tentative + 1}] {type(e).__name__}", flush=True)
    verif("3. message envoyé (POST …/messages/stream vu)", envoye, MESSAGE[:60])

    # 3bis) Analyse du flux : étapes exécutées + artefact créé côté serveur.
    evenements = re.findall(r'"type":"([a-z_]+)"', corps_flux)
    nom_fichier_flux = re.search(r'"filename":"([^"]+)"', corps_flux)
    print(f"[flux] événements: {sorted(set(evenements))}", flush=True)
    if nom_fichier_flux:
        print(f"[flux] artefact annoncé: {nom_fichier_flux.group(1)}", flush=True)
    # Traçage des étapes : titre, outil, statut, sortie (diagnostic honnête).
    for ligne in corps_flux.split("\n"):
        if not ligne.startswith("data:"):
            continue
        brut = ligne[5:].strip()
        if not brut or brut == "[DONE]":
            continue
        m_step = re.search(r'"type":"step_update","step":(\{.*\})', brut)
        if m_step:
            try:
                step = json.loads(m_step.group(1))
                print(
                    f"[étape] {step.get('status')} | {str(step.get('title'))[:55]} "
                    f"| outil={step.get('toolName')} | sortie={str(step.get('output'))[:130]}",
                    flush=True,
                )
            except Exception:
                pass

    # 4) Réponse complète
    dernier = ""
    debut = time.time()
    if envoye:
        try:
            page.locator(".nova-fil .nova-bulle").first.wait_for(
                state="visible", timeout=30000)
        except Exception:
            pass
        if frappe := page.locator(".nova-frappe"):
            try:
                frappe.last.wait_for(state="visible", timeout=30000)
                frappe.last.wait_for(state="hidden", timeout=300000)
            except Exception:
                pass
        for _ in range(4):
            bulles = page.locator(".nova-fil .nova-bulle")
            dernier = bulles.last.inner_text() if bulles.count() else ""
            time.sleep(3)
            bulles = page.locator(".nova-fil .nova-bulle")
            nouveau = bulles.last.inner_text() if bulles.count() else ""
            if nouveau == dernier and len(nouveau) > 80:
                dernier = nouveau
                break
            dernier = nouveau
    duree = time.time() - debut
    reponse = dernier.strip()

    # 4bis) Le livrable arrive APRÈS l'exécution du plan complet (rédaction
    # LLM + appel outil + message final avec le lien) : on attend qu'une
    # bulle contienne le lien d'artefact réel — jusqu'à 150 s.
    fil_complet = ""
    debut_attente = time.time()
    while time.time() - debut_attente < 150:
        bulles = page.locator(".nova-fil .nova-bulle")
        fil_complet = "\n".join(bulles.nth(i).inner_text() for i in range(bulles.count())) if bulles.count() else ""
        if "/api/files/artifacts/" in fil_complet:
            break
        time.sleep(3)
    reponse = fil_complet.strip() or reponse
    duree = time.time() - debut
    verif("4. réponse assistant complète (bulle stable)",
          len(reponse) > 80,
          f"{duree:.0f}s d'attente, fil {len(reponse)} caractères")

    # 5) LIVRABLE CRÉÉ côté serveur — événement artifact_created du flux
    # (vérité moteur) + lien de téléchargement dans le fil.
    id_artifact_flux = None
    m_zone = re.search(r'"type":"artifact_created"', corps_flux)
    if m_zone:
        zone = corps_flux[m_zone.start():m_zone.start() + 600]
        m_id = re.search(r'"id":"([A-Za-z0-9_-]+)"', zone)
        id_artifact_flux = m_id.group(1) if m_id else None
    url_artifact = re.search(r"/api/files/artifacts/([A-Za-z0-9_-]+)", reponse)
    id_livrable = id_artifact_flux or (url_artifact.group(1) if url_artifact else None)
    verif("5. livrable CRÉÉ côté serveur (artifact_created + id réel)",
          bool(id_livrable),
          f"id={id_livrable} fichier={nom_fichier_flux.group(1) if nom_fichier_flux else '—'}")

    # 6) TÉLÉCHARGEMENT RÉEL + signature du fichier
    telecharge = False
    signature = ""
    if id_livrable:
        href = f"{BASE}/api/files/artifacts/{id_livrable}?redirect=1"
        try:
            corps_octets = page.evaluate(
                """async (u) => {
                    const r = await fetch(u, {credentials:'include', cache:'no-store'});
                    const b = await r.arrayBuffer();
                    const t = new Uint8Array(b.slice(0, 8));
                    return { statut: r.status, taille: b.byteLength,
                             tete: Array.from(t).map(x => String.fromCharCode(x)).join('') };
                }""", href)
            statut = corps_octets.get("statut")
            taille = corps_octets.get("taille", 0)
            tete = corps_octets.get("tete", "")
            signature = tete[:5]
            telecharge = statut in (200, 307) and taille > 500
            print(f"[réseau] GET livrable → {statut}, {taille} octets, tête={tete!r}", flush=True)
        except Exception as e:
            print(f"[téléchargement] {type(e).__name__}", flush=True)
    verif("6. TÉLÉCHARGEMENT RÉEL du PDF créé (signature %PDF- vérifiée)",
          telecharge and signature == "%PDF-",
          f"tête={signature!r}")

    # 7) Aucun refus de création
    verif("7. aucun refus de création de document dans la réponse",
          not MOTIFS_REFUS.search(reponse))

    page.screenshot(path=str(CAPTURE), full_page=True)
    print(f"[capture] {CAPTURE}", flush=True)
    extrait = re.sub(r"\s+", " ", reponse)[:400]
    print(f"[extrait-réponse] {extrait}", flush=True)
finally:
    nav.close()
    avec.stop()

total = len(resultats)
ok = sum(resultats)
print()
print(f"VERDICT : {ok}/{total} vérifications OK — {'GREEN' if ok == total else 'RED'}")
sys.exit(0 if ok == total else 1)

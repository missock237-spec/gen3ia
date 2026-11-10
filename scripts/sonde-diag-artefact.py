#!/usr/bin/env python3
"""SONDE DIAGNOSTIC — attachement de fichier sur /chat production.
Distingue : problème de chooser / d'onChange React / de rendu de puce."""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
EMAIL = f"sonde-diag-{int(time.time())}@gen3ia.test"
PASSWORD = "Gen3iaE2E!2026"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# PDF minimal
pdf = Path("/tmp/sonde-diag.pdf")
contenu = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\nxref\n0 4\n0000000000 65535 f \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n9\n%%EOF"
pdf.write_bytes(contenu)

avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
msgs = []
page.on("console", lambda m: msgs.append(f"{m.type}: {m.text[:120]}"))

page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
page.wait_for_load_state("networkidle", timeout=60000)
page.wait_for_selector('input[type="email"]', state="visible", timeout=60000)
time.sleep(2)
# UI V2 « Aurora » : le formulaire d'inscription est derrière l'onglet S'inscrire
try:
    page.click('button:has-text("S\'inscrire")', timeout=8000)
    time.sleep(1)
except Exception as e:
    print("[0] onglet S'inscrire:", e)
pseudo = "sd" + str(int(time.time()) % 10**10)
page.fill('input[placeholder="Prénom"]', "Sonde")
page.fill('input[placeholder="Nom"]', "Diag")
page.fill('input[placeholder="Nom d\'utilisateur"]', pseudo)
page.fill('input[type="email"]', EMAIL)
page.fill('input[type="password"] >> nth=0', PASSWORD)
page.fill('input[type="password"] >> nth=1', PASSWORD)
page.click('button[type="submit"]', timeout=15000)
page.wait_for_url("**/dashboard**", timeout=90000)
print("[1] signup OK →", page.url)

page.goto(BASE + "/chat", wait_until="domcontentloaded", timeout=60000)
page.wait_for_load_state("networkidle", timeout=60000)
page.wait_for_selector("textarea.nova-saisie", state="visible", timeout=60000)
time.sleep(3)
print("[2] /chat OK — cookies:", [c["name"] for c in page.context.cookies()])

inp = page.locator('input[type="file"]').first
print("[3] input file présent:", inp.count() if (inp := page.locator('input[type="file"]')).count() >= 0 else "?")
print("    accept =", inp.get_attribute("accept"))
print("    hidden =", inp.get_attribute("hidden"))

# Voie A : set_input_files DIRECT sur l'input (bypass chooser)
inp.set_input_files(str(pdf))
time.sleep(2)
puce = page.get_by_text("sonde-diag").first
try:
    puce.wait_for(state="visible", timeout=4000)
    print("[4] voie A (set_input_files direct) : PUCE VISIBLE ✓")
except Exception:
    print("[4] voie A (set_input_files direct) : puce ABSENTE ✗")
    # état de l'input après set
    etat = page.evaluate("""() => {
        const i = document.querySelector('input[type="file"]');
        return { fichiers: i ? i.files.length : -1, valeur: i ? i.value : null };
    }""")
    print("    état input:", etat)
    # React est-il branché ? touche une touche dans la textarea et regarde la valeur du state
    ta = page.locator("textarea.nova-saisie")
    ta.click()
    ta.press_sequentially("test", delay=10)
    time.sleep(1)
    val = ta.input_value()
    print("    textarea value après frappe:", repr(val), "(si 'test' → React hydraté)")
page.screenshot(path="/tmp/sonde-diag.png")
print("[5] console:")
for m in msgs[-8:]:
    print("   ", m)
nav.close()
avec.stop()

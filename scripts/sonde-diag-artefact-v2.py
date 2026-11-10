#!/usr/bin/env python3
"""SONDE DIAGNOSTIC v2 — qui avale le change du file input ?"""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
EMAIL = f"sonde-v2-{int(time.time())}@gen3ia.test"
PASSWORD = "Gen3iaE2E!2026"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

pdf = Path("/tmp/sonde-v2.pdf")
pdf.write_bytes(b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\nxref\n0 4\n0000000000 65535 f \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n9\n%%EOF")

avec = sync_playwright().start()
nav = avec.chromium.launch(headless=True)
page = nav.new_page(viewport={"width": 1440, "height": 900}, user_agent=UA)
page.goto(BASE + "/signup", wait_until="domcontentloaded", timeout=60000)
page.wait_for_load_state("networkidle", timeout=60000)
page.wait_for_selector('input[type="email"]', state="visible", timeout=60000)
time.sleep(2)
try:
    page.click('button:has-text("S\'inscrire")', timeout=8000)
    time.sleep(1)
except Exception as e:
    print("[0] onglet:", e)
pseudo = "s2" + str(int(time.time()) % 10**10)
page.fill('input[placeholder="Prénom"]', "Sonde")
page.fill('input[placeholder="Nom"]', "V2")
page.fill('input[placeholder="Nom d\'utilisateur"]', pseudo)
page.fill('input[type="email"]', EMAIL)
page.fill('input[type="password"] >> nth=0', PASSWORD)
page.fill('input[type="password"] >> nth=1', PASSWORD)
page.click('button[type="submit"]', timeout=15000)
page.wait_for_url("**/dashboard**", timeout=90000)
print("[1] signup OK")

page.goto(BASE + "/chat", wait_until="domcontentloaded", timeout=60000)
page.wait_for_load_state("networkidle", timeout=60000)
page.wait_for_selector("textarea.nova-saisie", state="visible", timeout=60000)
time.sleep(3)

# Écouteur NATIF (hors React) sur le file input + hook toast
page.evaluate("""() => {
  window.__diag = { changeFired: 0, filesSeen: -1, toasts: [] };
  const inp = document.querySelector('input[type="file"]');
  if (inp) inp.addEventListener('change', (e) => {
    window.__diag.changeFired += 1;
    window.__diag.filesSeen = e.target.files ? e.target.files.length : -2;
    window.__diag.nomVu = e.target.files && e.target.files[0] ? e.target.files[0].name : null;
  });
  // observe les toasts
  new MutationObserver(() => {
    const alertes = document.querySelectorAll('[role="alert"], .nova-toast, [class*="toast"]');
    alertes.forEach(a => {
      const t = (a.textContent || '').trim();
      if (t && !window.__diag.toasts.includes(t)) window.__diag.toasts.push(t);
    });
  }).observe(document.body, { childList: true, subtree: true });
}""")

# Voie chooser (parcours utilisateur réel)
with page.expect_file_chooser(timeout=15000) as fc:
    page.click('label[title="Joindre des fichiers"]')
fc.value.set_files(str(pdf))
time.sleep(3)
diag = page.evaluate("() => window.__diag")
puce = page.get_by_text("sonde-v2").first
puce_vue = False
try:
    puce.wait_for(state="visible", timeout=2000)
    puce_vue = True
except Exception:
    pass
print("[2] chooser: changeFired =", diag.get("changeFired"), "| filesSeen =", diag.get("filesSeen"),
      "| nomVu =", diag.get("nomVu"), "| puce =", puce_vue, "| toasts =", diag.get("toasts"))

# Voie directe set_input_files
page.evaluate("() => { window.__diag.changeFired = 0; }")
page.locator('input[type="file"]').first.set_input_files(str(pdf))
time.sleep(3)
diag2 = page.evaluate("() => window.__diag")
nb_puces = page.locator(".nova-piece").count()
print("[3] direct : changeFired =", diag2.get("changeFired"), "| filesSeen =", diag2.get("filesSeen"),
      "| nb .nova-piece =", nb_puces, "| toasts =", diag2.get("toasts"))
page.screenshot(path="/tmp/sonde-v2.png")
nav.close()
avec.stop()

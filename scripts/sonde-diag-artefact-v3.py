#!/usr/bin/env python3
"""SONDE v3 — React fiber du file input : onChange présent ? dispatch natif ?"""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "https://www.gen3ia.online"
EMAIL = f"sonde-v3-{int(time.time())}@gen3ia.test"
PASSWORD = "Gen3iaE2E!2026"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

pdf = Path("/tmp/sonde-v3.pdf")
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
except Exception:
    pass
pseudo = "s3" + str(int(time.time()) % 10**10)
page.fill('input[placeholder="Prénom"]', "Sonde")
page.fill('input[placeholder="Nom"]', "V3")
page.fill('input[placeholder="Nom d\'utilisateur"]', pseudo)
page.fill('input[type="email"]', EMAIL)
page.fill('input[type="password"] >> nth=0', PASSWORD)
page.fill('input[type="password"] >> nth=1', PASSWORD)
page.click('button[type="submit"]', timeout=15000)
page.wait_for_url("**/dashboard**", timeout=90000)
page.goto(BASE + "/chat", wait_until="domcontentloaded", timeout=60000)
page.wait_for_load_state("networkidle", timeout=60000)
page.wait_for_selector("textarea.nova-saisie", state="visible", timeout=60000)
time.sleep(3)

info = page.evaluate("""() => {
  const inp = document.querySelector('input[type="file"]');
  if (!inp) return { erreur: "pas d'input" };
  const cleFiber = Object.keys(inp).find((k) => k.startsWith("__reactFiber$"));
  const cleProps = Object.keys(inp).find((k) => k.startsWith("__reactProps$"));
  const props = cleProps ? inp[cleProps] : null;
  return {
    cleFiber: !!cleFiber,
    cleProps: !!cleProps,
    onChangePresent: !!(props && typeof props.onChange === "function"),
    typeProps: props ? Object.keys(props) : [],
  };
}""")
print("[1] fiber/props:", info)

# pose le fichier PUIS dispatch manuel d'un change natif bubblant
page.locator('input[type="file"]').first.set_input_files(str(pdf))
res = page.evaluate("""() => {
  const inp = document.querySelector('input[type="file"]');
  const avant = inp.files.length;
  const ev = new Event("change", { bubbles: true });
  inp.dispatchEvent(ev);
  return { avant };
}""")
time.sleep(2)
nb = page.locator(".nova-piece").count()
puce = page.get_by_text("sonde-v3").first
vue = False
try:
    puce.wait_for(state="visible", timeout=2000)
    vue = True
except Exception:
    pass
print(f"[2] set_input_files (files={res.get('avant')}) + dispatch change bubblant → puce={vue} .nova-piece={nb}")
page.screenshot(path="/tmp/sonde-v3.png")
nav.close()
avec.stop()

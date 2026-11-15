/* Diagnostic OAuth : capture la vraie erreur Firebase lors de signInWithPopup */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "https://gen3ia.online";

const run = async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-features=ThirdPartyCookiesEnabled"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const logs = [];
  page.on("console", (msg) => logs.push(`[console.${msg.type()}] ${msg.text().slice(0, 500)}`));
  page.on("pageerror", (err) => logs.push(`[pageerror] ${String(err).slice(0, 500)}`));
  page.on("requestfailed", (req) =>
    logs.push(`[requestfailed] ${req.method()} ${req.url().slice(0, 200)} :: ${req.failure()?.errorText}`)
  );

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 60000 });

  // Clic Google
  const googleBtn = page.getByRole("button", { name: /continuer avec google/i });
  await googleBtn.click();
  await page.waitForTimeout(9000);

  // Capturer l'alerte affichée + popup éventuel
  const alertText = await page.evaluate(() => document.querySelector("[role=alert]")?.textContent || "aucune");
  const pages = context.pages().map((p) => p.url());

  console.log("=== PAGES OUVERTES ===");
  pages.forEach((p) => console.log(" -", p.slice(0, 160)));
  console.log("=== ALERTE UI ===");
  console.log(alertText);
  console.log("=== LOGS CONSOLE/ERREURS ===");
  logs.forEach((l) => console.log(l));

  await browser.close();
};

run().catch((e) => { console.error("FATAL:", e); process.exit(1); });

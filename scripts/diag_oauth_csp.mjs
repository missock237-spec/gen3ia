/* Prouve la cause racine : relâche la CSP côté client (interception de route)
   puis relance le clic Google — si le popup s'ouvre vers accounts.google.com,
   la CSP de proxy.ts était bien le bloqueur. */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const RELAXED_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://apis.google.com https://www.gstatic.com https://www.googleapis.com; frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://*.firebaseio.com https://content.googleapis.com; connect-src 'self' https: wss:";

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const logs = [];
  page.on("console", (m) => logs.push(`[console.${m.type()}] ${m.text().slice(0, 300)}`));
  page.on("requestfailed", (r) => logs.push(`[requestfailed] ${r.url().slice(0, 140)} :: ${r.failure()?.errorText}`));

  // Relâche la CSP sur le document principal uniquement
  await page.route(`${BASE}/**`, async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    if ((headers["content-type"] || "").includes("text/html")) {
      headers["content-security-policy"] = RELAXED_CSP;
    }
    await route.fulfill({ response, headers });
  });

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 60000 });

  const popupPromise = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
  await page.getByRole("button", { name: /continuer avec google/i }).click();
  const popup = await popupPromise;

  console.log("=== POPUP OUVERT ? ===");
  if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
    console.log("URL popup:", popup.url().slice(0, 120));
    const content = await popup.evaluate(() => document.body?.innerText?.slice(0, 200) || "(vide)").catch(() => "(err)");
    console.log("Contenu popup:", content.replace(/\n/g, " | ").slice(0, 200));
    await popup.close();
    console.log("VERDICT: POPUP OK — la CSP était bien la cause racine");
  } else {
    const alertText = await page.evaluate(() => document.querySelector("[role=alert]")?.textContent || "aucune");
    console.log("Aucun popup. Alerte:", alertText);
    console.log("VERDICT: le popup ne s'ouvre pas même sans CSP stricte");
  }

  console.log("=== LOGS ===");
  logs.forEach((l) => console.log(l));
  await browser.close();
};

run().catch((e) => { console.error("FATAL:", e); process.exit(1); });

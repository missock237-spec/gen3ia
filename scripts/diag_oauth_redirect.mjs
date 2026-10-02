/* Diagnostic OAuth : extraire redirect_uri exact + tester le handler Firebase */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const provider = process.argv[2] || "github";

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 60000 });

  // provider provient de argv (entrée utilisateur) : échappé avant d'être
  // compilé en regex — un argument « .*|x » ne peut plus détourner le motif.
  const providerPattern = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const btn = page.getByRole("button", { name: new RegExp(`continuer avec ${providerPattern}`, "i") });
  await btn.click();
  await page.waitForTimeout(8000);

  const popup = context.pages()[context.pages().length - 1];
  const popupUrl = popup?.url() || "";

  console.log(`=== POPUP ${provider.toUpperCase()} ===`);
  console.log(popupUrl.slice(0, 400));

  // extraire redirect_uri
  const m = popupUrl.match(/redirect_uri=([^&]+)/);
  if (m) {
    const redirectUri = decodeURIComponent(decodeURIComponent(m[1]));
    console.log("=== REDIRECT_URI ===");
    console.log(redirectUri);
    // tester la disponibilité du handler Firebase
    if (redirectUri.includes("__/auth/handler")) {
      const res = await fetch(redirectUri, { redirect: "manual" });
      console.log("=== HANDLER STATUS ===", res.status);
    }
  }

  await browser.close();
};

run().catch((e) => { console.error("FATAL:", e); process.exit(1); });

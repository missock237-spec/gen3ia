/* SONDE BRUTE gateway /images/generations — timeout long, réponse trimisée.
 * N'imprime JAMAIS la config. */
import { readFileSync } from "node:fs";

const brut = readFileSync("/etc/.z-ai-config", "utf-8");
const cfg = JSON.parse(brut) as { baseUrl: string; apiKey: string; chatId?: string; userId?: string; token?: string };

async function sonde(nom: string, corps: Record<string, unknown>, délai: number): Promise<void> {
  const t0 = Date.now();
  try {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
      "X-Z-AI-From": "Z",
    };
    if (cfg.chatId) h["X-Chat-Id"] = cfg.chatId;
    if (cfg.userId) h["X-User-Id"] = cfg.userId;
    if (cfg.token) h["X-Token"] = cfg.token;
    const r = await fetch(`${cfg.baseUrl}/images/generations`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(corps),
      signal: AbortSignal.timeout(délai),
    });
    const texte = await r.text();
    console.log(`[${nom}] ${r.status} en ${Date.now() - t0} ms — corps: ${texte.slice(0, 300)}`);
  } catch (e) {
    console.log(`[${nom}] ÉCHEC en ${Date.now() - t0} ms: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  await sonde("cogview+size", { prompt: "un arbre photographié en forêt, photoréaliste", size: "1024x1024" }, 170_000);
}
main();

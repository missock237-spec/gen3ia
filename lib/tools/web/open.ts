import { z } from "zod";
import type { ToolDefinition } from "../types";
// MOTEUR DE RECHERCHE WEB gen3ia : la lecture de page passe par le module
// dédié — navigation Playwright/Chromium (rendu JS réel) quand le
// navigateur est disponible, HTTP direct + extraction structurée Cheerio
// sinon. La garde SSRF (assertPublicHttpUrl) est appliquée EN AMONT du
// fetch/playwright dans navigation-playwright.ts.
import { naviguerVersPage } from "@/lib/recherche-web/extraction/navigation-playwright";

const OpenInput = z.object({
  url: z.string().url(),
  maxCharacters: z.number().int().min(1000).max(50000).default(20000),
});

interface OpenResult { url: string; status: number; contentType: string; text: string; }

export const webOpenTool: ToolDefinition<z.infer<typeof OpenInput>, OpenResult> = {
  id: "web.open",
  name: "Open Web Page",
  description:
    "Retrieve and extract text from a public web page (rendu Playwright/Chromium si disponible, sinon HTTP + extraction structurée).",
  category: "web",
  risk: "low",
  inputSchema: OpenInput,
  async execute(input, _context) {
    const page = await naviguerVersPage(input.url, {
      maxCaracteres: input.maxCharacters,
      budgetMs: 25_000,
    });
    const contenu = page.texte || (page.description ?? "");
    if (!contenu.trim()) throw new Error("Web page returned no extractable text.");
    return {
      url: page.urlFinale ?? page.url,
      // Le statut HTTP exact n'est pas toujours connu après rendu Chromium ;
      // 200 reflète « page rendue et lue » — les échecs réels lèvent avant.
      status: 200,
      contentType: page.methode === "playwright" ? "text/html (rendu Chromium)" : "text/html",
      text: contenu,
    };
  },
};

export async function openWebPage(url: string, maxCharacters = 20000): Promise<string> {
  const parsed = OpenInput.parse({ url, maxCharacters });
  const result = await webOpenTool.execute(parsed, { userId: "system" });
  return result.text;
}

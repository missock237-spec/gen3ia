import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

/**
 * Garde-fous des routes GEO — un seul mauvais Disallow peut rendre Gen3ia
 * INVISIBLE pour ChatGPT/Claude/Perplexity ; un sitemap incomplet prive les
 * moteurs de réponse des pages citables. Ces tests bloquent la régression.
 */
describe("GEO : routes robots / sitemap / llms", () => {
  it("robots.txt autorise explicitement les crawlers IA majeurs", () => {
    const rules = robots().rules as Array<{ userAgent: string | string[]; allow?: string | string[] }>;
    const agents = rules.flatMap((rule) => (Array.isArray(rule.userAgent) ? rule.userAgent : [rule.userAgent]));
    for (const crawler of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot", "Applebot-Extended"]) {
      expect(agents, `crawler IA manquant : ${crawler}`).toContain(crawler);
      const rule = rules.find((r) => (Array.isArray(r.userAgent) ? r.userAgent : [r.userAgent]).includes(crawler));
      expect(rule?.allow).toContain("/");
    }
  });

  it("robots.txt protège les surfaces privées sans bloquer la vitrine", () => {
    const rules = robots().rules as Array<{ userAgent: string | string[]; disallow?: string[] }>;
    for (const rule of rules) {
      expect(rule.disallow).toContain("/api/");
      expect(rule.disallow).toContain("/admin");
    }
    expect(robots().sitemap).toContain("/sitemap.xml");
  });

  it("le sitemap expose toutes les surfaces citables publiques", () => {
    const urls = sitemap().map((entry) => new URL(entry.url).pathname);
    for (const required of ["/", "/en", "/faq", "/studio", "/live", "/marketplace", "/integrations", "/signup"]) {
      expect(urls, `page publique manquante du sitemap : ${required}`).toContain(required);
    }
  });

  it("le sitemap déclare les alternates hreflang fr/en réciproques", () => {
    const entries = sitemap();
    const fr = entries.find((entry) => entry.url.endsWith("gen3ia.online/"));
    const en = entries.find((entry) => new URL(entry.url).pathname === "/en");
    expect(fr?.alternates?.languages).toMatchObject({ fr: expect.any(String), en: expect.any(String) });
    expect(en?.alternates?.languages).toMatchObject({ fr: expect.any(String), en: expect.any(String) });
  });

  it("llms.txt référence la FAQ et la version anglaise (anti-dérive)", () => {
    const llms = readFileSync(path.join(process.cwd(), "public/llms.txt"), "utf8");
    expect(llms).toContain("https://gen3ia.online/faq");
    expect(llms).toContain("https://gen3ia.online/en");
    expect(llms).toContain("Gen3ia");
  });

  it("llms-full.txt contient le résumé anglais et les liens clés", () => {
    const full = readFileSync(path.join(process.cwd(), "public/llms-full.txt"), "utf8");
    expect(full).toContain("English summary");
    expect(full).toContain("autonomous AI agent platform");
    expect(full).toContain("https://gen3ia.online/faq");
    expect(full).toContain("800+");
  });
});

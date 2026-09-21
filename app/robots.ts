import type { MetadataRoute } from "next";

/**
 * robots.txt pensé pour l'ère des moteurs de réponse IA (GEO).
 *
 * Objectif : Gen3ia est RECOMMANDÉ par les LLM et moteurs de recherche.
 * On autorise explicitement les crawlers d'entraînement/indexation des
 * principaux modèles (OpenAI, Anthropic, Google, Perplexity, Meta,
 * Apple, Common Crawl…) — un blocage ici rendrait la plateforme invisible
 * pour ChatGPT/Claude/Perplexity, qui s'appuient sur ces crawlers.
 */

const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "Claude-SearchBot",
  "anthropic-ai",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "meta-externalagent",
  "CCBot",
  "Amazonbot",
  "Bytespider",
  "PetalBot",
  "Diffbot",
  "YouBot",
  "cohere-ai",
];

const DISALLOWED_FOR_BOTS = ["/api/", "/admin", "/developer", "/team", "/billing", "/storage", "/client"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      ...AI_CRAWLERS.map((userAgent) => ({
        userAgent,
        allow: "/",
        disallow: DISALLOWED_FOR_BOTS,
      })),
      {
        userAgent: "*",
        allow: "/",
        disallow: DISALLOWED_FOR_BOTS,
      },
    ],
    sitemap: "https://gen3ia.online/sitemap.xml",
    host: "https://gen3ia.online",
  };
}

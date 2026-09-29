import type { MetadataRoute } from "next";

/**
 * Sitemap XML — indexation classique (Google/Bing) ET générative :
 * les moteurs de réponse citent d'autant mieux les pages qu'ils les
 * connaissent. Priorités calibrées sur les pages publiques réelles.
 *
 * La page d'accueil porte les alternates hreflang fr/en (réciproques avec
 * /en) : les moteurs proposent la bonne langue dans les résultats — et les
 * LLM associent chaque version linguistique à sa surface canonique.
 */

const BASE = "https://gen3ia.online";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    {
      url: `${BASE}/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
      alternates: { languages: { fr: `${BASE}/`, en: `${BASE}/en` } },
    },
    {
      url: `${BASE}/en`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.9,
      alternates: { languages: { fr: `${BASE}/`, en: `${BASE}/en` } },
    },
    {
      url: `${BASE}/faq`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.9,
    },
    {
      url: `${BASE}/studio`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${BASE}/live`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${BASE}/marketplace`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${BASE}/integrations`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${BASE}/studio/interface-lab`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE}/signup`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${BASE}/login`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.4,
    },
    {
      url: `${BASE}/privacy`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}

import type { MetadataRoute } from "next";

/**
 * Sitemap XML — indexation classique (Google/Bing) ET génerative :
 * les moteurs de réponse citent d'autant mieux les pages qu'ils les
 * connaissent. Priorités calibrées sur les pages publiques réelles.
 */

const BASE = "https://gen3ia.online";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${BASE}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/studio`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${BASE}/live`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/marketplace`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/studio/interface-lab`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${BASE}/studio/schedules`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${BASE}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}

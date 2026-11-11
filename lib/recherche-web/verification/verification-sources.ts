/* ------------------------------------------------------------------ */
/* VÉRIFICATION DES SOURCES — dates et crédibilité                     */
/* ------------------------------------------------------------------ */
/* Deux vérifications demandées par l'architecture propriétaire :       */
/*   1. DATES : une date de publication annoncée est VALIDÉE (format    */
/*      parsable, pas dans le futur, pas antérieure à 1990) ; une date  */
/*      absurde est retirée plutôt que propagée à la synthèse.          */
/*   2. SOURCES : crédibilité de domaine par liste triée — référence    */
/*      encyclopédique/institutionnelle = élevée, presse établie =      */
/*      moyenne, inconnu = inconnue. Aucun blocage : la crédibilité     */
/*      pondère le score, elle ne censure pas.                          */

/** Parse une date annoncée par un moteur ou une page et la valide.
 *  Retourne undefined si le format est inconnu ou la date absurde. */
export function validerDatePublication(brute?: string, maintenant = new Date()): string | undefined {
  if (!brute) return undefined;
  const nettoye = brute.trim();
  if (!nettoye) return undefined;
  const date = new Date(nettoye);
  if (Number.isNaN(date.getTime())) return undefined;
  // Pas dans le futur (tolérance 24 h pour les fuseaux décalés)…
  if (date.getTime() > maintenant.getTime() + 86_400_000) return undefined;
  // …ni antérieure à 1995 (le web n'existait pas : signal d'erreur de parse).
  if (date.getFullYear() < 1995) return undefined;
  return date.toISOString();
}

const DOMAINES_CREDIBILITE_ELEVEE = [
  "wikipedia.org",
  "who.int", "unesco.org", "un.org", "banquemondiale.org", "worldbank.org",
  "gouvernement.fr", "legifrance.gouv.fr", "service-public.fr", "insee.fr",
  "opensky.gov", "nasa.gov", "esa.int", "europa.eu",
  "nature.com", "science.org", "sciencedirect.com", "springer.com", "arxiv.org",
  "ieee.org", "acm.org", "cambridge.org", "oxfordacademic.com",
];

const DOMAINES_CREDIBILITE_MOYENNE = [
  "lemonde.fr", "lefigaro.fr", "liberation.fr", "france24.com", "rfi.fr",
  "lepoint.fr", "nouvelobs.com", "lexpress.fr", "lesoir.be", "letemps.ch",
  "bbc.com", "bbc.co.uk", "nytimes.com", "theguardian.com", "washingtonpost.com",
  "reuters.com", "apnews.com", "afp.com", "wsj.com", "ft.com",
  "bfmtv.com", "francetvinfo.fr", "euronews.com", "cnbc.com", "bloomberg.com",
  "techcrunch.com", "wired.com", "theverge.com", "arstechnica.com",
  "github.com", "developer.mozilla.org", "stackoverflow.com", "nextjs.org", "reactjs.org",
];

/** Crédibilité d'une source par son domaine : « elevée » (institution,
 *  encyclopédie, revue scientifique), « moyenne » (presse/tech établie),
 *  « inconnue » (le reste — ne pénalise pas fort, ne censure pas). */
export function credibiliteDomaine(url: string): "elevée" | "moyenne" | "inconnue" {
  try {
    const hote = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (DOMAINES_CREDIBILITE_ELEVEE.some((d) => hote === d || hote.endsWith(`.${d}`))) return "elevée";
    if (DOMAINES_CREDIBILITE_MOYENNE.some((d) => hote === d || hote.endsWith(`.${d}`))) return "moyenne";
    return "inconnue";
  } catch {
    return "inconnue";
  }
}

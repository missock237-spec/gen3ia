/**
 * Vérifications CSP / URL pour les sondes de production — comparaisons par
 * TOKEN EXACT (Task 57, fermeture des alertes CodeQL
 * js/incomplete-url-substring-sanitization).
 *
 * Historique : les sondes testaient des hôtes avec `String.includes()`. Une
 * sous-chaîne accepte des valeurs piégées : une CSP autorisant
 * `evil-doublecheck.net.attacker.io` faisait passer `includes("doubleclick.net")`,
 * et une popup `evil-accounts.google.com.x.io` faisait passer
 * `includes("accounts.google.com")`. Les helpers comparent désormais des
 * tokens ENTIERS : directive CSP découpée sur espaces/points-virgules, hôte
 * URL comparé exactement (ou sous-domaine délimité par point).
 */

/**
 * Vrai si `token` apparaît comme source EXACTE dans une directive CSP quelconque
 * (tokens = découpage espaces ; `token` doit inclure ses guillemets le cas échéant).
 */
export function cspHasToken(csp, token) {
  if (typeof csp !== "string" || !token) return false;
  return csp.split(";").some((raw) => raw.trim().split(/\s+/).includes(token));
}

/**
 * Vrai si `directive` autorise `source` (égalité de token, ou variantes
 * `https://source` / `*.source` / `https://*.source` — jamais une sous-chaîne).
 */
export function cspAuthorizes(csp, directive, source) {
  if (typeof csp !== "string" || !directive || !source) return false;
  return csp.split(";").some((raw) => {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts[0].toLowerCase() !== directive.toLowerCase()) return false;
    return sourceTokens(source).some((variant) => parts.slice(1).includes(variant));
  });
}

/** Variantes de token acceptées pour une source hôte (schéma et wildcard). */
function sourceTokens(source) {
  return [source, `https://${source}`, `*.${source}`, `https://*.${source}`];
}

/**
 * Vrai si N'IMPORTE QUELLE directive autorise `source` (variantes ci-dessus).
 * Usage : vérifier qu'un hôte est autorisé sans coupler la sonde à la
 * directive exacte choisie par la production.
 */
export function cspAuthorizesAny(csp, source) {
  if (typeof csp !== "string" || !source) return false;
  const variants = sourceTokens(source);
  return csp.split(";").some((raw) => {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    return variants.some((variant) => parts.slice(1).includes(variant));
  });
}

/** Vrai si l'URL a EXACTEMENT `host` pour hostname (sous-domaine délimité par point accepté). */
export function urlHasHost(url, host) {
  if (typeof url !== "string" || !host) return false;
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return hostname === host || hostname.endsWith(`.${host}`);
}

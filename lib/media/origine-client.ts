import "server-only";

import { isAllowedJobHost, resolveJobOrigin } from "@/lib/queue/origin";

/**
 * ORIGINE CLIENT RÉSOLUE PAR LA ROUTE — l'hôte RÉELLEMENT navigué par
 * l'utilisateur (cookie de session host-only).
 *
 * CONSTAT PRODUCTION (sonde 2026-11-12, commit 0c88ec19 déployé) : derrière
 * nginx, `request.nextUrl.origin` vaut « https://localhost:3000 » (Host du
 * proxy_pass, proto de X-Forwarded-Proto) — les liens médias durables des
 * messages persistés pointaient vers localhost : pour l'utilisateur, l'audio
 * et la vidéo « ne sont pas réellement créés et envoyés » alors que l'objet
 * R2 existe. Le repli canonique (GEN3IA_APP_ORIGIN = apex) est LUI AUSSI
 * faux pour une session www : le cookie est host-only, le lien apex rend
 * 401. La SEULE origine jouable est celle que le navigateur de l'utilisateur
 * navigue réellement.
 *
 * SIGNAUX (ordre de confiance décroissante, TOUS validés par l'allowlist) :
 *  1. X-Forwarded-Host (+ X-Forwarded-Proto) — posés par le proxy inverse :
 *     le seul signal SERVEUR qui connaît l'hôte public réellement navigué ;
 *  2. Referer — posé par le navigateur de l'utilisateur : une entrée cliente,
 *     mais son SEUL usage ici est choisir l'origine d'un LIEN renvoyé À CE
 *     MÊME client (aucune destination réseau n'en dérive — zéro SSRF) ;
 *  3. request.nextUrl.origin — l'origine vue du serveur (fausse derrière un
 *     proxy qui réécrit le Host) ;
 *  4. origine canonique GEN3IA_APP_ORIGIN (resolveJobOrigin, allowlist).
 *
 * Garde ANTI-FALSIFICATION : chaque candidat est validé (https hors dev
 * local, hôte dans l'allowlist du dépôt, chemin anti-« // ») ; en production
 * les hôtes LOCAUX sont toujours rejetés — jamais de lien localhost dans un
 * message persisté. Aucun candidat valide → undefined : l'appelant garde son
 * repli (URL présignée d'origine), jamais de lien mort silencieux.
 */

/** Hôtes locaux de développement — http toléré uniquement hors production. */
const HOTES_LOCALS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function estHoteLocal(hote: string): boolean {
  return HOTES_LOCALS.has(hote.toLowerCase());
}

/** Production réelle (build Next standalone / PM2) : aucune origine locale
 *  n'est l'origine naviguée — c'est l'artefact d'un proxy interne. */
function estProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Valide un candidat d'origine et renvoie sa forme canonique (schéma+hôte),
 *  ou null. `tolererLocal` est FAUX en production. */
function validerOrigine(candidat: string, tolererLocal: boolean): string | null {
  const brut = candidat.trim();
  if (!brut || brut.length > 200) return null;
  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    return null;
  }
  const hote = url.hostname.toLowerCase();
  const httpsOuLocal =
    url.protocol === "https:" || (url.protocol === "http:" && estHoteLocal(hote));
  if (!httpsOuLocal) return null;
  if (!isAllowedJobHost(hote)) return null;
  if (estHoteLocal(hote) && !tolererLocal) return null;
  if (url.pathname.startsWith("//")) return null; // anti-falsification « protocol-relative »
  return url.origin;
}

/** Première valeur d'un en-tête multi-valeurs (« a, b » → « a »), sans vide. */
function premiereValeur(enTete: string | null): string | null {
  const premiere = enTete?.split(",")[0]?.trim();
  return premiere ? premiere : null;
}

/**
 * Origine RÉELLEMENT naviguée par l'utilisateur, résolue PAR LA ROUTE depuis
 * la requête (jamais un champ de corps client). `undefined` si aucun signal
 * valide — l'appelant garde son repli d'origine.
 */
export function resolveOrigineClient(request: {
  headers: Headers;
  nextUrl?: { origin?: string };
}): string | undefined {
  const tolererLocal = !estProduction();

  // 1) X-Forwarded-Host / X-Forwarded-Proto — signal du proxy de confiance.
  const hoteTransfere = premiereValeur(request.headers.get("x-forwarded-host"));
  if (hoteTransfere) {
    const protoTransfere = premiereValeur(request.headers.get("x-forwarded-proto")) ?? "https";
    const origine = validerOrigine(`${protoTransfere}://${hoteTransfere}`, tolererLocal);
    if (origine) return origine;
  }

  // 2) Referer — le navigateur de l'utilisateur (usage lien uniquement).
  const referer = request.headers.get("referer");
  if (referer) {
    const origine = validerOrigine(referer, tolererLocal);
    if (origine) return origine;
  }

  // 3) Origine vue du serveur (nextUrl) — correcte hors proxy réécrivain.
  const origineRequete = request.nextUrl?.origin;
  if (origineRequete) {
    const origine = validerOrigine(origineRequete, tolererLocal);
    if (origine) return origine;
  }

  // 4) Origine canonique du serveur (env — allowlist).
  const canonique = resolveJobOrigin();
  return canonique.ok ? canonique.origin : undefined;
}

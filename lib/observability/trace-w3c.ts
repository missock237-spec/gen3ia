/**
 * CONTEXTE DE TRACE W3C (Task K — Tracing distribué) — module 100 % PUR.
 *
 * SANS dépendance, SANS « server-only » : importable depuis le middleware
 * (qui doit rester exécutable au runtime Edge comme au runtime Node) ET
 * depuis les modules serveur node (service-identity, logger, otel).
 * Toute la logique est un parse par regex + arithmétique BigInt : aucune
 * API plateforme au-delà de Web Crypto (getRandomValues, disponible nativement
 * dans les deux runtimes).
 *
 * Norme : W3C Trace Context — https://www.w3.org/TR/trace-context/
 *   traceparent = « 00-<trace-id>-<parent-id>-<trace-flags> »
 *     trace-id     : 32 hexadécimales minuscules, PAS tous zéros
 *     parent-id    : 16 hexadécimales minuscules, PAS tous zéros
 *     trace-flags  : 2 hexadécimales (bit 0 = échantillonné)
 *     version      : 2 hexadécimales, « ff » interdit
 *
 * CORRÉLATION AVEC LE TRACE-ID GEN3IA :
 *   l'en-tête custom x-gen3ia-trace-id (audit 25-a) reste la clé primaire.
 *   Un trace-id W3C fait toujours un traceId Gen3ia valide (32 hex ⊂
 *   [a-zA-Z0-9_-]{8,64}) — l'inverse non (ex. « trc_<uuid> » n'est pas du
 *   hex). La dérivation w3cTraceIdDepuisGen3ia() est donc DÉTERMINISTE :
 *   le même traceId Gen3ia propagé sur plusieurs requêtes inter-services
 *   produit le MÊME trace-id W3C — la trace reste un seul arbre côté
 *   collecteur. La bijection (documentée dans docs/sre/tracing.md) permet
 *   de relier un trace-id W3C à son identifiant Gen3ia et réciproquement.
 */

/** En-tête standard W3C (Trace Context). */
export const TRACEPARENT_HEADER = "traceparent";

/** En-tête custom Gen3ia (audit 25-a) — la clé primaire de corrélation. */
export const GEN3IA_TRACE_HEADER = "x-gen3ia-trace-id";

/** Grammaire d'un traceId Gen3ia sain (anti-injection de logs) — même
 *  grammaire que middleware.ts et lib/observability/logger.ts. */
export const GEN3IA_TRACE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

const W3C_TRACE_ID_RE = /^[0-9a-f]{32}$/;
const W3C_SPAN_ID_RE = /^[0-9a-f]{16}$/;
const W3C_FLAGS_RE = /^[0-9a-f]{2}$/;

/** Version « ff » : tout le paquet est interdit par la spécification. */
const VERSION_INTERDITE = "ff";

/** Traceparent validé et décomposé (tout en minuscules). */
export interface TraceparentW3C {
  traceId: string;
  spanId: string;
  flags: string;
}

/** Un traceId Gen3ia est-il sain (réutilisable sans risque de log) ? */
export function estTraceIdGen3iaValide(valeur: string | null | undefined): boolean {
  return Boolean(valeur && GEN3IA_TRACE_ID_RE.test(valeur));
}

/**
 * Décompose et valide un en-tête traceparent ENTRANT. Tolérant : majuscules
 * acceptées (normalisées en minuscules), version > 00 acceptée SI le format
 * reste à 4 champs (compatibilité ascendante W3C) ; tout le reste est ignoré
 * (retour undefined) — jamais d'exception.
 */
export function parserTraceparent(valeur: string | null | undefined): TraceparentW3C | undefined {
  if (!valeur) return undefined;
  const parties = valeur.trim().toLowerCase().split("-");
  if (parties.length !== 4) return undefined;
  const [version, traceId, spanId, flags] = parties;
  if (!/^[0-9a-f]{2}$/.test(version) || version === VERSION_INTERDITE) return undefined;
  if (!W3C_TRACE_ID_RE.test(traceId) || /^0+$/.test(traceId)) return undefined;
  if (!W3C_SPAN_ID_RE.test(spanId) || /^0+$/.test(spanId)) return undefined;
  if (!W3C_FLAGS_RE.test(flags)) return undefined;
  return { traceId, spanId, flags };
}

/** traceId Gen3ia candidat depuis un traceparent entrant (sain uniquement). */
export function traceIdGen3iaDepuisTraceparent(valeur: string | null | undefined): string | undefined {
  return parserTraceparent(valeur)?.traceId;
}

/** Nouveau span-id par requête — Web Crypto natif (Edge ET Node ≥ 19). */
export function genererSpanIdW3C(): string {
  const octets = new Uint8Array(8);
  crypto.getRandomValues(octets);
  let hex = "";
  for (const octet of octets) hex += octet.toString(16).padStart(2, "0");
  return hex;
}

/* ------------------------------------------------------------------ */
/* Dérivation déterministe traceId Gen3ia → trace-id W3C                */
/* ------------------------------------------------------------------ */

const FNV_PREMIER_64 = 0x100000001b3n;
const MASQUE_64 = 0xffffffffffffffffn;
/** Graine 1 : basis offset FNV-1a 64 standard. */
const GRAINE_1 = 0xcbf29ce484222325n;
/** Graine 2 : constante de diffusion (fraction dorée, splitmix64). */
const GRAINE_2 = 0x9e3779b97f4a7c15n;

/** FNV-1a 64 bits (BigInt pur — AUCUNE dépendance node ni hash externe). */
function fnv1a64(graine: bigint, entree: string): string {
  let hachage = graine;
  for (let i = 0; i < entree.length; i++) {
    hachage ^= BigInt(entree.charCodeAt(i) & 0xff);
    hachage = (hachage * FNV_PREMIER_64) & MASQUE_64;
  }
  return hachage.toString(16).padStart(16, "0");
}

/**
 * Trace-id W3C associé à un traceId Gen3ia :
 *   - déjà 32 hexadécimales minuscules → utilisé tel quel (identité) ;
 *   - sinon → FNV-1a 128 bits déterministe (deux passes 64 bits, graines
 *     distinctes). Déterministe = propagation inter-services cohérente
 *     (le même traceId Gen3ia donne le même arbre W3C chez le collecteur).
 */
export function w3cTraceIdDepuisGen3ia(traceId: string): string {
  if (W3C_TRACE_ID_RE.test(traceId)) return traceId;
  const moitie1 = fnv1a64(GRAINE_1, traceId);
  const moitie2 = fnv1a64(GRAINE_2, `gen3ia\x1f${traceId}`);
  const compose = `${moitie1}${moitie2}`;
  // Garde-fou théorique (probabilité ~0) : « tous zéros » est interdit.
  return /^0+$/.test(compose) ? `${compose.slice(0, 31)}1` : compose;
}

/**
 * Formate un en-tête traceparent SORTANT valide pour un traceId Gen3ia :
 * « 00-<trace-id dérivé>-<nouveau span-id>-<flags> ». Le span-id est NOUVEAU
 * par défaut (chaque saut = un span distinct du même arbre) ; les flags
 * entrants peuvent être préservés via options.flags (défaut « 01 » =
 * échantillonné).
 */
export function formaterTraceparent(
  traceIdGen3ia: string,
  options: { spanId?: string; flags?: string } = {},
): string {
  const traceId = w3cTraceIdDepuisGen3ia(traceIdGen3ia);
  const spanId = options.spanId && W3C_SPAN_ID_RE.test(options.spanId) ? options.spanId : genererSpanIdW3C();
  const flags = options.flags && W3C_FLAGS_RE.test(options.flags) ? options.flags : "01";
  return `00-${traceId}-${spanId}-${flags}`;
}

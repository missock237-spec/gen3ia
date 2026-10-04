import "server-only";

/**
 * Garde-quota Firestore — disjoncteur process-local (Task 95-b).
 *
 * Quand Firestore renvoie une erreur de quota (RESOURCE_EXHAUSTED / 429 /
 * quota quotidien gratuit épuisé), chaque appel qui insiste coûte du débit
 * et du temps serverless. Ce module centralise :
 *
 *   1. la DÉTECTION robuste des erreurs de quota (et des incidents
 *      transitoires qui ne doivent PAS ouvrir le disjoncteur) ;
 *   2. un DISJONCTEUR à trois états (closed / open / half-open) : après
 *      QUOTA_BREAKER_OPEN_THRESHOLD erreurs consécutives, les appels
 *      Firestore sont court-circuités vers le repli Supabase pendant un
 *      cooldown (90 s quota logiciel, 10 min quota quotidien) ; une sonde
 *      unique est ensuite autorisée pour refermer le circuit.
 *
 * Contrat : AUCUNE I/O, état 100 % process-local (Node mono-thread, champs
 * simples), horloge Date.now() brute (compatible vi.useFakeTimers).
 * Les files vidéo (lib/video) et firestore-fallback codent contre ces
 * exports exacts — l'API est gelée.
 */

export type QuotaGuardState = "closed" | "open" | "half-open";

export interface QuotaGuardStats {
  state: QuotaGuardState;
  consecutiveQuotaErrors: number;
  /** Instant d'ouverture du disjoncteur (ISO 8601), null si fermé. */
  openedAt: string | null;
  lastQuotaErrorAt: string | null;
  /** Message de la dernière erreur de quota, tronqué à 300 caractères. */
  lastQuotaError: string | null;
  /** Appels Firestore évités pendant l'ouverture (compteur de vie du process). */
  shortCircuits: number;
  /** true = quota QUOTIDIEN détecté (cooldown long), sinon quota logiciel. */
  hardQuota: boolean;
  cooldownEndsAt: string | null;
}

/** Erreurs consécutives nécessaires pour ouvrir le disjoncteur. */
export const QUOTA_BREAKER_OPEN_THRESHOLD = 3;
/** Cooldown après un quota "logiciel" (rate limit court). */
export const QUOTA_COOLDOWN_SOFT_MS = 90_000;
/** Cooldown après un quota QUOTIDIEN épuisé (inutile d'insister avant 10 min). */
export const QUOTA_COOLDOWN_HARD_MS = 600_000;

// ---------------------------------------------------------------------------
// Collecte des faits d'erreur (robuste : code nombre ou chaîne, cause en
// chaîne, objets non-Error, messages REST ou gRPC)
// ---------------------------------------------------------------------------

/** Profondeur maximale de descente dans la chaîne error.cause. */
const MAX_CAUSE_DEPTH = 5;

interface ErrorFacts {
  /** Codes normalisés : majuscules, tirets → underscores ("8", "429", "RESOURCE_EXHAUSTED"…). */
  codes: string[];
  /** Messages en minuscules (chaîne d'erreur brute incluse). */
  messages: string[];
}

function normalizeCode(code: unknown): string {
  return String(code)
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");
}

function collectErrorFacts(error: unknown): ErrorFacts {
  const codes: string[] = [];
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && current !== undefined; depth += 1) {
    if (typeof current === "string") {
      messages.push(current.toLowerCase());
      break; // une chaîne n'a pas de cause enfouie
    }
    if (typeof current !== "object") break;
    const candidate = current as Record<string, unknown>;
    if (candidate.code !== undefined && candidate.code !== null) {
      codes.push(normalizeCode(candidate.code));
    }
    if (candidate.status !== undefined && candidate.status !== null) {
      codes.push(normalizeCode(candidate.status));
    }
    if (typeof candidate.message === "string" && candidate.message.trim()) {
      messages.push(candidate.message.toLowerCase());
    }
    current = candidate.cause;
  }
  return { codes, messages };
}

// ---------------------------------------------------------------------------
// Détection QUOTA
// ---------------------------------------------------------------------------

/** gRPC 8 = RESOURCE_EXHAUSTED ; 429 = HTTP Too Many Requests. */
const QUOTA_CODES = new Set(["8", "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED", "429"]);

const QUOTA_MESSAGE_NEEDLES = [
  "quota",
  "resource_exhausted",
  "free daily read units",
  "too many requests",
  "rate limit",
  "exhausted",
];

/** "per day"/"daily" combinés à un mot de pression = quota quotidien. */
function messageSignalsDailyLimit(message: string): boolean {
  const daily = message.includes("per day") || message.includes("daily");
  const pressure =
    message.includes("limit") ||
    message.includes("exceeded") ||
    message.includes("pressure") ||
    message.includes("exhaust") ||
    message.includes("quota");
  return daily && pressure;
}

/**
 * L'erreur est-elle une erreur de QUOTA Firestore ? Robuste au code nombre
 * ou chaîne (gRPC 8 vs REST "8"), aux causes imbriquées et aux objets non-Error.
 * Ne matche JAMAIS les erreurs métier ("permission denied", "not found", …).
 */
export function isFirestoreQuotaError(error: unknown): boolean {
  const { codes, messages } = collectErrorFacts(error);
  if (codes.some((code) => QUOTA_CODES.has(code))) return true;
  return messages.some(
    (message) =>
      QUOTA_MESSAGE_NEEDLES.some((needle) => message.includes(needle)) || messageSignalsDailyLimit(message),
  );
}

// ---------------------------------------------------------------------------
// Détection TRANSITOIRE (PAS quota : n'ouvre pas le disjoncteur)
// ---------------------------------------------------------------------------

/** gRPC 14 = UNAVAILABLE, 4 = DEADLINE_EXCEEDED ; 500/503 côté REST. */
const TRANSIENT_CODES = new Set([
  "14",
  "4",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "500",
  "503",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
]);

const TRANSIENT_MESSAGE_NEEDLES = [
  "unavailable",
  "deadline exceeded",
  "etimedout",
  "econnreset",
  "econnrefused",
  "internal error",
  "backend error",
];

/**
 * Incident transitoire (indisponibilité, timeout, réseau) : ce n'est PAS un
 * quota — le disjoncteur ne doit pas bouger, les files vidéo gèrent ces
 * erreurs via leur propre budget de retry.
 */
export function isFirestoreTransientError(error: unknown): boolean {
  const { codes, messages } = collectErrorFacts(error);
  if (codes.some((code) => TRANSIENT_CODES.has(code))) return true;
  return messages.some((message) => TRANSIENT_MESSAGE_NEEDLES.some((needle) => message.includes(needle)));
}

// ---------------------------------------------------------------------------
// Quota quotidien (cooldown long) — interne
// ---------------------------------------------------------------------------

const DAILY_QUOTA_NEEDLES = ["free daily", "per day", "daily limit"];

function looksLikeDailyQuotaError(error: unknown): boolean {
  const { messages } = collectErrorFacts(error);
  return messages.some((message) => DAILY_QUOTA_NEEDLES.some((needle) => message.includes(needle)));
}

// ---------------------------------------------------------------------------
// Disjoncteur (état process-local)
// ---------------------------------------------------------------------------

let breakerState: QuotaGuardState = "closed";
let consecutiveQuotaErrors = 0;
let openedAtMs: number | null = null;
let lastQuotaErrorAtMs: number | null = null;
let lastQuotaErrorMessage: string | null = null;
let shortCircuits = 0;
let hardQuota = false;
let cooldownEndsAtMs: number | null = null;
/** Sonde half-open consommée et pas encore résolue (succès/échec). */
let probeInFlight = false;

/** État dérivé paresseusement : open + cooldown écoulé se lit half-open. */
function currentState(): QuotaGuardState {
  if (breakerState === "open" && cooldownEndsAtMs !== null && Date.now() >= cooldownEndsAtMs) {
    return "half-open";
  }
  return breakerState;
}

function extractErrorMessage(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && current !== undefined; depth += 1) {
    if (typeof current === "string") return current;
    if (typeof current !== "object") break;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
    current = (current as { cause?: unknown }).cause;
  }
  return String(error);
}

function openBreaker(error: unknown): void {
  hardQuota = looksLikeDailyQuotaError(error);
  const now = Date.now();
  openedAtMs = now;
  cooldownEndsAtMs = now + (hardQuota ? QUOTA_COOLDOWN_HARD_MS : QUOTA_COOLDOWN_SOFT_MS);
  breakerState = "open";
}

/**
 * Enregistre une erreur de quota Firestore remontée par un appel réel.
 * - disjoncteur fermé : compte l'erreur ; au seuil → OUVERT (cooldown) ;
 * - déjà ouvert : rafraîchit le cooldown (erreur concurrente / sonde ratée) ;
 * - half-open (sonde échouée) : retour à OUVERT avec cooldown FRAIS, le
 *   compteur shortCircuits est préservé.
 */
export function noteFirestoreQuotaError(error: unknown): void {
  consecutiveQuotaErrors += 1;
  lastQuotaErrorAtMs = Date.now();
  lastQuotaErrorMessage = extractErrorMessage(error).slice(0, 300);
  const wasHalfOpen = currentState() === "half-open";
  if (wasHalfOpen) probeInFlight = false;
  const mustOpen =
    breakerState === "open" || wasHalfOpen || consecutiveQuotaErrors >= QUOTA_BREAKER_OPEN_THRESHOLD;
  if (!mustOpen) return;
  openBreaker(error);
}

/**
 * Un appel Firestore réel a RÉUSSI (ou la lecture a répondu, même "absent") :
 * le circuit se referme, les compteurs d'erreurs repartent de zéro.
 */
export function noteFirestoreSuccess(): void {
  breakerState = "closed";
  consecutiveQuotaErrors = 0;
  hardQuota = false;
  openedAtMs = null;
  cooldownEndsAtMs = null;
  probeInFlight = false;
}

/**
 * Faut-il éviter Firestore ? true en état ouvert ET mi-ouvert (l'appelant
 * combine avec beginFirestoreProbe() : `shouldShortCircuitFirestore() &&
 * !beginFirestoreProbe()` → basculer sur le repli). Chaque réponse "true"
 * qui va effectivement court-circuiter un appel incrémente shortCircuits.
 */
export function shouldShortCircuitFirestore(): boolean {
  const state = currentState();
  if (state === "closed") return false;
  // Mi-ouvert avec sonde disponible : l'appelant va TENTER Firestore via la
  // sonde — ce n'est pas un appel évité, on ne compte pas.
  if (state === "half-open" && !probeInFlight) return true;
  shortCircuits += 1;
  return true;
}

/**
 * Consomme l'unique sonde half-open : true exactement UNE FOIS après
 * l'expiration du cooldown. L'appelant tente alors un vrai appel Firestore :
 * succès → noteFirestoreSuccess() (circuit refermé) ; nouvelle erreur de
 * quota → noteFirestoreQuotaError() (retour à ouvert, cooldown frais).
 * Si l'appelant ne rapporte jamais l'issue, la sonde reste consommée et les
 * appels restent court-circuités (fail-safe vers le repli Supabase).
 */
export function beginFirestoreProbe(): boolean {
  if (currentState() !== "half-open") return false;
  if (probeInFlight) return false;
  probeInFlight = true;
  return true;
}

/** Instantané des statistiques (consommé par GET /api/health/infra). */
export function getQuotaGuardStats(): QuotaGuardStats {
  return {
    state: currentState(),
    consecutiveQuotaErrors,
    openedAt: openedAtMs === null ? null : new Date(openedAtMs).toISOString(),
    lastQuotaErrorAt: lastQuotaErrorAtMs === null ? null : new Date(lastQuotaErrorAtMs).toISOString(),
    lastQuotaError: lastQuotaErrorMessage,
    shortCircuits,
    hardQuota,
    cooldownEndsAt: cooldownEndsAtMs === null ? null : new Date(cooldownEndsAtMs).toISOString(),
  };
}

/** Réinitialise intégralement l'état (tests uniquement). */
export function resetQuotaGuardForTests(): void {
  breakerState = "closed";
  consecutiveQuotaErrors = 0;
  openedAtMs = null;
  lastQuotaErrorAtMs = null;
  lastQuotaErrorMessage = null;
  shortCircuits = 0;
  hardQuota = false;
  cooldownEndsAtMs = null;
  probeInFlight = false;
}

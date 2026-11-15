/**
 * Hiérarchie d'erreurs du SDK Gen3ia.
 *
 * Trois familles, à traiter distinctement par l'intégrateur :
 *  - Gen3iaConfigurationError : le SDK est mal configuré (clé manquante…) —
 *    toujours un bug d'intégration, à corriger avant tout appel ;
 *  - Gen3iaApiError : le serveur a répondu une erreur HTTP structurée —
 *    status, requestId (support Gen3ia), issues (validation zod) et
 *    retryAfterMs (429) exploitables ;
 *  - Gen3iaNetworkError : la requête n'a pas atteint le serveur — réseau,
 *    DNS, timeout. Seuls les GET sont retentés automatiquement (jamais un
 *    POST : ré-exécuter une mission facturée doublerait la facture).
 */

/** Classe de base — permet `catch (e) { if (e instanceof Gen3iaError) … }`. */
export class Gen3iaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Gen3iaError";
  }
}

/** Le SDK est mal configuré pour l'appel demandé (auth absente, etc.). */
export class Gen3iaConfigurationError extends Gen3iaError {
  constructor(message: string) {
    super(message);
    this.name = "Gen3iaConfigurationError";
  }
}

/** Erreur HTTP structurée renvoyée par l'API Gen3ia. */
export class Gen3iaApiError extends Gen3iaError {
  readonly status: number;
  /** Identifiant de corrélation serveur (en-tête x-request-id) — à joindre à tout ticket. */
  readonly requestId?: string;
  /** Détail de validation (flatten zod) présent sur les 400. */
  readonly issues?: unknown;
  /** Millisecondes suggérées avant nouvel essai (en-tête retry-after des 429). */
  readonly retryAfterMs?: number;

  constructor(message: string, options: { status: number; requestId?: string; issues?: unknown; retryAfterMs?: number }) {
    super(message);
    this.name = "Gen3iaApiError";
    this.status = options.status;
    this.requestId = options.requestId;
    this.issues = options.issues;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** La requête n'a pas atteint le serveur (réseau, DNS, timeout). */
export class Gen3iaNetworkError extends Gen3iaError {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "Gen3iaNetworkError";
    this.cause = options?.cause;
  }
}

/** Le suivi d'une mission a dépassé le délai imparti (waitFor). */
export class Gen3iaTimeoutError extends Gen3iaError {
  constructor(message: string) {
    super(message);
    this.name = "Gen3iaTimeoutError";
  }
}

/**
 * Extrait un message lisible du champ `error` d'une réponse API. Le serveur
 * renvoie soit une chaîne, soit un objet flatten zod { formErrors, fieldErrors }.
 */
export function messageFromErrorBody(errorBody: unknown, fallback: string): string {
  if (typeof errorBody === "string" && errorBody.trim()) return errorBody;
  if (errorBody && typeof errorBody === "object") {
    const formErrors = (errorBody as { formErrors?: unknown }).formErrors;
    if (Array.isArray(formErrors) && formErrors.length > 0) {
      return formErrors.filter((m) => typeof m === "string").join(", ") || fallback;
    }
  }
  return fallback;
}

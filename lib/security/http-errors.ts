/**
 * Erreurs HTTP typées pour les routes API.
 *
 * Objectif robustesse : une route ne doit plus deviner le statut d'une erreur
 * à partir du message (`.includes("auth")`) — les erreurs d'authentification
 * doivent renvoyer 401, les erreurs d'infrastructure (Firestore indisponible,
 * provider LLM en panne) 503, et le reste 500. Sinon l'UI traite une panne
 * backend comme une déconnexion (ou l'inverse) et l'utilisateur est perdu.
 *
 * Convention API (contract-first) : chaque réponse d'erreur transporte un
 * CODE machine lisible (`AUTH_REQUIRED`, `PROVIDER_UNAVAILABLE`…) en plus du
 * message humain — `{ error: "...", code: "AUTH_REQUIRED" }`. Le champ
 * `error` reste une chaîne pour ne pas casser l'UI existante qui le lit.
 */

export type ApiErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "PROVIDER_UNAVAILABLE"
  | "CONFLICT"
  | "INTERNAL";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, message: string, code?: ApiErrorCode) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code ?? defaultCodeFor(status);
  }
}

function defaultCodeFor(status: number): ApiErrorCode {
  switch (status) {
    case 400: return "INVALID_REQUEST";
    case 401: return "AUTH_REQUIRED";
    case 402: return "QUOTA_EXCEEDED";
    case 403: return "FORBIDDEN";
    case 404: return "NOT_FOUND";
    case 409: return "CONFLICT";
    case 429: return "RATE_LIMITED";
    case 503: return "PROVIDER_UNAVAILABLE";
    default: return "INTERNAL";
  }
}

export function unauthorized(message = "Authentification requise : jeton manquant ou session expirée."): HttpError {
  return new HttpError(401, message, "AUTH_REQUIRED");
}

export function serviceUnavailable(message = "Service momentanément indisponible. Réessayez dans un instant."): HttpError {
  return new HttpError(503, message, "PROVIDER_UNAVAILABLE");
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message, "INVALID_REQUEST");
}

export function notFound(message = "Ressource introuvable."): HttpError {
  return new HttpError(404, message, "NOT_FOUND");
}

export function forbidden(message = "Accès refusé."): HttpError {
  return new HttpError(403, message, "FORBIDDEN");
}

const AUTH_MESSAGE_RE =
  /missing authorization|authentification requise|authentication required|unauthorized|jeton invalide|invalid[_ ]token|token expired|pas de session/i;
const DEGRADED_MESSAGE_RE =
  /failed precondition|unavailable|firestore|deadline exceeded|quota exceeded|resource.exhausted|backend error|service.*(indisponible|unavailable)/i;

/**
 * Détermine le statut HTTP d'une erreur attrapée dans une route :
 * 1. HttpError -> son statut ;
 * 2. message d'authentification -> 401 (compatibilité avec les messages
 *    historiques "Missing Authorization header") ;
 * 3. panne d'infrastructure connue -> 503 (l'UI sait alors qu'il faut
 *    réessayer, pas se reconnecter) ;
 * 4. sinon -> le statut de repli fourni (500 par défaut).
 */
export function errorStatus(error: unknown, fallback = 500): number {
  if (error instanceof HttpError) return error.status;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (AUTH_MESSAGE_RE.test(message)) return 401;
  if (DEGRADED_MESSAGE_RE.test(message)) return 503;
  return fallback;
}

/**
 * Code d'erreur machine associé à une exception attrapée : même logique de
 * classification que `errorStatus`, garantie de cohérence statut <-> code.
 */
export function errorCode(error: unknown): ApiErrorCode {
  if (error instanceof HttpError) return error.code;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (AUTH_MESSAGE_RE.test(message)) return "AUTH_REQUIRED";
  if (DEGRADED_MESSAGE_RE.test(message)) return "PROVIDER_UNAVAILABLE";
  return "INTERNAL";
}

/**
 * Corps JSON d'erreur standardisé pour les routes : `{ error, code }`.
 * Usage : `NextResponse.json(errorBody(e), { status: errorStatus(e) })`.
 */
export function errorBody(error: unknown, fallbackMessage = "Une erreur inattendue est survenue."): { error: string; code: ApiErrorCode } {
  return {
    error: error instanceof Error && error.message ? error.message : fallbackMessage,
    code: errorCode(error),
  };
}

/**
 * Convertit une ZodError en erreur lisible : les dumps Zod bruts exposaient
 * la structure interne (`origin`, `code`…) en langue machine — illisibles
 * pour l'utilisateur et pour l'UI (audit 25-a D4). Statut 422 + code
 * INVALID_REQUEST + un message humain identifiant le champ en cause.
 */
export function zodValidationError(error: { issues: ReadonlyArray<{ code: string; path: PropertyKey[] }> }): HttpError {
  const first = error.issues[0];
  const field = first && first.path.length > 0 ? String(first.path.join(".")) : "";
  let detail = "valeur refusée par la validation";
  if (first) {
    if (first.code === "too_small") detail = "valeur trop courte (minimum non atteint)";
    else if (first.code === "too_big") detail = "valeur trop longue (maximum dépassé)";
    else if (first.code === "invalid_type") detail = "type de valeur inattendu";
    else if (first.code === "invalid_string" || first.code === "invalid_format") detail = "format invalide";
    else if (first.code === "unrecognized_keys") detail = "champ inconnu refusé";
  }
  return new HttpError(
    422,
    `Requête invalide${field ? ` (champ « ${field} »)` : ""} : ${detail}.`,
    "INVALID_REQUEST",
  );
}

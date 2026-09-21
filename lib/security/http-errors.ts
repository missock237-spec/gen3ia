/**
 * Erreurs HTTP typées pour les routes API.
 *
 * Objectif robustesse : une route ne doit plus deviner le statut d'une erreur
 * à partir du message (`.includes("auth")`) — les erreurs d'authentification
 * doivent renvoyer 401, les erreurs d'infrastructure (Firestore indisponible,
 * provider LLM en panne) 503, et le reste 500. Sinon l'UI traite une panne
 * backend comme une déconnexion (ou l'inverse) et l'utilisateur est perdu.
 */

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function unauthorized(message = "Authentification requise : jeton manquant ou session expirée."): HttpError {
  return new HttpError(401, message);
}

export function serviceUnavailable(message = "Service momentanément indisponible. Réessayez dans un instant."): HttpError {
  return new HttpError(503, message);
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

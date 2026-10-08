/**
 * Horloge de renouvellement « Live Voix » (Task 110-b) — module PUR.
 *
 * Sessions de 10 minutes renouvelables par jetons sans état (contrat 110-0) :
 * le client déclenche POST /api/live/voice/renew à T-30 s avant expiration
 * (grâce serveur : 60 s), UNE SEULE FOIS par epoch, jusqu'à maxEpochs.
 *
 * Décision pure (aucune horloge interne, testable) :
 *  - `expired`  : le temps de l'epoch courante est écoulé (remainingMs = 0) ;
 *  - `renew`    : dans la fenêtre T-renewLeadMs ET l'epoch courante n'a pas
 *                 déjà été renouvelée (garde `lastRenewAtMs`) ;
 *  - `none`     : tout le reste (hors fenêtre, epoch finale déjà lancée…).
 *
 * La garde « une seule fois par epoch » compare lastRenewAtMs au début de
 * l'epoch courante (startedAtMs) : un horodatage de renouvellement ANTÉRIEUR
 * au début de cette epoch appartient à l'epoch précédente et ne bloque pas.
 */

/** Durée d'une epoch (défaut du contrat : 10 minutes). */
export const SESSION_MS_DEFAUT = 600_000;

/** Nombre maximal d'epochs (défaut du contrat : 6, soit 60 minutes). */
export const MAX_EPOCHS_DEFAUT = 6;

/** Déclenchement du renouvellement avant expiration (défaut : 30 s). */
export const RENEW_LEAD_MS_DEFAUT = 30_000;

export interface RenewalClockInput {
  /** Début de l'epoch courante (ms epoch). */
  startedAtMs: number;
  /** Maintenant (ms epoch). */
  nowMs: number;
  /** Durée d'une epoch (défaut 600 000 ms). */
  sessionMs?: number;
  /** Époque courante (commence à 1 côté serveur). */
  epoch: number;
  /** Nombre maximal d'epochs (défaut 6). */
  maxEpochs?: number;
  /** Fenêtre de renouvellement avant expiration (défaut 30 000 ms). */
  renewLeadMs?: number;
  /** Horodatage du DERNIER renouvellement réussi (garde anti-doublon). */
  lastRenewAtMs?: number;
}

export type RenewalAction = "none" | "renew" | "expired";

export interface RenewalDecision {
  action: RenewalAction;
  /** Temps restant de l'epoch courante (ms, jamais négatif). */
  remainingMs: number;
}

/**
 * Décide de l'action de renouvellement à l'instant `nowMs`.
 */
export function computeRenewalDecision(input: RenewalClockInput): RenewalDecision {
  const sessionMs = input.sessionMs ?? SESSION_MS_DEFAUT;
  const maxEpochs = input.maxEpochs ?? MAX_EPOCHS_DEFAUT;
  const renewLeadMs = input.renewLeadMs ?? RENEW_LEAD_MS_DEFAUT;

  const remainingMs = Math.max(0, input.startedAtMs + sessionMs - input.nowMs);

  // Temps écoulé : la session (epoch courante) est terminée, quel que soit
  // le numéro d'epoch — c'est le cas final (la dernière epoch finit en
  // `expired`, les précédentes ayant été renouvelées avant).
  if (remainingMs <= 0) {
    return { action: "expired", remainingMs: 0 };
  }

  // Dernière epoch : aucun renouvellement supplémentaire n'est possible.
  if (input.epoch >= maxEpochs) {
    return { action: "none", remainingMs };
  }

  // Hors fenêtre T-30 s : rien à faire.
  if (remainingMs > renewLeadMs) {
    return { action: "none", remainingMs };
  }

  // Une seule tentative par epoch : un renouvellement horodaté APRÈS le
  // début de l'epoch courante a déjà été fait pour CELLE-CI.
  if (input.lastRenewAtMs !== undefined && input.lastRenewAtMs > input.startedAtMs) {
    return { action: "none", remainingMs };
  }

  return { action: "renew", remainingMs };
}

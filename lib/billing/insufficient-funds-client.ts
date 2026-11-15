"use client";

/**
 * Détection client du blocage « fonds insuffisants » (Task 153).
 *
 * Les routes d'exécution d'agents IA réservent le coût AVANT toute
 * génération : un solde insuffisant renvoie 402 PAYMENT_REQUIRED avec un
 * message humain. Ce module permet aux UI de reconnaître CE cas précis
 * (statut HTTP ou empreinte du message) et d'afficher l'invite de recharge
 * (lien /billing) au lieu d'une erreur générique.
 */

export class InsufficientFundsError extends Error {
  readonly code = "PAYMENT_REQUIRED" as const;

  constructor(message: string) {
    super(message);
    this.name = "InsufficientFundsError";
  }
}

const INSUFFICIENT_FUNDS_MESSAGE_RE =
  /solde insuffisant|insufficient (wallet )?balance|wallet balance is 0|rechargez votre portefeuille|recharge your gen3ia wallet/i;

/** Reconnaît l'échec « paiement requis » parmi une erreur quelconque. */
export function isInsufficientFundsError(error: unknown): boolean {
  if (error instanceof InsufficientFundsError) return true;
  if (error instanceof Error && error.name === "InsufficientFundsError") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return INSUFFICIENT_FUNDS_MESSAGE_RE.test(message);
}

/**
 * Fabrique l'erreur à partir d'une réponse HTTP : conserve le message
 * serveur (montants précis) et le marque comme « fonds insuffisants »
 * quand le statut/code l'indique.
 */
export async function errorFromResponse(response: Response, fallback: string): Promise<Error> {
  const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  const message = data.error ?? fallback;
  if (response.status === 402 || data.code === "PAYMENT_REQUIRED") {
    return new InsufficientFundsError(message);
  }
  return new Error(message);
}

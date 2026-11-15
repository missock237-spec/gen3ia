/**
 * PASSERELLE DE PAIEMENT UNIQUE — décision client (session 2026-10-23) :
 * Chariow est LA SEULE passerelle d'encaissement de Gen3ia (abonnements de la
 * grille tarifaire, recharge du wallet, achat d'extensions). Stripe, Sebpay,
 * Paydunya & co. ne sont ni implémentés ni autorisés : ce module matérialise
 * la décision et sert de point de contrôle unique aux routes d'encaissement
 * (POST /api/billing/topup, POST /api/billing/plans/checkout,
 * POST /api/extensions/:id/install).
 *
 * PAYMENT_PROVIDER (env, optionnel) : défaut « chariow » — seule valeur
 * supportée. Toute autre valeur court-circuite explicitement les points
 * d'entrée d'encaissement (501) : une configuration erronée ne peut pas
 * déclencher un encaissement via un canal non validé (fail-safe, même
 * philosophie que GEN3IA_BILLING_ENABLED dans lib/billing/billing-mode.ts).
 *
 * Les paiements WALLET (crédits internes Gen3ia, lib/billing/wallet.ts) ne
 * passent PAS par une passerelle externe et restent disponibles quel que soit
 * ce flag — seuls les encaissements externes sont gate-és ici.
 */

/** Passerelles d'encaissement autorisées — Chariow est la seule, point final. */
export const SUPPORTED_PAYMENT_PROVIDERS = ["chariow"] as const;

/** Passerelle configurée (env PAYMENT_PROVIDER, défaut « chariow »). */
export function getPaymentProvider(): string {
  return process.env.PAYMENT_PROVIDER?.trim().toLowerCase() || "chariow";
}

/** true uniquement si la passerelle configurée est Chariow (la seule supportée). */
export function isPaymentProviderActive(): boolean {
  return (SUPPORTED_PAYMENT_PROVIDERS as readonly string[]).includes(getPaymentProvider());
}

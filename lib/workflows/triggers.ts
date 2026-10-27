import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * DÉCLENCHEURS WEBHOOK / CRON DES WORKFLOWS (P2 — demande « amélioration des
 * performances » : « déclencheurs webhook/cron »).
 *
 * Deux façons de lancer un workflow SANS session utilisateur :
 *
 *   WEBHOOK — POST /api/workflows/triggers/webhook/<token>
 *     Le token d'URL (gwtr_<32 hex>) est généré par le propriétaire via
 *     POST /api/workflows/[id]/trigger-token. Seul le HACHAGE SHA-256 du
 *     token est persisté (fuite Firestore ⇒ aucun token exploitable) ; la
 *     recherche se fait par égalité de hachage (index mono-champ natif).
 *
 *   CRON — POST /api/cron/workflow-triggers (bearer CRON_SECRET)
 *     Un workflow peut déclarer `triggerIntervalMinutes` (5..1440). La
 *     route sentinelle parcourt ces workflows et lance ceux dont la dernière
 *     exécution déclenchée est plus ancienne que l'intervalle.
 *
 * FACTURATION : l'exécution est facturée au PROPRIÉTAIRE du workflow
 * (userId du document) — même règle que l'exécution depuis l'UI.
 *
 * Fonctions PURES testées : hachage, parsing d'intervalle, calcul d'échéance.
 */

/** Préfixe des tokens de déclencheur webhook. */
export const TOKEN_PREFIXE = "gwtr_";

/** Champ Firestore portant le hachage du token. */
export const CHAMP_TOKEN_HASH = "triggerTokenHash";

/** Champ Firestore portant l'intervalle cron (minutes). */
export const CHAMP_INTERVALE = "triggerIntervalMinutes";

/** Champ Firestore portant l'horodatage du dernier déclenchement (ms). */
export const CHAMP_DERNIER = "triggerLastFiredAt";

/** Génère un token d'URL neuf (l'original n'est montré qu'une fois). */
export function genererTokenDeclencheur(): string {
  return `${TOKEN_PREFIXE}${randomBytes(16).toString("hex")}`;
}

/** Hachage SHA-256 hex d'un token (valeur persistée en Firestore). */
export function hacherToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** true si le token a la forme attendue (rejet rapide avant requête Firestore). */
export function tokenBienForme(token: string): boolean {
  return new RegExp(`^${TOKEN_PREFIXE}[0-9a-f]{32}$`).test(token);
}

/**
 * Signature HMAC du corps de webhook (défense en profondeur) : si le
 * propriétaire configure `WEBHOOK_TRIGGER_SECRET`, le webhook exige
 * l'en-tête `x-gen3ia-trigger-signature: sha256=<hex>` — HMAC du corps brut.
 * Optionnel : sans secret configuré, le token d'URL reste la seule barrière
 * (+ rate limit par IP).
 */
export function signerCorps(corpsBrut: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(corpsBrut, "utf8").digest("hex")}`;
}

export function verifierSignatureCorps(
  corpsBrut: string,
  secret: string,
  recu: string | null,
): boolean {
  if (!recu?.startsWith("sha256=")) return false;
  const attendu = Buffer.from(signerCorps(corpsBrut, secret));
  const fourni = Buffer.from(recu);
  return attendu.length === fourni.length && timingSafeEqual(attendu, fourni);
}

/** Parse l'intervalle de déclenchement cron (minutes) — null si invalide. */
export function parserIntervale(valeur: unknown): number | null {
  if (typeof valeur !== "number" || !Number.isFinite(valeur)) return null;
  const entier = Math.floor(valeur);
  if (entier < 5 || entier > 1440) return null;
  return entier;
}

/**
 * Échéance due ? (pur) — lastFiredAt absent = jamais déclenché = dû.
 * Marge de sécurité 15 s pour absorber la dérive des ticks cron.
 */
export function estDue(
  intervalleMinutes: number,
  dernierDeclenchement: unknown,
  maintenantMs: number,
): boolean {
  if (typeof dernierDeclenchement !== "number" || !Number.isFinite(dernierDeclenchement)) {
    return true;
  }
  return maintenantMs >= dernierDeclenchement + intervalleMinutes * 60_000 - 15_000;
}

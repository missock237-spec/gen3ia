import { FieldValue } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { createNotification } from "@/lib/notifications/repository";

/**
 * Alerte de solde critique du wallet (audit de production — facturation D).
 *
 * Exigence : « une alerte automatique par e-mail (via Resend) ou notification
 * in-app quand le solde du wallet passe sous le seuil critique (ex. moins de
 * 500 FCFA / 1 €) en cours de mission » — l'utilisateur doit savoir AVANT que
 * ses agents ne s'arrêtent, jamais après coup dans un fil d'erreur.
 *
 * Architecture (choix assumés) :
 *  - Le DÉDUP est atomique : le drapeau `lowBalanceNotifiedAtMs` est écrit
 *    dans la MÊME transaction Firestore que la mutation de fonds (réservation
 *    ou règlement). Deux exécutions concurrentes ne peuvent donc pas doubler
 *    l'alerte, et aucune course n'est possible entre « décrémenter » et
 *    « notifier ». Cooldown par défaut : 24 h (une seule relance par jour
 *    tant que le solde reste critique).
 *  - Le RÉARMEMENT se fait à chaque recharge réelle (applyTopup) : de
 *    l'argent entre → le cycle d'alerte repart. Une restitution (release)
 *    NE réarme PAS : ce ne sont pas des fonds nouveaux, re-notifier au
 *    prochain prélèvement serait du spam.
 *  - La DISPATCHE (notification in-app + e-mail) part APRÈS le commit,
 *    fire-and-forget : elle ne peut JAMAIS bloquer ni faire échouer une
 *    mission. L'e-mail est un e-mail SYSTÈME (non facturé à l'utilisateur —
 *    facturer quelqu'un pour lui annoncer qu'il n'a plus de crédit serait
 *    absurde), envoyé via la même configuration Resend que l'email agentique.
 *  - Le HARD-STOP (« agents stoppés, solde 0 ») déclenche aussi l'alerte :
 *    c'est le moment le plus critique — la mission vient d'échouer.
 *
 * Tout est fail-soft : une panne de Resend ou de notifications ne doit
 * jamais dégrader l'exécution facturée elle-même.
 */

/** Seuil critique en unités mineures — défaut : 500 FCFA (audit de production). */
export function lowBalanceThresholdMinor(): number {
  const raw = Number(process.env.GEN3IA_WALLET_LOW_THRESHOLD_MINOR);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 50_000;
}

/** Cooldown entre deux alertes pour le même wallet — défaut : 24 h. */
export function lowBalanceCooldownMs(): number {
  const raw = Number(process.env.GEN3IA_WALLET_LOW_COOLDOWN_MS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
}

/** Le solde DISPONIBLE (balance − réservé) est-il sous le seuil critique ? */
export function isLowBalance(availableMinor: number): boolean {
  return Number.isSafeInteger(availableMinor) && availableMinor < lowBalanceThresholdMinor();
}

/** Convertit un champ timestamp Firestore (Timestamp | number | unknown) en ms. */
function toMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    try {
      return (value as { toMillis: () => number }).toMillis();
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Le cooldown est-il écoulé (ou jamais notifié) pour ce wallet ? */
export function cooldownElapsed(notifiedAtMs: unknown, nowMs: number): boolean {
  const last = toMillis(notifiedAtMs);
  return nowMs - last >= lowBalanceCooldownMs();
}

/** Formatage honnête XAF (unités mineures → FCFA arrondi au plancher). */
export function formatMinorAsFcfa(minorMinor: number, currency: string): string {
  const whole = Math.floor(minorMinor / 100);
  return `${whole.toLocaleString("fr-FR")} ${currency === "XAF" ? "FCFA" : currency}`;
}

/** L'e-mail système est-il envoyable (configuration Resend présente) ? */
export function isSystemEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM_ADDRESS?.trim());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function sendSystemEmail(to: string, availableLabel: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM_ADDRESS?.trim();
  if (!apiKey || !from) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      subject: `Gen3ia — solde faible (${availableLabel})`,
      text: [
        "Bonjour,",
        "",
        `Le solde de votre wallet Gen3ia est passé sous le seuil critique : ${availableLabel} disponibles.`,
        "Vos agents peuvent s'arrêter faute de crédits.",
        "",
        "Rechargez votre wallet : https://gen3ia.online/billing",
        "",
        "— Gen3ia",
      ].join("\n"),
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend system email failed (${response.status}): ${detail.slice(0, 200)}`);
  }
}

/**
 * Marque le wallet « alerté » hors transaction (chemin hard-stop : la
 * transaction a échoué, le drapeau ne peut pas y être écrit). Best-effort :
 * une course résiduelle ne peut au pire produire qu'une alerte de plus.
 */
export async function markLowBalanceNotified(userId: string): Promise<void> {
  try {
    await adminDb.collection("userWallets").doc(userId).set(
      { userId, lowBalanceNotifiedAtMs: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  } catch (error) {
    console.warn("[wallet] drapeau basse-alerte non écrit (non bloquant):", error instanceof Error ? error.message : error);
  }
}

/**
 * Dispatche l'alerte de solde critique : notification in-app (temps réel via
 * polling 25 s du centre de notifications) + e-mail système si configuré.
 * Ne lève JAMAIS — chaque étage est indépendamment fail-soft.
 */
export async function fireLowBalanceAlert(params: {
  userId: string;
  availableMinor: number;
  currency: string;
}): Promise<void> {
  const availableLabel = formatMinorAsFcfa(params.availableMinor, params.currency);
  try {
    await createNotification({
      userId: params.userId,
      type: "info",
      title: "Solde Gen3ia critique",
      body: `Solde disponible : ${availableLabel}. Rechargez votre wallet pour que vos agents continuent à travailler sans interruption.`,
    });
  } catch (error) {
    console.warn("[wallet] notification basse-alerte impossible (non bloquant):", error instanceof Error ? error.message : error);
  }
  try {
    if (!isSystemEmailConfigured()) return;
    const profile = await adminDb.collection("users").doc(params.userId).get();
    const email = typeof profile.get("email") === "string" ? String(profile.get("email")).trim() : "";
    if (!email || !EMAIL_RE.test(email) || email.length > 320) return;
    await sendSystemEmail(email, availableLabel);
  } catch (error) {
    console.warn("[wallet] e-mail basse-alerte impossible (non bloquant):", error instanceof Error ? error.message : error);
  }
}

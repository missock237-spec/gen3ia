import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import type { MessagingChannel } from "./index";

/**
 * Préférences de notification par utilisateur (collection messagingPreferences).
 * L'utilisateur choisit le canal et le destinataire (numéro WhatsApp, chat ID
 * Telegram, canal Slack) depuis /integrations. Les agents utilisent ces
 * préférences pour notifier et demander une approbation distante.
 */

const COLLECTION = "messagingPreferences";

export const MessagingPreferencesSchema = z.object({
  channel: z.enum(["whatsapp", "telegram", "slack"]),
  recipient: z
    .string()
    .trim()
    .min(3)
    .max(128)
    .regex(/^[\w@+.:|#\-\[\]]+$/, "Destinataire invalide."),
  approvalsEnabled: z.boolean().default(true),
  updatedAt: z.number().int().positive().optional(),
});

export type MessagingPreferences = z.infer<typeof MessagingPreferencesSchema>;

export async function getMessagingPreferences(userId: string): Promise<MessagingPreferences | null> {
  if (!userId?.trim()) throw new Error("userId is required.");
  const snapshot = await adminDb.collection(COLLECTION).doc(userId).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() ?? {};
  const parsed = MessagingPreferencesSchema.safeParse({
    channel: data.channel,
    recipient: data.recipient,
    approvalsEnabled: data.approvalsEnabled ?? true,
  });
  return parsed.success ? parsed.data : null;
}

export async function setMessagingPreferences(userId: string, preferences: MessagingPreferences): Promise<MessagingPreferences> {
  if (!userId?.trim()) throw new Error("userId is required.");
  const parsed = MessagingPreferencesSchema.parse(preferences);
  const now = Date.now();
  await adminDb.collection(COLLECTION).doc(userId).set({
    channel: parsed.channel,
    recipient: parsed.recipient,
    approvalsEnabled: parsed.approvalsEnabled,
    updatedAt: Timestamp.fromMillis(now),
  }, { merge: true });
  return { ...parsed, updatedAt: now };
}

export async function clearMessagingPreferences(userId: string): Promise<void> {
  if (!userId?.trim()) throw new Error("userId is required.");
  await adminDb.collection(COLLECTION).doc(userId).delete().catch(() => undefined);
}

/** Utilisé uniquement pour la documentation Firestore (timestamps serveur). */
export const MESSAGING_PREFERENCES_FIELD_SERVER_TIMESTAMP = FieldValue.serverTimestamp;

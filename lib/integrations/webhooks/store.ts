import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";

/**
 * Endpoints de webhooks sortants : Gen3ia émet ses événements
 * (approbation requise, exécution terminée, échec…) vers n8n / Make /
 * Zapier ou tout système externe déclaré par l'utilisateur.
 */

const COLLECTION = "outgoingWebhooks";
export const MAX_WEBHOOKS_PER_USER = 20;

export const OUTGOING_WEBHOOK_EVENTS = [
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.completed",
  "approval.failed",
  "execution.completed",
  "execution.failed",
  "test.ping",
] as const;

export type OutgoingWebhookEvent = (typeof OUTGOING_WEBHOOK_EVENTS)[number];

const EVENTS_SET = new Set<string>(OUTGOING_WEBHOOK_EVENTS);

export const WebhookEventsSchema = z
  .array(z.enum(OUTGOING_WEBHOOK_EVENTS))
  .min(1)
  .max(OUTGOING_WEBHOOK_EVENTS.length);

export interface OutgoingWebhook {
  id: string;
  ownerId: string;
  url: string;
  events: OutgoingWebhookEvent[];
  description?: string;
  disabled: boolean;
  createdAt: number;
  /** Secret HMAC : retourné uniquement à la création, jamais re-listé. */
  secret?: string;
}

interface StoredWebhook {
  id: string;
  ownerId: string;
  url: string;
  events: OutgoingWebhookEvent[];
  description?: string;
  disabled: boolean;
  secret: string;
  createdAt: Timestamp;
}

function fromDoc(doc: { id: string } & Record<string, unknown>): StoredWebhook {
  return {
    id: doc.id,
    ownerId: String(doc.ownerId),
    url: String(doc.url),
    events: (Array.isArray(doc.events) ? doc.events : []) as OutgoingWebhookEvent[],
    description: typeof doc.description === "string" ? doc.description : undefined,
    disabled: Boolean(doc.disabled),
    secret: String(doc.secret),
    createdAt: doc.createdAt as Timestamp,
  };
}

function toPublic(endpoint: StoredWebhook): OutgoingWebhook {
  return {
    id: endpoint.id,
    ownerId: endpoint.ownerId,
    url: endpoint.url,
    events: endpoint.events,
    description: endpoint.description,
    disabled: endpoint.disabled,
    createdAt: endpoint.createdAt?.toMillis?.() ?? Date.now(),
  };
}

export function generateWebhookSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

export async function createOutgoingWebhook(params: {
  ownerId: string;
  url: string;
  events: OutgoingWebhookEvent[];
  description?: string;
}): Promise<OutgoingWebhook & { secret: string }> {
  if (!params.ownerId?.trim()) throw new Error("userId is required.");
  const events = WebhookEventsSchema.parse(params.events);

  // Validation anti-SSRF : uniquement des URL HTTPS publiques.
  let parsed: URL;
  try {
    parsed = await assertPublicHttpUrl(params.url);
  } catch (error) {
    throw new Error(`URL de webhook refusée : ${error instanceof Error ? error.message : "invalide"}`);
  }
  if (parsed.protocol !== "https:") throw new Error("Les webhooks sortants exigent une URL HTTPS.");

  const existing = await adminDb.collection(COLLECTION).where("ownerId", "==", params.ownerId).get();
  if (existing.size >= MAX_WEBHOOKS_PER_USER) {
    throw new Error(`Maximum ${MAX_WEBHOOKS_PER_USER} endpoints de webhook par utilisateur.`);
  }

  const secret = generateWebhookSecret();
  const description = params.description?.trim().slice(0, 200) || undefined;
  const ref = adminDb.collection(COLLECTION).doc();
  await ref.create({
    ownerId: params.ownerId,
    url: parsed.toString(),
    events,
    description: description ?? null,
    disabled: false,
    secret,
    createdAt: FieldValue.serverTimestamp(),
  });

  return {
    id: ref.id,
    ownerId: params.ownerId,
    url: parsed.toString(),
    events,
    description,
    disabled: false,
    createdAt: Date.now(),
    secret,
  };
}

export async function listOutgoingWebhooks(ownerId: string): Promise<OutgoingWebhook[]> {
  if (!ownerId?.trim()) throw new Error("userId is required.");
  const snapshot = await adminDb.collection(COLLECTION).where("ownerId", "==", ownerId).get();
  return snapshot.docs
    .map((doc) => toPublic(fromDoc({ id: doc.id, ...doc.data() })))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteOutgoingWebhook(ownerId: string, webhookId: string): Promise<void> {
  if (!ownerId?.trim()) throw new Error("userId is required.");
  if (!webhookId || webhookId.length > 128) throw new Error("Invalid webhook id.");
  const ref = adminDb.collection(COLLECTION).doc(webhookId);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.get("ownerId") !== ownerId) throw new Error("Webhook introuvable pour cet utilisateur.");
  await ref.delete();
}

export async function setOutgoingWebhookDisabled(ownerId: string, webhookId: string, disabled: boolean): Promise<void> {
  if (!ownerId?.trim()) throw new Error("userId is required.");
  const ref = adminDb.collection(COLLECTION).doc(webhookId);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.get("ownerId") !== ownerId) throw new Error("Webhook introuvable pour cet utilisateur.");
  await ref.update({ disabled });
}

export async function listActiveEndpointsForEvent(ownerId: string, event: OutgoingWebhookEvent): Promise<Array<{ id: string; url: string; secret: string }>> {
  const snapshot = await adminDb.collection(COLLECTION).where("ownerId", "==", ownerId).get();
  return snapshot.docs
    .map((doc) => fromDoc({ id: doc.id, ...doc.data() }))
    .filter((endpoint) => !endpoint.disabled && endpoint.events.includes(event))
    .map((endpoint) => ({ id: endpoint.id, url: endpoint.url, secret: endpoint.secret }));
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { billUsage } from "@/lib/billing/media-meter";

/**
 * Canaux de messagerie de l'agent — WhatsApp, Telegram, Slack.
 *
 * Ces canaux utilisent des identifiants de plateforme côté serveur
 * (compte WhatsApp Business Cloud API, bot Telegram, bot Slack). Les
 * connexions OAuth par utilisateur (ex. un workspace Slack spécifique)
 * passent par le Connections Hub Composio (/integrations).
 */

export type MessagingChannel = "whatsapp" | "telegram" | "slack";

const MAX_TEXT_LENGTH = 4096;

const RecipientSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[\w@+.:|#\-\[\]]+$/, "Invalid recipient identifier.");

const MessageSchema = z.object({
  channel: z.enum(["whatsapp", "telegram", "slack"]),
  to: RecipientSchema,
  text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
});

export type AgentMessage = z.infer<typeof MessageSchema>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is not configured.`);
  return value.trim();
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof payload.error === "object" && payload.error !== null
      ? JSON.stringify(payload.error).slice(0, 300)
      : String(payload.error ?? response.status).slice(0, 300);
    throw new Error(`Messaging provider error: ${detail}`);
  }
  return payload;
}

async function sendWhatsApp(to: string, text: string): Promise<Record<string, unknown>> {
  const token = requireEnv("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = requireEnv("WHATSAPP_PHONE_NUMBER_ID");
  return postJson(
    `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`,
    { authorization: `Bearer ${token}` },
    { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: text } },
  );
}

async function sendTelegram(to: string, text: string): Promise<Record<string, unknown>> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const payload = await postJson(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {},
    { chat_id: to, text, link_preview_options: { is_disabled: true } },
  );
  if (payload.ok === false) throw new Error(`Telegram API error: ${String(payload.description ?? "unknown").slice(0, 300)}`);
  return payload;
}

async function sendSlack(to: string, text: string): Promise<Record<string, unknown>> {
  const token = requireEnv("SLACK_BOT_TOKEN");
  const payload = await postJson(
    "https://slack.com/api/chat.postMessage",
    { authorization: `Bearer ${token}` },
    { channel: to, text },
  );
  if (payload.ok === false) throw new Error(`Slack API error: ${String(payload.error ?? "unknown").slice(0, 300)}`);
  return payload;
}

export function getMessagingChannelStatus(): Record<MessagingChannel, boolean> {
  return {
    whatsapp: Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    slack: Boolean(process.env.SLACK_BOT_TOKEN),
  };
}

/** Normalise un destinataire WhatsApp (supprime espaces, tirets, parenthèses). */
export function normalizeWhatsAppRecipient(value: string): string {
  return value.replace(/[\s()\-.]/g, "");
}

/**
 * Envoie un message depuis un agent et métèore l'usage via le wallet.
 * La facturation est passée AVANT l'envoi (rejet si solde insuffisant) :
 * un message sortant n'est jamais gratuit par accident.
 */
export async function sendAgentMessage(params: AgentMessage & { userId: string }): Promise<{ channel: MessagingChannel; providerMessageId?: string }> {
  const { userId, ...messageInput } = params;
  if (!userId?.trim()) throw new Error("A user ID is required to send an agent message.");
  const message = MessageSchema.parse(messageInput);
  const to =
    message.channel === "whatsapp" ? normalizeWhatsAppRecipient(message.to) : message.to;

  await billUsage({
    userId,
    executionId: `msg_${randomUUID()}`,
    kind: message.channel === "whatsapp" ? "whatsapp_message" : message.channel === "telegram" ? "telegram_message" : "slack_message",
    quantity: 1,
    metadata: { channel: message.channel },
  });

  let result: Record<string, unknown>;
  switch (message.channel) {
    case "whatsapp": result = await sendWhatsApp(to, message.text); break;
    case "telegram": result = await sendTelegram(to, message.text); break;
    case "slack": result = await sendSlack(to, message.text); break;
  }

  const providerMessageId =
    (result.messages as Array<{ id?: string }> | undefined)?.[0]?.id ??
    ((result.result as { message_id?: number } | undefined)?.message_id !== undefined
      ? String((result.result as { message_id: number }).message_id)
      : (result.ts as string | undefined));

  return { channel: message.channel, providerMessageId };
}

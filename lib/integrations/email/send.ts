import { randomUUID } from "node:crypto";
import { z } from "zod";
import { billUsage } from "@/lib/billing/media-meter";

/**
 * Email agentique — envoi via Resend (API HTTP, aucune dépendance SMTP).
 *
 * Configuration serveur requise : RESEND_API_KEY + EMAIL_FROM_ADDRESS
 * (domaine vérifié chez Resend). L'usage est météoré par destinataire via
 * COST_EMAIL_EUR avant l'envoi.
 */

const MAX_SUBJECT_LENGTH = 200;
const MAX_TEXT_LENGTH = 100_000;
const MAX_HTML_LENGTH = 200_000;
const MAX_RECIPIENTS = 10;

const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const EmailInputSchema = z.object({
  to: z.union([z.string().trim().max(320), z.array(z.string().trim().max(320)).min(1).max(MAX_RECIPIENTS)]),
  subject: z.string().trim().min(1).max(MAX_SUBJECT_LENGTH),
  text: z.string().max(MAX_TEXT_LENGTH).optional(),
  html: z.string().max(MAX_HTML_LENGTH).optional(),
  replyTo: z.string().trim().max(320).optional(),
});

export type AgentEmailInput = z.infer<typeof EmailInputSchema>;

export interface AgentEmailResult {
  id: string;
  recipients: string[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is not configured.`);
  return value.trim();
}

function normalizeRecipients(to: AgentEmailInput["to"]): string[] {
  const list = (Array.isArray(to) ? to : [to])
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
  const unique = [...new Set(list)];
  if (unique.length === 0) throw new Error("Au moins un destinataire est requis.");
  if (unique.length > MAX_RECIPIENTS) throw new Error(`Maximum ${MAX_RECIPIENTS} destinataires par email.`);
  for (const address of unique) {
    if (!EMAIL_ADDRESS_RE.test(address) || address.length > 320) {
      throw new Error(`Adresse email invalide : "${address.slice(0, 64)}".`);
    }
  }
  return unique;
}

export function isEmailProviderConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM_ADDRESS);
}

/**
 * Envoie un email au nom de la plateforme pour le compte d'un utilisateur.
 * `text` et `html` sont mutuellement exclusifs côté priorité : si `html` est
 * fourni, `text` sert de version de repli (recommandé).
 */
export async function sendAgentEmail(params: AgentEmailInput & { userId: string }): Promise<AgentEmailResult> {
  if (!params.userId?.trim()) throw new Error("A user ID is required to send an email.");
  if (!isEmailProviderConfigured()) {
    throw new Error("L'envoi d'email n'est pas configuré sur la plateforme (RESEND_API_KEY / EMAIL_FROM_ADDRESS manquants).");
  }

  const recipients = normalizeRecipients(params.to);
  const subject = params.subject.trim();
  const text = params.text?.trim();
  const html = params.html?.trim();
  if (!text && !html) throw new Error("Le contenu de l'email est requis (text ou html).");

  await billUsage({
    userId: params.userId,
    executionId: `email_${randomUUID()}`,
    kind: "email",
    quantity: recipients.length,
    metadata: { recipients: String(recipients.length) },
  });

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requireEnv("RESEND_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: requireEnv("EMAIL_FROM_ADDRESS"),
      to: recipients,
      subject,
      ...(text ? { text } : {}),
      ...(html ? { html } : {}),
      ...(params.replyTo && EMAIL_ADDRESS_RE.test(params.replyTo) ? { reply_to: params.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await response.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!response.ok) {
    throw new Error(`Resend API error: ${String(payload.message ?? payload.name ?? response.status).slice(0, 300)}`);
  }
  return { id: payload.id ?? "accepted", recipients };
}

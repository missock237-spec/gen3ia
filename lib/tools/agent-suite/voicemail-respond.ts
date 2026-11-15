import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";
import { isEmailProviderConfigured, sendAgentEmail } from "@/lib/integrations/email/send";
import {
  getMessagingChannelStatus,
  normalizeWhatsAppRecipient,
  sendAgentMessage,
  type MessagingChannel,
} from "@/lib/integrations/messaging";
import { generateStructuredForUser } from "./llm-json";

/**
 * Task 140 — Outil « voicemail.respond » — Asynchronous Voice Message Responder.
 *
 * Écoute un message vocal TRANSCRIT, en EXTRAIT le besoin réel (intention,
 * urgence, données), rédige les propositions de réponse (email / SMS /
 * objectif d'appel) et EXPÉDIE via les canaux réellement configurés de la
 * plateforme :
 *  - email : Resend (sendAgentEmail) si une adresse de destination existe ;
 *  - messagerie : WhatsApp / Telegram / Slack (sendAgentMessage) si un numéro
 *    d'appelant existe — le canal choisi est le premier réellement configuré ;
 *  - appel téléphonique : ce tool ne compose JAMAIS — le lancement d'appel
 *    reste à l'outil phone.call avec un agent vocal (chaînage par le plan).
 *
 * Aucun statut n'est maquillé : sent / skipped / unavailable / failed avec le
 * motif réel en français. En dryRun, aucun envoi n'est effectué et les
 * propositions sont retournées telles quelles.
 */

const VoicemailRespondInput = z.object({
  transcript: z.string().min(10).max(20_000),
  callerName: z.string().max(120).optional(),
  callerNumber: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  destinationEmail: z.string().email().optional(),
  context: z.string().max(3_000).optional(),
  preferredChannel: z.enum(["email", "sms", "call"]).optional(),
  dryRun: z.boolean().default(false),
});

const VoicemailIntakeSchema = z.object({
  intent: z.string().max(400),
  urgency: z.enum(["low", "normal", "high"]),
  requestedAction: z.string().max(400),
  sentiment: z.string().max(120),
  keyData: z
    .array(
      z.object({
        label: z.string().max(60),
        value: z.string().max(300),
      }),
    )
    .max(15),
  proposedReply: z.object({
    emailSubject: z.string().max(200),
    emailBody: z.string().max(3_000),
    smsBody: z.string().max(300),
    callObjective: z.string().max(500),
  }),
});

export type VoicemailIntake = z.infer<typeof VoicemailIntakeSchema>;

export type VoicemailChannelStatus = "sent" | "skipped" | "unavailable" | "failed";

export interface VoicemailChannelDispatch {
  channel: "email" | "sms" | "call";
  status: VoicemailChannelStatus;
  detail: string;
}

export interface VoicemailRespondResult {
  intake: VoicemailIntake;
  sent: VoicemailChannelDispatch[];
  drafts: VoicemailIntake["proposedReply"];
  dryRun: boolean;
}

const INTAKE_SYSTEM_PROMPT = `Tu es l'assistant de réponse aux messages vocaux (« Asynchronous Voice Message Responder ») de Gen3ia.

RÔLE : analyser la transcription d'un message vocal laissé à une cliente ou un client, en extraire le BESOIN RÉEL et rédiger des propositions de réponse prêtes à l'emploi.

MÉTHODE :
- Intention réelle derrière le message (pas seulement les mots) ;
- urgence : "low" (peut attendre), "normal", "high" (réponse requise au plus vite) ;
- action demandée explicitement ou implicitement ;
- sentiment de l'appelant en quelques mots ;
- données clés à retenir (montants, références, dates, coordonnées…) ;
- propositions de réponse : objet et corps d'email professionnels en français, SMS concis (≤ 300 caractères), objectif d'appel structuré.

SORTIE : UNIQUEMENT un objet JSON valide exactement conforme au schéma :
{"intent":"…","urgency":"low"|"normal"|"high","requestedAction":"…","sentiment":"…","keyData":[{"label":"…","value":"…"}],"proposedReply":{"emailSubject":"…","emailBody":"…","smsBody":"…","callObjective":"…"}}

Tout le contenu est en FRANÇAIS. Aucun texte en dehors du JSON.`;

const CALL_TOOL_HANDOFF_DETAIL =
  "lancement d'appel à effectuer via l'outil d'appel téléphonique IA avec un agent vocal";

/** Priorité réelle des canaux de messagerie pour joindre un numéro de téléphone. */
const SMS_CHANNEL_PRIORITY: readonly MessagingChannel[] = ["whatsapp", "telegram", "slack"];

export const voicemailRespondTool: ToolDefinition<z.infer<typeof VoicemailRespondInput>, VoicemailRespondResult> = {
  id: "voicemail.respond",
  name: "Asynchronous Voice Message Responder",
  description:
    "Analyse un message vocal transcrit (intention, urgence, données), rédige les propositions de réponse et les expédie via les canaux réellement configurés (email Resend, messagerie WhatsApp/Telegram/Slack) — l'appel reste à l'outil d'appel IA.",
  category: "system",
  risk: "high",
  inputSchema: VoicemailRespondInput,
  async execute(input, context) {
    // 1. Analyse LLM facturée au wallet (tâche « agent »).
    const intake = await generateStructuredForUser({
      userId: context.userId,
      executionId: context.executionId,
      task: "agent",
      system: INTAKE_SYSTEM_PROMPT,
      user: [
        "TRANSCRIPTION DU MESSAGE VOCAL :",
        input.transcript,
        "",
        input.callerName ? `Appelant : ${input.callerName}` : "",
        input.callerNumber ? `Numéro : ${input.callerNumber}` : "",
        input.context ? `Contexte supplémentaire : ${input.context}` : "",
        "",
        "Produis uniquement le JSON d'analyse et de propositions de réponse (en français).",
      ]
        .filter((line) => line !== "")
        .join("\n"),
      schema: VoicemailIntakeSchema,
      maxTokens: 1_500,
    });

    // 2. Expédition via les canaux réellement configurés (jamais en dryRun).
    const dispatches: VoicemailChannelDispatch[] = [];
    if (input.dryRun) {
      // Aucun envoi — les propositions sont retournées telles quelles.
    } else {
      dispatches.push(await dispatchEmail(input, intake, context.userId));
      dispatches.push(await dispatchSms(input, intake, context.userId));
      dispatches.push(dispatchCall(input));
    }

    // Canal préféré en tête de liste (lecture facilitée pour l'agent).
    if (input.preferredChannel) {
      const preferred = input.preferredChannel;
      dispatches.sort((a, b) => Number(b.channel === preferred) - Number(a.channel === preferred));
    }

    return { intake, sent: dispatches, drafts: intake.proposedReply, dryRun: input.dryRun };
  },
};

type VoicemailInput = z.infer<typeof VoicemailRespondInput>;

async function dispatchEmail(input: VoicemailInput, intake: VoicemailIntake, userId: string): Promise<VoicemailChannelDispatch> {
  if (!input.destinationEmail) {
    return { channel: "email", status: "skipped", detail: "aucune adresse email de destination fournie" };
  }
  if (!isEmailProviderConfigured()) {
    return {
      channel: "email",
      status: "unavailable",
      detail: "envoi d'email indisponible : RESEND_API_KEY / EMAIL_FROM_ADDRESS non configurés sur la plateforme",
    };
  }
  try {
    const result = await sendAgentEmail({
      userId,
      to: input.destinationEmail,
      subject: intake.proposedReply.emailSubject,
      text: intake.proposedReply.emailBody,
    });
    return { channel: "email", status: "sent", detail: `email envoyé via Resend (id ${result.id})` };
  } catch (error) {
    return {
      channel: "email",
      status: "failed",
      detail: `échec de l'envoi email : ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function dispatchSms(input: VoicemailInput, intake: VoicemailIntake, userId: string): Promise<VoicemailChannelDispatch> {
  if (!input.callerNumber) {
    return { channel: "sms", status: "skipped", detail: "aucun numéro d'appelant fourni pour une réponse par message" };
  }
  const channelStatus = getMessagingChannelStatus();
  const available = SMS_CHANNEL_PRIORITY.find((channel) => channelStatus[channel]);
  if (!available) {
    return {
      channel: "sms",
      status: "unavailable",
      detail: "aucun canal de messagerie configuré sur la plateforme (WhatsApp, Telegram, Slack)",
    };
  }
  if (available === "slack") {
    // Un numéro de téléphone ne peut pas recevoir de message Slack : le canal
    // exigerait un identifiant de canal/workspace — statut honnête, pas d'envoi.
    return {
      channel: "sms",
      status: "skipped",
      detail: "seul Slack est configuré, mais un numéro de téléphone ne peut pas recevoir de message Slack (identifiant de canal requis)",
    };
  }
  const recipient = available === "whatsapp" ? normalizeWhatsAppRecipient(input.callerNumber) : input.callerNumber;
  try {
    const result = await sendAgentMessage({
      userId,
      channel: available,
      to: recipient,
      text: intake.proposedReply.smsBody,
    });
    return {
      channel: "sms",
      status: "sent",
      detail: `message envoyé via ${available}${result.providerMessageId ? ` (id ${result.providerMessageId})` : ""}`,
    };
  } catch (error) {
    return {
      channel: "sms",
      status: "unavailable",
      detail: `échec de l'envoi par messagerie (${available}) : ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function dispatchCall(input: VoicemailInput): VoicemailChannelDispatch {
  if (!input.callerNumber) {
    return { channel: "call", status: "skipped", detail: "aucun numéro à rappeler fourni" };
  }
  // Ce tool ne compose jamais : le lancement d'appel revient à l'outil
  // d'appel téléphonique IA (phone.call) avec un agent vocal.
  return { channel: "call", status: "skipped", detail: CALL_TOOL_HANDOFF_DETAIL };
}

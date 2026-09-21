import type { ActionApproval } from "@/lib/agents/action-approvals";
import { getMessagingPreferences } from "./preferences";
import { getMessagingChannelStatus, sendAgentMessage } from "./index";
import { buildRemoteApprovalLinks } from "./remote-approval";

/**
 * Notifie l'utilisateur sur son canal de messagerie préféré quand une action
 * sensible requiert son approbation. Les liens sont signés (HMAC) : l'appel
 * depuis le téléphone n'exige aucune session navigateur.
 *
 * Best effort par construction : aucun échec de notification ne doit faire
 * échouer la création de l'approbation elle-même.
 */

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  slack: "Slack",
};

function formatMessage(approval: ActionApproval, links: { approveUrl: string; rejectUrl: string }): string {
  const lines = [
    "🔐 GEN3IA — Approbation requise",
    "",
    `Action : ${approval.toolSlug}`,
    `Motif : ${approval.reason.length > 300 ? `${approval.reason.slice(0, 300)}…` : approval.reason}`,
    "",
    `✅ Approuver : ${links.approveUrl}`,
    "",
    `❌ Refuser : ${links.rejectUrl}`,
    "",
    `⏳ Le lien expire le ${new Date(approval.expiresAt).toLocaleString("fr-FR")}.`,
  ];
  return lines.join("\n");
}

export async function notifyApprovalRequested(approval: ActionApproval): Promise<{ sent: boolean; channel?: string; error?: string }> {
  try {
    const status = getMessagingChannelStatus();
    const preferences = await getMessagingPreferences(approval.ownerId);
    if (!preferences || !preferences.approvalsEnabled) return { sent: false };
    if (!status[preferences.channel]) return { sent: false, error: `Le canal ${CHANNEL_LABELS[preferences.channel] ?? preferences.channel} n'est pas configuré sur la plateforme.` };

    const links = buildRemoteApprovalLinks(approval.id, approval.ownerId, approval.expiresAt);
    const result = await sendAgentMessage({
      userId: approval.ownerId,
      channel: preferences.channel,
      to: preferences.recipient,
      text: formatMessage(approval, links),
    });
    return { sent: true, channel: result.channel };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message.slice(0, 300) : "Notification failed." };
  }
}

export async function notifyApprovalResolved(approval: ActionApproval, outcome: "approved" | "rejected" | "completed" | "failed"): Promise<void> {
  try {
    const preferences = await getMessagingPreferences(approval.ownerId);
    if (!preferences || !preferences.approvalsEnabled) return;
    const status = getMessagingChannelStatus();
    if (!status[preferences.channel]) return;
    const labels: Record<typeof outcome, string> = {
      approved: "✅ Approuvée — l'exécution va démarrer.",
      rejected: "❌ Refusée — l'action ne sera pas exécutée.",
      completed: "🏁 Action externe terminée avec succès.",
      failed: "⚠️ Action externe terminée en échec.",
    };
    await sendAgentMessage({
      userId: approval.ownerId,
      channel: preferences.channel,
      to: preferences.recipient,
      text: `GEN3IA — Action ${approval.toolSlug} : ${labels[outcome]}`,
    });
  } catch {
    /* best effort : la résolution ne dépend jamais d'une notification. */
  }
}

/**
 * Notification « agent toujours actif » : prévient l'utilisateur sur son
 * canal préféré quand une exécution déclenchée automatiquement (planification,
 * webhook, veille) se termine. Best effort par construction.
 */
export async function notifyScheduleRunCompleted(params: {
  userId: string;
  scheduleId: string;
  status: string;
  error?: string;
}): Promise<void> {
  try {
    const preferences = await getMessagingPreferences(params.userId);
    if (!preferences) return;
    const status = getMessagingChannelStatus();
    if (!status[preferences.channel]) return;

    const outcomes: Record<string, string> = {
      completed: "🏁 mission terminée avec succès.",
      failed: "⚠️ mission terminée en échec.",
      cancelled: "■ mission annulée.",
    };
    const outcome = outcomes[params.status] ?? `ℹ️ mission terminée (${params.status}).`;
    const scheduleName = params.scheduleId.slice(0, 8);
    const detail = params.error ? `\nErreur : ${params.error.slice(0, 200)}` : "";
    await sendAgentMessage({
      userId: params.userId,
      channel: preferences.channel,
      to: preferences.recipient,
      text: `GEN3IA — Votre agent (planification ${scheduleName}) : ${outcome}${detail}`,
    });
  } catch {
    /* best effort : la notification ne doit jamais faire échouer l'exécution. */
  }
}

import "server-only";

import { exportUserData } from "@/lib/memory/privacy";
import { listConversations, listMessages } from "@/lib/chat/repository";
import { listAgentsForUser } from "@/lib/agents/repository";

/**
 * PORTABILITÉ COMPLÈTE DU COMPTE — gouvernance des données (Job 478451, it. 25).
 *
 * Constat d'audit « niveau grandes entreprises » : l'export RGPD historique
 * (`/api/memory/export`) ne couvrait que la MÉMOIRE personnalisée
 * (souvenirs, retours IA, leçons, consentements). Or une part majeure des
 * données personnelles vit ailleurs : conversations + messages, agents IA.
 * Aucune surface n'en donnait la portabilité — et aucune UI n'exposait les
 * endpoints existants (dead code côté utilisateur).
 *
 * Ce module livre l'export COMPLET et AUTO-DESCRIPTIF du compte :
 *
 *   - `memoire`       : délègue à exportUserData (contrat Task 42 inchangé) ;
 *   - `conversations` : fils + messages reconstitués chronologiquement ;
 *   - `agents`        : registre des agents accessibles au compte.
 *
 * Contrat d'HONNÊTETÉ (même école que la politique de sauvegarde it. 23) :
 * un export qui tronque sans le dire est un mensonge. Chaque namespace est
 * décrit dans `manifest` avec son compte réel, son drapeau `tronque` et, le
 * cas échéant, l'erreur qui a restreint la section — un incident sur UNE
 * section ne doit jamais invalider les autres (fail-soft, 500 = dernière
 * option, jamais la première).
 *
 * Sécurité : TOUT est strictement scopé au userId authentifié par
 * l'appelant (protectRoute) ; les repositories sous-jacents revalident
 * l'ownership document par document.
 */

/** Caps d'export — bornes explicites, documentées dans le manifest. */
export const ACCOUNT_EXPORT_CAPS = {
  /** Nombre maximal de conversations reconstituées (les plus récentes). */
  conversations: 50,
  /** Nombre maximal de messages reconstitués PAR conversation. */
  messagesParConversation: 200,
  /** Nombre maximal de agents retournés. */
  agents: 100,
} as const;

export interface ExportNamespaceEntry {
  /** Nombre d'éléments réellement inclus dans l'export. */
  count: number;
  /** true si le namespace réel dépasse la cap — l'export est PARTIEL. */
  tronque: boolean;
  /** Description de l'incident ayant restreint la section (fail-soft). */
  erreur?: string;
}

export interface AccountExportConversation {
  id: string;
  titre: string;
  statut: string;
  creeLe: string;
  majLe: string;
  agentId?: string;
  projectId?: string;
  messages: Array<{
    id: string;
    role: string;
    contenu: string;
    creeLe: string;
  }>;
}

export interface AccountExport {
  format: "gen3ia.account-export";
  version: 1;
  exportedAt: string;
  userId: string;
  /** Caps appliquées — le consommateur peut vérifier la complétude. */
  caps: typeof ACCOUNT_EXPORT_CAPS;
  manifest: {
    memoire: ExportNamespaceEntry;
    conversations: ExportNamespaceEntry;
    agents: ExportNamespaceEntry;
  };
  memoire: Awaited<ReturnType<typeof exportUserData>>;
  conversations: AccountExportConversation[];
  agents: Array<Record<string, unknown>>;
}

type NamespaceResult<T> =
  | { ok: true; data: T; entry: ExportNamespaceEntry }
  | { ok: false; entry: ExportNamespaceEntry };

/**
 * Wrapper fail-soft : une section en erreur produit une entrée de manifest
 * honnête (erreur incluse) au lieu d'un 500 global.
 */
async function sectionEchecDoux<T>(
  nom: string,
  charge: () => Promise<{ data: T; count: number; tronque: boolean }>,
): Promise<NamespaceResult<T>> {
  try {
    const { data, count, tronque } = await charge();
    return { ok: true, data, entry: { count, tronque } };
  } catch (error) {
    return {
      ok: false,
      entry: {
        count: 0,
        tronque: true,
        erreur: `${nom}: ${error instanceof Error ? error.message : "échec inconnu"}`,
      },
    };
  }
}

function tronqueOuNon(count: number, cap: number): boolean {
  return count >= cap;
}

export async function exportAccountData(userId: string): Promise<AccountExport> {
  if (!userId?.trim()) throw new Error("Account export requires userId.");

  const [memoireRes, conversationsRes, agentsRes] = await Promise.all([
    sectionEchecDoux("memoire", async () => {
      const data = await exportUserData(userId);
      return {
        data,
        count: data.memories.length + data.aiFeedback.length + data.aiFeedbackLessons.length,
        tronque: false,
      };
    }),
    sectionEchecDoux("conversations", async () => {
      const fils = await listConversations(userId, ACCOUNT_EXPORT_CAPS.conversations);
      const conversations: AccountExportConversation[] = [];
      let tronque = tronqueOuNon(fils.length, ACCOUNT_EXPORT_CAPS.conversations);
      for (const fil of fils) {
        // Chronologie ascendante (asc) = fil lisible tel quel dans l'export.
        const messages = await listMessages(userId, fil.id, ACCOUNT_EXPORT_CAPS.messagesParConversation, {
          order: "asc",
        });
        if (messages.length >= ACCOUNT_EXPORT_CAPS.messagesParConversation) tronque = true;
        conversations.push({
          id: fil.id,
          titre: fil.title,
          statut: fil.status ?? "active",
          creeLe: fil.createdAt,
          majLe: fil.updatedAt,
          agentId: fil.agentId,
          projectId: fil.projectId,
          messages: messages.map((m) => ({
            id: m.id,
            role: String(m.role ?? ""),
            contenu: m.content,
            creeLe: m.createdAt,
          })),
        });
      }
      return { data: conversations, count: conversations.length, tronque };
    }),
    sectionEchecDoux("agents", async () => {
      const registre = await listAgentsForUser(userId);
      const agents = registre.slice(0, ACCOUNT_EXPORT_CAPS.agents).map((a) => ({ ...a }) as Record<string, unknown>);
      return { data: agents, count: agents.length, tronque: registre.length > ACCOUNT_EXPORT_CAPS.agents };
    }),
  ]);

  return {
    format: "gen3ia.account-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    userId,
    caps: ACCOUNT_EXPORT_CAPS,
    manifest: {
      memoire: memoireRes.entry,
      conversations: conversationsRes.entry,
      agents: agentsRes.entry,
    },
    memoire: memoireRes.ok ? memoireRes.data : ({} as AccountExport["memoire"]),
    conversations: conversationsRes.ok ? conversationsRes.data : [],
    agents: agentsRes.ok ? agentsRes.data : [],
  };
}

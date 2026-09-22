import "server-only";

import { randomUUID } from "crypto";

import { FieldValue } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { generate } from "@/lib/ai/router";
import { listHubConnections } from "@/lib/integrations/composio/connections";
import { executeComposioTool } from "@/lib/integrations/composio/tools";
import { isRedisConfigured, rateLimitDistributed } from "@/lib/cache/redis";

/**
 * GEN — le chat IA de la page d'accueil.
 *
 * ISOLEMENT GARANTI PAR CONSTRUCTION (pas par promesse) :
 *  - AUCUN passage par AgentRuntime, le planificateur ou executeToolSecurely :
 *    gen n'a donc matériellement accès à AUCUN outil d'agent (fichiers,
 *    documents, code, terminal, mémoire, extensions, appels, emails…).
 *  - DEUX capacités seulement : répondre (LLM simple) et exécuter UNE tâche
 *    simple via UN connecteur de l'utilisateur connecté — actions STRICTEMENT
 *    en lecture (allowlist par préfixe/suffixe, ex. SEARCH_/LIST_/GET_),
 *    effets externes impossibles.
 *  - Collection de conversation dédiée (genChatConversations) : le
 *    propriétaire des conversations agent IA ne voit jamais ce fil.
 *
 * Auth : facultative. Visiteur anonyme = réponses uniquement (quota IP via
 * Redis). Utilisateur connecté = + connecteurs personnels en lecture.
 */

const CHATS = "genChatConversations";

/** Actions connecteurs autorisées pour gen : lecture stricte uniquement. */
const SAFE_ACTION_PREFIX = /^(SEARCH|LIST|GET|FETCH|FIND|READ|LOAD|VIEW|RETRIEVE|CHECK|LOOKUP|QUERY|SCAN|BROWSE|DOWNLOAD)/i;
const UNSAFE_SLUG_HINT = /(DELETE|REMOVE|CREATE|UPDATE|SEND|POST|PUT|PATCH|MOVE|ARCHIVE|RESTORE|PURGE|CANCEL|INVITE|GRANT|REVOKE|UPLOAD|MERGE|DEACTIVATE|ACTIVATE|SUBMIT|PUBLISH)/i;

/**
 * Valide un slug d'action Composio pour gen. Format réel : `<TOOLKIT>_<ACTION>`
 * (ex. GITHUB_LIST_REPOSITORIES) — le préfixe de lecture est donc testé sur
 * la partie APRÈS le toolkit, et l'interdit sur le slug ENTIERS (aucun
 * déguisement du type LIST_REPOS_THEN_DELETE impossible : le mot DELETE
 * nulle part).
 */
export function isSafeGenConnectorSlug(slug: string): boolean {
  if (!/^[A-Za-z0-9_]{3,160}$/.test(slug)) return false;
  const rest = slug.replace(/^[^_]+_/, "");
  if (!SAFE_ACTION_PREFIX.test(rest)) return false;
  if (UNSAFE_SLUG_HINT.test(slug)) return false;
  return true;
}

export interface GenQuotaResult {
  allowed: boolean;

  limit: number;

  retryAfterMs: number;

  bucket: "anonymous" | "authenticated";
}

/**
 * Quota gen — Redis distribué (partagé entre instances). Anonyme : 6 messages
 * / 5 min / IP. Connecté : 20 messages / 5 min / utilisateur (les actions
 * connecteur restent limitées par les quotas Composio eux-mêmes).
 */
export async function checkGenQuota(params: { userId?: string; ip: string }): Promise<GenQuotaResult> {
  if (params.userId) {
    const result = await rateLimitDistributed(`gen:user:${params.userId}`, { limit: 20, windowMs: 5 * 60 * 1000 });
    return { allowed: result.allowed, limit: 20, retryAfterMs: result.retryAfterMs, bucket: "authenticated" };
  }
  // Sans Redis (rare), rateLimitDistributed retombe sur un compteur local :
  // le quota reste effectif par instance.
  const result = await rateLimitDistributed(`gen:ip:${params.ip}`, { limit: 6, windowMs: 5 * 60 * 1000 });
  return { allowed: result.allowed, limit: 6, retryAfterMs: result.retryAfterMs, bucket: "anonymous" };
}

/** Connecteurs connectés de l'utilisateur (lecture seule pour gen). */
export async function listGenConnectors(userId: string): Promise<string[]> {
  try {
    const accounts = await listHubConnections(userId);
    return accounts
      .filter((account) => account.status === "ACTIVE" && account.enabled)
      .map((account) => account.toolkit)
      .slice(0, 16);
  } catch {
    return [];
  }
}

const GEN_DECISION_SYSTEM = [
  "Tu es « Gen », l'assistante IA publique de Gen3ia (plateforme d'agents IA pour entreprises).",
  "Ton rôle : accueillir les visiteurs, répondre à leurs questions sur Gen3ia (agents IA, connecteurs, automatisation, appels téléphoniques IA, génération de documents, tarifs à confirmer sur le site) et discuter naturellement.",
  "Tu es isolee des comptes et des outils d'agents : ne promets JAMAIS d'agir sur des fichiers, des documents, du code ou des comptes externes.",
  "Réponds dans la langue du visiteur. Style : chaleureux, concis (2 à 6 phrases), professionnel.",
].join("\n");

interface ConnectorDecision {
  toolkit: string;

  toolSlug: string;

  arguments: Record<string, unknown>;
}

function parseDecision(raw: string): { action: "answer"; reply: string } | { action: "connector"; call: ConnectorDecision } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (parsed.action === "answer" && typeof parsed.reply === "string") {
      return { action: "answer", reply: parsed.reply.slice(0, 4_000) };
    }
    if (
      parsed.action === "connector" &&
      typeof parsed.toolkit === "string" &&
      typeof parsed.toolSlug === "string" &&
      parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments)
    ) {
      return {
        action: "connector",
        call: {
          toolkit: (parsed.toolkit as string).toLowerCase().slice(0, 64),
          toolSlug: (parsed.toolSlug as string).slice(0, 160),
          arguments: parsed.arguments as Record<string, unknown>,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function decide(message: string, connected: string[], history: Array<{ role: string; content: string }>): Promise<{ action: "answer"; reply: string } | { action: "connector"; call: ConnectorDecision }> {
  const catalogHint = connected.length > 0
    ? `Connecteurs en LECTURE SEULE de l'utilisateur connecté (toolkits) : ${connected.join(", ")}. Actions autorisées uniquement si le slug commence par SEARCH_/LIST_/GET_/FETCH_/FIND_/READ_ etc.`
    : "Aucun connecteur disponible : choisis toujours action=answer.";

  const response = await generate({
    task: "chat",
    preferFree: true,
    maxTokens: 1_200,
    messages: [
      { role: "system", content: `${GEN_DECISION_SYSTEM}\n\n${catalogHint}\n\nRéponds STRICTEMENT avec un JSON, sans texte autour :\n{"action":"answer","reply":"..."} pour répondre,\nou {"action":"connector","toolkit":"<toolkit>","toolSlug":"<SLUG>","arguments":{}} pour exécuter une action de lecture via un connecteur (une seule, jamais une écriture).` },
      ...history.slice(-6).map((item) => ({ role: item.role === "user" ? "user" as const : "assistant" as const, content: item.content })),
      { role: "user", content: message },
    ],
    metadata: { feature: "gen-home-chat" },
  });

  const decision = parseDecision(response.text);
  if (!decision) return { action: "answer", reply: response.text.slice(0, 4_000) };
  return decision;
}

async function summarizeConnectorResult(message: string, call: ConnectorDecision, rawResult: unknown): Promise<string> {
  try {
    const response = await generate({
      task: "chat",
      preferFree: true,
      maxTokens: 1_200,
      messages: [
        { role: "system", content: GEN_DECISION_SYSTEM },
        { role: "user", content: message },
        { role: "user", content: `Résultat de l'action ${call.toolSlug} (${call.toolkit}) :\n${JSON.stringify(rawResult).slice(0, 6_000)}\n\nRésume ce résultat pour le visiteur en 3 à 8 phrases claires, dans sa langue. Ne mentionne pas les JSON ni les slugs.` },
      ],
      metadata: { feature: "gen-home-chat" },
    });
    return response.text.slice(0, 4_000);
  } catch {
    return "L'action a été exécutée mais je n'ai pas pu mettre le résultat en forme. Pouvez-vous reformuler votre demande ?";
  }
}

export interface GenReply {
  reply: string;

  conversationId: string;

  connectorUsed: { toolkit: string; toolSlug: string } | null;
}

export async function runGenTurn(input: {
  userId?: string;
  message: string;
  conversationId?: string;
  selectedConnectors?: string[];
}): Promise<GenReply> {
  const conversationId = input.conversationId ?? randomUUID();
  const connectedAll = input.userId ? await listGenConnectors(input.userId) : [];
  const requested = [...new Set((input.selectedConnectors ?? []).map((item) => item.trim().toLowerCase()))];
  // La sélection utilisateur ne peut qu'intersecter les connexions déjà
  // réellement actives et vérifiées ; elle ne crée jamais une permission.
  const connected = requested.length > 0
    ? connectedAll.filter((toolkit) => requested.includes(toolkit))
    : connectedAll;

  const history = await loadGenHistory(input.userId, conversationId);

  const decision = await decide(input.message, connected, history);

  if (decision.action === "answer") {
    await persistGenExchange(input, conversationId, decision.reply, null);
    return { reply: decision.reply, conversationId, connectorUsed: null };
  }

  // Garde-fou dur : slug de lecture uniquement + toolkit réellement connecté.
  const slug = decision.call.toolSlug;
  if (!isSafeGenConnectorSlug(slug) || !connected.includes(decision.call.toolkit)) {
    const reply = "Cette action dépasse mes capacités publiques (je ne peux exécuter que des consultations en lecture via vos connecteurs). Posez-moi une question sur Gen3ia, ou connectez-vous avec vos intégrations pour aller plus loin avec un agent.";
    await persistGenExchange(input, conversationId, reply, null);
    return { reply, conversationId, connectorUsed: null };
  }

  let rawResult: unknown;
  try {
    rawResult = await executeComposioTool({
      userId: input.userId!,
      toolSlug: slug,
      arguments: decision.call.arguments,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reply = "L'action n'a pas abouti (connecteur indisponible ou arguments invalides). Vérifiez la connexion de l'application dans la page Intégrations, puis réessayez.";
    await persistGenExchange(input, conversationId, reply, { toolkit: decision.call.toolkit, toolSlug: slug, ok: false });
    void error; // journalisé par le route appelant si nécessaire
    return { reply, conversationId, connectorUsed: { toolkit: decision.call.toolkit, toolSlug: slug } };
  }

  const reply = await summarizeConnectorResult(input.message, decision.call, rawResult);
  await persistGenExchange(input, conversationId, reply, { toolkit: decision.call.toolkit, toolSlug: slug, ok: true });
  return { reply, conversationId, connectorUsed: { toolkit: decision.call.toolkit, toolSlug: slug } };
}

async function loadGenHistory(userId: string | undefined, conversationId: string): Promise<Array<{ role: string; content: string }>> {
  if (!userId) return [];
  try {
    const snapshot = await adminDb.collection(CHATS).doc(genDocId(userId, conversationId)).get();
    if (!snapshot.exists) return [];
    const messages = (snapshot.data() as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
    return messages.slice(-6);
  } catch {
    return [];
  }
}

function genDocId(userId: string, conversationId: string): string {
  // Document borné et déterministe : conversation gen = (utilisateur, fil).
  return `${userId}_${conversationId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
}

async function persistGenExchange(
  input: { userId?: string; message: string },
  conversationId: string,
  reply: string,
  connector: { toolkit: string; toolSlug: string; ok?: boolean } | null,
): Promise<void> {
  if (!input.userId) return; // anonyme : aucune persistance (vie privée)
  try {
    await adminDb.collection(CHATS).doc(genDocId(input.userId, conversationId)).set(
      {
        userId: input.userId,
        surface: "homepage",
        messages: FieldValue.arrayUnion(
          { role: "user", content: input.message.slice(0, 2_000), at: Date.now() },
          { role: "assistant", content: reply.slice(0, 4_000), at: Date.now() },
        ),
        ...(connector ? { lastConnector: connector } : {}),
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } catch {
    // Persistance best-effort : le visiteur garde sa réponse même si
    // Firestore est indisponible.
  }
}

/** Diagnostic (health check). */
export function genIsolationGuarantees(): Record<string, unknown> {
  return {
    agentRuntime: false,
    agentTools: false,
    fileTools: false,
    codeTools: false,
    connectorMode: "read-only-allowlist",
    redisQuota: isRedisConfigured(),
    collection: CHATS,
  };
}

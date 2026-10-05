import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import {
  resilientCreate,
  resilientDelete,
  resilientGet,
  resilientQuery,
  resilientSet,
} from "@/lib/db/firestore-fallback";
import { isFirestoreQuotaError, shouldShortCircuitFirestore } from "@/lib/db/quota-guard";
import { CHUNKED_COMMIT_SIZE, commitOpsInChunks, type ChunkedWriteOp } from "@/lib/firestore/chunked-commit";
import type {
  ConversationMessage,
  ConversationStatus,
  MessageAttachment,
  MessageCitation,
} from "@/lib/domain/conversations/types";

import {
  indexConversationMessage,
} from "@/lib/chat/vector-index";

/**
 * Dépôt conversation/messages (Task 96-c) — entièrement adossé à la couche
 * résiliente Firestore→Supabase (lib/db/firestore-fallback) : sous quota
 * Firestore épuisé, la section Agent IA ET le workspace continuent de
 * créer/lire/renommer/supprimer des conversations via le miroir chaud.
 *
 * Règles respectées :
 *  - écritures en `new Date()` (JAMAIS FieldValue.serverTimestamp) : les
 *    sentinelles sont écartées du miroir JSONB et casseraient le tri ;
 *  - garde d'ownership (userId) reproduite à l'identique sur les chemins
 *    de repli — jamais la conversation d'un autre utilisateur ;
 *  - tri/lémitage : resilientQuery filtre par égalité puis trie EN MÉMOIRE
 *    (index-safe) ; le cap de scan est demandé à 200 puis redécoupé ici,
 *    car un `limit(N)` côté Firestore renverrait des documents ARBITRAIRES
 *    (le tri est appliqué après le scan).
 */

/** Cap de scan partagé avec resilientQuery (QUERY_DEFAULT_LIMIT). */
const SCAN_LIMIT = 200;

export interface ChatConversation {
  id: string;
  userId: string;
  title: string;
  /** Projet de rattachement (Conversation-first). */
  projectId?: string;
  /** Agent IA propriétaire du fil (historique scopé par agent). */
  agentId?: string;
  model?: string;
  provider?: string;
  status?: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type ChatMessage = ConversationMessage;

/** Pièce jointe dénormalisée pour la validation d'entrée. */
export type ChatMessageAttachment = MessageAttachment;
export type ChatMessageCitation = MessageCitation;

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function attachmentsFrom(value: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      filename: str(x.filename, "fichier"),
      path: typeof x.path === "string" ? x.path : undefined,
      url: typeof x.url === "string" ? x.url : undefined,
      contentType: typeof x.contentType === "string" ? x.contentType : undefined,
      sizeBytes: typeof x.sizeBytes === "number" ? x.sizeBytes : undefined,
      // Métadonnées de conversion conservées à la relecture : sans elles, le
      // contenu RÉEL des fichiers importés ne peut plus être ré-injecté dans
      // les tours suivants ni ré-affiché (bug production : l'historique
      // amputait fileId/fileKind/charCount/rowCount).
      fileId: typeof x.fileId === "string" ? x.fileId : undefined,
      fileKind: typeof x.fileKind === "string" ? x.fileKind : undefined,
      charCount: typeof x.charCount === "number" ? x.charCount : undefined,
      rowCount: typeof x.rowCount === "number" ? x.rowCount : undefined,
    }));
  return list.length > 0 ? list : undefined;
}

function citationsFrom(value: unknown): MessageCitation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      source: str(x.source, "source"),
      snippet: typeof x.snippet === "string" ? x.snippet : undefined,
      url: typeof x.url === "string" ? x.url : undefined,
    }));
  return list.length > 0 ? list : undefined;
}

const conversationRef = (id: string) => adminDb.collection("chatConversations").doc(id);

/** Horodatage lisible : Date (écritures 96-c), Timestamp Firestore (lectures) ou chaîne ISO (miroir). */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return new Date().toISOString();
}

type ConversationDoc = Record<string, unknown> & { id?: string };

function conversationFrom(id: string, x: ConversationDoc): ChatConversation {
  return {
    id,
    userId: x.userId as string,
    title: String(x.title ?? "Nouvelle conversation"),
    projectId: typeof x.projectId === "string" ? x.projectId : undefined,
    agentId: typeof x.agentId === "string" ? x.agentId : undefined,
    model: x.model,
    provider: x.provider,
    status: x.status === "archived" ? ("archived" as const) : ("active" as const),
    messageCount: Number(x.messageCount ?? 0),
    createdAt: iso(x.createdAt),
    updatedAt: iso(x.updatedAt),
  } as ChatConversation;
}

export async function createConversation(
  userId: string,
  title = "Nouvelle conversation",
  options: { projectId?: string; agentId?: string } = {},
) {
  // Identifiant généré localement par le SDK (aucune I/O) : il alimente
  // resilientCreate, qui tient Firestore ET le miroir à jour.
  const id = adminDb.collection("chatConversations").doc().id;
  const now = new Date();
  await resilientCreate(
    "chatConversations",
    id,
    {
      userId, title: title.slice(0, 120), messageCount: 0,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.agentId ? { agentId: options.agentId } : {}),
      status: "active" as const,
      createdAt: now, updatedAt: now,
    },
    userId,
  );
  return {
    id, userId, title, messageCount: 0,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    status: "active" as const,
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

export async function listConversations(
  userId: string,
  limit = 50,
  options: { projectId?: string; agentId?: string; query?: string } = {},
): Promise<ChatConversation[]> {
  const capped = Math.min(limit, 100);
  const filters: Array<{ field: string; value: unknown }> = [{ field: "userId", value: userId }];
  if (options.agentId) {
    // Historique scopé à un agent IA : seuls ses fils sont listés.
    filters.push({ field: "agentId", value: options.agentId });
  }
  if (options.projectId) filters.push({ field: "projectId", value: options.projectId });
  // Scan borné 200 + tri mémoire updatedAt desc (index-safe : pas d'index
  // composite requis, comportement de repli no-index historique absorbé) —
  // puis redécoupage à la limite demandée.
  const docs = await resilientQuery<ConversationDoc>(
    "chatConversations",
    filters,
    { orderField: "updatedAt", descending: true, limit: SCAN_LIMIT, includeIds: true },
  );
  let conversations = docs.map((x) => conversationFrom(String(x.id), x));
  if (conversations.length > capped) conversations = conversations.slice(0, capped);
  const query = options.query?.trim().toLowerCase();
  if (query) {
    conversations = conversations.filter((c) => c.title.toLowerCase().includes(query));
  }
  return conversations;
}

/** Dernière conversation de l'utilisateur (accueil « Reprendre »). */
export async function findLatestConversation(userId: string): Promise<ChatConversation | null> {
  // Scan borné + tri mémoire : un `limit(1)` côté Firestore renverrait un
  // document ARBITRAIRE (tri appliqué après le scan) — on scanne jusqu'au
  // cap puis on prend le plus récent.
  const docs = await resilientQuery<ConversationDoc>(
    "chatConversations",
    [{ field: "userId", value: userId }],
    { orderField: "updatedAt", descending: true, limit: SCAN_LIMIT, includeIds: true },
  );
  const first = docs[0];
  if (!first) return null;
  return conversationFrom(String(first.id), first);
}

export async function getConversation(userId: string, id: string) {
  const x = await resilientGet<ConversationDoc>("chatConversations", id);
  // Garde d'ownership identique au chemin Firestore historique : une
  // conversation d'un autre utilisateur est indiscernable d'une absente.
  if (!x || x.userId !== userId) return null;
  return conversationFrom(id, x);
}

/**
 * Ordre de lecture des messages.
 *  - "asc"    : les N PLUS ANCIENS, ordre chronologique (affichage du fil).
 *  - "recent" : les N PLUS RÉCENTS, renvoyés en ordre chronologique
 *    (contexte LLM) — sans cette option, une conversation longue tronquait
 *    le contexte aux tout premiers échanges et l'agent « oubliait » la fin.
 */
export type ListMessagesOrder = "asc" | "recent";

type MessageDoc = Record<string, unknown> & { id?: string };

function messageFrom(id: string, conversationId: string, userId: string, x: MessageDoc): ChatMessage {
  return {
    id,
    conversationId,
    userId,
    role: x.role,
    content: String(x.content ?? ""),
    attachments: attachmentsFrom(x.attachments),
    citations: citationsFrom(x.citations),
    generationStatus: x.generationStatus === "failed" ? ("failed" as const) : ("complete" as const),
    provider: x.provider,
    model: x.model,
    imageUrl: typeof x.imageUrl === "string" ? x.imageUrl : undefined,
    runId: typeof x.runId === "string" ? x.runId : undefined,
    connectors: Array.isArray(x.connectors)
      ? x.connectors.filter((c: unknown): c is string => typeof c === "string" && c.length > 0 && c.length <= 60)
      : undefined,
    usage: x.usage,
    createdAt: iso(x.createdAt),
  } as ChatMessage;
}

export async function listMessages(
  userId: string,
  conversationId: string,
  limit = 100,
  options: { order?: ListMessagesOrder } = {},
): Promise<ChatMessage[]> {
  if (!(await getConversation(userId, conversationId))) throw new Error("Conversation introuvable.");
  const capped = Math.min(limit, 200);
  const recent = options.order === "recent";
  const filters = [
    { field: "conversationId", value: conversationId },
    { field: "userId", value: userId },
  ];
  let docs: MessageDoc[];
  try {
    docs = await resilientQuery<MessageDoc>("chatMessages", filters, {
      orderField: "createdAt",
      descending: recent,
      // Scan borné puis tri mémoire + découpage : un `limit(capped)` côté
      // Firestore renverrait des documents ARBITRAIRES — le contexte LLM
      // exige les VRAIS N plus récents/anciens (RC3, plan 20).
      limit: SCAN_LIMIT,
      includeIds: true,
    });
  } catch {
    // Repli SANS index (déploiement d'index en attente) : requête filtrée
    // simple puis tri en mémoire — le contexte LLM ne casse jamais.
    docs = await resilientQuery<MessageDoc>("chatMessages", filters, { limit: SCAN_LIMIT, includeIds: true });
  }
  const messages = docs.map((x) => messageFrom(String(x.id), conversationId, userId, x));
  // Tri chronologique déterministe, puis fenêtre demandée :
  //  - "recent" : la FIN du fil (les N plus récents), réordonnée asc ;
  //  - "asc"    : le DÉBUT du fil (les N plus anciens).
  messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return recent && messages.length > capped ? messages.slice(-capped) : messages.slice(0, capped);
}

export async function appendMessage(input: Omit<ChatMessage, "id" | "createdAt">) {
  const ref = adminDb.collection("chatMessages").doc();
  const now = new Date();
  // Rattachement projet de la conversation (capturé pendant la transaction,
  // sans lecture Firestore supplémentaire) : sert au filtrage du miroir
  // vectoriel par projet (recherche sémantique contextuelle).
  let conversationProjectId: string | null = null;
  let transactionDone = false;
  try {
    // CHEMIN NOMINAL : transaction Firestore (atomicité message + compteur).
    // Disjoncteur ouvert : ni transaction ni sonde gaspillée — repli direct.
    if (!shouldShortCircuitFirestore()) {
      await adminDb.runTransaction(async tx => {
        const conversation = conversationRef(input.conversationId);
        const snap = await tx.get(conversation);
        if (!snap.exists || snap.data()?.userId !== input.userId) throw new Error("Conversation introuvable.");
        const data = snap.data();
        if (typeof data?.projectId === "string" && data.projectId.length > 0) {
          conversationProjectId = data.projectId;
        }
        tx.set(ref, {
          ...input,
          generationStatus: input.generationStatus ?? "complete",
          createdAt: now,
        });
        const current = Number(snap.data()?.messageCount ?? 0);
        tx.update(conversation, { messageCount: current + 1, updatedAt: now });
      });
      transactionDone = true;
    }
  } catch (error) {
    // QUOTA (ou disjoncteur fraîchement ouvert) : décomposition résiliente.
    // Les incidents TRANSITOIRES et métier restent rejetés (comportement
    // historique : retry côté appelant).
    if (!isFirestoreQuotaError(error) && !shouldShortCircuitFirestore()) throw error;
  }
  if (!transactionDone) {
    // QUOTA (ou disjoncteur ouvert) : décomposition résiliente sur le miroir
    // Supabase — get (garde d'ownership) + create (message) + set merge
    // (compteur incrémenté, résolu côté miroir). L'atomicité message/compteur
    // cède devant la DISPONIBILITÉ du chat.
    const conversation = await resilientGet<ConversationDoc>("chatConversations", input.conversationId);
    if (!conversation || conversation.userId !== input.userId) throw new Error("Conversation introuvable.");
    if (typeof conversation.projectId === "string" && conversation.projectId.length > 0) {
      conversationProjectId = conversation.projectId;
    }
    await resilientCreate(
      "chatMessages",
      ref.id,
      { ...input, generationStatus: input.generationStatus ?? "complete", createdAt: now },
      input.userId,
    );
    await resilientSet(
      "chatConversations",
      input.conversationId,
      { messageCount: FieldValue.increment(1), updatedAt: now },
      { merge: true, ownerId: input.userId },
    );
  }
  const saved: ChatMessage = { ...input, generationStatus: input.generationStatus ?? "complete", id: ref.id, createdAt: now.toISOString() };

  // Miroir vectoriel (recherche sémantique de l'historique) : best-effort,
  // après la persistance Firestore. L'indexation n'ajoute que l'appel
  // d'embedding (~200-400 ms) à un tour de chat qui dure déjà plusieurs
  // secondes ; elle ne peut JAMAIS faire échouer l'envoi du message.
  // (Serveur : on attend — un travail « fire-and-forget » serait tué par
  // la fin de l'invocation serverless avant d'être envoyé.)
  try {
    await indexConversationMessage({
      messageId: saved.id,
      conversationId: saved.conversationId,
      userId: saved.userId,
      role: saved.role,
      content: saved.content,
      createdAt: saved.createdAt,
      projectId: conversationProjectId,
    });
  } catch {
    // Déjà avalé dans indexConversationMessage — double ceinture.
  }

  return saved;
}

export async function renameConversation(userId: string, id: string, title: string) {
  const conversation = await getConversation(userId, id);
  if (!conversation) throw new Error("Conversation introuvable.");
  await resilientSet(
    "chatConversations",
    id,
    { title: title.trim().slice(0, 120), updatedAt: new Date() },
    { merge: true, ownerId: userId },
  );
}

/** Mise à jour partielle (projet, agent, statut, modèle) d'une conversation. */
export async function updateConversation(
  userId: string,
  id: string,
  patch: { projectId?: string | null; agentId?: string; status?: ConversationStatus; model?: string; provider?: string },
) {
  if (!(await getConversation(userId, id))) throw new Error("Conversation introuvable.");
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.projectId !== undefined) {
    // null détache le projet ; une chaîne non vide le rattache.
    // FieldValue.delete() : la clé est retirée de Firestore ET écartée du
    // miroir (assainissement) — pas de résurrection du projet côté repli.
    update.projectId = patch.projectId || FieldValue.delete();
  }
  if (patch.agentId) {
    // Rattachement d'un fil à un agent IA : le backfill des fils legacy
    // créés sans agentId rend l'historique scopé par agent complet.
    update.agentId = patch.agentId;
  }
  if (patch.status) update.status = patch.status;
  if (patch.model) update.model = patch.model;
  if (patch.provider) update.provider = patch.provider;
  await resilientSet("chatConversations", id, update, { merge: true, ownerId: userId });
  return getConversation(userId, id);
}

export async function deleteConversation(userId: string, id: string) {
  if (!(await getConversation(userId, id))) throw new Error("Conversation introuvable.");
  // Purge des messages : Firestore-first (les identifiants de messages ne
  // vivent que dans les ids de documents, hors payload). Sous quota, les
  // messages orphelins restent en place (aucune route ne les expose sans
  // conversation) — la conversation, elle, disparaît des DEUX stores via
  // resilientDelete ci-dessous.
  try {
    // Purge par lots de 450 jusqu'à épuisement (limite Firestore : 500 ops
    // par batch) — l'ancien `.limit(500)` unique laissait des messages
    // orphelins au-delà de 500.
    for (;;) {
      const messages = await adminDb.collection("chatMessages").where("conversationId", "==", id).where("userId", "==", userId).limit(CHUNKED_COMMIT_SIZE).get();
      const messageDocs = messages.docs;
      if (messageDocs.length === 0) break;
      const ops: ChunkedWriteOp[] = messageDocs.map((d) => ({ kind: "delete" as const, ref: d.ref }));
      await commitOpsInChunks(adminDb, ops);
      if (messageDocs.length < CHUNKED_COMMIT_SIZE) break;
    }
  } catch (error) {
    if (!isFirestoreQuotaError(error) && !shouldShortCircuitFirestore()) throw error;
    // Quota : purge Firestore des messages différée — ne bloque JAMAIS la
    // suppression de la conversation (pivot de l'historique).
  }
  await resilientDelete("chatConversations", id);
}

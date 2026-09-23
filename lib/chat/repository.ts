import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import type {
  ConversationMessage,
  ConversationStatus,
  MessageAttachment,
  MessageCitation,
} from "@/lib/domain/conversations/types";

export interface ChatConversation {
  id: string;
  userId: string;
  title: string;
  /** Projet de rattachement (Conversation-first). */
  projectId?: string;
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

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return new Date().toISOString();
}

export async function createConversation(
  userId: string,
  title = "Nouvelle conversation",
  options: { projectId?: string } = {},
) {
  const ref = adminDb.collection("chatConversations").doc();
  const now = new Date();
  await ref.set({
    userId, title: title.slice(0, 120), messageCount: 0,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    status: "active" as const,
    createdAt: now, updatedAt: now,
  });
  return {
    id: ref.id, userId, title, messageCount: 0,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    status: "active" as const,
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

export async function listConversations(
  userId: string,
  limit = 50,
  options: { projectId?: string; query?: string } = {},
): Promise<ChatConversation[]> {
  let snap;
  if (options.projectId) {
    snap = await adminDb
      .collection("chatConversations")
      .where("userId", "==", userId)
      .where("projectId", "==", options.projectId)
      .orderBy("updatedAt", "desc")
      .limit(Math.min(limit, 100))
      .get();
  } else {
    snap = await adminDb.collection("chatConversations").where("userId", "==", userId).orderBy("updatedAt", "desc").limit(Math.min(limit, 100)).get();
  }
  let conversations = snap.docs.map(d => {
    const x = d.data();
    return {
      id: d.id,
      userId: x.userId,
      title: String(x.title ?? "Nouvelle conversation"),
      projectId: typeof x.projectId === "string" ? x.projectId : undefined,
      model: x.model,
      provider: x.provider,
      status: x.status === "archived" ? ("archived" as const) : ("active" as const),
      messageCount: Number(x.messageCount ?? 0),
      createdAt: iso(x.createdAt),
      updatedAt: iso(x.updatedAt),
    };
  });
  const query = options.query?.trim().toLowerCase();
  if (query) {
    conversations = conversations.filter((c) => c.title.toLowerCase().includes(query));
  }
  return conversations;
}

/** Dernière conversation de l'utilisateur (accueil « Reprendre »). */
export async function findLatestConversation(userId: string): Promise<ChatConversation | null> {
  const snap = await adminDb
    .collection("chatConversations")
    .where("userId", "==", userId)
    .orderBy("updatedAt", "desc")
    .limit(1)
    .get();
  const doc = snap.docs[0];
  if (!doc) return null;
  const x = doc.data();
  return {
    id: doc.id,
    userId: x.userId,
    title: String(x.title ?? "Nouvelle conversation"),
    projectId: typeof x.projectId === "string" ? x.projectId : undefined,
    status: x.status === "archived" ? "archived" : "active",
    messageCount: Number(x.messageCount ?? 0),
    createdAt: iso(x.createdAt),
    updatedAt: iso(x.updatedAt),
  };
}

export async function getConversation(userId: string, id: string) {
  const snap = await conversationRef(id).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  const x = snap.data()!;
  return {
    id: snap.id,
    userId: x.userId,
    title: String(x.title ?? "Nouvelle conversation"),
    projectId: typeof x.projectId === "string" ? x.projectId : undefined,
    model: x.model,
    provider: x.provider,
    status: x.status === "archived" ? ("archived" as const) : ("active" as const),
    messageCount: Number(x.messageCount ?? 0),
    createdAt: iso(x.createdAt),
    updatedAt: iso(x.updatedAt),
  } as ChatConversation;
}

export async function listMessages(userId: string, conversationId: string, limit = 100): Promise<ChatMessage[]> {
  if (!(await getConversation(userId, conversationId))) throw new Error("Conversation introuvable.");
  const snap = await adminDb.collection("chatMessages").where("conversationId", "==", conversationId).where("userId", "==", userId).orderBy("createdAt", "asc").limit(Math.min(limit, 200)).get();
  return snap.docs.map(d => {
    const x = d.data();
    return {
      id: d.id,
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
    };
  });
}

export async function appendMessage(input: Omit<ChatMessage, "id" | "createdAt">) {
  const ref = adminDb.collection("chatMessages").doc();
  const now = new Date();
  await adminDb.runTransaction(async tx => {
    const conversation = conversationRef(input.conversationId);
    const snap = await tx.get(conversation);
    if (!snap.exists || snap.data()?.userId !== input.userId) throw new Error("Conversation introuvable.");
    tx.set(ref, {
      ...input,
      generationStatus: input.generationStatus ?? "complete",
      createdAt: now,
    });
    const current = Number(snap.data()?.messageCount ?? 0);
    tx.update(conversation, { messageCount: current + 1, updatedAt: FieldValue.serverTimestamp() });
  });
  return { ...input, generationStatus: input.generationStatus ?? "complete", id: ref.id, createdAt: now.toISOString() };
}

export async function renameConversation(userId: string, id: string, title: string) {
  const conversation = await getConversation(userId, id);
  if (!conversation) throw new Error("Conversation introuvable.");
  await conversationRef(id).update({ title: title.trim().slice(0, 120), updatedAt: FieldValue.serverTimestamp() });
}

/** Mise à jour partielle (projet, statut, modèle) d'une conversation. */
export async function updateConversation(
  userId: string,
  id: string,
  patch: { projectId?: string | null; status?: ConversationStatus; model?: string; provider?: string },
) {
  if (!(await getConversation(userId, id))) throw new Error("Conversation introuvable.");
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (patch.projectId !== undefined) {
    // null détache le projet ; une chaîne non vide le rattache.
    update.projectId = patch.projectId || FieldValue.delete();
  }
  if (patch.status) update.status = patch.status;
  if (patch.model) update.model = patch.model;
  if (patch.provider) update.provider = patch.provider;
  await conversationRef(id).update(update);
  return getConversation(userId, id);
}

export async function deleteConversation(userId: string, id: string) {
  if (!(await getConversation(userId, id))) throw new Error("Conversation introuvable.");
  const messages = await adminDb.collection("chatMessages").where("conversationId", "==", id).where("userId", "==", userId).limit(500).get();
  const batch = adminDb.batch();
  messages.docs.forEach(d => batch.delete(d.ref));
  batch.delete(conversationRef(id));
  await batch.commit();
}

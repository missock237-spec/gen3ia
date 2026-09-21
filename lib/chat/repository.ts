import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";

export interface ChatConversation {
  id: string;
  userId: string;
  title: string;
  model?: string;
  provider?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  provider?: string;
  model?: string;
  /** URL d'une image générée (Agnes AI) jointe à la réponse. */
  imageUrl?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  createdAt: string;
}

const conversationRef = (id: string) => adminDb.collection("chatConversations").doc(id);

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object" && "toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return new Date().toISOString();
}

export async function createConversation(userId: string, title = "Nouvelle conversation") {
  const ref = adminDb.collection("chatConversations").doc();
  const now = new Date();
  await ref.set({
    userId, title: title.slice(0, 120), messageCount: 0,
    createdAt: now, updatedAt: now,
  });
  return { id: ref.id, userId, title, messageCount: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

export async function listConversations(userId: string, limit = 50): Promise<ChatConversation[]> {
  const snap = await adminDb.collection("chatConversations").where("userId", "==", userId).orderBy("updatedAt", "desc").limit(Math.min(limit, 100)).get();
  return snap.docs.map(d => {
    const x = d.data();
    return { id: d.id, userId: x.userId, title: String(x.title ?? "Nouvelle conversation"), model: x.model, provider: x.provider, messageCount: Number(x.messageCount ?? 0), createdAt: iso(x.createdAt), updatedAt: iso(x.updatedAt) };
  });
}

export async function getConversation(userId: string, id: string) {
  const snap = await conversationRef(id).get();
  if (!snap.exists || snap.data()?.userId !== userId) return null;
  return { id: snap.id, ...snap.data() } as ChatConversation;
}

export async function listMessages(userId: string, conversationId: string, limit = 100): Promise<ChatMessage[]> {
  if (!(await getConversation(userId, conversationId))) throw new Error("Conversation introuvable.");
  const snap = await adminDb.collection("chatMessages").where("conversationId", "==", conversationId).where("userId", "==", userId).orderBy("createdAt", "asc").limit(Math.min(limit, 200)).get();
  return snap.docs.map(d => {
    const x = d.data();
    return { id: d.id, conversationId, userId, role: x.role, content: String(x.content ?? ""), provider: x.provider, model: x.model, imageUrl: typeof x.imageUrl === "string" ? x.imageUrl : undefined, usage: x.usage, createdAt: iso(x.createdAt) };
  });
}

export async function appendMessage(input: Omit<ChatMessage, "id" | "createdAt">) {
  const ref = adminDb.collection("chatMessages").doc();
  const now = new Date();
  await adminDb.runTransaction(async tx => {
    const conversation = conversationRef(input.conversationId);
    const snap = await tx.get(conversation);
    if (!snap.exists || snap.data()?.userId !== input.userId) throw new Error("Conversation introuvable.");
    tx.set(ref, { ...input, createdAt: now });
    const current = Number(snap.data()?.messageCount ?? 0);
    tx.update(conversation, { messageCount: current + 1, updatedAt: FieldValue.serverTimestamp() });
  });
  return { ...input, id: ref.id, createdAt: now.toISOString() };
}

export async function renameConversation(userId: string, id: string, title: string) {
  const conversation = await getConversation(userId, id);
  if (!conversation) throw new Error("Conversation introuvable.");
  await conversationRef(id).update({ title: title.trim().slice(0, 120), updatedAt: FieldValue.serverTimestamp() });
}

export async function deleteConversation(userId: string, id: string) {
  if (!(await getConversation(userId, id))) throw new Error("Conversation introuvable.");
  const messages = await adminDb.collection("chatMessages").where("conversationId", "==", id).where("userId", "==", userId).limit(500).get();
  const batch = adminDb.batch();
  messages.docs.forEach(d => batch.delete(d.ref));
  batch.delete(conversationRef(id));
  await batch.commit();
}

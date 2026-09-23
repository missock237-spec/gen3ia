import "server-only";

import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { maskSecrets } from "@/lib/security/secret-masking";

/**
 * Sessions du terminal agent — « terminal partagé par projet ».
 *
 * Chaque commande exécutée par un agent via `terminal.execute` est
 * enregistrée dans une session Firestore :
 *  - la session est rattachée au projet (sinon conversation, sinon un
 *    espace « agent » global de l'utilisateur) ;
 *  - les entrées constituent la piste d'audit (qui, quoi, résultat, mode)
 *    ET le flux temps réel affiché dans le Workshop IDE ;
 *  - les secrets éventuellement présents dans la sortie sont masqués
 *    AVANT toute persistance ;
 *  - la rétention de sortie est contrôlée (plafond d'entrées par session,
 *    purge des plus anciennes) ;
 *  - un échec d'enregistrement n'interrompt JAMAIS l'exécution de l'agent
 *    (fonctions fail-soft : elles renvoient null au lieu de lever).
 */

const SESSIONS_COLLECTION = "agentTerminalSessions";
const ENTRIES_SUBCOLLECTION = "entries";
const MAX_ENTRIES_PER_SESSION = 500;
const TRIM_TO = 400;

export type TerminalSessionStatus = "active" | "stopped";

export interface TerminalSession {
  id: string;
  userId: string;
  projectId?: string;
  conversationId?: string;
  title: string;
  status: TerminalSessionStatus;
  commandCount: number;
  lastCommand?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalEntry {
  index: number;
  command: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  /** Mode réellement employé : sandbox Docker ou simulation intégrée. */
  mode?: "sandbox" | "simulation";
  engine?: string | null;
  success?: boolean;
  error?: string;
  createdAt: string;
}

const OUTPUT_CAP_CHARS = 100_000;

function cap(text: string | undefined): string | undefined {
  if (!text) return text;
  if (text.length <= OUTPUT_CAP_CHARS) return text;
  return `${text.slice(0, OUTPUT_CAP_CHARS)}\n[sortie tronquée : ${text.length - OUTPUT_CAP_CHARS} caractères supplémentaires]`;
}

function sessionFrom(id: string, data: FirebaseFirestore.DocumentData): TerminalSession {
  return {
    id,
    userId: String(data.userId ?? ""),
    projectId: typeof data.projectId === "string" ? data.projectId : undefined,
    conversationId: typeof data.conversationId === "string" ? data.conversationId : undefined,
    title: String(data.title ?? "Terminal agent"),
    status: data.status === "stopped" ? "stopped" : "active",
    commandCount: Number(data.commandCount ?? 0),
    lastCommand: typeof data.lastCommand === "string" ? data.lastCommand : undefined,
    createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: data.updatedAt instanceof Date ? data.updatedAt.toISOString() : new Date().toISOString(),
  };
}

function entryFrom(data: FirebaseFirestore.DocumentData): TerminalEntry {
  return {
    index: Number(data.index ?? 0),
    command: String(data.command ?? ""),
    stdout: typeof data.stdout === "string" ? data.stdout : undefined,
    stderr: typeof data.stderr === "string" ? data.stderr : undefined,
    exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined,
    durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
    mode: data.mode === "sandbox" ? "sandbox" : data.mode === "simulation" ? "simulation" : undefined,
    engine: typeof data.engine === "string" ? data.engine : null,
    success: Boolean(data.success),
    error: typeof data.error === "string" ? data.error : undefined,
    createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : new Date().toISOString(),
  };
}

function sessionsDb(): Firestore {
  return adminDb;
}

/** Crée (ou retrouve) la session terminal d'un contexte donné. */
export async function ensureTerminalSession(params: {
  userId: string;
  sessionId?: string;
  projectId?: string;
  conversationId?: string;
}): Promise<TerminalSession | null> {
  try {
    const db = sessionsDb();
    if (params.sessionId) {
      const ref = db.collection(SESSIONS_COLLECTION).doc(params.sessionId);
      const snapshot = await ref.get();
      if (snapshot.exists && snapshot.get("userId") === params.userId) return sessionFrom(snapshot.id, snapshot.data() ?? {});
    }
    const scopeId = params.projectId
      ? `project:${params.projectId}`
      : params.conversationId
        ? `conversation:${params.conversationId}`
        : "agent";
    const query = await db
      .collection(SESSIONS_COLLECTION)
      .where("userId", "==", params.userId)
      .where("scopeKey", "==", scopeId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    if (!query.empty) {
      const doc = query.docs[0];
      return sessionFrom(doc.id, doc.data());
    }
    const now = new Date();
    const created = await db.collection(SESSIONS_COLLECTION).add({
      userId: params.userId,
      scopeKey: scopeId,
      projectId: params.projectId ?? null,
      conversationId: params.conversationId ?? null,
      title: params.projectId ? `Terminal · ${params.projectId}` : params.conversationId ? `Terminal · conversation` : "Terminal des agents",
      status: "active" satisfies TerminalSessionStatus,
      commandCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return sessionFrom(created.id, (await created.get()).data() ?? {});
  } catch {
    return null;
  }
}

export interface RecordTerminalExecutionInput {
  userId: string;
  sessionId?: string;
  projectId?: string;
  conversationId?: string;
  command: string;
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  mode?: "sandbox" | "simulation";
  engine?: string | null;
  error?: string;
}

/**
 * Enregistre une exécution de commande agent dans la session — piste
 * d'audit + flux temps réel. Secrets masqués, sortie plafonnée, rétention
 * contrôlée, échec jamais bloquant (renvoie null).
 */
export async function recordTerminalExecution(input: RecordTerminalExecutionInput): Promise<TerminalEntry | null> {
  try {
    const session =
      (await ensureTerminalSession({ userId: input.userId, sessionId: input.sessionId, projectId: input.projectId, conversationId: input.conversationId })) ??
      (await ensureTerminalSession({ userId: input.userId }));
    if (!session) return null;

    const now = new Date();
    const entry = {
      command: maskSecrets(input.command.slice(0, 50_000)),
      stdout: cap(maskSecrets(input.stdout ?? "")) || undefined,
      stderr: cap(maskSecrets(input.stderr ?? "")) || undefined,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      mode: input.mode,
      engine: input.engine ?? null,
      success: input.success,
      error: input.error ? maskSecrets(input.error.slice(0, 2_000)) : undefined,
      createdAt: now,
    };

    const db = sessionsDb();
    const sessionRef = db.collection(SESSIONS_COLLECTION).doc(session.id);
    const entryRef = sessionRef.collection(ENTRIES_SUBCOLLECTION).doc();
    const countRef = sessionRef.collection(ENTRIES_SUBCOLLECTION).doc("__meta");
    const countSnapshot = await countRef.get();
    const nextIndex = Number(countSnapshot.get("count") ?? 0);

    await db.runTransaction(async (tx) => {
      tx.set(countRef, { count: nextIndex + 1, updatedAt: now }, { merge: true });
      tx.set(entryRef, { ...entry, index: nextIndex });
      tx.update(sessionRef, {
        commandCount: FieldValue.increment(1),
        lastCommand: entry.command.slice(0, 200),
        updatedAt: now,
      });
    });

    // Rétention contrôlée : au-delà du plafond, purge des plus anciennes
    // (best-effort — la suppression en échec n'affecte ni l'agent ni l'IDE).
    if (nextIndex + 1 > MAX_ENTRIES_PER_SESSION) {
      const stale = await sessionRef
        .collection(ENTRIES_SUBCOLLECTION)
        .where("index", "<", nextIndex + 1 - TRIM_TO)
        .limit(TRIM_TO)
        .get()
        .catch(() => null);
      if (stale && !stale.empty) {
        const batch = db.batch();
        stale.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit().catch(() => undefined);
      }
    }

    return { ...entry, index: nextIndex, createdAt: now.toISOString() };
  } catch {
    return null;
  }
}

/** Liste les sessions terminal d'un utilisateur (les plus récentes d'abord). */
export async function listTerminalSessions(userId: string, limit = 30): Promise<TerminalSession[]> {
  try {
    const query = await sessionsDb()
      .collection(SESSIONS_COLLECTION)
      .where("userId", "==", userId)
      .orderBy("updatedAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 100))
      .get();
    return query.docs.map((doc) => sessionFrom(doc.id, doc.data()));
  } catch {
    return [];
  }
}

/** Entrées d'une session, éventuellement à partir d'un index (polling live). */
export async function getTerminalEntries(userId: string, sessionId: string, sinceIndex = -1, limit = 200): Promise<TerminalEntry[]> {
  try {
    const sessionRef = sessionsDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const snapshot = await sessionRef.get();
    if (!snapshot.exists || snapshot.get("userId") !== userId) return [];
    const query = await sessionRef
      .collection(ENTRIES_SUBCOLLECTION)
      .where("index", ">", sinceIndex)
      .orderBy("index", "asc")
      .limit(Math.min(Math.max(limit, 1), 500))
      .get();
    return query.docs.filter((doc) => doc.id !== "__meta").map((doc) => entryFrom(doc.data()));
  } catch {
    return [];
  }
}

/** La session accepte-t-elle encore des commandes ? (arrêt utilisateur) */
export async function isTerminalSessionActive(userId: string, sessionId: string): Promise<boolean> {
  try {
    const snapshot = await sessionsDb().collection(SESSIONS_COLLECTION).doc(sessionId).get();
    return snapshot.exists && snapshot.get("userId") === userId && snapshot.get("status") !== "stopped";
  } catch {
    // En cas d'incident de lecture on reste permissif : l'agent ne doit pas
    // être bloqué par une panne d'affichage.
    return true;
  }
}

/** Arrêt d'une session par l'utilisateur (aucune nouvelle commande acceptée). */
export async function stopTerminalSession(userId: string, sessionId: string): Promise<boolean> {
  try {
    const ref = sessionsDb().collection(SESSIONS_COLLECTION).doc(sessionId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.get("userId") !== userId) return false;
    await ref.update({ status: "stopped" satisfies TerminalSessionStatus, updatedAt: new Date() });
    return true;
  } catch {
    return false;
  }
}

import "server-only";

import {
  listKeys,
  newUlid,
  patchJson,
  readJsonIfExists,
  removeKey,
  removePrefix,
  userDir,
  userKey,
  writeJson,
} from "@/lib/storage/user-data-store";

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
 * Dépôt conversations/messages (Task 109-b) — adossé à la MÉMOIRE R2 PAR
 * UTILISATEUR (lib/storage/user-data-store, contrat Task 109-a). Chaque
 * conversation est un document JSON `users/{uid}/conversations/{cid}.json`
 * et chaque message un objet PROPRE `users/{uid}/conversations/{cid}/
 * messages/{ulid}.json` — l'identifiant du message est l'ULID de sa clé
 * (tri lexicographique = ordre chronologique).
 *
 * Règles respectées (surface d'API strictement identique à l'ère
 * précédente — zéro modification de route nécessaire) :
 *  - horodatages normalisés en ISO strings à la lecture (`iso`, qui accepte
 *    les chaînes ISO stockées) ;
 *  - garde d'ownership (userId) reproduite sur tous les chemins — la
 *    conversation d'un autre utilisateur est indiscernable d'une absente
 *    (et les clés sont de toute façon scopées par uid) ;
 *  - appendMessage : écriture du message = objet propre (pas de compteur
 *    partagé) ; la méta conversation (compteur + dernier message +
 *    horodatages) est patchée en BEST-EFFORT avec 1 retry — un échec de
 *    patch n'annule JAMAIS le message déjà persisté ;
 *  - listConversations : scan du préfixe (cap 500 clés), filtrage EXACT
 *    `{cid}.json` (les messages ne sont jamais pris pour des
 *    conversations), tri updatedAt desc en mémoire, slice sur la limite
 *    demandée (cap 100) ;
 *  - listMessages : tri lexicographique des clés ULID (= chronologique),
 *    fenêtre demandée — "asc" : début du fil ; "recent" : fin du fil,
 *    renvoyée en ordre chronologique (contrat RC3 conservé).
 */

/** Cap de scan des préfixes (règle transverse Task 109). */
const SCAN_MAX_OBJECTS = 500;

/** Cap de la fenêtre de MESSAGES renvoyée (parité avec le contrat RC3). */
const MESSAGES_RESULT_CAP = 200;

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

/* ------------------------------------------------------------------ */
/* Clés canoniques (mémoire R2 par utilisateur)                        */
/* ------------------------------------------------------------------ */

const JSON_SUFFIX = ".json";

const conversationsPrefix = (uid: string) => `${userDir(uid, "conversations")}/`;
const conversationKey = (uid: string, cid: string) => userKey(uid, "conversations", cid);
const messagesPrefix = (uid: string, cid: string) => `${userDir(uid, "conversations", cid, "messages")}/`;
const messageKey = (uid: string, cid: string, mid: string) => userKey(uid, "conversations", cid, "messages", mid);

/** Horodatage lisible : chaîne ISO (documents R2) ou autre forme acceptée → ISO. */
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
  // Identifiant ULID généré localement (aucune I/O) : tri lexicographique ≈
  // ordre de création, mais la liste trie par updatedAt.
  const id = newUlid();
  const now = new Date();
  await writeJson(conversationKey(userId, id), {
    v: 1,
    id,
    userId,
    title: title.slice(0, 120),
    messageCount: 0,
    status: "active" as const,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
  });
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
  const prefix = conversationsPrefix(userId);
  const objets = await listKeys(prefix, { maxObjects: SCAN_MAX_OBJECTS });
  // Filtrage EXACT : `conversations/{cid}.json` — une seule extension, aucun
  // sous-dossier (les messages vivent dans conversations/{cid}/messages/ et
  // ne doivent JAMAIS être comptés comme des conversations).
  const cles = objets
    .map((objet) => objet.key)
    .filter((key) =>
      key.startsWith(prefix) &&
      key.endsWith(JSON_SUFFIX) &&
      !key.slice(prefix.length, key.length - JSON_SUFFIX.length).includes("/"),
    );
  // Lecture en lots (parallèle) des méta-documents ; les clés disparues
  // entre le listage et la lecture (course avec une suppression) → null.
  const docs = await Promise.all(cles.map((key) => readJsonIfExists<ConversationDoc>(key)));
  let conversations: ChatConversation[] = [];
  for (let index = 0; index < cles.length; index += 1) {
    const doc = docs[index];
    if (!doc) continue;
    // Le cid vient de la CLÉ (identité stable), pas du document.
    const cid = cles[index].slice(prefix.length, cles[index].length - JSON_SUFFIX.length);
    conversations.push(conversationFrom(cid, doc));
  }
  // Filtres en mémoire (mêmes critères qu'historiquement).
  if (options.agentId) {
    // Historique scopé à un agent IA : seuls ses fils sont listés.
    conversations = conversations.filter((c) => c.agentId === options.agentId);
  }
  if (options.projectId) conversations = conversations.filter((c) => c.projectId === options.projectId);
  // Recherche textuelle : correspondance littérale sur le titre.
  const query = options.query?.trim().toLowerCase();
  if (query) {
    conversations = conversations.filter((c) => c.title.toLowerCase().includes(query));
  }
  // Tri updatedAt desc (ISO comparables), puis fenêtre demandée.
  conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return conversations.slice(0, capped);
}

/** Dernière conversation de l'utilisateur (accueil « Reprendre »). */
export async function findLatestConversation(userId: string): Promise<ChatConversation | null> {
  // Réutilise listConversations(limit 1) : même scan borné, même tri.
  const [latest] = await listConversations(userId, 1);
  return latest ?? null;
}

export async function getConversation(userId: string, id: string) {
  const doc = await readJsonIfExists<ConversationDoc>(conversationKey(userId, id));
  // Garde d'ownership identique au chemin historique : une conversation d'un
  // autre utilisateur est indiscernable d'une absente.
  if (!doc || doc.userId !== userId) return null;
  return conversationFrom(id, doc);
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
  const capped = Math.min(limit, MESSAGES_RESULT_CAP);
  const recent = options.order === "recent";
  const prefix = messagesPrefix(userId, conversationId);
  // Tri lexicographique des clés = ordre chronologique (ULID) : le fil est
  // reconstitué depuis les CLÉS, plus depuis les horodatages.
  const cles = (await listKeys(prefix, { maxObjects: SCAN_MAX_OBJECTS }))
    .map((objet) => objet.key)
    .filter((key) => key.endsWith(JSON_SUFFIX))
    .sort();
  // Fenêtre demandée posée AVANT lecture :
  //  - "recent" : la FIN du fil (les N plus récents) ;
  //  - "asc"    : le DÉBUT du fil (les N plus anciens).
  const fenetre = recent && cles.length > capped ? cles.slice(-capped) : cles.slice(0, capped);
  const docs = await Promise.all(fenetre.map((key) => readJsonIfExists<ConversationDoc>(key)));
  const messages: ChatMessage[] = [];
  for (let index = 0; index < fenetre.length; index += 1) {
    const doc = docs[index];
    if (!doc) continue;
    // L'id du message = l'ULID de sa clé (les deux sont identiques dans le
    // document ; la clé fait foi).
    const mid = fenetre[index].slice(prefix.length, fenetre[index].length - JSON_SUFFIX.length);
    messages.push(messageFrom(mid, conversationId, userId, doc));
  }
  return messages;
}

export async function appendMessage(input: Omit<ChatMessage, "id" | "createdAt">) {
  const now = new Date();
  // Garde d'ownership + capture du rattachement projet de la conversation :
  // sert au filtrage du miroir vectoriel par projet (recherche sémantique
  // contextuelle).
  const meta = await readJsonIfExists<ConversationDoc>(conversationKey(input.userId, input.conversationId));
  if (!meta || meta.userId !== input.userId) throw new Error("Conversation introuvable.");
  const conversationProjectId =
    typeof meta.projectId === "string" && meta.projectId.length > 0 ? meta.projectId : null;

  // Message = objet PROPRE (pas de compteur partagé) : id = ULID de la clé.
  const id = newUlid(now);
  const saved: ChatMessage = {
    ...input,
    generationStatus: input.generationStatus ?? "complete",
    id,
    createdAt: now.toISOString(),
  };
  await writeJson(messageKey(input.userId, input.conversationId, id), {
    v: 1,
    ...saved,
    ulid: id,
  });

  // Méta conversation : patch BEST-EFFORT (compteur + dernier message +
  // horodatages). Le message ci-dessus est déjà persisté : un échec du
  // patch (course concurrente, incident ponctuel) ne le remet JAMAIS en
  // cause — 1 retry puis abandon silencieux (la lecture du fil liste les
  // messages par clés, le compteur n'est qu'une indication d'affichage).
  const metaKey = conversationKey(input.userId, input.conversationId);
  const preview = (input.content ?? "").trim().slice(0, 120);
  const patchMeta = () =>
    patchJson<ConversationDoc>(metaKey, {
      messageCount: Number(meta.messageCount ?? 0) + 1,
      ...(preview ? { lastMessagePreview: preview } : {}),
      lastMessageAt: saved.createdAt,
      updatedAt: saved.createdAt,
    });
  try {
    await patchMeta();
  } catch {
    try {
      await patchMeta();
    } catch {
      // Best-effort assumé : un seul retry, puis on continue sans la méta.
    }
  }

  // Miroir vectoriel (recherche sémantique de l'historique) : best-effort,
  // après la persistance R2. L'indexation n'ajoute que l'appel d'embedding
  // à un tour de chat qui dure déjà plusieurs secondes ; elle ne peut
  // JAMAIS faire échouer l'envoi du message. (Serveur : on attend — un
  // travail « fire-and-forget » serait tué par la fin de l'invocation
  // serverless avant d'être envoyé.)
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
  await patchJson<ConversationDoc>(conversationKey(userId, id), {
    title: title.trim().slice(0, 120),
    updatedAt: new Date().toISOString(),
  });
}

/** Mise à jour partielle (projet, agent, statut, modèle) d'une conversation. */
export async function updateConversation(
  userId: string,
  id: string,
  patch: { projectId?: string | null; agentId?: string; status?: ConversationStatus; model?: string; provider?: string },
) {
  if (!(await getConversation(userId, id))) throw new Error("Conversation introuvable.");
  const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.projectId !== undefined) {
    // null détache le projet ; une chaîne non vide le rattache. La valeur
    // `undefined` est omise à la sérialisation canonique : la clé disparaît
    // proprement du document (pas de trace résiduelle du rattachement).
    update.projectId = patch.projectId || undefined;
  }
  if (patch.agentId) {
    // Rattachement d'un fil à un agent IA : le backfill des fils legacy
    // créés sans agentId rend l'historique scopé par agent complet.
    update.agentId = patch.agentId;
  }
  if (patch.status) update.status = patch.status;
  if (patch.model) update.model = patch.model;
  if (patch.provider) update.provider = patch.provider;
  await patchJson<ConversationDoc>(conversationKey(userId, id), update);
  return getConversation(userId, id);
}

export async function deleteConversation(userId: string, id: string) {
  if (!(await getConversation(userId, id))) throw new Error("Conversation introuvable.");
  // Purge des messages : le préfixe messages/ porte UN objet par message.
  // removePrefix est borné (taille de page) : boucle jusqu'à épuisement
  // pour ne laisser AUCUN message orphelin (parité avec l'ancienne purge
  // par lots itérés).
  const prefix = messagesPrefix(userId, id);
  for (;;) {
    const supprimes = await removePrefix(prefix, { maxObjects: SCAN_MAX_OBJECTS });
    if (supprimes < SCAN_MAX_OBJECTS) break;
  }
  // La méta part en dernier : tant qu'elle existe, le fil reste cohérent
  // (aucune route n'expose les messages orphelins sans conversation).
  await removeKey(conversationKey(userId, id));
}

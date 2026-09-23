/**
 * Domaine « Conversation-first » — types du workspace conversationnel.
 *
 * Séparation stricte des responsabilités (directive Conversation-first) :
 *  - Conversation : titre, messages, projet, modèle, statut, timestamps.
 *  - Message      : rôle, contenu, pièces jointes, citations, génération.
 *  - Run          : exécution d'un plan ou d'un outil (timeline lisible).
 *  - Approval     : action sensible nécessitant une validation humaine.
 *  - Artifact     : document, code, image, rapport ou fichier produit.
 *
 * Les conversations réutilisent les collections `chatConversations` /
 * `chatMessages` existantes afin que TOUTE conversation créée avant la
 * refonte reste consultable et reprenable exactement où elle s'est arrêtée.
 */

/* ------------------------------------------------------------------ */
/* Conversation                                                        */
/* ------------------------------------------------------------------ */

export type ConversationStatus = "active" | "archived";

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  /** Projet de rattachement (contexte persistant, instructions, fichiers). */
  projectId?: string;
  model?: string;
  provider?: string;
  status: ConversationStatus;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Message                                                             */
/* ------------------------------------------------------------------ */

export type MessageRole = "user" | "assistant";

/** Pièce jointe d'un message (fichier permanent ou image générée). */
export interface MessageAttachment {
  filename: string;
  /** Clé R2 du stockage permanent (`users/<uid>/permanent/...`). */
  path?: string;
  /** URL signée ou publique (images générées). */
  url?: string;
  contentType?: string;
  sizeBytes?: number;
}

/** Citation renvoyant vers une source utilisée pour produire la réponse. */
export interface MessageCitation {
  /** Identifiant lisible de la source (outil, document, connecteur). */
  source: string;
  /** Extrait court reprenant l'information utilisée. */
  snippet?: string;
  url?: string;
}

export type GenerationStatus = "complete" | "failed";

export interface ConversationMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: MessageRole;
  content: string;
  attachments?: MessageAttachment[];
  citations?: MessageCitation[];
  generationStatus?: GenerationStatus;
  provider?: string;
  model?: string;
  /** URL d'une image générée (Agnes AI) jointe à la réponse. */
  imageUrl?: string;
  /** Run lié à ce message (timeline d'exécution affichée inline). */
  runId?: string;
  /** Connecteurs activés par l'utilisateur pour ce tour (slugs Composio). */
  connectors?: string[];
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Run — timeline d'exécution lisible                                  */
/* ------------------------------------------------------------------ */

/**
 * Phases affichées comme blocs repliables dans la conversation :
 * compréhension de la demande → plan proposé → outils sélectionnés →
 * approbation requise → exécution → résultat et artefacts.
 */
export type RunPhase = "understanding" | "plan" | "tools" | "approval" | "execution" | "result";

export type RunStepStatus = "pending" | "in_progress" | "done" | "failed" | "skipped" | "awaiting";

export interface RunStep {
  id: string;
  phase: RunPhase;
  title: string;
  /** Détail technique accessible sans envahir la lecture principale. */
  detail?: string;
  toolName?: string;
  toolInput?: unknown;
  /** Sortie condensée de l'étape (aperçu affichable). */
  output?: string;
  status: RunStepStatus;
  /** Artefact produit par l'étape, le cas échéant. */
  artifactId?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type RunStatus = "planning" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled";

export interface ConversationRun {
  id: string;
  userId: string;
  conversationId: string;
  projectId?: string;
  objective: string;
  status: RunStatus;
  steps: RunStep[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/* ------------------------------------------------------------------ */
/* Approval — validation inline                                        */
/* ------------------------------------------------------------------ */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ConversationApproval {
  id: string;
  userId: string;
  conversationId: string;
  runId: string;
  /** Étape du run concernée (exécutée après décision). */
  stepId: string;
  toolName: string;
  title: string;
  /** Résumé clair de l'impact de l'action approuvée. */
  impact: string;
  /** Données concernées (périmètre lisible). */
  dataScope: string;
  /** Coût estimé, formaté (ex. « ~0,01 € », « gratuit », « inclus »). */
  estimatedCost: string;
  risk: string;
  status: ApprovalStatus;
  /** Limite de décision : au-delà, la validation expire (contexte obsolète). */
  expiresAt?: string;
  decidedAt?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Artifact — livrable standardisé                                     */
/* ------------------------------------------------------------------ */

export type ArtifactType = "code" | "document" | "table" | "image" | "report" | "file";

export interface ArtifactVersion {
  version: number;
  /** Contenu textuel (code, markdown, tableau CSV…). */
  content?: string;
  /** Clé R2 du fichier stocké. */
  storagePath?: string;
  /** URL publique ou signée (images). */
  url?: string;
  note?: string;
  createdAt: string;
}

export interface ConversationArtifact {
  id: string;
  userId: string;
  conversationId?: string;
  projectId?: string;
  runId?: string;
  type: ArtifactType;
  title: string;
  /** Langage du code (coloration côté client). */
  language?: string;
  filename?: string;
  content?: string;
  storagePath?: string;
  url?: string;
  versions: ArtifactVersion[];
  createdAt: string;
  updatedAt: string;
}

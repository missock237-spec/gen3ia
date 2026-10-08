import "server-only";

import {
  readJsonIfExists,
  removeKey,
  removePrefix,
  userKey,
  writeJson,
} from "@/lib/storage/user-data-store";
import { listMemories } from "./user-memory";
import { exportFeedbackData, purgeFeedbackData } from "@/lib/ai/feedback";
import { exportToolConsents, purgeToolConsents } from "@/lib/security/tool-consents";

/**
 * VIE PRIVÉE — MÉMOIRE LONGUE DURÉE (Task 42, axe 6).
 *
 * La mémoire personnalisée n'est utile que si l'utilisateur en garde le
 * contrôle. Ce module fournit les trois droits fondamentaux :
 *
 *   1. PORTABILITÉ  : exportUserData — tout ce que Gen3ia retient sur ce
 *      compte (souvenirs, retours IA, leçons, consentements) dans un JSON
 *      portable, horodaté, auto-descriptif.
 *   2. EFFACEMENT   : purgeUserData — suppression irréversible et complète
 *      (souvenirs + retours + leçons + consentements + drapeau de
 *      consentement). Les contenus de conversations restent gouvernés par
 *      leurs propres surfaces (hors périmètre mémoire).
 *   3. CONSENTEMENT : memoryConsent — drapeau explicite d'utilisation de la
 *      mémoire personnalisée ; les surfaces de lecture mémoire doivent le
 *      respecter (défaut : consenti — comportement historique — mais
 *      révocable à tout moment).
 *
 * Sécurité : chaque fonction opère STRICTEMENT sur le userId authentifié ;
 * la purge exige le drapeau `confirm: true` côté appelant (double
 * validation applicative en plus de l'UI).
 *
 * Task 109 : le drapeau de consentement vit dans R2
 * (`users/{uid}/privacy/consent.json`) et la purge des souvenirs passe par
 * `removePrefix` (RGPD) au lieu des batches Firestore.
 */

/** Document R2 du drapeau de consentement mémoire. */
interface ConsentDoc {
  v: 1;
  userId: string;
  memoryProcessing: boolean;
  updatedAt: string;
}

/** Clé R2 du drapeau de consentement : « users/{uid}/privacy/consent.json ». */
function consentKey(userId: string): string {
  return userKey(userId, "privacy", "consent");
}

/**
 * Préfixe R2 des souvenirs clé/valeur : « users/{uid}/memories/ ». Dérivé de
 * userKey (contrat : userKey(uid, ...segments) =
 * « users/{uid}/{segments.join("/")}.json ») pour rester aligné sur la
 * composition canonique des clés et bénéficier de la validation du uid.
 */
function memoriesPrefix(userId: string): string {
  return userKey(userId, "memories", "sonde").slice(0, -"sonde.json".length);
}

export interface MemoryConsentState {
  /** La mémoire personnalisée peut-elle être lue pour personnaliser les réponses ? */
  memoryProcessing: boolean;
  updatedAtMs: number | null;
}

export async function getMemoryConsent(userId: string): Promise<MemoryConsentState> {
  if (!userId?.trim()) return { memoryProcessing: true, updatedAtMs: null };
  try {
    const doc = await readJsonIfExists<ConsentDoc>(consentKey(userId));
    if (!doc) return { memoryProcessing: true, updatedAtMs: null };
    const updatedAtMs = typeof doc.updatedAt === "string" ? Date.parse(doc.updatedAt) : Number.NaN;
    return {
      memoryProcessing: doc.memoryProcessing !== false,
      updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    };
  } catch {
    return { memoryProcessing: true, updatedAtMs: null };
  }
}

export async function setMemoryConsent(userId: string, memoryProcessing: boolean): Promise<MemoryConsentState> {
  if (!userId?.trim()) throw new Error("Consent requires userId.");
  await writeJson(consentKey(userId), {
    v: 1,
    userId,
    memoryProcessing,
    updatedAt: new Date().toISOString(),
  } satisfies ConsentDoc);
  return { memoryProcessing, updatedAtMs: Date.now() };
}

/* ------------------------------------------------------------------ */
/* Export (portabilité)                                                */
/* ------------------------------------------------------------------ */

export interface MemoryExport {
  format: "gen3ia.memory-export";
  version: 1;
  exportedAt: string;
  userId: string;
  memories: Array<{ key: string; value: string; source: string; updatedAt?: string }>;
  aiFeedback: Awaited<ReturnType<typeof exportFeedbackData>>["feedback"];
  aiFeedbackLessons: Awaited<ReturnType<typeof exportFeedbackData>>["lessons"];
  toolConsents: Record<string, string>;
}

export async function exportUserData(userId: string): Promise<MemoryExport> {
  const [memories, feedback, toolConsents] = await Promise.all([
    listMemories(userId, 200),
    exportFeedbackData(userId),
    exportToolConsents(userId),
  ]);
  return {
    format: "gen3ia.memory-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    userId,
    memories,
    aiFeedback: feedback.feedback,
    aiFeedbackLessons: feedback.lessons,
    toolConsents: toolConsents as Record<string, string>,
  };
}

/* ------------------------------------------------------------------ */
/* Purge (effacement)                                                  */
/* ------------------------------------------------------------------ */

export interface PurgeReport {
  memoriesDeleted: number;
  feedbackAndLessonsDeleted: number;
  toolConsentsDeleted: boolean;
  consentReset: boolean;
}

export async function purgeUserData(userId: string): Promise<PurgeReport> {
  if (!userId?.trim()) throw new Error("Purge requires userId.");

  // Souvenirs : suppression par lots (removePrefix, RGPD) bouclée jusqu'à
  // épuisement — même stratégie que les batches Firestore historiques.
  let memoriesDeleted = 0;
  for (;;) {
    const supprimes = await removePrefix(memoriesPrefix(userId), { maxObjects: 300 });
    memoriesDeleted += supprimes;
    if (supprimes === 0) break;
  }

  const feedbackAndLessonsDeleted = await purgeFeedbackData(userId);
  await purgeToolConsents(userId);

  // Réinitialisation du drapeau de consentement (état par défaut) après
  // purge — le compte repart sur les réglages d'usine.
  await removeKey(consentKey(userId)).catch(() => undefined);

  return {
    memoriesDeleted,
    feedbackAndLessonsDeleted,
    toolConsentsDeleted: true,
    consentReset: true,
  };
}

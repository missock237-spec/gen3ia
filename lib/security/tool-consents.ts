import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { getToolSecurityDefinition, type ToolSecurityDefinition } from "./tool-permissions";

/**
 * CONSENTEMENTS UTILISATEUR PAR CATÉGORIE D'OUTIL (Task 42, axe 3).
 *
 * Troisième couche du modèle d'autorisation Gen3ia, AU-DESSUS des
 * permissions de politique d'exécution (execution-policy) et des
 * validations humaines HITL (approvals) :
 *
 *   1. Politique d'exécution (déjà existante) : quels outils l'agent PEUT
 *      techniquement appeler (allowNetwork, allowExternalApps…).
 *   2. Consentement utilisateur PAR CATÉGORIE (ce module) : le propriétaire
 *      du compte décide, par catégorie d'usage, si les appels sont
 *      « deny » (bloqués), « ask » (comportement historique : HITL selon
 *      le risque de l'outil) ou « always » (pré-approuvés pour les appels
 *      de lecture de cette catégorie ; les écritures restent gated par la
 *      validation humaine existante — JAMAIS contournée).
 *   3. Validation humaine (déjà existante) : cartes d'approbation pour les
 *      écritures/externes selon le risque de chaque outil.
 *
 * Défaut : « ask » partout — le comportement historique est inchangé tant
 * que l'utilisateur n'a pas explicitement resserré (deny) ou élargi
 * (always) une catégorie. Stockage Firestore cloisonné par utilisateur.
 */

const COLLECTION = "toolConsents";

export type ConsentMode = "ask" | "always" | "deny";

export type ConsentCategory = "external_apps" | "code_execution" | "camera" | "destructive";

export const CONSENT_CATEGORIES: readonly ConsentCategory[] = [
  "external_apps",
  "code_execution",
  "camera",
  "destructive",
];

export const CONSENT_MODES: readonly ConsentMode[] = ["ask", "always", "deny"];

export const CONSENT_CATEGORY_LABELS: Record<ConsentCategory, string> = {
  external_apps: "Applications et API externes",
  code_execution: "Exécution de code et terminal",
  camera: "Caméra",
  destructive: "Opérations destructrices (suppressions)",
};

/** Catégorie de consentement couverte par un outil (null = non concerné). */
export function consentCategoryForTool(toolName: string): ConsentCategory | null {
  let definition: ToolSecurityDefinition;
  try {
    definition = getToolSecurityDefinition(toolName);
  } catch {
    // Outils d'extension : profil externe par construction (tool-permissions).
    return toolName.startsWith("ext.") ? "external_apps" : null;
  }
  if (toolName === "camera.capture") return "camera";
  if (toolName === "code.execute" || toolName === "terminal.execute") return "code_execution";
  if (definition.destructive) return "destructive";
  if (definition.externalApp) return "external_apps";
  return null;
}

export type UserConsents = Partial<Record<ConsentCategory, ConsentMode>>;

/**
 * Cache TTL court (30 s, mono-processus) : les consentements sont lus à
 * CHAQUE appel d'outil par l'exécuteur — une lecture Firestore par appel
 * serait un coût inutile pour un réglage rarement modifié. Invalidation
 * immédiate à l'écriture (même process) ; délai max 30 s entre process.
 */
const CONSENT_CACHE_TTL_MS = 30_000;
const consentCache = new Map<string, { consents: UserConsents; at: number }>();

export async function getToolConsents(userId: string): Promise<UserConsents> {
  if (!userId?.trim()) return {};
  const cached = consentCache.get(userId);
  if (cached && Date.now() - cached.at < CONSENT_CACHE_TTL_MS) return cached.consents;
  try {
    const snap = await adminDb.collection(COLLECTION).doc(userId).get();
    const consents: UserConsents = {};
    if (snap.exists) {
      const data = snap.data() ?? {};
      const modes = (data.modes ?? {}) as Record<string, unknown>;
      for (const category of CONSENT_CATEGORIES) {
        const mode = modes[category];
        if (mode === "ask" || mode === "always" || mode === "deny") consents[category] = mode;
      }
    }
    consentCache.set(userId, { consents, at: Date.now() });
    return consents;
  } catch {
    return cached?.consents ?? {};
  }
}

export async function setToolConsent(userId: string, category: ConsentCategory, mode: ConsentMode): Promise<void> {
  if (!userId?.trim()) throw new Error("Consent requires userId.");
  if (!CONSENT_CATEGORIES.includes(category)) throw new Error(`Unknown consent category: ${category}`);
  if (!CONSENT_MODES.includes(mode)) throw new Error(`Unknown consent mode: ${mode}`);
  await adminDb
    .collection(COLLECTION)
    .doc(userId)
    .set({ userId, modes: { [category]: mode }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const cached = consentCache.get(userId);
  consentCache.set(userId, { consents: { ...(cached?.consents ?? {}), [category]: mode }, at: Date.now() });
}

export async function setToolConsents(userId: string, modes: UserConsents): Promise<void> {
  for (const [category, mode] of Object.entries(modes)) {
    await setToolConsent(userId, category as ConsentCategory, mode as ConsentMode);
  }
}

/* ------------------------------------------------------------------ */
/* Décision de consentement                                            */
/* ------------------------------------------------------------------ */

export interface ConsentDecision {
  category: ConsentCategory | null;
  mode: ConsentMode;
  /** false → l'appel est refusé AVANT toute exécution (catégorie « deny »). */
  allowed: boolean;
  /**
   * true → l'appel peut contourner la carte HITL de LECTURE (mode
   * « always »). Les écritures et opérations externes restent TOUJOURS
   * soumises à la validation humaine existante : ce consentement ne la
   * contourne jamais (garde de sécurité permanente).
   */
  preApproved: boolean;
}

export function decideConsent(toolName: string, consents: UserConsents): ConsentDecision {
  const category = consentCategoryForTool(toolName);
  if (!category) return { category: null, mode: "ask", allowed: true, preApproved: false };
  const mode = consents[category] ?? "ask";
  if (mode === "deny") return { category, mode, allowed: false, preApproved: false };
  // « always » pré-approuve uniquement les catégories non destructrices ;
  // code/camera/destructive conservent leurs gardes dédiées existantes.
  const preApproved = mode === "always" && category === "external_apps";
  return { category, mode, allowed: true, preApproved };
}

/**
 * Export RGPD (lib/memory/privacy.ts) et purge : lecture brute du document.
 */
export async function exportToolConsents(userId: string): Promise<UserConsents> {
  return getToolConsents(userId);
}

export async function purgeToolConsents(userId: string): Promise<void> {
  await adminDb.collection(COLLECTION).doc(userId).delete();
}

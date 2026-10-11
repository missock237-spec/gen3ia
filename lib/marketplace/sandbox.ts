import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import {
  getExtension,
  getInstallation,
  getLatestApprovedVersion,
  installExtension,
  uninstallExtension,
  type InstallationDoc,
} from "@/lib/extensions/repository";

/**
 * MARKETPLACE — SANDBOX D'ÉVALUATION D'EXTENSIONS (Task 132).
 *
 * Un utilisateur peut DÉMARRER UN ESSAI d'une extension approuvée :
 *  - l'extension est installée via la MÉCANIQUE STANDARD
 *    (installExtension de lib/extensions/repository — version approuvée,
 *    permissions du manifest, réglages par défaut) puis MARQUÉE « essai »
 *    sur son document d'installation (`trial: true`, `trialExpiresAt`) pour
 *    que l'UI la distingue d'une installation complète ;
 *  - le cycle de vie de l'essai vit dans la collection `extensionTrials`
 *    (doc `${extensionId}__${userId}`) : statut actif/expiré, compteurs
 *    d'usage PLAFONNÉS, limites figées au démarrage ;
 *  - à l'expiration (temps écoulé ou plafond atteint), assertTrialActive
 *    lève une erreur typée au message honnête invitant à installer la
 *    version complète ; expireTrials purge les essais échus (fail-soft,
 *    idempotent) et désinstalle l'installation d'évaluation — SAUF si
 *    l'utilisateur a acheté la version complète pendant l'essai.
 *
 * POLITIQUE D'ESSAI (décision documentée, lecture du brief Task 132) :
 * jamais deux essais SIMULTANÉS de la même extension (erreur claire), mais
 * un utilisateur sans essai ACTIF peut en démarrer un nouveau — les essais
 * expirés sont purgés puis remplaçables. Un plafond « un essai à vie par
 * extension » resterait un choix produit à confirmer par l'agent principal.
 *
 * BRANCHEMENT RUNTIME (hors périmètre Task 132, laissé à l'agent principal) :
 * les compteurs d'usage sont alimentés par recordTrialUsage — à appeler
 * depuis le pipeline d'exécution d'extension (lib/extensions/runtime.ts ou
 * app/api/extensions/[id]/run) aux côtés d'assertTrialActive, et expireTrials
 * est prévu pour être appelé au chargement du hub marketplace. Noter que le
 * runtime exige par ailleurs une entitlement pour les extensions payantes :
 * un essai d'extension payante ne s'exécutera réellement qu'une fois ce
 * branchement effectué.
 *
 * Toute E/S Firestore passe par la garde standard runFirestoreGuarded
 * (deadline anti-stall + disjoncteur quota — lib/queue/firestore-guard).
 */

/* ------------------------------------------------------------------ */
/* Constantes (documentées — plafonds de l'évaluation)                  */
/* ------------------------------------------------------------------ */

/** Collection du cycle de vie des essais (doc `${extensionId}__${userId}`). */
export const TRIALS_COLLECTION = "extensionTrials";
/** Collection des installations d'extensions (détenue par lib/extensions). */
const INSTALLATIONS_COLLECTION = "extensionInstallations";

/** Durée par défaut d'un essai : 48 heures. */
export const DEFAULT_TRIAL_HOURS = 48;
/** Bornes de durée acceptées (1 heure à 30 jours). */
export const TRIAL_HOURS_MIN = 1;
export const TRIAL_HOURS_MAX = 720;

/**
 * PLAFOND D'USAGE d'un essai : 50 appels d'outils (chaque exécution d'un
 * tool ou d'une étape de workflow de l'extension compte pour un appel).
 */
export const TRIAL_MAX_TOOL_CALLS = 50;
/**
 * PLAFOND D'USAGE d'un essai : 20 exécutions (chaque passage utilisateur
 * dans le pipeline d'exécution — run manuel ou appel agent — compte pour
 * une exécution).
 */
export const TRIAL_MAX_EXECUTIONS = 20;

/** Plafond défensif des scans (essais d'un utilisateur). */
const TRIAL_SCAN_CAP = 100;

/* ------------------------------------------------------------------ */
/* Erreur typée                                                        */
/* ------------------------------------------------------------------ */

/** Codes machine d'erreur du sandbox d'évaluation. */
export type TrialErrorCode =
  | "trial_missing"
  | "trial_inactive"
  | "trial_expired"
  | "trial_quota_tools"
  | "trial_quota_executions"
  | "trial_conflict"
  | "trial_unavailable"
  | "trial_invalid";

/** Statut HTTP recommandé pour chaque code (mapping route). */
const TRIAL_STATUS_BY_CODE: Record<TrialErrorCode, number> = {
  trial_missing: 404,
  trial_inactive: 403,
  trial_expired: 403,
  trial_quota_tools: 403,
  trial_quota_executions: 403,
  trial_conflict: 409,
  trial_unavailable: 409,
  trial_invalid: 400,
};

/**
 * Erreur métier typée du sandbox d'évaluation : `code` machine + `status`
 * HTTP recommandé, message humain en français.
 */
export class TrialError extends Error {
  readonly code: TrialErrorCode;
  readonly status: number;

  constructor(code: TrialErrorCode, message: string) {
    super(message);
    this.name = "TrialError";
    this.code = code;
    this.status = TRIAL_STATUS_BY_CODE[code];
  }
}

/* ------------------------------------------------------------------ */
/* Schéma du document d'essai                                          */
/* ------------------------------------------------------------------ */

export const ExtensionTrialSchema = z.object({
  id: z.string().trim().min(1).max(160),
  extensionId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(128),
  status: z.enum(["active", "expired"]),
  /** Marquage visible pour l'UI : ce document EST un essai d'évaluation. */
  trial: z.literal(true),
  /** Durée effective de l'essai (heures), figée au démarrage. */
  hours: z.number().int().min(TRIAL_HOURS_MIN).max(TRIAL_HOURS_MAX),
  startedAt: z.number().int().min(0),
  /** Expiration en millisecondes epoch (startedAt + hours × 3 600 000). */
  trialExpiresAt: z.number().int().min(0),
  /** Compteurs d'usage — plafonnés par `limits`. */
  usage: z.object({
    toolCalls: z.number().int().min(0),
    executions: z.number().int().min(0),
  }),
  /** Plafonds figés au démarrage (constantes publiques du module). */
  limits: z.object({
    maxToolCalls: z.number().int().min(1),
    maxExecutions: z.number().int().min(1),
  }),
  endedAt: z.number().int().min(0).optional(),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});

export type ExtensionTrial = z.infer<typeof ExtensionTrialSchema>;

/**
 * Installation d'extension augmentée des marqueurs d'essai écrits par ce
 * module (champs additifs — le type InstallationDoc de lib/extensions
 * reste inchangé) : `trial: true` + `trialExpiresAt` (ms epoch).
 */
type TrialInstallationDoc = InstallationDoc & { trial?: boolean; trialExpiresAt?: number };

function parseTrialDoc(id: string, data: Record<string, unknown> | undefined): ExtensionTrial | null {
  if (!data) return null;
  const parsed = ExtensionTrialSchema.safeParse({
    ...data,
    id: typeof data.id === "string" && data.id ? data.id : id,
  });
  return parsed.success ? parsed.data : null;
}

function trialDocId(extensionId: string, userId: string): string {
  return `${extensionId}__${userId}`;
}

async function readTrial(extensionId: string, userId: string): Promise<ExtensionTrial | null> {
  if (!extensionId?.trim() || !userId?.trim()) return null;
  const snap = await runFirestoreGuarded(`trial get ${extensionId}/${userId}`, () =>
    adminDb.collection(TRIALS_COLLECTION).doc(trialDocId(extensionId, userId)).get(),
  );
  if (!snap.exists) return null;
  return parseTrialDoc(trialDocId(extensionId, userId), snap.data() as Record<string, unknown> | undefined);
}

/** Essai courant d'un utilisateur pour une extension (null = aucun). */
export async function getExtensionTrial(extensionId: string, userId: string): Promise<ExtensionTrial | null> {
  return readTrial(extensionId, userId);
}

/* ------------------------------------------------------------------ */
/* Fonctions PURES                                                     */
/* ------------------------------------------------------------------ */

/**
 * Durée d'un essai : paramètre explicite > EXTENSION_TRIAL_HOURS (entier
 * dans les bornes) > 48 h. Un paramètre explicite invalide lève (jamais de
 * durée silencieusement corrigée — l'appelant doit savoir ce qu'il demande).
 */
export function resolveTrialHours(explicitHours?: number): number {
  if (typeof explicitHours === "number") {
    if (!Number.isInteger(explicitHours) || explicitHours < TRIAL_HOURS_MIN || explicitHours > TRIAL_HOURS_MAX) {
      throw new TrialError(
        "trial_invalid",
        `Durée d'évaluation invalide : indiquez un nombre entier d'heures entre ${TRIAL_HOURS_MIN} et ${TRIAL_HOURS_MAX}.`,
      );
    }
    return explicitHours;
  }
  const envHours = Number(process.env.EXTENSION_TRIAL_HOURS);
  if (Number.isInteger(envHours) && envHours >= TRIAL_HOURS_MIN && envHours <= TRIAL_HOURS_MAX) {
    return envHours;
  }
  return DEFAULT_TRIAL_HOURS;
}

/**
 * Garde d'essai (PURE) : lève une TrialError typée si l'essai n'est plus
 * utilisable — message honnête invitant à installer la version complète.
 * Ordre des contrôles : présence → statut → expiration temps → plafonds.
 */
export function assertTrialActive(trial: ExtensionTrial | null | undefined, nowMs: number = Date.now()): void {
  if (!trial) {
    throw new TrialError(
      "trial_missing",
      "Aucune évaluation n'est en cours pour cette extension. Démarrez un essai ou installez la version complète.",
    );
  }
  if (trial.status !== "active") {
    throw new TrialError(
      "trial_inactive",
      "Votre évaluation de cette extension est terminée. Installez la version complète pour continuer à l'utiliser.",
    );
  }
  if (trial.trialExpiresAt <= nowMs) {
    throw new TrialError(
      "trial_expired",
      "Votre période d'évaluation est terminée : installez la version complète de l'extension pour continuer à l'utiliser.",
    );
  }
  if (trial.usage.toolCalls >= trial.limits.maxToolCalls) {
    throw new TrialError(
      "trial_quota_tools",
      `Votre évaluation a atteint son plafond de ${trial.limits.maxToolCalls} appels d'outils. Installez la version complète pour continuer à l'utiliser.`,
    );
  }
  if (trial.usage.executions >= trial.limits.maxExecutions) {
    throw new TrialError(
      "trial_quota_executions",
      `Votre évaluation a atteint son plafond de ${trial.limits.maxExecutions} exécutions. Installez la version complète pour continuer à l'utiliser.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Démarrage d'un essai                                                */
/* ------------------------------------------------------------------ */

export interface StartTrialInput {
  userId: string;
  extensionId: string;
  /** Durée en heures (défaut : EXTENSION_TRIAL_HOURS sinon 48 h). */
  hours?: number;
}

/**
 * Démarre un essai d'évaluation : installe l'extension (mécanique standard,
 * version approuvée), marque l'installation « essai » et crée le document
 * de cycle de vie avec compteurs plafonnés.
 *
 * Refus clairs (TrialError) : extension absente/non approuvée, sans version
 * approuvée, essai déjà ACTIF, version complète déjà installée, durée
 * invalide. Un essai actif mais ÉCHU est purgé au passage puis remplacé.
 */
export async function startExtensionTrial(input: StartTrialInput): Promise<ExtensionTrial> {
  const userId = input.userId?.trim();
  const extensionId = input.extensionId?.trim();
  if (!userId) {
    throw new TrialError("trial_invalid", "Identifiant utilisateur requis pour démarrer une évaluation.");
  }
  if (!extensionId) {
    throw new TrialError("trial_invalid", "Identifiant d'extension requis pour démarrer une évaluation.");
  }
  const hours = resolveTrialHours(input.hours);

  // 1) Extension réelle, approuvée, non supprimée.
  const extension = await getExtension(extensionId);
  if (!extension || extension.status !== "approved" || extension.deletedAt) {
    throw new TrialError("trial_unavailable", "Cette extension n'est pas disponible à l'évaluation actuellement.");
  }

  // 2) Version approuvée (source des permissions et réglages, comme la
  //    route d'installation standard).
  const approvedVersion = await getLatestApprovedVersion(extensionId);
  if (!approvedVersion) {
    throw new TrialError("trial_unavailable", "Aucune version approuvée de cette extension n'est disponible à l'évaluation.");
  }

  // 3) Jamais deux essais simultanés : un essai ACTIF non échu bloque.
  const existing = await readTrial(extensionId, userId);
  if (existing && existing.status === "active" && existing.trialExpiresAt > Date.now()) {
    throw new TrialError(
      "trial_conflict",
      "Un essai d'évaluation est déjà en cours pour cette extension. Installez la version complète pour continuer sans limite.",
    );
  }
  // Essai actif mais échu : purge au passage (fail-soft) avant remplacement.
  if (existing && existing.status === "active") {
    await expireOneTrial(existing);
  }

  // 4) Version complète déjà installée ? L'évaluation est inutile — refus
  //    honnête (l'installation d'essai porte le marqueur `trial: true`,
  //    une installation complète n'en porte pas).
  const installation = await getInstallation(extensionId, userId);
  if (installation && installation.status === "active" && (installation as TrialInstallationDoc).trial !== true) {
    throw new TrialError(
      "trial_conflict",
      "Vous disposez déjà de la version complète de cette extension : l'évaluation est réservée aux nouvelles installations.",
    );
  }

  // 5) Installation réelle (mécanique standard — même contrat que la route
  //    POST /api/extensions/[id]/install : version approuvée, permissions du
  //    manifest, réglages par défaut).
  await installExtension({
    userId,
    extension,
    version: approvedVersion.version,
    permissionsGranted: approvedVersion.manifest.permissions ?? [],
    settings: Object.fromEntries((approvedVersion.manifest.settings ?? []).map((setting) => [setting.key, setting.default])),
  });

  // 6) Marquage d'évaluation sur l'installation (APRÈS installExtension :
  //    son transaction set() remplace le document complet). Visible pour l'UI.
  const now = Date.now();
  const trialExpiresAt = now + hours * 3_600_000;
  await runFirestoreGuarded(`trial mark ${extensionId}/${userId}`, () =>
    adminDb
      .collection(INSTALLATIONS_COLLECTION)
      .doc(trialDocId(extensionId, userId))
      .set({ trial: true, trialExpiresAt }, { merge: true }),
  );

  // 7) Document de cycle de vie (source de vérité de l'essai).
  const trial: ExtensionTrial = ExtensionTrialSchema.parse({
    id: trialDocId(extensionId, userId),
    extensionId,
    userId,
    status: "active",
    trial: true,
    hours,
    startedAt: now,
    trialExpiresAt,
    usage: { toolCalls: 0, executions: 0 },
    limits: { maxToolCalls: TRIAL_MAX_TOOL_CALLS, maxExecutions: TRIAL_MAX_EXECUTIONS },
    createdAt: now,
    updatedAt: now,
  });
  await runFirestoreGuarded(`trial start ${extensionId}/${userId}`, () =>
    adminDb.collection(TRIALS_COLLECTION).doc(trial.id).set(trial),
  );
  return trial;
}

/* ------------------------------------------------------------------ */
/* Comptabilisation de l'usage (plafonnée)                              */
/* ------------------------------------------------------------------ */

export interface RecordTrialUsageInput {
  userId: string;
  extensionId: string;
  /** Nombre d'appels d'outils à comptabiliser (défaut 0). */
  toolCalls?: number;
  /** Nombre d'exécutions à comptabiliser (défaut 0). */
  executions?: number;
}

/**
 * Comptabilise l'usage d'un essai : incrémente les compteurs SANS JAMAIS
 * dépasser les plafonds (min(limite, courant + delta)). Renvoie l'essai
 * mis à jour, ou null si l'utilisateur n'a AUCUN essai pour cette
 * extension (installation complète : rien à comptabiliser côté évaluation).
 * Lève TrialError si l'essai n'est plus actif (expiration ou plafond déjà
 * atteint) — le pipeline d'exécution doit refuser la passe.
 */
export async function recordTrialUsage(input: RecordTrialUsageInput): Promise<ExtensionTrial | null> {
  const userId = input.userId?.trim();
  const extensionId = input.extensionId?.trim();
  if (!userId || !extensionId) {
    throw new TrialError("trial_invalid", "Identifiants requis pour comptabiliser l'usage d'une évaluation.");
  }
  const toolCalls = Math.max(0, Math.floor(Number(input.toolCalls ?? 0)));
  const executions = Math.max(0, Math.floor(Number(input.executions ?? 0)));
  if (toolCalls === 0 && executions === 0) return readTrial(extensionId, userId);

  const trial = await readTrial(extensionId, userId);
  if (!trial) return null;
  assertTrialActive(trial);

  return runFirestoreGuarded(`trial usage ${extensionId}/${userId}`, () =>
    adminDb.runTransaction(async (tx) => {
      const ref = adminDb.collection(TRIALS_COLLECTION).doc(trial.id);
      const snap = await tx.get(ref);
      if (!snap.exists) return trial;
      const current = parseTrialDoc(snap.id, snap.data() as Record<string, unknown> | undefined);
      if (!current || current.status !== "active") return current ?? trial;
      // PLAFOND : les compteurs ne dépassent jamais les limites d'évaluation.
      const usage = {
        toolCalls: Math.min(current.limits.maxToolCalls, current.usage.toolCalls + toolCalls),
        executions: Math.min(current.limits.maxExecutions, current.usage.executions + executions),
      };
      const updated: ExtensionTrial = { ...current, usage, updatedAt: Date.now() };
      tx.set(ref, updated);
      return updated;
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Purge des essais expirés (fail-soft, idempotent)                    */
/* ------------------------------------------------------------------ */

/**
 * Désinstalle l'installation d'ÉVALUATION d'un essai — SAUF si elle a été
 * remplacée par une version complète (achat pendant l'essai : le marqueur
 * `trial` a disparu, l'installation est conservée). Fail-soft : une panne
 * n'interrompt jamais la purge globale.
 */
async function uninstallTrialInstallation(extensionId: string, userId: string): Promise<boolean> {
  try {
    const installation = await getInstallation(extensionId, userId);
    if (!installation || installation.status !== "active") return false;
    if ((installation as TrialInstallationDoc).trial !== true) return false;
    await uninstallExtension(extensionId, userId);
    return true;
  } catch (error) {
    console.error(
      "[marketplace/sandbox] désinstallation de l'essai impossible (fail-soft) :",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Fige UN essai en « expired » (transaction CAS : un document déjà terminal
 * ne repasse pas, et un essai REMPLACÉ par un essai plus récent n'est pas
 * expiré par erreur) puis désinstalle l'installation d'évaluation.
 * Fail-soft : renvoie false sans lever en cas d'incident (retenté au
 * passage suivant).
 */
async function expireOneTrial(trial: ExtensionTrial): Promise<boolean> {
  try {
    const now = Date.now();
    const expired = await runFirestoreGuarded(`trial expire ${trial.id}`, () =>
      adminDb.runTransaction(async (tx): Promise<boolean> => {
        const ref = adminDb.collection(TRIALS_COLLECTION).doc(trial.id);
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const data = snap.data() as Record<string, unknown> | undefined;
        if (typeof data?.status !== "string" || data.status !== "active") return false;
        // Race défensive : le document a pu être remplacé par un essai frais
        // entre la lecture du scan et cette transaction — on ne l'expire pas.
        const expiresAt = Number(data.trialExpiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt > now) return false;
        tx.set(ref, { status: "expired", endedAt: now, updatedAt: now }, { merge: true });
        return true;
      }),
    );
    if (!expired) return false;
    await uninstallTrialInstallation(trial.extensionId, trial.userId);
    return true;
  } catch (error) {
    console.error(
      "[marketplace/sandbox] expiration de l'essai impossible (fail-soft) :",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Purge les essais EXPIRÉS d'un utilisateur (appelé au chargement du hub,
 * fail-soft total : une panne Firestore n'interrompt jamais la page).
 * Idempotent : un essai déjà « expired » n'est jamais retraité ; renvoie le
 * nombre d'essais effectivement expirés au passage.
 */
export async function expireTrials(userId: string): Promise<number> {
  const uid = userId?.trim();
  if (!uid) return 0;
  let expired = 0;
  try {
    const snap = await runFirestoreGuarded(`trial list ${uid}`, () =>
      adminDb.collection(TRIALS_COLLECTION).where("userId", "==", uid).limit(TRIAL_SCAN_CAP).get(),
    );
    for (const doc of snap.docs) {
      const trial = parseTrialDoc(doc.id, doc.data() as Record<string, unknown> | undefined);
      if (!trial || trial.status !== "active") continue; // déjà terminal → idempotence
      if (trial.trialExpiresAt > Date.now()) continue; // encore en cours
      if (await expireOneTrial(trial)) expired++;
    }
  } catch (error) {
    // FAIL-SOFT : journalisé, jamais levé vers le hub.
    console.error(
      "[marketplace/sandbox] purge des essais expirés impossible (fail-soft) :",
      error instanceof Error ? error.message : error,
    );
  }
  return expired;
}

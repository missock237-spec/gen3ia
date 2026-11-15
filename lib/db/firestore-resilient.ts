import "server-only";

import { type DocumentData, type Query } from "@/lib/r2fs";

import { adminDb } from "@/lib/firebase/admin";
import {
  beginFirestoreProbe,
  isFirestoreQuotaError,
  isFirestoreTransientError,
  noteFirestoreQuotaError,
  noteFirestoreStall,
  noteFirestoreSuccess,
  shouldShortCircuitFirestore,
} from "@/lib/db/quota-guard";

/**
 * Accès Firestore résilient — Firestore UNIQUE moteur de données (Task 108).
 *
 * Historique : ce module était adossé à un miroir Postgres secondaire
 * (Task 95-b/96-c, ADR-006 retiré) qui servait de repli sous quota. Task 108
 * supprime ce second backend du projet (décision worklog 108-0) : Firestore
 * redevient l'unique stockage opérationnel. La couche conserve néanmoins sa
 * VALEUR Firestore-only :
 *   - deadline anti-stall (Task 97) : chaque tentative est bornée, un
 *     "stall" ouvre immédiatement le disjoncteur (quota-guard) ;
 *   - disjoncteur à trois états : sous quota, les appels sont court-circuités
 *     en erreur QUOTA-CLASSIFIÉE — les files vidéo (lib/video) classent
 *     l'erreur, appliquent leur backoff et ré-enfilent SANS consommer le
 *     budget de relance ni notifier l'utilisateur ;
 *   - index composite manquant (Task 101 / C3c) : absorbé DANS la couche
 *     (scan plafonné + tri mémoire), sans mobiliser le disjoncteur ;
 *   - requêtes à tri/limit SERVEUR dès qu'un champ d'ordre est fourni
 *     (Task 101 / C3a).
 *
 * Garanties :
 *   - les incidents TRANSITOIRES (UNAVAILABLE / DEADLINE_EXCEEDED / réseau)
 *     ne déclenchent PAS le disjoncteur : les files vidéo les gèrent via
 *     leur propre budget de retry ;
 *   - une erreur de quota est TOUJOURS rejetée à l'appelant après notation
 *     au disjoncteur — jamais de perte silencieuse de données métier.
 */

/**
 * Le garde-quota autorise-t-il une tentative Firestore ? Disjoncteur fermé :
 * oui. Ouvert : non. Mi-ouvert : une unique sonde est consommée via
 * beginFirestoreProbe() pour tenter de refermer le circuit sur un appel réel.
 */
/**
 * Task 106-fix — état du disjoncteur Firestore, exposé pour la COHÉRENCE DE
 * RÉGIME des files : quand le disjoncteur est ouvert, TOUTES les écritures
 * résilientes échouent en erreur quota-classifiée — les claims
 * transactionnels (runTransaction Firestore direct) doivent AUSSI renoncer
 * (aucun chemin ne progresse tant que le quota ne revient pas).
 */
export function firestoreUsable(): boolean {
  return !shouldShortCircuitFirestore() || beginFirestoreProbe();
}

/** Erreur synthétique quand le disjoncteur est ouvert (le message porte le
 * mot « quota » pour rester classé quota par isFirestoreQuotaError — les
 * files vidéo l'absorbent via leur politique de reprise). */
function quotaBreakerError(): Error {
  return new Error("Firestore sous quota : disjoncteur ouvert, appel court-circuité (reprise après cooldown).");
}

// ---------------------------------------------------------------------------
// Deadline anti-stall (Task 97) — constat production du 05/10
// ---------------------------------------------------------------------------

/**
 * Délai imparti à CHAQUE tentative Firestore. Constaté en production le
 * 05/10 : quand le quota quotidien est épuisé, les ÉCRITURES Firestore ne
 * remontent PAS l'erreur RESOURCE_EXHAUSTED — elles pendent indéfiniment
 * côté SDK (retentées internes), ce qui ferait pendre les requêtes serverless.
 * Chaque tentative est donc bornée : au-delà du délai, un "stall" est noté
 * au disjoncteur (qui s'ouvre immédiatement).
 *
 * 6 s : assez long pour laisser passer les appels lents légitimes (p99),
 * assez court pour que create→get→set d'un même appel métier tienne dans le
 * budget d'une fonction serverless (le premier stall ouvre le circuit — les
 * appels suivants sont instantanés).
 */
export const FIRESTORE_ATTEMPT_TIMEOUT_MS = 6_000;

/**
 * Exécute `op` sous deadline. Au-delà de FIRESTORE_ATTEMPT_TIMEOUT_MS :
 *  - `noteFirestoreStall()` ouvre le disjoncteur (signal coûteux = preuve
 *    suffisante, cf. quota-guard.noteFirestoreStall) ;
 *  - l'erreur synthétique porte le mot "quota" → classée quota par
 *    isFirestoreQuotaError → TOUS les chemins de reprise existants
 *    s'engagent sans modification (le contrat d'erreur du module est
 *    préservé).
 * Le rejet tardif de `op` (après timeout) est absorbé par la course
 * (Promise.race souscrit aux deux promesses — jamais d'unhandledRejection).
 */
async function attemptFirestore<T>(label: string, op: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const detail = `${label}: aucune réponse en ${FIRESTORE_ATTEMPT_TIMEOUT_MS}ms`;
          noteFirestoreStall(detail);
          reject(new Error(`${detail} (probablement quota Firestore épuisé).`));
        }, FIRESTORE_ATTEMPT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Payload métier : tout objet sérialisable (interfaces sans index signature acceptées). */
type WritablePayload = object;

// ---------------------------------------------------------------------------
// Écritures résilientes
// ---------------------------------------------------------------------------

/**
 * NOTE SIGNATURE (Task 108) : le paramètre `ownerId` est CONSERVÉ pour la
 * compatibilité des appelants (il alimentait la colonne owner_id du miroir
 * secondaire supprimé) — il est désormais accepté puis ignoré.
 */
export async function resilientCreate(
  collection: string,
  documentId: string,
  payload: WritablePayload,
  _ownerId?: string,
): Promise<void> {
  if (!firestoreUsable()) throw quotaBreakerError();
  try {
    await attemptFirestore(`create ${collection}/${documentId}`, () =>
      adminDb.collection(collection).doc(documentId).create(payload),
    );
    noteFirestoreSuccess();
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    throw error;
  }
}

export async function resilientSet(
  collection: string,
  documentId: string,
  payload: WritablePayload,
  options: { merge?: boolean; ownerId?: string } = {},
): Promise<void> {
  if (!firestoreUsable()) throw quotaBreakerError();
  try {
    await attemptFirestore(`set ${collection}/${documentId}`, () =>
      adminDb.collection(collection).doc(documentId).set(payload, {
        merge: options.merge ?? false,
      }),
    );
    noteFirestoreSuccess();
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    throw error;
  }
}

/**
 * Task 106-fix (racine réelle) — convertit les clés pointées (« a.b ») en
 * objets imbriqués. LE SDK FIRESTORE N'INTERPRÈTE PAS les clés avec points
 * dans set() : `{ "checkpoints.completedSegments": [...] }` crée un champ
 * LITTÉRAL nommé « checkpoints.completedSegments » à côté du champ imbriqué —
 * l'écriture « réussit » sans jamais toucher le vrai champ (constaté en
 * production : checkpoints jamais visibles du claim, re-rendu infini).
 */
export function nestDottedKeys(payload: Record<string, unknown>): Record<string, unknown> {
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!key.includes(".")) {
      nested[key] = value;
      continue;
    }
    const parts = key.split(".");
    let cursor = nested;
    for (const part of parts.slice(0, -1)) {
      const existing = cursor[part];
      if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]!] = value;
  }
  return nested;
}

/**
 * Task 106-fix — écriture de CHECKPOINT, cohérente avec le CLAIM.
 *
 * Sémantique : Firestore D'ABORD avec la même primitive que le claim (pas de
 * course temporelle — un write lent n'est PAS un quota) ; clés pointées
 * converties en chemins imbriqués (voir nestDottedKeys). Une erreur de quota
 * RÉEL (RESOURCE_EXHAUSTED / daily limit) est notée au disjoncteur puis
 * rejetée — le claim, lui aussi, renonce (cohérence de régime). Les autres
 * erreurs propagent (comme resilientSet).
 */
export async function writeCheckpointSet(
  collection: string,
  documentId: string,
  payload: WritablePayload,
  _ownerId?: string,
): Promise<void> {
  const nested = nestDottedKeys(payload as Record<string, unknown>);
  try {
    await adminDb.collection(collection).doc(documentId).set(nested, { merge: true });
    noteFirestoreSuccess();
  } catch (error) {
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    throw error;
  }
}

export async function resilientGet<T>(
  collection: string,
  documentId: string,
): Promise<T | null> {
  if (!firestoreUsable()) throw quotaBreakerError();
  try {
    const snapshot = await attemptFirestore(`get ${collection}/${documentId}`, () =>
      adminDb.collection(collection).doc(documentId).get(),
    );
    // La LECTURE a réussi (doc absent = succès quand même) : referme le circuit.
    noteFirestoreSuccess();
    if (snapshot.exists) return snapshot.data() as T;
    return null;
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Lectures résilientes
// ---------------------------------------------------------------------------

/**
 * Limite par défaut des listes résilientes (Task 101 / C3b) : conservateur,
 * aligné sur le cap de scan de resilientQuery. Ce plafond borne le coût au
 * pire cas sans casser les appelants raisonnables.
 */
const LIST_DEFAULT_LIMIT = 200;

export async function resilientList<T>(
  collection: string,
  ownerField: string,
  ownerId: string,
  limit: number = LIST_DEFAULT_LIMIT,
): Promise<T[]> {
  const safeLimit = Math.max(1, Math.floor(limit) || LIST_DEFAULT_LIMIT);
  if (!firestoreUsable()) throw quotaBreakerError();
  try {
    const snap = await attemptFirestore(`list ${collection} par ${ownerField}`, () =>
      adminDb.collection(collection).where(ownerField, "==", ownerId).limit(safeLimit).get(),
    );
    noteFirestoreSuccess();
    return snap.docs.map((doc) => doc.data() as T);
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    throw error;
  }
}

export async function resilientListByPayloadField<T>(
  collection: string,
  field: string,
  value: string,
  limit: number = LIST_DEFAULT_LIMIT,
): Promise<T[]> {
  const safeLimit = Math.max(1, Math.floor(limit) || LIST_DEFAULT_LIMIT);
  if (!firestoreUsable()) throw quotaBreakerError();
  try {
    const snap = await attemptFirestore(`list ${collection} par ${field}`, () =>
      adminDb.collection(collection).where(field, "==", value).limit(safeLimit).get(),
    );
    noteFirestoreSuccess();
    return snap.docs.map((doc) => doc.data() as T);
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Détection « index composite manquant » (Task 101 / C3a-C3c)
// ---------------------------------------------------------------------------

/** Profondeur maximale de descente dans la chaîne error.cause. */
const MAX_MISSING_INDEX_DEPTH = 5;

/**
 * L'erreur est-elle un FAILED_PRECONDITION « index composite manquant » ?
 *
 * Firestore rejette une requête combinant filtres d'égalité et orderBy sur un
 * champ différent tant que l'index composite requis n'existe pas (gRPC 9 /
 * FirebaseError "failed-precondition", message canonique « The query requires
 * an index »). Le match est VOLONTAIREMENT large (code 9 OU message index) :
 * le repli associé est le comportement historique (scan + tri mémoire), donc
 * un faux positif ne dégrade que le coût, jamais la justesse.
 */
export function isFirestoreMissingIndexError(error: unknown): boolean {
  let current: unknown = error;
  let code = "";
  let message = "";
  for (let depth = 0; depth < MAX_MISSING_INDEX_DEPTH && current !== null && current !== undefined; depth += 1) {
    if (typeof current === "string") {
      if (!message) message = current.toLowerCase();
      break; // une chaîne n'a pas de cause enfouie
    }
    if (typeof current !== "object") break;
    const candidate = current as Record<string, unknown>;
    if (!code && candidate.code !== undefined && candidate.code !== null) {
      code = String(candidate.code).trim().toUpperCase().replace(/-/g, "_");
    }
    if (!message && typeof candidate.message === "string") {
      message = candidate.message.toLowerCase();
    }
    current = candidate.cause;
  }
  if (!code && !message) message = String(error ?? "").toLowerCase();
  return code === "9" || code === "FAILED_PRECONDITION" || message.includes("requires an index") || message.includes("needs an index");
}

// ---------------------------------------------------------------------------
// resilientQuery — requête filtrée : tri serveur + limit exact (Task 101),
// repli scan + tri mémoire (historique, index manquant)
// ---------------------------------------------------------------------------

export interface ResilientQueryOptions {
  /** Champ du payload (ou du doc) utilisé pour le tri. */
  orderField?: string;
  /** Tri décroissant (défaut : ascendant). */
  descending?: boolean;
  /**
   * Nombre max de résultats (défaut : cap de scan 200). Depuis Task 101 (C3a),
   * ce limit est appliqué CÔTÉ FIRESTORE dès qu'un champ d'ordre est fourni :
   * la requête ne lit plus que `limit` documents (les bons), au lieu de
   * balayer 200 documents arbitraires puis trier en mémoire.
   */
  limit?: number;
  /**
   * Injecte l'identifiant du document dans chaque résultat (`id` = doc.id
   * Firestore). Requis par les dépôts dont les payloads ne portent PAS
   * l'identifiant (chat, agents) — sans lui, un résultat resilientQuery est
   * impossible à ré-addresser (lecture ciblée, suppression…).
   */
  includeIds?: boolean;
}

/** Cap de scan par défaut — protège Firestore d'un balayage complet. */
const QUERY_DEFAULT_LIMIT = 200;

/**
 * Comparateur mémoire : horodatages (Timestamp Firestore via toMillis,
 * objets Date, dates ISO 8601) > nombres > chaînes ; valeurs absentes
 * repoussées à la fin. Les Timestamp/Date sont indispensables : les docs
 * écrits avec `new Date()` (Task 96-c) relisent des Timestamp Firestore,
 * et le tri mémoire doit rester juste sans dépendre du SDK.
 */
function temporalMillis(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    try {
      const ms = (value as { toMillis: () => number }).toMillis();
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  return null;
}

function looksLikeIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function compareDocs(left: unknown, right: unknown, field: string): number {
  const leftValue = ((left ?? {}) as Record<string, unknown>)[field];
  const rightValue = ((right ?? {}) as Record<string, unknown>)[field];
  if (leftValue === undefined && rightValue === undefined) return 0;
  if (leftValue === undefined) return 1;
  if (rightValue === undefined) return -1;
  const leftMs = temporalMillis(leftValue);
  const rightMs = temporalMillis(rightValue);
  if (leftMs !== null && rightMs !== null) return leftMs - rightMs;
  if (looksLikeIsoDate(leftValue) && looksLikeIsoDate(rightValue)) {
    return Date.parse(leftValue) - Date.parse(rightValue);
  }
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    return leftValue - rightValue;
  }
  const leftText = String(leftValue);
  const rightText = String(rightValue);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

/**
 * Requête résiliente (Task 101 / C3a) :
 *  - Firestore (chemin nominal) : filtres d'égalité + orderBy SERVEUR dès
 *    qu'un champ d'ordre est fourni + limit EXACT (le `limit` demandé, plus
 *    jamais un cap de 200 re-trié en mémoire) — les N plus récents/anciens
 *    sont garantis, et le coût en lectures tombe au nombre demandé ;
 *  - index composite manquant (FAILED_PRECONDITION) : repli DANS la couche —
 *    scan plafonné sans orderBy + tri mémoire (comportement historique), le
 *    temps que l'index soit déployé ; ni le disjoncteur ni la classification
 *    quota ne sont mobilisés pour ce cas (ni quota, ni incident transitoire) ;
 *  - quota Firestore : erreur notée au disjoncteur puis rejetée (Task 108 —
 *    plus de repli secondaire ; les files vidéo appliquent leur backoff).
 * Quand le disjoncteur est ouvert, l'erreur est levée d'emblée.
 */
export async function resilientQuery<T>(
  collection: string,
  filters: Array<{ field: string; value: unknown }>,
  options?: ResilientQueryOptions,
): Promise<T[]> {
  const requestedLimit = options?.limit ?? null;
  const scanCap = requestedLimit ?? QUERY_DEFAULT_LIMIT;
  /**
   * Horizon de justesse du repli scan (Task 101) : quand l'index manque, le
   * scan reprend le PLAFOND de la couche (200) plutôt que la seule limite
   * demandée — le tri mémoire peut alors reconstruire une fenêtre « N plus
   * récents » aussi juste que le permets l'horizon documenté. Coût borné au
   * pire cas à 200 lectures, uniquement pendant la fenêtre de déploiement.
   */
  const fallbackScanCap = Math.max(scanCap, QUERY_DEFAULT_LIMIT);
  const orderField = options?.orderField;
  const descending = options?.descending === true;
  const orderRequested = typeof orderField === "string" && orderField.length > 0;

  if (!firestoreUsable()) throw quotaBreakerError();

  /** Construit la chaîne Firestore : filtres (+ tri serveur) + limite. */
  const buildQuery = (ordered: boolean, scanLimit: number): Query<DocumentData, DocumentData> => {
    let query: Query<DocumentData, DocumentData> = adminDb.collection(collection);
    for (const filter of filters) {
      query = query.where(filter.field, "==", filter.value);
    }
    if (ordered && orderRequested) {
      // Tri porté par la requête : le limit demandé devient EXACT (garde de
      // justesse Task 101 — un limit Firestore SANS orderBy renverrait un
      // sous-ensemble arbitraire). Pas de cap 200 quand un limit est fourni.
      query = query.orderBy(orderField!, descending ? "desc" : "asc");
      query = query.limit(requestedLimit ?? scanLimit);
    } else {
      // Sans champ d'ordre : cap de scan (l'ordre brut de Firestore n'a pas
      // de sens métier, le tri mémoire resterait cosmétique).
      query = query.limit(scanLimit);
    }
    return query;
  };

  /** Exécute la requête puis applique tri mémoire + découpage. */
  const collect = async (ordered: boolean, scanLimit: number): Promise<T[]> => {
    const snapshot = await attemptFirestore(
      `query ${collection} (${filters.length} filtre(s)${ordered ? ", trié" : ""})`,
      () => buildQuery(ordered, scanLimit).get(),
    );
    let docs = snapshot.docs.map((doc) =>
      options?.includeIds
        ? ({ ...(doc.data() as object), id: doc.id } as T)
        : (doc.data() as T),
    );
    if (orderField) {
      // Tri mémoire conservé : il porte le chemin scan (index manquant) ;
      // sur le chemin trié serveur, il est un simple ré-arrangement
      // idempotent du même ordre.
      docs = [...docs].sort((left, right) => compareDocs(left, right, orderField));
      if (descending) docs.reverse();
    }
    if (requestedLimit !== null) docs = docs.slice(0, requestedLimit);
    return docs;
  };

  try {
    const docs = await collect(true, scanCap);
    noteFirestoreSuccess();
    return docs;
  } catch (error) {
    // Index composite manquant sur la requête TRIÉE : la couche absorbe
    // (contrat C3c) — scan à l'horizon de justesse + tri mémoire, disponibilité
    // préservée pendant la fenêtre de déploiement d'index.
    let failure: unknown = error;
    if (orderRequested && isFirestoreMissingIndexError(error)) {
      try {
        const docs = await collect(false, fallbackScanCap);
        noteFirestoreSuccess();
        return docs;
      } catch (scanError) {
        failure = scanError; // traité ci-dessous (quota → rejet, etc.)
      }
    }
    if (isFirestoreTransientError(failure)) throw failure;
    if (!isFirestoreQuotaError(failure)) throw failure;
    noteFirestoreQuotaError(failure);
    throw failure;
  }
}

// ---------------------------------------------------------------------------
// Suppression résiliente
// ---------------------------------------------------------------------------

/**
 * Suppression résiliente : delete Firestore (idempotent — doc absent =
 * succès). Les erreurs TRANSITOIRES et métier sont rejetées telles quelles ;
 * une erreur de QUOTA est notée au disjoncteur puis rejetée (conventions du
 * module).
 */
export async function resilientDelete(collection: string, documentId: string): Promise<void> {
  if (!firestoreUsable()) throw quotaBreakerError();
  try {
    await attemptFirestore(`delete ${collection}/${documentId}`, () =>
      adminDb.collection(collection).doc(documentId).delete(),
    );
    noteFirestoreSuccess();
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    throw error;
  }
}

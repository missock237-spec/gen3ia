import "server-only";

import { FieldValue, type DocumentData, type Query } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
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
 * Accès Firestore résilient avec repli Supabase (Task 95-b).
 *
 * Principe : Firestore reste la VÉRITÉ ; la table `firestore_fallback`
 * (Supabase, JSONB, PK (collection, document_id)) porte un MIROIR tenu à
 * jour à chaque écriture. Quand Firestore atteint son quota
 * (RESOURCE_EXHAUSTED / 429 / quota quotidien gratuit épuisé), chaque
 * fonction bascule automatiquement sur le miroir au lieu d'échouer — les
 * files vidéo (rendu, production) continuent de progresser pendant la
 * panne et `reconcileFallbackToFirestore` ré-imbrique les écritures
 * miroir dans Firestore une fois le quota revenu.
 *
 * Disjoncteur (lib/db/quota-guard) : au-delà de 3 erreurs de quota
 * consécutives, Firestore n'est plus interrogé du tout (sonde half-open
 * unique après cooldown) — les appels partent directement sur le repli.
 *
 * Garanties :
 *   - le MIROIR ne lève JAMAIS (échec journalisé côté appelant possible,
 *     mais jamais propagé) ;
 *   - les incidents TRANSITOIRES (UNAVAILABLE / DEADLINE_EXCEEDED /
 *     réseau) ne déclenchent NI le disjoncteur NI la bascule : les files
 *     vidéo les gèrent via leur propre budget de retry ;
 *   - un chemin de secours indisponible lève `fallbackError()` — jamais
 *     de perte silencieuse de données métier.
 */

function fallbackEnabled(): boolean {
  return Boolean(getSupabaseAdmin());
}

function fallbackError(): Error {
  return new Error("Firestore quota atteinte et Supabase fallback indisponible.");
}

/**
 * Le garde-quota autorise-t-il une tentative Firestore ? Disjoncteur fermé :
 * oui. Ouvert : non. Mi-ouvert : une unique sonde est consommée via
 * beginFirestoreProbe() pour tenter de refermer le circuit sur un appel réel.
 */
function firestoreUsable(): boolean {
  return !shouldShortCircuitFirestore() || beginFirestoreProbe();
}

// ---------------------------------------------------------------------------
// Deadline anti-stall (Task 97) — constat production du 05/10
// ---------------------------------------------------------------------------

/**
 * Délai imparti à CHAQUE tentative Firestore. Constaté en production le
 * 05/10 : quand le quota quotidien est épuisé, les ÉCRITURES Firestore ne
 * remontent PAS l'erreur RESOURCE_EXHAUSTED — elles pendent indéfiniment
 * côté SDK (retentées internes), ce qui ferait pendre les requêtes serverless
 * au lieu de basculer sur le repli. Chaque tentative est donc bornée : au
 *-delà du délai, un "stall" est noté au disjoncteur (qui s'ouvre
 * immédiatement) et l'appel bascule sur le miroir.
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
 *    isFirestoreQuotaError → TOUS les chemins de repli existants s'engagent
 *    sans modification (le contrat d'erreur du module est préservé).
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
          reject(new Error(`${detail} (probablement quota Firestore épuisé — bascule vers le repli).`));
        }, FIRESTORE_ATTEMPT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Row = {
  collection: string;
  document_id: string;
  owner_id?: string | null;
  payload: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

/** Payload métier : tout objet sérialisable (interfaces sans index signature acceptées). */
type WritablePayload = object;

/**
 * Résout le propriétaire d'un document pour la table de secours : owner
 * explicite, sinon sniff de `payload.userId` (même règle que le miroir) —
 * garantit que `resilientList` fonctionne pendant une panne de quota.
 */
function resolveOwnerId(payload: WritablePayload, ownerId?: string): string | null {
  if (ownerId) return ownerId;
  const candidate = payload as Record<string, unknown>;
  return typeof candidate.userId === "string" ? candidate.userId : null;
}

// ---------------------------------------------------------------------------
// Assainissement du miroir — sentinelles Firestore → JSONB
// ---------------------------------------------------------------------------

/** Chemin dans un payload : clés d'objets (string) et indices de tableaux (number). */
type PropertyPath = string | number;

interface IncrementResolution {
  path: PropertyPath[];
  amount: number;
}

/** Profondeur maximale de descente dans le payload miroir. */
const MAX_SANITIZE_DEPTH = 10;

/** Marqueur interne : la clé/élément porteur doit disparaître du miroir. */
const DELETED: unique symbol = Symbol("gen3ia-mirror-deleted");

/**
 * Side-channel module-privé : `sanitizeMirrorPayload` ne retourne que
 * { payload, mutated } (contrat public) ; les résolutions d'incrément et les
 * clés supprimées voyagent via WeakMap, consommées immédiatement par
 * `mirrorToSupabase` (même module, même tick de résolution).
 */
const PENDING_INCREMENTS = new WeakMap<object, IncrementResolution[]>();
const PENDING_DELETES = new WeakMap<object, PropertyPath[][]>();

function sentinelKind(value: unknown): "delete" | "increment" | "unknown" | null {
  if (typeof value !== "object" || value === null) return null;
  // 1) VRAI SDK firebase-admin (les sentinelles n'exposent PAS _methodName à
  //    l'exécution — discriminant fiable : instanceof + getter methodName,
  //    opérande porté par la propriété publique `operand`).
  if (value instanceof FieldValue) {
    const raw = (value as { methodName?: unknown }).methodName;
    const method = typeof raw === "string" && raw.startsWith("FieldValue.") ? raw.slice("FieldValue.".length) : "";
    if (method === "delete") return "delete";
    if (method === "increment") return "increment";
    return "unknown";
  }
  // 2) Duck-typing legacy / mocks de test (_methodName + _operand).
  const legacy = (value as { _methodName?: unknown })._methodName;
  if (typeof legacy === "string") {
    if (legacy === "delete") return "delete";
    if (legacy === "increment") return "increment";
    return "unknown";
  }
  return null;
}

function sentinelOperand(value: unknown): number {
  const operand = (value as { operand?: unknown; _operand?: unknown }).operand ?? (value as { _operand?: unknown })._operand;
  const amount = Number(operand ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function sanitizeNode(
  value: unknown,
  path: PropertyPath[],
  depth: number,
  seen: Set<object>,
  increments: IncrementResolution[],
  deletes: PropertyPath[][],
): { value: unknown; changed: boolean } {
  if (typeof value === "object" && value !== null) {
    // Sentinelles Firestore (vrai SDK FieldValue OU duck-typing legacy).
    const kind = sentinelKind(value);
    if (kind !== null) {
      if (kind === "delete") {
        deletes.push([...path]);
        return { value: DELETED, changed: true };
      }
      if (kind === "increment") {
        increments.push({ path: [...path], amount: sentinelOperand(value) });
        return { value: DELETED, changed: true };
      }
      // Sentinelle inconnue (serverTimestamp, arrayUnion…) : non sérialisable
      // en JSONB — la clé est écartée plutôt que de mirrorer un objet opaque.
      deletes.push([...path]);
      return { value: DELETED, changed: true };
    }
    // Timestamp Firestore (duck-typing toMillis) → ISO 8601 (JSONB-safe).
    if (typeof (value as { toMillis?: unknown }).toMillis === "function") {
      try {
        const millis = (value as { toMillis: () => number }).toMillis();
        if (typeof millis === "number" && Number.isFinite(millis)) {
          return { value: new Date(millis).toISOString(), changed: true };
        }
      } catch {
        // toMillis défaillant : garder la valeur telle quelle (jamais lever).
      }
    }
    if (depth >= MAX_SANITIZE_DEPTH) return { value, changed: false };
    if (seen.has(value)) return { value, changed: false }; // cycle
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        let changed = false;
        const out: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const child = sanitizeNode(value[index], [...path, index], depth + 1, seen, increments, deletes);
          if (child.value === DELETED) {
            // Sentinelle en élément de tableau (interdit côté Firestore) → null.
            changed = true;
            out.push(null);
            continue;
          }
          if (child.changed) changed = true;
          out.push(child.value);
        }
        return { value: changed ? out : value, changed };
      }
      let changed = false;
      const out: Record<string, unknown> = {};
      const source = value as Record<string, unknown>;
      for (const key of Object.keys(source)) {
        const child = sanitizeNode(source[key], [...path, key], depth + 1, seen, increments, deletes);
        if (child.value === DELETED) {
          changed = true;
          continue; // la clé disparaît du miroir
        }
        out[key] = child.value;
        if (child.changed) changed = true;
      }
      return { value: changed ? out : value, changed };
    } finally {
      seen.delete(value);
    }
  }
  return { value, changed: false };
}

/**
 * Assainit un payload pour le miroir JSONB (exporté pour les tests) :
 * - FieldValue.delete → la clé est DROPPÉE ;
 * - FieldValue.increment → la clé est écartée du payload retourné et la
 *   résolution (valeur actuelle + opérande) est confiée à mirrorToSupabase ;
 * - sentinelles inconnues → clé écartée (jamais de garbage en JSONB) ;
 * - Timestamp-like (toMillis) → chaîne ISO 8601.
 * Récursion profonde (tableaux inclus, max 10 niveaux), sans cycle (Set des
 * objets vus sur le chemin courant) ; jamais de mutation en place.
 */
export function sanitizeMirrorPayload(payload: object): { payload: Record<string, unknown>; mutated: boolean } {
  const increments: IncrementResolution[] = [];
  const deletes: PropertyPath[][] = [];
  const seen = new Set<object>();
  const sanitized = sanitizeNode(payload, [], 0, seen, increments, deletes);
  const result = (sanitized.changed ? sanitized.value : payload) as Record<string, unknown>;
  if (increments.length > 0) PENDING_INCREMENTS.set(result, increments);
  if (deletes.length > 0) PENDING_DELETES.set(result, deletes);
  return { payload: result, mutated: sanitized.changed };
}

function getPath(source: unknown, path: PropertyPath[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyPath, unknown>)[segment];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: PropertyPath[], value: unknown): void {
  if (path.length === 0) return;
  let current: Record<PropertyPath, unknown> = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const next = current[segment];
    if (next === null || typeof next !== "object") {
      const container = (typeof path[index + 1] === "number" ? [] : {}) as Record<PropertyPath, unknown>;
      current[segment] = container;
      current = container;
    } else {
      current = next as Record<PropertyPath, unknown>;
    }
  }
  current[path[path.length - 1]!] = value;
}

function removePath(target: Record<string, unknown>, path: PropertyPath[]): void {
  if (path.length === 0) return;
  const parent = getPath(target, path.slice(0, -1));
  if (parent === null || typeof parent !== "object") return;
  delete (parent as Record<PropertyPath, unknown>)[path[path.length - 1]!];
}

// ---------------------------------------------------------------------------
// Écritures résilientes
// ---------------------------------------------------------------------------

export async function resilientCreate(
  collection: string,
  documentId: string,
  payload: WritablePayload,
  ownerId?: string,
): Promise<void> {
  if (!firestoreUsable()) {
    if (!fallbackEnabled()) throw fallbackError();
    return writeFallbackInsert(collection, documentId, payload, ownerId);
  }
  try {
    await attemptFirestore(`create ${collection}/${documentId}`, () =>
      adminDb.collection(collection).doc(documentId).create(payload),
    );
    noteFirestoreSuccess();
    await mirrorToSupabase(collection, documentId, payload, ownerId);
    return;
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    if (!fallbackEnabled()) throw error;
    return writeFallbackInsert(collection, documentId, payload, ownerId);
  }
}

export async function resilientSet(
  collection: string,
  documentId: string,
  payload: WritablePayload,
  options: { merge?: boolean; ownerId?: string } = {},
): Promise<void> {
  if (!firestoreUsable()) {
    if (!fallbackEnabled()) throw fallbackError();
    return writeFallbackSet(collection, documentId, payload, options);
  }
  try {
    await attemptFirestore(`set ${collection}/${documentId}`, () =>
      adminDb.collection(collection).doc(documentId).set(payload, {
        merge: options.merge ?? false,
      }),
    );
    noteFirestoreSuccess();
    await mirrorToSupabase(collection, documentId, payload, options.ownerId, {
      merge: options.merge ?? false,
    });
    return;
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    if (!fallbackEnabled()) throw error;
    return writeFallbackSet(collection, documentId, payload, options);
  }
}

export async function resilientGet<T>(
  collection: string,
  documentId: string,
): Promise<T | null> {
  if (!firestoreUsable()) {
    if (!fallbackEnabled()) throw fallbackError();
    const row = await readFallback(collection, documentId);
    return (row?.payload as T | undefined) ?? null;
  }
  try {
    const snapshot = await attemptFirestore(`get ${collection}/${documentId}`, () =>
      adminDb.collection(collection).doc(documentId).get(),
    );
    // La LECTURE a réussi (doc absent = succès quand même) : referme le circuit.
    noteFirestoreSuccess();
    if (snapshot.exists) return snapshot.data() as T;
    // Miss Firestore : une ligne miroir peut subsister (écrite pendant une
    // panne de quota jamais réconciliée) — firestore-first, le miroir complète.
    // Défensif : un échec du miroir ne transforme jamais un "absent" en erreur.
    try {
      const row = await readFallback(collection, documentId);
      return (row?.payload as T | undefined) ?? null;
    } catch {
      return null;
    }
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    if (!fallbackEnabled()) throw error;
    const row = await readFallback(collection, documentId);
    return (row?.payload as T | undefined) ?? null;
  }
}

async function writeFallbackInsert(
  collection: string,
  documentId: string,
  payload: WritablePayload,
  ownerId?: string,
): Promise<void> {
  const supabase = getSupabaseAdmin()!;
  const { error: dbError } = await supabase.from("firestore_fallback").insert({
    collection,
    document_id: documentId,
    owner_id: resolveOwnerId(payload, ownerId),
    payload,
  });
  if (dbError) throw fallbackError();
}

async function writeFallbackSet(
  collection: string,
  documentId: string,
  payload: WritablePayload,
  options: { merge?: boolean; ownerId?: string },
): Promise<void> {
  const supabase = getSupabaseAdmin()!;
  // Assainissement identique au miroir nominal : les sentinelles
  // (FieldValue.increment / delete) ne sont pas sérialisables en JSONB —
  // les incréments sont résolus sur la valeur miroir ACTUELLE (contrat
  // Task 95-b/96-c : `messageCount: FieldValue.increment(1)` écrit un
  // nombre, jamais un objet opaque), les delete retirent la clé.
  const { payload: sanitized } = sanitizeMirrorPayload(payload);
  const increments = PENDING_INCREMENTS.get(sanitized) ?? [];
  PENDING_INCREMENTS.delete(sanitized);
  const deletes = PENDING_DELETES.get(sanitized) ?? [];
  PENDING_DELETES.delete(sanitized);
  const needBase = options.merge === true || increments.length > 0 || deletes.length > 0;
  const current = needBase ? await readFallback(collection, documentId) : null;
  const base = { ...((current?.payload ?? {}) as Record<string, unknown>) };
  const merged = options.merge === true ? { ...base, ...sanitized } : { ...sanitized };
  if (options.merge === true) {
    for (const deletedPath of deletes) removePath(merged, deletedPath);
  }
  for (const increment of increments) {
    const currentNumber = Number(getPath(base, increment.path) ?? 0);
    const baseNumber = Number.isFinite(currentNumber) ? currentNumber : 0;
    setPath(merged, increment.path, baseNumber + increment.amount);
  }
  const { error: dbError } = await supabase.from("firestore_fallback").upsert({
    collection,
    document_id: documentId,
    owner_id: resolveOwnerId(sanitized, options.ownerId ?? current?.owner_id ?? undefined) ?? current?.owner_id ?? null,
    payload: merged,
    updated_at: new Date().toISOString(),
  }, { onConflict: "collection,document_id" });
  if (dbError) throw fallbackError();
}

// ---------------------------------------------------------------------------
// Miroir best-effort (ne lève JAMAIS)
// ---------------------------------------------------------------------------

async function mirrorToSupabase(
  collection: string,
  documentId: string,
  payload: WritablePayload,
  ownerId?: string,
  options: { merge?: boolean } = {},
): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  // Best-effort mirror : Firestore reste la source primaire tant que son
  // quota est disponible. Le miroir garantit que le chemin de secours
  // possède les données nécessaires au moment où Firestore devient
  // indisponible — et que la réconciliation peut ré-imbriquer fidèlement.
  const candidate = payload as Record<string, unknown>;
  try {
    // 1) Assainissement : les sentinelles Firestore (FieldValue.increment /
    //    delete, serverTimestamp) ne sont pas sérialisables en JSONB.
    const { payload: sanitized } = sanitizeMirrorPayload(payload);
    const increments = PENDING_INCREMENTS.get(sanitized) ?? [];
    PENDING_INCREMENTS.delete(sanitized);
    const deletes = PENDING_DELETES.get(sanitized) ?? [];
    PENDING_DELETES.delete(sanitized);

    // 2) Résolution : les incréments (valeur actuelle + opérande) et la
    //    sémantique merge (le doc Firestore final = base + payload) exigent
    //    la ligne miroir actuelle. En cas d'échec de lecture, on écrit la
    //    charge assainie SANS les clés non résolubles — jamais d'échec.
    let finalPayload = sanitized;
    if (increments.length > 0 || deletes.length > 0 || options.merge === true) {
      try {
        const current = await readFallback(collection, documentId);
        const base = { ...((current?.payload ?? {}) as Record<string, unknown>) };
        const merged = options.merge === true ? { ...base, ...sanitized } : { ...sanitized };
        if (options.merge === true) {
          for (const deletedPath of deletes) removePath(merged, deletedPath);
        }
        for (const increment of increments) {
          const currentNumber = Number(getPath(base, increment.path) ?? 0);
          const baseNumber = Number.isFinite(currentNumber) ? currentNumber : 0;
          setPath(merged, increment.path, baseNumber + increment.amount);
        }
        finalPayload = merged;
      } catch {
        finalPayload = sanitized;
      }
    }

    const { error } = await supabase.from("firestore_fallback").upsert({
      collection,
      document_id: documentId,
      owner_id: ownerId ?? (typeof candidate.userId === "string" ? candidate.userId : null),
      payload: finalPayload,
      updated_at: new Date().toISOString(),
    }, { onConflict: "collection,document_id" });
    if (error) return;
  } catch {
    // Le miroir ne doit jamais rendre indisponible Firestore.
  }
}

async function readFallback(collection: string, documentId: string): Promise<Row | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("firestore_fallback")
    .select("collection,document_id,owner_id,payload,created_at,updated_at")
    .eq("collection", collection)
    .eq("document_id", documentId)
    .maybeSingle();
  if (error) throw error;
  return data as Row | null;
}

// ---------------------------------------------------------------------------
// Lectures résilientes
// ---------------------------------------------------------------------------

export async function resilientList<T>(
  collection: string,
  ownerField: string,
  ownerId: string,
): Promise<T[]> {
  if (!firestoreUsable()) {
    if (!fallbackEnabled()) throw fallbackError();
    return listFallbackByOwner<T>(collection, ownerId);
  }
  try {
    const snap = await attemptFirestore(`list ${collection} par ${ownerField}`, () =>
      adminDb.collection(collection).where(ownerField, "==", ownerId).get(),
    );
    noteFirestoreSuccess();
    return snap.docs.map((doc) => doc.data() as T);
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    if (!fallbackEnabled()) throw error;
    return listFallbackByOwner<T>(collection, ownerId);
  }
}

async function listFallbackByOwner<T>(collection: string, ownerId: string): Promise<T[]> {
  const supabase = getSupabaseAdmin()!;
  const { data, error: dbError } = await supabase
    .from("firestore_fallback")
    .select("payload")
    .eq("collection", collection)
    .eq("owner_id", ownerId);
  if (dbError) throw fallbackError();
  return (data ?? []).map((row) => row.payload as T);
}

export async function resilientListByPayloadField<T>(
  collection: string,
  field: string,
  value: string,
): Promise<T[]> {
  if (!firestoreUsable()) {
    if (!fallbackEnabled()) throw fallbackError();
    return listFallbackByPayloadField<T>(collection, field, value);
  }
  try {
    const snap = await attemptFirestore(`list ${collection} par ${field}`, () =>
      adminDb.collection(collection).where(field, "==", value).get(),
    );
    noteFirestoreSuccess();
    return snap.docs.map((doc) => doc.data() as T);
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    if (!fallbackEnabled()) throw error;
    return listFallbackByPayloadField<T>(collection, field, value);
  }
}

async function listFallbackByPayloadField<T>(
  collection: string,
  field: string,
  value: string,
): Promise<T[]> {
  const supabase = getSupabaseAdmin()!;
  const { data, error: dbError } = await supabase.from("firestore_fallback").select("payload").eq("collection", collection).filter("payload->>" + field, "eq", value);
  if (dbError) throw fallbackError();
  return (data ?? []).map((row) => row.payload as T);
}

export async function resilientCount(
  collection: string,
  ownerField: string,
  ownerId: string,
): Promise<number> {
  if (!firestoreUsable()) {
    if (!fallbackEnabled()) throw fallbackError();
    return countFallback(collection, ownerId);
  }
  try {
    const snap = await attemptFirestore(`count ${collection} par ${ownerField}`, () =>
      adminDb.collection(collection).where(ownerField, "==", ownerId).get(),
    );
    noteFirestoreSuccess();
    return snap.size;
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    if (!fallbackEnabled()) throw error;
    return countFallback(collection, ownerId);
  }
}

async function countFallback(collection: string, ownerId: string): Promise<number> {
  const supabase = getSupabaseAdmin()!;
  const { count, error: dbError } = await supabase
    .from("firestore_fallback")
    .select("document_id", { count: "exact", head: true })
    .eq("collection", collection)
    .eq("owner_id", ownerId);
  if (dbError) throw fallbackError();
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// resilientQuery — requête filtrée avec tri mémoire + cap de scan
// ---------------------------------------------------------------------------

export interface FallbackQueryOptions {
  /** Champ du payload (ou du doc) utilisé pour le tri. */
  orderField?: string;
  /** Tri décroissant (défaut : ascendant). */
  descending?: boolean;
  /** Nombre max de résultats (défaut : cap de scan 200). */
  limit?: number;
  /**
   * Injecte l'identifiant du document dans chaque résultat (`id` = doc.id
   * Firestore côté nominal, `document_id` miroir côté repli). Requis par les
   * dépôts dont les payloads ne portent PAS l'identifiant (chat, agents) —
   * sans lui, un résultat resilientQuery est impossible à ré-addresser
   * (lecture ciblée, suppression…).
   */
  includeIds?: boolean;
}

/** Cap de scan par défaut — protège Firestore ET la table de secours d'un balayage complet. */
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

async function queryFallback<T>(
  collection: string,
  filters: Array<{ field: string; value: unknown }>,
  options: FallbackQueryOptions | undefined,
  scanCap: number,
): Promise<T[]> {
  const supabase = getSupabaseAdmin()!;
  let request = supabase.from("firestore_fallback").select("collection,document_id,payload").eq("collection", collection);
  for (const filter of filters) {
    request = request.filter("payload->>" + filter.field, "eq", String(filter.value));
  }
  if (options?.orderField) {
    request = request.order("payload->>" + options.orderField, { ascending: !options.descending });
  }
  request = request.limit(scanCap);
  const { data, error: dbError } = await request;
  if (dbError) throw fallbackError();
  return (data ?? []).map((row) =>
    options?.includeIds
      ? ({ ...(row.payload as object), id: row.document_id } as T)
      : (row.payload as T),
  );
}

/**
 * Requête résiliente : filtres d'égalité (+ tri mémoire et limite) côté
 * Firestore, filtres `payload->>` triés/limités côté secours. Quand le
 * disjoncteur est ouvert, le repli est consulté d'emblée.
 */
export async function resilientQuery<T>(
  collection: string,
  filters: Array<{ field: string; value: unknown }>,
  options?: FallbackQueryOptions,
): Promise<T[]> {
  const requestedLimit = options?.limit ?? null;
  const scanCap = requestedLimit ?? QUERY_DEFAULT_LIMIT;

  if (!firestoreUsable()) {
    if (!fallbackEnabled()) throw fallbackError();
    return queryFallback<T>(collection, filters, options, scanCap);
  }
  try {
    let query: Query<DocumentData, DocumentData> = adminDb.collection(collection);
    for (const filter of filters) {
      query = query.where(filter.field, "==", filter.value);
    }
    query = query.limit(scanCap);
    const snapshot = await attemptFirestore(`query ${collection} (${filters.length} filtre(s))`, () => query.get());
    noteFirestoreSuccess();
    let docs = snapshot.docs.map((doc) =>
      options?.includeIds
        ? ({ ...(doc.data() as object), id: doc.id } as T)
        : (doc.data() as T),
    );
    if (options?.orderField) {
      const orderField = options.orderField;
      docs = [...docs].sort((left, right) => compareDocs(left, right, orderField));
      if (options.descending) docs.reverse();
    }
    if (requestedLimit !== null) docs = docs.slice(0, requestedLimit);
    return docs;
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    if (!fallbackEnabled()) throw error;
    return queryFallback<T>(collection, filters, options, scanCap);
  }
}

// ---------------------------------------------------------------------------
// Suppression résiliente (Task 96-c)
// ---------------------------------------------------------------------------

/**
 * Purge la ligne miroir correspondante (best-effort, ne lève JAMAIS) —
 * obligatoire après un delete Firestore nominal : sans elle, resilientGet
 * « ressusciterait » un document supprimé via le repli (miss Firestore →
 * lecture miroir).
 */
async function purgeMirrorRow(collection: string, documentId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from("firestore_fallback")
      .delete()
      .eq("collection", collection)
      .eq("document_id", documentId);
    if (error) return; // le miroir ne lève jamais
  } catch {
    // le miroir ne lève jamais
  }
}

/** Suppression de repli : purge du miroir SEUL (Firestore injoignable). */
async function deleteFallbackOnly(collection: string, documentId: string): Promise<void> {
  const supabase = getSupabaseAdmin()!;
  const { error } = await supabase
    .from("firestore_fallback")
    .delete()
    .eq("collection", collection)
    .eq("document_id", documentId);
  if (error) throw fallbackError();
}

/**
 * Suppression résiliente : delete Firestore d'abord ; en cas de QUOTA, purge
 * du miroir seul (le document disparaît de la vue utilisateur dans les deux
 * mondes — la vérité Firestore sera complétée par la réconciliation, qui ne
 * ré-imbrique PAS les lignes miroir purgées). Les erreurs TRANSITOIRES et
 * métier sont rejetées telles quelles (conventions du module). À noter :
 * le delete Firestore est idempotent (doc absent = succès) — le chemin
 * nominal purge donc aussi le miroir d'un document qui n'existerait PLUS
 * que dans le repli (jamais réconcilié).
 */
export async function resilientDelete(collection: string, documentId: string): Promise<void> {
  if (!firestoreUsable()) {
    if (!fallbackEnabled()) throw fallbackError();
    return deleteFallbackOnly(collection, documentId);
  }
  try {
    await attemptFirestore(`delete ${collection}/${documentId}`, () =>
      adminDb.collection(collection).doc(documentId).delete(),
    );
    noteFirestoreSuccess();
    await purgeMirrorRow(collection, documentId);
    return;
  } catch (error) {
    if (isFirestoreTransientError(error)) throw error;
    if (!isFirestoreQuotaError(error)) throw error;
    noteFirestoreQuotaError(error);
    if (!fallbackEnabled()) throw error;
    return deleteFallbackOnly(collection, documentId);
  }
}

// ---------------------------------------------------------------------------
// Réconciliation miroir → Firestore (après une panne de quota)
// ---------------------------------------------------------------------------

/** Collections vidéo ré-imbriquées par défaut (les files doivent revivre). */
export const DEFAULT_RECONCILE_COLLECTIONS = [
  "videoRenderJobs",
  "videoProductionJobs",
  "videoProjects",
  "videoVersions",
  "videoAssets",
] as const;

export interface ReconcileResult {
  reconciled: number;
  failed: number;
  /** true = rien tenté (Supabase absent ou disjoncteur encore ouvert). */
  skipped: boolean;
}

/**
 * Ré-imbrique les lignes miroir (plus récentes après une panne de quota)
 * dans Firestore avec { merge: true }, afin de rendre la vérité à Firestore.
 * Les lignes miroir ne sont JAMAIS supprimées : le miroir reste une trace
 * durable et le prochain passage est idempotent (merge).
 */
export async function reconcileFallbackToFirestore(
  options: { collections?: string[]; limit?: number; updatedSince?: string } = {},
): Promise<ReconcileResult> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { reconciled: 0, failed: 0, skipped: true };
  if (shouldShortCircuitFirestore() && !beginFirestoreProbe()) {
    return { reconciled: 0, failed: 0, skipped: true };
  }

  const collections = options.collections ?? [...DEFAULT_RECONCILE_COLLECTIONS];
  const limit = Math.min(options.limit ?? 25, 100);

  let request = supabase
    .from("firestore_fallback")
    .select("collection,document_id,payload,updated_at")
    .in("collection", [...collections]);
  if (options.updatedSince) {
    request = request.gt("updated_at", options.updatedSince);
  }
  request = request.order("updated_at", { ascending: false }).limit(limit);

  const { data, error: dbError } = await request;
  if (dbError) throw fallbackError();

  const rows = (data ?? []) as Array<{
    collection: string;
    document_id: string;
    payload: Record<string, unknown>;
  }>;

  let reconciled = 0;
  let failed = 0;
  let successNoted = false;
  for (const row of rows) {
    try {
      await attemptFirestore(`reconcile ${row.collection}/${row.document_id}`, () =>
        adminDb.collection(row.collection).doc(row.document_id).set(row.payload, { merge: true }),
      );
      reconciled += 1;
      if (!successNoted) {
        // Un succès réel referme le circuit (au plus une note par passe).
        noteFirestoreSuccess();
        successNoted = true;
      }
    } catch (error) {
      if (isFirestoreQuotaError(error)) {
        // Quota à nouveau mort : on s'arrête, la prochaine passe reprendra.
        noteFirestoreQuotaError(error);
        break;
      }
      // Incident transitoire ou autre : ligne suivante.
      failed += 1;
    }
  }
  return { reconciled, failed, skipped: false };
}

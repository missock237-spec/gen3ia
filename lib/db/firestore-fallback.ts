import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const QUOTA_CODES = new Set(["8", "RESOURCE_EXHAUSTED", "quota-exceeded"]);

function isFirestoreQuotaError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  const code = String(e?.code ?? "").toUpperCase();
  const message = String(e?.message ?? "").toLowerCase();
  return QUOTA_CODES.has(code) ||
    code.includes("RESOURCE_EXHAUSTED") ||
    message.includes("quota") ||
    message.includes("resource_exhausted") ||
    message.includes("free daily read units");
}

function fallbackEnabled(): boolean {
  return Boolean(getSupabaseAdmin());
}

function fallbackError(): Error {
  return new Error("Firestore quota atteinte et Supabase fallback indisponible.");
}

type Row = {
  collection: string;
  document_id: string;
  owner_id?: string | null;
  payload: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export async function resilientCreate(
  collection: string,
  documentId: string,
  payload: Record<string, unknown>,
  ownerId?: string,
): Promise<void> {
  try {
    await adminDb.collection(collection).doc(documentId).create(payload);
    await mirrorToSupabase(collection, documentId, payload, ownerId);
    return;
  } catch (error) {
    if (!isFirestoreQuotaError(error) || !fallbackEnabled()) throw error;
    const supabase = getSupabaseAdmin()!;
    const { error: dbError } = await supabase.from("firestore_fallback").insert({
      collection,
      document_id: documentId,
      owner_id: ownerId ?? null,
      payload,
    });
    if (dbError) throw fallbackError();
  }
}

export async function resilientSet(
  collection: string,
  documentId: string,
  payload: Record<string, unknown>,
  options: { merge?: boolean; ownerId?: string } = {},
): Promise<void> {
  try {
    await adminDb.collection(collection).doc(documentId).set(payload, {
      merge: options.merge ?? false,
    });
    await mirrorToSupabase(collection, documentId, payload, options.ownerId);
    return;
  } catch (error) {
    if (!isFirestoreQuotaError(error) || !fallbackEnabled()) throw error;
    const supabase = getSupabaseAdmin()!;
    const current = options.merge
      ? await readFallback(collection, documentId)
      : null;
    const merged = {
      ...(current?.payload ?? {}),
      ...payload,
    };
    const { error: dbError } = await supabase.from("firestore_fallback").upsert({
      collection,
      document_id: documentId,
      owner_id: options.ownerId ?? current?.owner_id ?? null,
      payload: merged,
      updated_at: new Date().toISOString(),
    }, { onConflict: "collection,document_id" });
    if (dbError) throw fallbackError();
  }
}

export async function resilientGet<T>(
  collection: string,
  documentId: string,
): Promise<T | null> {
  try {
    const snap = await adminDb.collection(collection).doc(documentId).get();
    return snap.exists ? (snap.data() as T) : null;
  } catch (error) {
    if (!isFirestoreQuotaError(error) || !fallbackEnabled()) throw error;
    const row = await readFallback(collection, documentId);
    return (row?.payload as T | undefined) ?? null;
  }
}

async function mirrorToSupabase(
  collection: string,
  documentId: string,
  payload: Record<string, unknown>,
  ownerId?: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  // Best-effort mirror: Firestore reste la source primaire tant que son quota
  // est disponible. Le miroir garantit que le chemin de secours possède les
  // données nécessaires au moment où Firestore devient indisponible.
  try {
    await supabase.from("firestore_fallback").upsert({
      collection,
      document_id: documentId,
      owner_id: ownerId ?? (typeof payload.userId === "string" ? payload.userId : null),
      payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: "collection,document_id" });
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

export async function resilientList<T>(
  collection: string,
  ownerField: string,
  ownerId: string,
): Promise<T[]> {
  try {
    const snap = await adminDb.collection(collection).where(ownerField, "==", ownerId).get();
    return snap.docs.map((doc) => doc.data() as T);
  } catch (error) {
    if (!isFirestoreQuotaError(error) || !fallbackEnabled()) throw error;
    const supabase = getSupabaseAdmin()!;
    const { data, error: dbError } = await supabase
      .from("firestore_fallback")
      .select("payload")
      .eq("collection", collection)
      .eq("owner_id", ownerId);
    if (dbError) throw fallbackError();
    return (data ?? []).map((row) => row.payload as T);
  }
}

export async function resilientCount(
  collection: string,
  ownerField: string,
  ownerId: string,
): Promise<number> {
  try {
    const snap = await adminDb.collection(collection).where(ownerField, "==", ownerId).get();
    return snap.size;
  } catch (error) {
    if (!isFirestoreQuotaError(error) || !fallbackEnabled()) throw error;
    const supabase = getSupabaseAdmin()!;
    const { count, error: dbError } = await supabase
      .from("firestore_fallback")
      .select("document_id", { count: "exact", head: true })
      .eq("collection", collection)
      .eq("owner_id", ownerId);
    if (dbError) throw fallbackError();
    return count ?? 0;
  }
}

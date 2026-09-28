import "server-only";

import { NotificationSchema, type CreateNotificationInput, type Gen3iaNotification } from "./repository";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { resolveProfileId, type IdentityForBackend } from "@/lib/db/driver";

/**
 * Repository notifications — implémentation Supabase (Task 40, pilote ADR-006).
 *
 * Sémantique IDENTIQUE au backend Firestore (lib/notifications/repository.ts) :
 * mêmes formes de retour (Gen3iaNotification validée zod), mêmes limites
 * (50 max), même best-effort contractuel — un échec de notification ne
 * bloque JAMAIS le flux métier.
 *
 * Mapping Firestore → Postgres (table `notifications`, migration 0001) :
 *   type (approval_requested|info)  → metadata.type  (enum exact préservé)
 *   kind                            → metadata.kind
 *   approvalId/conversationId/…     → metadata.* (références opaques)
 *   userId (uid Firebase)           → owner_profile_id (pont ADR-006)
 *   createdAtMs                     → created_at (timestamptz)
 *
 * L'invalidation du micro-cache Redis est déléguée À L'APPELANT
 * (repository.ts) : un seul point d'invalidation, les deux backends.
 */

// ---------------------------------------------------------------------------
// Mappages purs (testés sans client)
// ---------------------------------------------------------------------------

/** Construit la ligne Postgres depuis une entrée métier. */
export function notificationToRow(
  input: CreateNotificationInput,
  profileId: string,
  notificationId: string,
  nowMs: number,
): Record<string, unknown> {
  return {
    id: notificationId,
    owner_profile_id: profileId,
    kind: input.type === "approval_requested" ? "approval" : "system",
    title: input.title.slice(0, 200),
    body: (input.body ?? "").slice(0, 800),
    link: null,
    read: false,
    metadata: {
      type: input.type,
      ...(input.kind ? { kind: input.kind } : {}),
      userId: input.userId,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(input.toolSlug ? { toolSlug: input.toolSlug } : {}),
    },
    created_at: new Date(nowMs).toISOString(),
  };
}

/** Reconstruit la forme métier validée depuis une ligne Postgres. */
export function rowToNotification(row: {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  read: boolean;
  read_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}): Gen3iaNotification | null {
  const meta = row.metadata ?? {};
  const parsed = NotificationSchema.safeParse({
    id: row.id,
    userId: typeof meta.userId === "string" ? meta.userId : "unknown",
    type: meta.type === "approval_requested" ? "approval_requested" : "info",
    title: row.title,
    body: row.body ?? "",
    read: row.read,
    ...(typeof meta.kind === "string" ? { kind: meta.kind } : {}),
    ...(typeof meta.approvalId === "string" ? { approvalId: meta.approvalId } : {}),
    ...(typeof meta.conversationId === "string" ? { conversationId: meta.conversationId } : {}),
    ...(typeof meta.executionId === "string" ? { executionId: meta.executionId } : {}),
    ...(typeof meta.toolSlug === "string" ? { toolSlug: meta.toolSlug } : {}),
    createdAtMs: new Date(row.created_at).getTime(),
  });
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// CRUD (client service-role ; scoping explicite par owner_profile_id)
// ---------------------------------------------------------------------------

/** ID d'identifiant métier : uuid natif (crypto.randomUUID, runtime Node 20+). */
function newNotificationId(): string {
  return crypto.randomUUID();
}

export async function createNotificationSupabase(
  input: CreateNotificationInput,
  identity: IdentityForBackend,
): Promise<Gen3iaNotification | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase || !input.userId?.trim()) return null;

  const profileId = await resolveProfileId(identity);
  if (!profileId) return null;

  const now = Date.now();
  const row = notificationToRow(input, profileId, newNotificationId(), now);
  const { error } = await supabase.from("notifications").insert(row);
  if (error) throw new Error(`notifications insert: ${error.message}`);
  return NotificationSchema.parse({
    id: row.id,
    userId: input.userId,
    type: input.type,
    title: row.title,
    body: row.body,
    read: false,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.toolSlug ? { toolSlug: input.toolSlug } : {}),
    createdAtMs: now,
  });
}

export async function listNotificationsSupabase(
  profileId: string,
  limit: number,
  unreadOnly: boolean,
): Promise<Gen3iaNotification[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  let query = supabase
    .from("notifications")
    .select("id, kind, title, body, read, read_at, metadata, created_at")
    .eq("owner_profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50));
  if (unreadOnly) query = query.eq("read", false);

  const { data, error } = await query;
  if (error) throw new Error(`notifications list: ${error.message}`);
  return (data ?? [])
    .map((row) => rowToNotification(row as Parameters<typeof rowToNotification>[0]))
    .filter((item): item is Gen3iaNotification => item !== null);
}

export async function countUnreadSupabase(profileId: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return 0;
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("owner_profile_id", profileId)
    .eq("read", false);
  if (error) throw new Error(`notifications count: ${error.message}`);
  return count ?? 0;
}

export async function markReadSupabase(profileId: string, id: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  // Scoping double : owner_profile_id ET id — impossible de marquer la
  // notification d'un autre utilisateur même avec un id forgé.
  const { error } = await supabase
    .from("notifications")
    .update({ read: true, read_at: new Date().toISOString() })
    .eq("owner_profile_id", profileId)
    .eq("id", id);
  if (error) throw new Error(`notifications markRead: ${error.message}`);
}

export async function markAllReadSupabase(profileId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase
    .from("notifications")
    .update({ read: true, read_at: new Date().toISOString() })
    .eq("owner_profile_id", profileId)
    .eq("read", false);
  if (error) throw new Error(`notifications markAllRead: ${error.message}`);
}

export async function markForApprovalReadSupabase(
  profileId: string,
  approvalId: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return;
  // metadata->>approvalId : les références opaques vivent en JSONB.
  const { error } = await supabase
    .from("notifications")
    .update({ read: true, read_at: new Date().toISOString() })
    .eq("owner_profile_id", profileId)
    .eq("read", false)
    .eq("metadata->>approvalId", approvalId);
  if (error) throw new Error(`notifications markForApproval: ${error.message}`);
}

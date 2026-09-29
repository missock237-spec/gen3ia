import "server-only";

import { v5 as uuidv5 } from "uuid";

import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { resolveProfileId, type IdentityForBackend } from "@/lib/db/driver";
import { mirrorToSupabase } from "@/lib/db/dual-write";
import type { Gen3iaNotification } from "./repository";

/**
 * Miroir Supabase des notifications — Phase P2 (Task 43, ADR-006).
 *
 * Firestore reste la VÉRITÉ (repository.ts) ; ce module réplique chaque
 * écriture primale vers Postgres quand le domaine `notifications` est
 * inscrit dans DUAL_WRITE_DOMAINS. Best-effort strict : un échec de miroir
 * n'affecte jamais le flux métier (compteurs + journal, réconciliation par
 * backfill idempotent + checksums).
 *
 * Identifiants : l'id Postgres est dérivé DÉTERMINISTEMENT de l'id Firestore
 * (uuid v5 dans l'espace de noms Gen3ia notifications). Conséquences :
 *   - le miroir et le backfill sont IDEMPOTENTS par construction
 *     (upsert "on conflict id do nothing") sans ligne migration_mapping ;
 *   - la réconciliation (checksums par utilisateur) compare directement
 *     les ensembles d'ids dérivés ;
 *   - la table migration_mapping reste réservée aux domaines dont la clé
 *     primaire doit rester un uuid frais (agents, conversations… FK graph).
 *
 * La forme de ligne est COMPATIBLE avec le backend Supabase primaire
 * (lib/notifications/supabase-repository.ts) : au cutover P3, les lectures
 * Postgres retrouvent exactement la même sémantique (metadata.userId,
 * metadata.type, titres/tronquatures identiques). L'id Firestore d'origine
 * est conservé dans metadata.firestoreId (audit + traçabilité).
 */

/** Espace de noms uuid v5 réservé au miroir notifications (constant). */
const NOTIFICATION_MIRROR_NAMESPACE = "3e2bf0a6-9d51-4c77-9d2c-0b1a2e4f6a01";

/** Id Postgres déterministe dérivé de l'id Firestore (stable, testé). */
export function notificationMirrorId(firestoreId: string): string {
  return uuidv5(firestoreId, NOTIFICATION_MIRROR_NAMESPACE);
}

/** Tronquatures IDENTIQUES au backend primaire (supabase-repository). */
export function mirrorRowFromNotification(
  notification: Gen3iaNotification,
  profileId: string,
): Record<string, unknown> {
  return {
    id: notificationMirrorId(notification.id),
    owner_profile_id: profileId,
    kind: notification.type === "approval_requested" ? "approval" : "system",
    title: notification.title.slice(0, 200),
    body: (notification.body ?? "").slice(0, 800),
    link: null,
    read: notification.read,
    read_at: notification.read ? new Date(notification.createdAtMs).toISOString() : null,
    metadata: {
      type: notification.type,
      ...(notification.kind ? { kind: notification.kind } : {}),
      userId: notification.userId,
      firestoreId: notification.id,
      ...(notification.approvalId ? { approvalId: notification.approvalId } : {}),
      ...(notification.conversationId ? { conversationId: notification.conversationId } : {}),
      ...(notification.executionId ? { executionId: notification.executionId } : {}),
      ...(notification.toolSlug ? { toolSlug: notification.toolSlug } : {}),
    },
    created_at: new Date(notification.createdAtMs).toISOString(),
  };
}

function identityFor(userId: string): IdentityForBackend {
  return { uid: userId, provider: "firebase-bridge" };
}

// ---------------------------------------------------------------------------
// Opérations miroir (une par écriture primale du repository)
// ---------------------------------------------------------------------------

/** Réplique une création de notification (idempotent). */
export function mirrorNotificationCreated(notification: Gen3iaNotification): void {
  void mirrorToSupabase("notifications", async () => {
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error("supabase admin indisponible");
    const profileId = await resolveProfileId(identityFor(notification.userId));
    if (!profileId) throw new Error("profil introuvable (pont d'identité)");
    const row = mirrorRowFromNotification(notification, profileId);
    const { error } = await supabase
      .from("notifications")
      .upsert(row, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(`notifications mirror insert: ${error.message}`);
  });
}

/** Réplique le marquage « lu » d'une notification (idempotent). */
export function mirrorNotificationRead(userId: string, firestoreId: string): void {
  void mirrorToSupabase("notifications", async () => {
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error("supabase admin indisponible");
    const profileId = await resolveProfileId(identityFor(userId));
    if (!profileId) throw new Error("profil introuvable (pont d'identité)");
    const { error } = await supabase
      .from("notifications")
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("owner_profile_id", profileId)
      .eq("id", notificationMirrorId(firestoreId));
    if (error) throw new Error(`notifications mirror markRead: ${error.message}`);
  });
}

/** Réplique « tout marquer lu » (idempotent). */
export function mirrorAllNotificationsRead(userId: string): void {
  void mirrorToSupabase("notifications", async () => {
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error("supabase admin indisponible");
    const profileId = await resolveProfileId(identityFor(userId));
    if (!profileId) throw new Error("profil introuvable (pont d'identité)");
    const { error } = await supabase
      .from("notifications")
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("owner_profile_id", profileId)
      .eq("read", false);
    if (error) throw new Error(`notifications mirror markAllRead: ${error.message}`);
  });
}

/** Réplique « marquer lues les notifications d'une approbation » (idempotent). */
export function mirrorNotificationsForApprovalRead(userId: string, approvalId: string): void {
  void mirrorToSupabase("notifications", async () => {
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error("supabase admin indisponible");
    const profileId = await resolveProfileId(identityFor(userId));
    if (!profileId) throw new Error("profil introuvable (pont d'identité)");
    const { error } = await supabase
      .from("notifications")
      .update({ read: true, read_at: new Date().toISOString() })
      .eq("owner_profile_id", profileId)
      .eq("read", false)
      .eq("metadata->>approvalId", approvalId);
    if (error) throw new Error(`notifications mirror markForApproval: ${error.message}`);
  });
}

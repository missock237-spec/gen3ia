import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue } from "@/lib/r2fs";
import { adminDb } from "@/lib/firebase/admin";
import { CHUNKED_COMMIT_SIZE, commitOpsInChunks, type ChunkedWriteOp } from "@/lib/firestore/chunked-commit";

import {
  assertOrgAttach,
  assertOrgTransfer,
  assertResourceRead,
  assertResourceWrite,
  listUserOrgIds,
} from "@/lib/tenants/resource-access";

/**
 * Projet — l'équivalent de l'espace de travail Claude : regroupe des
 * conversations, des instructions persistantes, des fichiers et sources,
 * des connecteurs autorisés, des règles de confidentialité et les
 * artefacts générés. Évite de mélanger sujets personnels, métier et
 * techniques.
 *
 * Cloisonnement multi-tenant (Task 58, priorité #1 — migration orgId) :
 *   - un projet SANS orgId reste personnel (comportement historique, seule
 *     la lecture/écriture par son propriétaire est possible) ;
 *   - un projet AVEC orgId est lisible par les membres de l'organisation et
 *     gérable par owner/admin (matrice centralisée resource-access) ;
 *   - la migration est LAZY : aucun backfill massif, un projet hérite d'un
 *     orgId à sa création (paramètre validé par assertOrgAttach) ou lors
 *     d'une mise à jour ultérieure (transfert) — zéro coupure de service.
 *
 * Les vues (listes) sont UNION personnel + organisations : chaque requête
 * Firestore reste bornée (`in` limité à 30 valeurs par chunk, plafond de
 * documents côté code).
 */

const COLLECTION = "workspaceProjects";

export interface WorkspaceProject {
  id: string;
  userId: string;
  name: string;
  description?: string;
  /** Instructions persistantes injectées dans chaque conversation du projet. */
  instructions?: string;
  /** Slugs des connecteurs autorisés dans le cadre du projet. */
  authorizedConnectors: string[];
  /** Règles de confidentialité (texte libre, injecté au modèle). */
  privacyRules?: string;
  /** Organisation propriétaire (absent = projet personnel). */
  orgId?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

function docFrom(id: string, data: FirebaseFirestore.DocumentData): WorkspaceProject {
  return {
    id,
    userId: String(data.userId ?? ""),
    name: String(data.name ?? "Projet"),
    description: typeof data.description === "string" ? data.description : undefined,
    instructions: typeof data.instructions === "string" ? data.instructions : undefined,
    authorizedConnectors: Array.isArray(data.authorizedConnectors)
      ? data.authorizedConnectors.filter((x): x is string => typeof x === "string").slice(0, 64)
      : [],
    privacyRules: typeof data.privacyRules === "string" ? data.privacyRules : undefined,
    orgId: typeof data.orgId === "string" && data.orgId ? data.orgId : undefined,
    status: data.status === "archived" ? "archived" : "active",
    createdAt: data.createdAt instanceof Date ? data.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: data.updatedAt instanceof Date ? data.updatedAt.toISOString() : new Date().toISOString(),
  };
}

function projectDocFrom(d: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>): WorkspaceProject {
  return docFrom(d.id, d.data());
}

export async function createProject(
  userId: string,
  input: { name: string; description?: string; instructions?: string; authorizedConnectors?: string[]; privacyRules?: string },
  opts?: { orgId?: string },
): Promise<WorkspaceProject> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new Error("Le nom du projet est requis.");
  // Rattachement multi-tenant (Task 58) : l'appelant doit être membre de
  // l'organisation cible — garde AVANT toute écriture.
  const orgId = opts?.orgId?.trim() || undefined;
  if (orgId) await assertOrgAttach(userId, orgId);
  const now = new Date();
  const ref = adminDb.collection(COLLECTION).doc(randomUUID());
  await ref.set({
    userId,
    name,
    description: input.description?.trim().slice(0, 600) || "",
    instructions: input.instructions?.trim().slice(0, 8000) || "",
    authorizedConnectors: (input.authorizedConnectors ?? []).slice(0, 64),
    privacyRules: input.privacyRules?.trim().slice(0, 2000) || "",
    ...(orgId ? { orgId } : {}),
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  return {
    id: ref.id,
    userId,
    name,
    description: input.description,
    instructions: input.instructions,
    authorizedConnectors: input.authorizedConnectors ?? [],
    privacyRules: input.privacyRules,
    ...(orgId ? { orgId } : {}),
    status: "active",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/** Firestore limite l'opérateur `in` à 30 valeurs par requête. */
const IN_QUERY_CHUNK = 30;

/**
 * Liste UNION org-aware (Task 58) : projets personnels + projets des
 * organisations dont l'utilisateur est membre. Même stratégie que les
 * agents (recommandation C) : requêtes bornées, fusion dédupliquée, tri
 * updatedAt desc, plafond 100 — I/O Firestore maîtrisées et déterministes.
 */
export async function listProjects(userId: string, limit = 50): Promise<WorkspaceProject[]> {
  const cap = Math.min(limit, 100);
  const personal = await adminDb
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .orderBy("updatedAt", "desc")
    .limit(cap)
    .get();

  const orgIds = await listUserOrgIds(userId);
  if (orgIds.length === 0) {
    return personal.docs.map(projectDocFrom);
  }

  const chunks: string[][] = [];
  for (let i = 0; i < orgIds.length; i += IN_QUERY_CHUNK) chunks.push(orgIds.slice(i, i + IN_QUERY_CHUNK));
  const orgSnapshots = await Promise.all(chunks.map((chunk) =>
    adminDb.collection(COLLECTION).where("orgId", "in", chunk).limit(cap).get()));

  const byId = new Map<string, WorkspaceProject>();
  for (const doc of personal.docs) byId.set(doc.id, projectDocFrom(doc));
  for (const snapshot of orgSnapshots) {
    for (const doc of snapshot.docs) {
      if (!byId.has(doc.id)) byId.set(doc.id, projectDocFrom(doc));
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, cap);
}

/**
 * Lecture org-aware : le propriétaire garde l'accès intégral ; un projet
 * d'organisation est lisible par ses membres. Toute dénégation renvoie
 * null (indiscernable d'un projet absent — anti-énumération).
 */
export async function getProject(userId: string, id: string): Promise<WorkspaceProject | null> {
  const snap = await adminDb.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  try {
    await assertResourceRead(userId, { ownerId: String(data.userId ?? ""), orgId: typeof data.orgId === "string" ? data.orgId : null });
  } catch {
    return null;
  }
  return docFrom(snap.id, data);
}

export async function updateProject(
  userId: string,
  id: string,
  patch: Partial<Pick<WorkspaceProject, "name" | "description" | "instructions" | "authorizedConnectors" | "privacyRules" | "status" | "orgId">>,
): Promise<WorkspaceProject> {
  const current = await adminDb.collection(COLLECTION).doc(id).get();
  if (!current.exists) throw new Error("Projet introuvable.");
  const data = current.data()!;
  const ref = { ownerId: String(data.userId ?? ""), orgId: typeof data.orgId === "string" ? data.orgId : null };
  // Écriture : propriétaire ou owner/admin de l'organisation (un simple
  // membre reçoit la même dénégation qu'un étranger — pas de fuite).
  await assertResourceWrite(userId, ref);
  // Transfert d'organisation (Task 58) : attachement/détachement validé —
  // la destination doit être une org dont l'appelant est membre ; vide =
  // détachement (retour personnel).
  await assertOrgTransfer(userId, ref, patch.orgId);

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 120);
    if (!name) throw new Error("Le nom du projet est requis.");
    update.name = name;
  }
  if (patch.description !== undefined) update.description = patch.description.trim().slice(0, 600);
  if (patch.instructions !== undefined) update.instructions = patch.instructions.trim().slice(0, 8000);
  if (patch.authorizedConnectors !== undefined) update.authorizedConnectors = patch.authorizedConnectors.slice(0, 64);
  if (patch.privacyRules !== undefined) update.privacyRules = patch.privacyRules.trim().slice(0, 2000);
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.orgId !== undefined) {
    const nextOrgId = patch.orgId.trim();
    if (nextOrgId) update.orgId = nextOrgId;
    else update.orgId = FieldValue.delete();
  }
  await adminDb.collection(COLLECTION).doc(id).update(update);
  const updated = await getProject(userId, id);
  if (!updated) throw new Error("Projet introuvable après mise à jour.");
  return updated;
}

export async function deleteProject(userId: string, id: string): Promise<void> {
  const snap = await adminDb.collection(COLLECTION).doc(id).get();
  if (!snap.exists) throw new Error("Projet introuvable.");
  const data = snap.data()!;
  // Suppression : écriture (propriétaire ou owner/admin d'organisation).
  await assertResourceWrite(userId, { ownerId: String(data.userId ?? ""), orgId: typeof data.orgId === "string" ? data.orgId : null });
  // Les conversations rattachées sont détachées (pas supprimées) : aucun
  // contenu utilisateur n'est détruit par la suppression d'un projet.
  // Détachement par lots de 450 (limite Firestore : 500 ops par batch,
  // updates + delete confondus) — boucle jusqu'à épuisement : chaque update
  // retire le projectId, la re-query ne revoit donc jamais les mêmes docs.
  for (;;) {
    const conversations = await adminDb
      .collection("chatConversations")
      .where("userId", "==", String(data.userId ?? userId))
      .where("projectId", "==", id)
      .limit(CHUNKED_COMMIT_SIZE)
      .get();
    const convDocs = conversations.docs;
    if (convDocs.length === 0) break;
    const ops: ChunkedWriteOp[] = convDocs.map((d) => ({
      kind: "update" as const,
      ref: d.ref,
      data: { projectId: FieldValue.delete() },
    }));
    await commitOpsInChunks(adminDb, ops);
    if (convDocs.length < CHUNKED_COMMIT_SIZE) break;
  }
  await commitOpsInChunks(adminDb, [{ kind: "delete", ref: adminDb.collection(COLLECTION).doc(id) }]);
}

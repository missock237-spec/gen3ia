import { randomUUID } from "node:crypto";

import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/security/http-errors";
import { getAgentForOwner } from "@/lib/agents/repository";

/**
 * MARKETPLACE D'AGENTS — ANNONCES & AVIS (V2, Task 114-c).
 *
 * Chaque utilisateur peut PUBLIER un de ses agents à la location (« listing »).
 * Un listing désigne UN agent du propriétaire ; un agent ne porte QU'UN seul
 * listing (upsert propre — republier met à jour l'existant, jamais de doublon).
 *
 * Collections r2fs (style mission-escrow : documents JSON plats, horodatages
 * numériques, scans filtrés par where) :
 *  - `agentListings/{listingId}`      — l'annonce (titre, prix, stats) ;
 *  - `agentListingHires/{hireId}`     — une location (écrite par hire.ts) ;
 *  - `agentListingReviews/{listingId}_{hireId}` — l'avis du locataire ;
 *  - `hireByExecution/{executionId}`  — mapping rapide executionId → hireId
 *    (consommé par settleAgentHireByExecution au tick final).
 *
 * PROPRIÉTÉ : toute écriture est scopée par ownerId vérifié côté serveur
 * (lecture brute de l'agent via getAgentForOwner — préfixe utilisateur R2 —
 * puis validation AgentRecordSchema) ; les lectures 404-anti-énumération.
 *
 * Les fonctions de DÉCISION (canHireListing, canRateListing, rateForListing)
 * sont PURES et testées sans dépendance.
 */

export const LISTINGS_COLLECTION = "agentListings";
export const HIRES_COLLECTION = "agentListingHires";
export const REVIEWS_COLLECTION = "agentListingReviews";
export const HIRE_BY_EXECUTION_COLLECTION = "hireByExecution";

/* ------------------------------------------------------------------ */
/* Schémas                                                             */
/* ------------------------------------------------------------------ */

export const ListingPricingSchema = z.object({
  model: z.literal("per_mission"),
  // XAF minor (×100) : 100 minor = 1 FCFA, plafond 1 000 000 = 10 000 FCFA.
  priceMinor: z.number().int().min(100).max(1_000_000),
});

export const ListingStatsSchema = z.object({
  hires: z.number().int().min(0).default(0),
  ratingSum: z.number().int().min(0).default(0),
  ratingCount: z.number().int().min(0).default(0),
});

export const AgentListingSchema = z.object({
  listingId: z.string().trim().min(1).max(128),
  agentId: z.string().trim().min(1).max(128),
  ownerId: z.string().trim().min(1).max(128),
  orgId: z.string().trim().min(1).max(128).optional(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(4_000),
  capabilityTags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  pricing: ListingPricingSchema,
  status: z.enum(["draft", "published", "suspended"]),
  stats: ListingStatsSchema.default({ hires: 0, ratingSum: 0, ratingCount: 0 }),
  createdAtMs: z.number().int().min(0),
  updatedAtMs: z.number().int().min(0),
});

export const AgentHireSchema = z.object({
  hireId: z.string().trim().min(1).max(128),
  listingId: z.string().trim().min(1).max(128),
  tenantId: z.string().trim().min(1).max(128),
  ownerId: z.string().trim().min(1).max(128),
  agentId: z.string().trim().min(1).max(128),
  executionId: z.string().trim().min(1).max(128),
  runId: z.string().trim().min(1).max(128),
  objective: z.string().trim().min(1).max(4_000),
  priceMinor: z.number().int().min(0),
  commissionBps: z.number().int().min(0).max(10_000),
  status: z.enum(["held", "completed", "released", "failed"]),
  conversationId: z.string().trim().min(1).max(128).optional(),
  createdAtMs: z.number().int().min(0),
  settledAtMs: z.number().int().min(0).optional(),
  error: z.string().max(2_000).optional(),
});

export const ListingReviewSchema = z.object({
  reviewId: z.string().trim().min(1).max(300),
  listingId: z.string().trim().min(1).max(128),
  hireId: z.string().trim().min(1).max(128),
  tenantId: z.string().trim().min(1).max(128),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1_000).optional(),
  createdAtMs: z.number().int().min(0),
  updatedAtMs: z.number().int().min(0).optional(),
});

export type AgentListing = z.infer<typeof AgentListingSchema>;
export type AgentHire = z.infer<typeof AgentHireSchema>;
export type ListingReview = z.infer<typeof ListingReviewSchema>;
export type ListingSort = "popular" | "newest" | "price_asc" | "rating";

/** Corps de POST /api/marketplace/agents (publication d'un listing). */
export const PublishListingBodySchema = z.object({
  agentId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(4_000),
  capabilityTags: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  priceMinor: z.number().int().min(100).max(1_000_000),
  publish: z.boolean().optional(),
});

/** Corps de PATCH /api/marketplace/agents/[listingId] (champs éditables). */
export const UpdateListingBodySchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(4_000).optional(),
  capabilityTags: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  priceMinor: z.number().int().min(100).max(1_000_000).optional(),
  status: z.enum(["draft", "published", "suspended"]).optional(),
});

export type UpdateListingPatch = z.infer<typeof UpdateListingBodySchema>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Plafond défensif des scans r2fs (listings). */
const SCAN_CAP = 200;

function listingsRef() {
  return adminDb.collection(LISTINGS_COLLECTION);
}

function parseListingDoc(id: string, data: Record<string, unknown> | undefined): AgentListing | null {
  if (!data) return null;
  const parsed = AgentListingSchema.safeParse({
    ...data,
    listingId: typeof data.listingId === "string" && data.listingId ? data.listingId : id,
  });
  return parsed.success ? parsed.data : null;
}

async function readListing(listingId: string): Promise<AgentListing | null> {
  if (!listingId?.trim()) return null;
  const snap = await listingsRef().doc(listingId).get();
  if (!snap.exists) return null;
  return parseListingDoc(listingId, snap.data() as Record<string, unknown> | undefined);
}

/**
 * Lecture d'un document de location (hire) — utilisée par les AVIS
 * (agent-listings) et partagée conceptuellement avec hire.ts ; hire.ts
 * possède ses propres lectures brutes fail-soft pour le règlement.
 */
async function readHireDoc(hireId: string): Promise<AgentHire | null> {
  if (!hireId?.trim()) return null;
  const snap = await adminDb.collection(HIRES_COLLECTION).doc(hireId).get();
  if (!snap.exists) return null;
  const parsed = AgentHireSchema.safeParse(snap.data() ?? {});
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ */
/* Fonctions PURES (testées sans dépendance)                           */
/* ------------------------------------------------------------------ */

/**
 * Garde de location (PURE) : annonce publiée ET locataire ≠ propriétaire.
 * Les codes de raison sont machine (`unavailable`, `self_hire`,
 * `unauthenticated`) — traduits en messages FR par hire.ts / les routes.
 */
export function canHireListing(
  listing: Pick<AgentListing, "status" | "ownerId">,
  tenantId: string,
): { ok: boolean; reason?: string } {
  if (listing.status !== "published") return { ok: false, reason: "unavailable" };
  if (!tenantId?.trim()) return { ok: false, reason: "unauthenticated" };
  if (listing.ownerId === tenantId) return { ok: false, reason: "self_hire" };
  return { ok: true };
}

/**
 * Garde d'avis (PURE) : seul le locataire d'une location RÉUSSIE
 * (« completed ») peut noter l'annonce — un avis par location.
 */
export function canRateListing(
  hire: Pick<AgentHire, "status" | "tenantId">,
  tenantId: string,
): { ok: boolean; reason?: string } {
  if (!tenantId?.trim() || hire.tenantId !== tenantId) return { ok: false, reason: "not_tenant" };
  if (hire.status !== "completed") return { ok: false, reason: "not_completed" };
  return { ok: true };
}

/** Note moyenne (PURE) : ratingSum/ratingCount arrondi à 1 décimale, 0 sans avis. */
export function rateForListing(listing: Pick<AgentListing, "stats">): number {
  const count = Number(listing.stats?.ratingCount ?? 0);
  if (!Number.isFinite(count) || count <= 0) return 0;
  const sum = Number(listing.stats?.ratingSum ?? 0);
  return Math.round((sum / count) * 10) / 10;
}

/** Comparateur de tri du catalogue (PUR, tri en mémoire — style mission-escrow). */
export function compareListingsForSort(a: AgentListing, b: AgentListing, sort: ListingSort): number {
  switch (sort) {
    case "popular":
      return (b.stats?.hires ?? 0) - (a.stats?.hires ?? 0) || b.createdAtMs - a.createdAtMs;
    case "price_asc":
      return a.pricing.priceMinor - b.pricing.priceMinor || b.createdAtMs - a.createdAtMs;
    case "rating":
      return (
        rateForListing(b) - rateForListing(a) ||
        (b.stats?.ratingCount ?? 0) - (a.stats?.ratingCount ?? 0) ||
        b.createdAtMs - a.createdAtMs
      );
    default:
      return b.createdAtMs - a.createdAtMs;
  }
}

/* ------------------------------------------------------------------ */
/* Publication / édition (propriétaire)                                */
/* ------------------------------------------------------------------ */

export interface PublishListingInput {
  agentId: string;
  title: string;
  description: string;
  capabilityTags?: string[];
  pricing: { priceMinor: number };
  /** false → status « draft » (brouillon privé) ; défaut : publié. */
  publish?: boolean;
}

/**
 * PUBLIE (ou MET À JOUR) le listing de location d'un agent DU propriétaire.
 *
 * DÉCISION UPSERT (documentée) : un agent ne porte qu'UN SEUL listing
 * (draft ou published) — republier un agent déjà listé met l'annonce
 * existante à jour (titre, description, tags, prix, statut) au lieu de
 * créer un doublon ou renvoyer 409 : l'opération est idempotente côté UI
 * et le catalogue ne peut pas être encombré d'annonces redondantes.
 * Lève 404 si l'agent n'appartient pas au propriétaire (anti-énumération),
 * 409 si l'agent n'est pas actif.
 */
export async function publishAgentListing(ownerId: string, input: PublishListingInput): Promise<AgentListing> {
  if (!ownerId?.trim()) throw new HttpError(401, "Authentification requise.");
  const agentId = input.agentId?.trim();
  if (!agentId) throw new HttpError(400, "Identifiant d'agent requis.");

  // Lecture brute CHEZ LE PROPRIÉTAIRE (préfixe R2 users/{ownerId}/agents/) :
  // un agent d'un autre utilisateur est indiscernable d'un agent absent.
  const agent = await getAgentForOwner(ownerId, agentId);
  if (!agent) throw new HttpError(404, "Agent introuvable ou inaccessible.");
  if (agent.status !== "active") {
    throw new HttpError(409, "Seul un agent actif peut être publié à la location.");
  }

  const now = Date.now();
  const status = input.publish === false ? ("draft" as const) : ("published" as const);
  const pricing = { model: "per_mission" as const, priceMinor: input.pricing.priceMinor };

  const existing = await findListingByAgentId(agentId);
  if (existing) {
    const updated = AgentListingSchema.parse({
      ...existing,
      title: input.title.trim(),
      description: input.description.trim(),
      capabilityTags: (input.capabilityTags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
      pricing,
      status,
      updatedAtMs: now,
    });
    await listingsRef().doc(existing.listingId).set(updated);
    return updated;
  }

  const listing = AgentListingSchema.parse({
    listingId: randomUUID(),
    agentId,
    ownerId,
    ...(typeof agent.orgId === "string" && agent.orgId ? { orgId: agent.orgId } : {}),
    title: input.title.trim(),
    description: input.description.trim(),
    capabilityTags: (input.capabilityTags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
    pricing,
    status,
    stats: { hires: 0, ratingSum: 0, ratingCount: 0 },
    createdAtMs: now,
    updatedAtMs: now,
  });
  await listingsRef().doc(listing.listingId).set(listing);
  return listing;
}

/** Listing existant d'un agent (un seul par agent — upsert documenté). */
async function findListingByAgentId(agentId: string): Promise<AgentListing | null> {
  const snap = await listingsRef().where("agentId", "==", agentId).limit(5).get();
  for (const doc of snap.docs) {
    const listing = parseListingDoc(doc.id, doc.data() as Record<string, unknown> | undefined);
    if (listing) return listing;
  }
  return null;
}

/**
 * Met à jour les champs éditables du listing — PROPRIÉTAIRE UNIQUEMENT.
 * Un listing d'un autre utilisateur renvoie 404 (anti-énumération :
 * indiscernable d'un listing absent).
 */
export async function updateAgentListing(ownerId: string, listingId: string, patch: UpdateListingPatch): Promise<AgentListing> {
  if (!ownerId?.trim()) throw new HttpError(401, "Authentification requise.");
  const current = await readListing(listingId);
  if (!current || current.ownerId !== ownerId) throw new HttpError(404, "Annonce introuvable.");

  const next = AgentListingSchema.parse({
    ...current,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
    ...(patch.capabilityTags !== undefined
      ? { capabilityTags: patch.capabilityTags.map((tag) => tag.trim()).filter(Boolean).slice(0, 8) }
      : {}),
    ...(patch.priceMinor !== undefined ? { pricing: { model: current.pricing.model, priceMinor: patch.priceMinor } } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updatedAtMs: Date.now(),
  });
  await listingsRef().doc(current.listingId).set(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* Lectures (catalogue + propriétaire)                                 */
/* ------------------------------------------------------------------ */

export async function getAgentListing(listingId: string): Promise<AgentListing | null> {
  return readListing(listingId);
}

export interface ListingPage {
  listings: AgentListing[];
  /** Curseur de suite (index de pagination simple) — null = fin du catalogue. */
  cursor: string | null;
}

/**
 * Catalogue PUBLIC : scan r2fs filtré status === "published" (même approche
 * que releaseExpiredEscrows), tri EN MÉMOIRE, pagination offset simple par
 * curseur d'index. Les annonces draft/suspended ne sortent jamais ici.
 */
export async function listPublishedAgentListings(
  options: { sort?: ListingSort; limit?: number; cursor?: string } = {},
): Promise<ListingPage> {
  const sort: ListingSort = options.sort ?? "newest";
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.min(50, Math.floor(Number(options.limit))))
    : 20;
  const snap = await listingsRef().where("status", "==", "published").limit(SCAN_CAP).get();
  const listings = snap.docs
    .map((doc) => parseListingDoc(doc.id, doc.data() as Record<string, unknown> | undefined))
    .filter((listing): listing is AgentListing => listing !== null)
    .sort((a, b) => compareListingsForSort(a, b, sort));

  const startRaw = Number.parseInt(options.cursor ?? "0", 10);
  const start = Number.isFinite(startRaw) && startRaw > 0 ? startRaw : 0;
  const page = listings.slice(start, start + limit);
  const nextIndex = start + limit;
  return { listings: page, cursor: nextIndex < listings.length ? String(nextIndex) : null };
}

/** Annonces D'UN propriétaire (tous statuts — pour « mes annonces »). */
export async function listOwnerListings(ownerId: string): Promise<AgentListing[]> {
  if (!ownerId?.trim()) return [];
  const snap = await listingsRef().where("ownerId", "==", ownerId).limit(SCAN_CAP).get();
  return snap.docs
    .map((doc) => parseListingDoc(doc.id, doc.data() as Record<string, unknown> | undefined))
    .filter((listing): listing is AgentListing => listing !== null)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/* ------------------------------------------------------------------ */
/* Avis (réputation)                                                   */
/* ------------------------------------------------------------------ */

export interface UpsertReviewInput {
  listingId: string;
  hireId: string;
  rating: number;
  comment?: string;
}

export interface UpsertReviewResult {
  review: ListingReview;
  /** Note moyenne mise à jour de l'annonce. */
  rating: number;
  created: boolean;
}

/**
 * Crée OU met à jour l'avis d'une location (doc-ID `listingId_hireId`
 * idempotent — une mise à jour de note est autorisée, les stats sont
 * corrigées : ancienne note retirée, nouvelle ajoutée, compteur inchangé).
 *
 * Gardes : hire réel + cohérent avec le listing + canRateListing (locataire
 * de la location ET mission « completed »). Les stats du listing sont mises
 * à jour dans une TRANSACTION (CAS : deux avis concurrents ne peuvent pas
 * perdre une incrément).
 */
export async function upsertListingReview(tenantId: string, input: UpsertReviewInput): Promise<UpsertReviewResult> {
  if (!tenantId?.trim()) throw new HttpError(401, "Authentification requise.");
  const hire = await readHireDoc(input.hireId);
  if (!hire || hire.listingId !== input.listingId) {
    throw new HttpError(404, "Location introuvable pour cette annonce.");
  }
  const check = canRateListing(hire, tenantId);
  if (!check.ok) {
    throw new HttpError(403, "Seul le locataire d'une location réussie peut noter cette annonce.");
  }

  const now = Date.now();
  const reviewId = `${input.listingId}_${input.hireId}`;
  const reviewRef = adminDb.collection(REVIEWS_COLLECTION).doc(reviewId);
  const existingSnap = await reviewRef.get();
  const created = !existingSnap.exists;
  const existingData = (existingSnap.data() ?? {}) as Record<string, unknown> | undefined;
  const previousRating = created ? 0 : Math.floor(Number(existingData?.rating ?? 0));

  const review = ListingReviewSchema.parse({
    reviewId,
    listingId: input.listingId,
    hireId: input.hireId,
    tenantId,
    rating: input.rating,
    ...(input.comment?.trim() ? { comment: input.comment.trim().slice(0, 1_000) } : {}),
    createdAtMs: created ? now : Math.floor(Number(existingData?.createdAtMs ?? now)),
    updatedAtMs: now,
  });
  await reviewRef.set(review);

  await adminDb.runTransaction(async (tx) => {
    const listingRef = listingsRef().doc(input.listingId);
    const snap = await tx.get(listingRef);
    if (!snap.exists) return;
    const data = (snap.data() ?? {}) as { stats?: { hires?: unknown; ratingSum?: unknown; ratingCount?: unknown } };
    const ratingSum = Number(data.stats?.ratingSum ?? 0) - (created ? 0 : previousRating) + input.rating;
    const ratingCount = Number(data.stats?.ratingCount ?? 0) + (created ? 1 : 0);
    tx.set(
      listingRef,
      {
        stats: {
          hires: Number(data.stats?.hires ?? 0),
          ratingSum: Math.max(0, ratingSum),
          ratingCount: Math.max(0, ratingCount),
        },
        updatedAtMs: now,
      },
      { merge: true },
    );
  });

  const listing = await readListing(input.listingId);
  return { review, rating: listing ? rateForListing(listing) : input.rating, created };
}

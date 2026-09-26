import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";

export type PlatformAdFormat = "image" | "video" | "link";

export interface PlatformAd {
  id: string;
  placement: string;
  format: PlatformAdFormat;
  title: string;
  advertiser: string;
  description?: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  targetUrl: string;
  ctaLabel?: string;
  enabled: boolean;
  startsAtMs?: number;
  endsAtMs?: number;
  priority: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type PlatformAdInput = Omit<PlatformAd, "id" | "createdAtMs" | "updatedAtMs">;

const COLLECTION = "platformAds";
const EVENTS_COLLECTION = "platformAdEvents";

function assertHttpUrl(value: string, field: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${field} doit être une URL valide.`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${field} doit utiliser HTTP(S).`);
  }
  return parsed.toString();
}

export function validatePlatformAdInput(input: PlatformAdInput): PlatformAdInput {
  if (!input.placement.trim() || input.placement.length > 80) throw new Error("Placement publicitaire invalide.");
  if (!["image", "video", "link"].includes(input.format)) throw new Error("Format publicitaire invalide.");
  if (!input.title.trim() || input.title.length > 160) throw new Error("Le titre publicitaire est requis.");
  if (!input.advertiser.trim() || input.advertiser.length > 120) throw new Error("L'annonceur est requis.");
  if (input.description && input.description.length > 500) throw new Error("La description est trop longue.");
  if (input.text && input.text.length > 2_000) throw new Error("Le texte publicitaire est trop long.");
  if (input.ctaLabel && input.ctaLabel.length > 60) throw new Error("Le libellé CTA est trop long.");
  if (!Number.isFinite(input.priority) || input.priority < -1000 || input.priority > 1000) throw new Error("Priorité invalide.");

  const normalized: PlatformAdInput = {
    ...input,
    placement: input.placement.trim(),
    title: input.title.trim(),
    advertiser: input.advertiser.trim(),
    description: input.description?.trim() || undefined,
    text: input.text?.trim() || undefined,
    targetUrl: assertHttpUrl(input.targetUrl.trim(), "targetUrl"),
    ctaLabel: input.ctaLabel?.trim() || undefined,
    imageUrl: input.imageUrl ? assertHttpUrl(input.imageUrl.trim(), "imageUrl") : undefined,
    videoUrl: input.videoUrl ? assertHttpUrl(input.videoUrl.trim(), "videoUrl") : undefined,
    enabled: input.enabled !== false,
    startsAtMs: input.startsAtMs && Number.isFinite(input.startsAtMs) ? input.startsAtMs : undefined,
    endsAtMs: input.endsAtMs && Number.isFinite(input.endsAtMs) ? input.endsAtMs : undefined,
    priority: Math.round(input.priority),
  };

  if (normalized.format === "image" && !normalized.imageUrl) throw new Error("Une publicité image doit définir imageUrl.");
  if (normalized.format === "video" && !normalized.videoUrl) throw new Error("Une publicité vidéo doit définir videoUrl.");
  if (normalized.startsAtMs && normalized.endsAtMs && normalized.endsAtMs <= normalized.startsAtMs) throw new Error("La date de fin doit être postérieure à la date de début.");
  return normalized;
}

export async function listPlatformAds(placement?: string): Promise<PlatformAd[]> {
  const collection = adminDb.collection(COLLECTION);
  const snapshot = placement
    ? await collection.where("placement", "==", placement).limit(200).get()
    : await collection.limit(200).get();
  return snapshot.docs
    .map((doc) => serializeAd(doc.id, doc.data()))
    .sort((a, b) => b.priority - a.priority || b.updatedAtMs - a.updatedAtMs);
}

/** Annonces réellement diffusables : activées et dans leur fenêtre de diffusion. */
export async function listEligiblePlatformAds(placement: string, nowMs = Date.now()): Promise<PlatformAd[]> {
  return (await listPlatformAds(placement)).filter((ad) => isCurrentlyEligible(ad, nowMs));
}

function isCurrentlyEligible(ad: PlatformAd, nowMs: number): boolean {
  return ad.enabled && (!ad.startsAtMs || ad.startsAtMs <= nowMs) && (!ad.endsAtMs || ad.endsAtMs > nowMs);
}

function fallbackAd(placement: string): PlatformAd {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://gen3ia.online").replace(/\/+$/, "");
  const now = Date.now();
  return {
    id: "fallback-gen3ia-marketplace",
    placement,
    format: "link",
    title: "Découvrez les capacités de Gen3ia",
    advertiser: "Gen3ia",
    description: "Explorez les agents, extensions et ressources disponibles dans l’écosystème Gen3ia.",
    text: "Marketplace Gen3ia",
    targetUrl: `${base}/marketplace`,
    ctaLabel: "Découvrir",
    enabled: true,
    priority: -1000,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

export async function choosePlatformAd(placement: string): Promise<PlatformAd> {
  const eligible = (await listPlatformAds(placement)).filter((ad) => isCurrentlyEligible(ad, Date.now()));
  if (eligible.length === 0) return fallbackAd(placement);
  const highestPriority = eligible[0].priority;
  const candidates = eligible.filter((ad) => ad.priority === highestPriority);
  return candidates[Math.floor(Math.random() * candidates.length)] ?? eligible[0];
}

export async function recordPlatformAdEvent(params: {
  adId: string;
  placement: string;
  type: "impression" | "click";
  userId?: string;
}): Promise<void> {
  await adminDb.collection(EVENTS_COLLECTION).doc(randomUUID()).set({
    adId: params.adId.slice(0, 160),
    placement: params.placement.slice(0, 80),
    type: params.type,
    ...(params.userId ? { userId: params.userId.slice(0, 160) } : {}),
    createdAt: FieldValue.serverTimestamp(),
    createdAtMs: Date.now(),
  });
}

export async function createPlatformAd(input: PlatformAdInput): Promise<PlatformAd> {
  const normalized = validatePlatformAdInput(input);
  const id = randomUUID();
  const now = Date.now();
  await adminDb.collection(COLLECTION).doc(id).set({ ...normalized, createdAtMs: now, updatedAtMs: now });
  return { id, ...normalized, createdAtMs: now, updatedAtMs: now };
}

export async function updatePlatformAd(id: string, patch: Partial<PlatformAdInput>): Promise<PlatformAd> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  const existing = await ref.get();
  if (!existing.exists) throw new Error("Publicité introuvable.");
  const current = serializeAd(id, existing.data()!);
  const merged = validatePlatformAdInput({
    placement: patch.placement ?? current.placement,
    format: patch.format ?? current.format,
    title: patch.title ?? current.title,
    advertiser: patch.advertiser ?? current.advertiser,
    description: patch.description ?? current.description,
    text: patch.text ?? current.text,
    imageUrl: patch.imageUrl ?? current.imageUrl,
    videoUrl: patch.videoUrl ?? current.videoUrl,
    targetUrl: patch.targetUrl ?? current.targetUrl,
    ctaLabel: patch.ctaLabel ?? current.ctaLabel,
    enabled: patch.enabled ?? current.enabled,
    startsAtMs: patch.startsAtMs ?? current.startsAtMs,
    endsAtMs: patch.endsAtMs ?? current.endsAtMs,
    priority: patch.priority ?? current.priority,
  });
  const updatedAtMs = Date.now();
  await ref.update({ ...merged, updatedAtMs });
  return { id, ...merged, createdAtMs: current.createdAtMs, updatedAtMs };
}

export async function deletePlatformAd(id: string): Promise<void> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  if (!(await ref.get()).exists) throw new Error("Publicité introuvable.");
  await ref.delete();
}

function serializeAd(id: string, data: DocumentData): PlatformAd {
  return {
    id,
    placement: String(data.placement ?? "settings"),
    format: data.format === "video" || data.format === "image" ? data.format : "link",
    title: String(data.title ?? ""),
    advertiser: String(data.advertiser ?? ""),
    description: typeof data.description === "string" ? data.description : undefined,
    text: typeof data.text === "string" ? data.text : undefined,
    imageUrl: typeof data.imageUrl === "string" ? data.imageUrl : undefined,
    videoUrl: typeof data.videoUrl === "string" ? data.videoUrl : undefined,
    targetUrl: String(data.targetUrl ?? "https://gen3ia.online/marketplace"),
    ctaLabel: typeof data.ctaLabel === "string" ? data.ctaLabel : undefined,
    enabled: data.enabled !== false,
    startsAtMs: Number.isFinite(Number(data.startsAtMs)) ? Number(data.startsAtMs) : undefined,
    endsAtMs: Number.isFinite(Number(data.endsAtMs)) ? Number(data.endsAtMs) : undefined,
    priority: Number.isFinite(Number(data.priority)) ? Number(data.priority) : 0,
    createdAtMs: Number.isFinite(Number(data.createdAtMs)) ? Number(data.createdAtMs) : Date.now(),
    updatedAtMs: Number.isFinite(Number(data.updatedAtMs)) ? Number(data.updatedAtMs) : Date.now(),
  };
}

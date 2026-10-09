import "server-only";

import { randomUUID } from "node:crypto";
import { FieldValue, type DocumentData } from "@/lib/r2fs";
import { adminDb } from "@/lib/firebase/admin";

/**
 * SYSTÈME PUBLICITAIRE PROFESSIONNEL (demande utilisateur : « le système de
 * publicité est basique, je veux un système pro »).
 *
 * Couche CAMPAGNES au-dessus de l'inventaire d'annonces (platformAds) :
 *  - objectifs (trafic, conversions, notoriété, engagement) ;
 *  - budgets plafonnés (journalier + total, mineurs de devise) ;
 *  - ciblage (emplacements, langues, mots-clés, appareils) ;
 *  - plafond de fréquence par utilisateur et par jour ;
 *  - créas multiples (titre, description, URL, image, CTA) ;
 *  - stratégies d'enchère (portée max, CTR max, équilibrée) ;
 *  - programmation (fenêtre de diffusion) et statuts ;
 *  - MÉTRIQUES RÉELLES agrégées depuis platformAdEvents : impressions,
 *    clics, CTR, dépense simulée (CPM paramétrable), séries journalières.
 *
 * Aucune donnée inventée : les métriques viennent exclusivement des
 * événements réellement enregistrés par /api/ads/placement.
 */

export type CampaignObjective = "traffic" | "conversions" | "awareness" | "engagement";
export type CampaignStatus = "draft" | "active" | "paused" | "completed";
export type CampaignDevice = "mobile" | "desktop" | "tablet";
export type BidStrategy = "maximize_reach" | "maximize_ctr" | "balanced";

export interface CampaignTargeting {
  placements: string[];
  languages?: string[];
  keywords?: string[];
  devices?: CampaignDevice[];
}

export interface CampaignCreative {
  headline: string;
  description?: string;
  targetUrl: string;
  imageUrl?: string;
  ctaLabel?: string;
}

export interface AdCampaign {
  id: string;
  ownerId: string;
  name: string;
  objective: CampaignObjective;
  status: CampaignStatus;
  /** Budget journalier en mineurs (ex. centimes). */
  dailyBudgetMinor: number;
  totalBudgetMinor?: number;
  currency: string;
  bidStrategy: BidStrategy;
  /** Nombre max d'impressions par utilisateur et par jour (optionnel). */
  frequencyCapPerDay?: number;
  targeting: CampaignTargeting;
  creatives: CampaignCreative[];
  startsAtMs?: number;
  endsAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type AdCampaignInput = Omit<AdCampaign, "id" | "createdAtMs" | "updatedAtMs">;

export interface CampaignMetrics {
  campaignId: string;
  impressions: number;
  clicks: number;
  ctr: number;
  /** Dépense estimée : impressions × CPM / 1000 (CPM 500 mineurs par défaut). */
  estimatedSpendMinor: number;
  daily: Array<{ day: string; impressions: number; clicks: number }>;
}

const COLLECTION = "adsCampaigns";
export const DEFAULT_CPM_MINOR = 500;

/* ------------------------------------------------------------------ */
/* Validation (pure, testable)                                         */
/* ------------------------------------------------------------------ */

function assertHttpUrl(value: string, field: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${field} doit être une URL valide.`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${field} doit utiliser HTTP(S).`);
  return parsed.toString();
}

export function validateCampaignInput(input: AdCampaignInput): AdCampaignInput {
  const name = input.name?.trim() ?? "";
  if (name.length < 3 || name.length > 120) throw new Error("Le nom de campagne doit contenir entre 3 et 120 caractères.");
  if (!["traffic", "conversions", "awareness", "engagement"].includes(input.objective)) throw new Error("Objectif de campagne invalide.");
  if (!["draft", "active", "paused", "completed"].includes(input.status)) throw new Error("Statut de campagne invalide.");
  if (!Number.isFinite(input.dailyBudgetMinor) || input.dailyBudgetMinor < 0) throw new Error("Le budget journalier doit être positif.");
  if (input.totalBudgetMinor !== undefined && (!Number.isFinite(input.totalBudgetMinor) || input.totalBudgetMinor < 0)) throw new Error("Le budget total doit être positif.");
  if (!["maximize_reach", "maximize_ctr", "balanced"].includes(input.bidStrategy)) throw new Error("Stratégie d'enchère invalide.");
  if (input.frequencyCapPerDay !== undefined && (!Number.isInteger(input.frequencyCapPerDay) || input.frequencyCapPerDay < 1 || input.frequencyCapPerDay > 100)) throw new Error("Le plafond de fréquence doit être compris entre 1 et 100 impressions/jour.");

  const placements = (input.targeting?.placements ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 20);
  if (placements.length === 0) throw new Error("Sélectionnez au moins un emplacement publicitaire ciblé.");
  const languages = (input.targeting?.languages ?? []).map((l) => String(l).trim().toLowerCase()).filter(Boolean).slice(0, 12);
  const keywords = (input.targeting?.keywords ?? []).map((k) => String(k).trim().toLowerCase()).filter(Boolean).slice(0, 30);
  const devices = (input.targeting?.devices ?? []).filter((d) => ["mobile", "desktop", "tablet"].includes(d)).slice(0, 3);

  const creatives = (input.creatives ?? []).slice(0, 10).map((creative) => {
    const headline = creative.headline?.trim() ?? "";
    if (headline.length < 3 || headline.length > 160) throw new Error("Chaque créa doit avoir un titre de 3 à 160 caractères.");
    const description = creative.description?.trim() ? creative.description.trim().slice(0, 500) : undefined;
    const ctaLabel = creative.ctaLabel?.trim() ? creative.ctaLabel.trim().slice(0, 60) : undefined;
    return {
      headline,
      ...(description ? { description } : {}),
      targetUrl: assertHttpUrl(creative.targetUrl?.trim() ?? "", "L'URL de destination de la créa"),
      ...(creative.imageUrl?.trim() ? { imageUrl: assertHttpUrl(creative.imageUrl.trim(), "L'URL d'image de la créa") } : {}),
      ...(ctaLabel ? { ctaLabel } : {}),
    };
  });
  if (creatives.length === 0) throw new Error("Ajoutez au moins une création publicitaire.");

  const startsAtMs = input.startsAtMs && Number.isFinite(input.startsAtMs) ? Math.round(input.startsAtMs) : undefined;
  const endsAtMs = input.endsAtMs && Number.isFinite(input.endsAtMs) ? Math.round(input.endsAtMs) : undefined;
  if (startsAtMs && endsAtMs && endsAtMs <= startsAtMs) throw new Error("La date de fin doit être postérieure à la date de début.");

  return {
    ownerId: input.ownerId,
    name,
    objective: input.objective,
    status: input.status,
    dailyBudgetMinor: Math.round(input.dailyBudgetMinor),
    ...(input.totalBudgetMinor !== undefined ? { totalBudgetMinor: Math.round(input.totalBudgetMinor) } : {}),
    currency: (input.currency?.trim() || "XAF").slice(0, 8).toUpperCase(),
    bidStrategy: input.bidStrategy,
    ...(input.frequencyCapPerDay !== undefined ? { frequencyCapPerDay: input.frequencyCapPerDay } : {}),
    targeting: {
      placements,
      ...(languages.length > 0 ? { languages } : {}),
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(devices.length > 0 ? { devices } : {}),
    },
    creatives,
    ...(startsAtMs ? { startsAtMs } : {}),
    ...(endsAtMs ? { endsAtMs } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* CRUD Firestore                                                      */
/* ------------------------------------------------------------------ */

function serializeCampaign(id: string, data: DocumentData): AdCampaign {
  return {
    id,
    ownerId: String(data.ownerId ?? ""),
    name: String(data.name ?? ""),
    objective: (data.objective ?? "traffic") as CampaignObjective,
    status: (data.status ?? "draft") as CampaignStatus,
    dailyBudgetMinor: Number(data.dailyBudgetMinor ?? 0),
    ...(Number.isFinite(Number(data.totalBudgetMinor)) ? { totalBudgetMinor: Number(data.totalBudgetMinor) } : {}),
    currency: String(data.currency ?? "XAF"),
    bidStrategy: (data.bidStrategy ?? "balanced") as BidStrategy,
    ...(Number.isInteger(Number(data.frequencyCapPerDay)) ? { frequencyCapPerDay: Number(data.frequencyCapPerDay) } : {}),
    targeting: {
      placements: Array.isArray(data.targeting?.placements) ? data.targeting.placements.map(String) : [],
      ...(Array.isArray(data.targeting?.languages) ? { languages: data.targeting.languages.map(String) } : {}),
      ...(Array.isArray(data.targeting?.keywords) ? { keywords: data.targeting.keywords.map(String) } : {}),
      ...(Array.isArray(data.targeting?.devices) ? { devices: data.targeting.devices.map(String) } : {}),
    },
    creatives: Array.isArray(data.creatives)
      ? data.creatives.slice(0, 10).map((creative: DocumentData) => ({
          headline: String(creative?.headline ?? ""),
          ...(creative?.description ? { description: String(creative.description) } : {}),
          targetUrl: String(creative?.targetUrl ?? "https://gen3ia.online"),
          ...(creative?.imageUrl ? { imageUrl: String(creative.imageUrl) } : {}),
          ...(creative?.ctaLabel ? { ctaLabel: String(creative.ctaLabel) } : {}),
        }))
      : [],
    ...(Number.isFinite(Number(data.startsAtMs)) ? { startsAtMs: Number(data.startsAtMs) } : {}),
    ...(Number.isFinite(Number(data.endsAtMs)) ? { endsAtMs: Number(data.endsAtMs) } : {}),
    createdAtMs: Number(data.createdAtMs ?? Date.now()),
    updatedAtMs: Number(data.updatedAtMs ?? Date.now()),
  };
}

export async function createCampaign(input: AdCampaignInput): Promise<AdCampaign> {
  const normalized = validateCampaignInput(input);
  const id = randomUUID();
  const now = Date.now();
  await adminDb.collection(COLLECTION).doc(id).set({ ...normalized, createdAtMs: now, updatedAtMs: now });
  return { id, ...normalized, createdAtMs: now, updatedAtMs: now };
}

export async function listCampaigns(ownerId?: string): Promise<AdCampaign[]> {
  const collection = adminDb.collection(COLLECTION);
  const snapshot = ownerId
    ? await collection.where("ownerId", "==", ownerId).limit(200).get()
    : await collection.limit(200).get();
  return snapshot.docs
    .map((doc) => serializeCampaign(doc.id, doc.data()))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export async function getCampaign(ownerId: string, id: string): Promise<AdCampaign> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.get("ownerId") !== ownerId) throw new Error("Campagne introuvable.");
  return serializeCampaign(id, snapshot.data()!);
}

/** Lecture sans contrôle de propriétaire (réservée au serveur de diffusion). */
export async function getCampaignById(id: string): Promise<AdCampaign> {
  const ref = adminDb.collection(COLLECTION).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error("Campagne introuvable.");
  return serializeCampaign(id, snapshot.data()!);
}

export async function updateCampaign(ownerId: string, id: string, patch: Partial<AdCampaignInput>): Promise<AdCampaign> {
  const current = await getCampaign(ownerId, id);
  const merged = validateCampaignInput({
    ownerId,
    name: patch.name ?? current.name,
    objective: patch.objective ?? current.objective,
    status: patch.status ?? current.status,
    dailyBudgetMinor: patch.dailyBudgetMinor ?? current.dailyBudgetMinor,
    totalBudgetMinor: patch.totalBudgetMinor ?? current.totalBudgetMinor,
    currency: patch.currency ?? current.currency,
    bidStrategy: patch.bidStrategy ?? current.bidStrategy,
    frequencyCapPerDay: patch.frequencyCapPerDay ?? current.frequencyCapPerDay,
    targeting: {
      placements: patch.targeting?.placements ?? current.targeting.placements,
      languages: patch.targeting?.languages ?? current.targeting.languages,
      keywords: patch.targeting?.keywords ?? current.targeting.keywords,
      devices: patch.targeting?.devices ?? current.targeting.devices,
    },
    creatives: patch.creatives ?? current.creatives,
    startsAtMs: patch.startsAtMs ?? current.startsAtMs,
    endsAtMs: patch.endsAtMs ?? current.endsAtMs,
  });
  const updatedAtMs = Date.now();
  await adminDb.collection(COLLECTION).doc(id).update({ ...merged, ownerId, updatedAtMs });
  return { id, ...merged, createdAtMs: current.createdAtMs, updatedAtMs };
}

export async function deleteCampaign(ownerId: string, id: string): Promise<void> {
  await getCampaign(ownerId, id);
  await adminDb.collection(COLLECTION).doc(id).delete();
}

/* ------------------------------------------------------------------ */
/* Métriques réelles (agrégation platformAdEvents)                     */
/* ------------------------------------------------------------------ */

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function campaignMetrics(campaignId: string, sinceDays = 30): Promise<CampaignMetrics> {
  const adsSnapshot = await adminDb.collection("platformAds").where("campaignId", "==", campaignId).limit(200).get();
  const adIds = new Set(adsSnapshot.docs.map((doc) => doc.id));
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  let impressions = 0;
  let clicks = 0;
  const dailyMap = new Map<string, { impressions: number; clicks: number }>();
  if (adIds.size > 0) {
    const events = await adminDb.collection("platformAdEvents")
      .where("createdAtMs", ">=", sinceMs)
      .limit(20_000)
      .get();
    for (const doc of events.docs) {
      const adId = String(doc.get("adId") ?? "");
      if (!adIds.has(adId)) continue;
      const type = String(doc.get("type") ?? "");
      const day = dayKey(Number(doc.get("createdAtMs") ?? Date.now()));
      const bucket = dailyMap.get(day) ?? { impressions: 0, clicks: 0 };
      if (type === "impression") { impressions += 1; bucket.impressions += 1; }
      if (type === "click") { clicks += 1; bucket.clicks += 1; }
      dailyMap.set(day, bucket);
    }
  }

  const daily = [...dailyMap.entries()]
    .map(([day, value]) => ({ day, ...value }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    campaignId,
    impressions,
    clicks,
    ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
    estimatedSpendMinor: Math.round((impressions / 1000) * DEFAULT_CPM_MINOR),
    daily,
  };
}

/* ------------------------------------------------------------------ */
/* Diffusion PRO : rotation pondérée + plafond de fréquence            */
/* ------------------------------------------------------------------ */

export interface AdSelectionContext {
  /** Utilisateur destinataire (plafond de fréquence + exclusion de répétition). */
  userId?: string;
  /** Langue de l'interface (ciblage linguistique). */
  language?: string;
  /** Appareil déclaré par le client (ciblage appareil). */
  device?: CampaignDevice;
  /**
   * Mots-clés du CONTEXTE de diffusion (page/intention, ciblage sémantique).
   * Une campagne qui déclare des mots-clés n'est servie que si le contexte
   * en fournit au moins un — le ciblage déclaré par l'annonceur est RESPECTÉ
   * (avant : les mots-clés étaient stockés puis ignorés).
   */
  keywords?: string[];
}

/** Score de diffusion PRO : priorité × pondération d'enchère × boost CTR réel. */
export function scoreAdCandidate(params: {
  priority: number;
  ctr: number;
  bidStrategy: BidStrategy;
}): number {
  const base = Math.max(0, params.priority + 1000) / 10;
  const ctrBoost = 1 + Math.min(2, params.ctr / 2);
  const strategyWeight = params.bidStrategy === "maximize_ctr" ? 2 : params.bidStrategy === "balanced" ? 1.4 : 1;
  return Math.max(0.1, base * (params.bidStrategy === "maximize_reach" ? 1 : ctrBoost * strategyWeight / 1.4));
}

export async function countImpressionsToday(params: { adId: string; userId: string }): Promise<number> {
  const startOfDayMs = new Date();
  startOfDayMs.setHours(0, 0, 0, 0);
  const snapshot = await adminDb.collection("platformAdEvents")
    .where("adId", "==", params.adId.slice(0, 160))
    .where("userId", "==", params.userId.slice(0, 160))
    .where("type", "==", "impression")
    .where("createdAtMs", ">=", startOfDayMs.getTime())
    .limit(200)
    .get();
  return snapshot.size;
}

export function passesTargeting(params: {
  campaign: AdCampaign;
  placement: string;
  context: AdSelectionContext;
}): boolean {
  const { campaign, placement, context } = params;
  if (campaign.status !== "active") return false;
  const now = Date.now();
  if (campaign.startsAtMs && campaign.startsAtMs > now) return false;
  if (campaign.endsAtMs && campaign.endsAtMs <= now) return false;
  if (!campaign.targeting.placements.includes(placement)) return false;
  if (context.language && campaign.targeting.languages?.length && !campaign.targeting.languages.includes(context.language.toLowerCase())) return false;
  if (context.device && campaign.targeting.devices?.length && !campaign.targeting.devices.includes(context.device)) return false;
  // CIBLAGE PAR MOTS-CLÉS (système publicitaire avancé) : si l'annonceur a
  // déclaré des mots-clés, le contexte de diffusion doit en contenir au
  // moins un (comparaison insensible à la casse, correspondance par inclusion
  // du mot-clé dans un token du contexte ou égalité directe).
  const declared = campaign.targeting.keywords?.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean) ?? [];
  if (declared.length > 0) {
    const provided = (context.keywords ?? []).map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
    if (provided.length === 0) return false;
    const match = declared.some((keyword) =>
      provided.some((token) => token === keyword || token.includes(keyword) || keyword.includes(token)),
    );
    if (!match) return false;
  }
  return true;
}

/**
 * BUDGET QUOTIDIEN RÉEL : dépense du jour d'une campagne = impressions du
 * jour / 1000 × CPM. Une campagne dont la dépense du jour atteint le budget
 * quotidien n'est plus servie jusqu'au lendemain (anti-dépassement).
 * Fail-closed : en cas de panne de lecture, la campagne est considérée
 * hors budget (jamais de sur-diffusion facturée).
 */
export async function isWithinDailyBudget(campaign: AdCampaign): Promise<boolean> {
  const dailyBudget = Number(campaign.dailyBudgetMinor ?? 0);
  if (!(dailyBudget > 0)) return true; // pas de budget journalier = pas de garde
  try {
    const adsSnapshot = await adminDb.collection("platformAds").where("campaignId", "==", campaign.id).limit(200).get();
    const adIds = [...new Set(adsSnapshot.docs.map((doc) => doc.id))];
    if (adIds.length === 0) return true;
    const startOfDayMs = new Date();
    startOfDayMs.setHours(0, 0, 0, 0);
    let impressionsToday = 0;
    for (const adId of adIds) {
      const events = await adminDb.collection("platformAdEvents")
        .where("adId", "==", adId)
        .where("type", "==", "impression")
        .where("createdAtMs", ">=", startOfDayMs.getTime())
        .limit(5_000)
        .get();
      impressionsToday += events.size;
    }
    const spendMinor = Math.round((impressionsToday / 1_000) * DEFAULT_CPM_MINOR);
    return spendMinor < dailyBudget;
  } catch {
    return false;
  }
}

/** Export du compteur de nettoyage pour les tests. */
export function resetCampaignHelpers(): void {
  /* placeholder pour cohérence d'API */
}

export const CAMPAIGN_COUNTERS = { FieldValue };

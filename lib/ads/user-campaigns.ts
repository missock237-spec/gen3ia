import "server-only";

import { randomUUID } from "node:crypto";

import { adminDb } from "@/lib/firebase/admin";
import {
  campaignMetrics,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
  validateCampaignInput,
  type AdCampaign,
  type AdCampaignInput,
  type CampaignMetrics,
} from "@/lib/ads/campaigns";
import {
  validatePlatformAdInput,
  type PlatformAdInput,
} from "@/lib/ads/platform-placement";

/**
 * GEN ADS — campagnes publicitaires UTILISATEUR (self-service).
 *
 * Demande utilisateur : « dans paramètres gen ads les utilisateurs doivent
 * pouvoir mettre en avant leur pub dans le projet ».
 *
 * Chaque utilisateur connecté crée ses propres campagnes depuis
 * Paramètres › Publicité (Gen Ads) : objectif, budget, ciblage par
 * emplacements, créations. Une campagne ACTIVE est automatiquement
 * publiée dans l'inventaire de diffusion (`platformAds`) : elle est alors
 * mise en avant dans le projet — y compris sous chaque réponse ou résultat
 * résolu par Gen3ia (placement `response_inline`).
 *
 * Garde-fous self-service :
 *  - quota de campagnes par utilisateur (MAX_CAMPAIGNS_PER_USER) ;
 *  - emplacements restreints au catalogue public AD_PLACEMENTS ;
 *  - nombre d'emplacements et de créations bornés ;
 *  - toute la validation PRO de campaigns.ts est réutilisée (budgets,
 *    fenêtres de diffusion, URL des créas…).
 */

/** Nombre maximum de campagnes par utilisateur (self-service). */
export const MAX_CAMPAIGNS_PER_USER = 10;
/** Emplacements maximum ciblés par campagne utilisateur. */
export const MAX_USER_PLACEMENTS = 6;
/** Créations maximum par campagne utilisateur. */
export const MAX_USER_CREATIVES = 3;
/** Priorité de diffusion des annonces utilisateur (rotation équitable). */
export const USER_AD_PRIORITY = 0;

const ADS_COLLECTION = "platformAds";

/* ------------------------------------------------------------------ */
/* Catalogue public des emplacements                                   */
/* ------------------------------------------------------------------ */

export interface AdPlacementInfo {
  id: string;
  label: string;
  description: string;
}

/** Emplacements où une campagne Gen Ads peut être mise en avant. */
export const AD_PLACEMENTS: AdPlacementInfo[] = [
  {
    id: "response_inline",
    label: "Réponses de l'IA",
    description: "Sous chaque réponse ou résultat résolu par Gen3ia (chat, missions, générations).",
  },
  {
    id: "results",
    label: "Page Résultats",
    description: "Sur la page des livrables générés par vos agents et missions.",
  },
  {
    id: "settings",
    label: "Espace Paramètres",
    description: "Dans l'espace Paramètres › Publicité, visible par tous les comptes.",
  },
  {
    id: "workspace",
    label: "Espace de travail",
    description: "Dans les surfaces de l'espace de travail connecté.",
  },
];

export const AD_PLACEMENT_IDS = AD_PLACEMENTS.map((placement) => placement.id);

/* ------------------------------------------------------------------ */
/* Validation self-service (pure, testable)                           */
/* ------------------------------------------------------------------ */

export type UserCampaignInput = Omit<AdCampaignInput, "ownerId">;

/**
 * Valide une campagne UTILISATEUR : réutilise toute la validation PRO puis
 * applique les garde-fous self-service (emplacements du catalogue, bornes).
 * (interne : ownerId requis, injecté par le service — jamais par le client)
 */
export function validateUserCampaignInput(input: AdCampaignInput): AdCampaignInput {
  const normalized = validateCampaignInput(input);

  const unknown = normalized.targeting.placements.filter(
    (placement) => !AD_PLACEMENT_IDS.includes(placement),
  );
  if (unknown.length > 0) {
    throw new Error(`Emplacement publicitaire inconnu : ${unknown.join(", ")}.`);
  }
  if (normalized.targeting.placements.length > MAX_USER_PLACEMENTS) {
    throw new Error(`Une campagne Gen Ads cible au plus ${MAX_USER_PLACEMENTS} emplacements.`);
  }
  if (normalized.creatives.length > MAX_USER_CREATIVES) {
    throw new Error(`Une campagne Gen Ads contient au plus ${MAX_USER_CREATIVES} créations.`);
  }
  if (normalized.dailyBudgetMinor < 0) {
    throw new Error("Le budget journalier doit être positif.");
  }
  return normalized;
}

/* ------------------------------------------------------------------ */
/* Inventaire de diffusion (pure, testable)                            */
/* ------------------------------------------------------------------ */

/** Entrée d'inventaire utilisateur (une annonce de plateforme). */
export type UserInventoryEntry = PlatformAdInput & { ownerUserId: string };

/**
 * Construit l'inventaire de diffusion d'une campagne : une annonce
 * `platformAds` par (emplacement × création), activée si et seulement si la
 * campagne est ACTIVE. Pure — aucune écriture, testable unitairement.
 */
export function buildInventoryEntries(campaign: AdCampaign): UserInventoryEntry[] {
  const advertiser = (campaign.advertiserName?.trim() || campaign.name).slice(0, 120);
  const enabled = campaign.status === "active";
  // Mots-clés de ciblage contextuel : transportés jusqu'à l'inventaire de
  // diffusion — l'annonce ne s'affiche sous une réponse/résultat que si la
  // requête de l'utilisateur présente une SIMILITUDE avec eux.
  const keywords = (campaign.targeting.keywords ?? [])
    .map((keyword) => keyword.trim().toLowerCase().slice(0, 60))
    .filter(Boolean)
    .slice(0, 30);
  const entries: UserInventoryEntry[] = [];

  for (const placement of campaign.targeting.placements.slice(0, MAX_USER_PLACEMENTS)) {
    for (const creative of campaign.creatives.slice(0, MAX_USER_CREATIVES)) {
      entries.push({
        placement,
        format: creative.imageUrl ? "image" : "link",
        title: creative.headline.slice(0, 160),
        advertiser,
        ...(creative.description ? { description: creative.description.slice(0, 500) } : {}),
        targetUrl: creative.targetUrl,
        ...(creative.imageUrl ? { imageUrl: creative.imageUrl } : {}),
        ...(creative.ctaLabel ? { ctaLabel: creative.ctaLabel } : {}),
        ...(keywords.length > 0 ? { keywords } : {}),
        enabled,
        priority: USER_AD_PRIORITY,
        campaignId: campaign.id,
        ownerUserId: campaign.ownerId,
      });
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Synchronisation inventaire ↔ campagne                               */
/* ------------------------------------------------------------------ */

/**
 * Synchronise l'inventaire de diffusion avec l'état de la campagne :
 *  1. supprime TOUTES les annonces `platformAds` rattachées à la campagne ;
 *  2. recrée l'inventaire (emplacements × créations) si elle est ACTIVE.
 *
 * Une campagne en pause / brouillon / terminée ne diffuse PLUS rien —
 * l'annonce ne peut jamais « survivre » à sa campagne. Retour : nombre
 * d'annonces réellement publiées.
 */
export async function syncCampaignInventory(campaign: AdCampaign): Promise<number> {
  const existing = await adminDb
    .collection(ADS_COLLECTION)
    .where("campaignId", "==", campaign.id)
    .limit(300)
    .get();
  await Promise.all(existing.docs.map((doc) => doc.ref.delete()));

  if (campaign.status !== "active") return 0;

  const entries = buildInventoryEntries(campaign);
  const now = Date.now();
  await Promise.all(
    entries.map((entry) => {
      // Validation complète de chaque annonce publiée (URL, longueurs…).
      // NB : validatePlatformAdInput propage les champs additionnels via son
      // spread d'entrée — `ownerUserId` (traçabilité utilisateur) survit.
      const normalized = validatePlatformAdInput(entry);
      return adminDb
        .collection(ADS_COLLECTION)
        .doc(randomUUID())
        .set({ ...normalized, ownerUserId: entry.ownerUserId, createdAtMs: now, updatedAtMs: now });
    }),
  );
  return entries.length;
}

/* ------------------------------------------------------------------ */
/* Service utilisateur                                                 */
/* ------------------------------------------------------------------ */

export type UserCampaignWithMetrics = AdCampaign & { metrics: CampaignMetrics | null };

/** Liste les campagnes de l'utilisateur avec leurs métriques réelles. */
export async function listUserCampaigns(userId: string): Promise<UserCampaignWithMetrics[]> {
  const campaigns = await listCampaigns(userId);
  return Promise.all(
    campaigns.map(async (campaign) => ({
      ...campaign,
      metrics: await campaignMetrics(campaign.id).catch(() => null),
    })),
  );
}

/** Crée la campagne de l'utilisateur et publie son inventaire si active. */
export async function createUserCampaign(
  userId: string,
  input: UserCampaignInput,
): Promise<{ campaign: AdCampaign; publishedAds: number }> {
  const normalized = validateUserCampaignInput({ ...input, ownerId: userId });

  const existing = await listCampaigns(userId);
  if (existing.length >= MAX_CAMPAIGNS_PER_USER) {
    throw new Error(
      `Quota atteint : ${MAX_CAMPAIGNS_PER_USER} campagnes maximum par utilisateur. Supprimez une campagne pour en créer une nouvelle.`,
    );
  }

  const campaign = await createCampaign(normalized);
  const publishedAds = await syncCampaignInventory(campaign);
  return { campaign, publishedAds };
}

/** Met à jour la campagne de l'utilisateur et resynchronise la diffusion. */
export async function updateUserCampaign(
  userId: string,
  id: string,
  patch: Partial<UserCampaignInput>,
): Promise<{ campaign: AdCampaign; publishedAds: number }> {
  // Garde de propriétaire : getCampaign lève si la campagne n'est pas à cet utilisateur.
  await getCampaign(userId, id);
  const normalizedPatch: Partial<UserCampaignInput> = { ...patch };

  // Self-service : les emplacements restent dans le catalogue public.
  if (normalizedPatch.targeting?.placements) {
    const unknown = normalizedPatch.targeting.placements.filter(
      (placement) => !AD_PLACEMENT_IDS.includes(placement),
    );
    if (unknown.length > 0) {
      throw new Error(`Emplacement publicitaire inconnu : ${unknown.join(", ")}.`);
    }
    if (normalizedPatch.targeting.placements.length > MAX_USER_PLACEMENTS) {
      throw new Error(`Une campagne Gen Ads cible au plus ${MAX_USER_PLACEMENTS} emplacements.`);
    }
  }
  if (normalizedPatch.creatives && normalizedPatch.creatives.length > MAX_USER_CREATIVES) {
    throw new Error(`Une campagne Gen Ads contient au plus ${MAX_USER_CREATIVES} créations.`);
  }

  // updateCampaign fusionne avec l'existant PUIS revalide tout (campagne complète).
  const campaign = await updateCampaign(userId, id, normalizedPatch);

  // Re-validation self-service du résultat fusionné (borne globale).
  validateUserCampaignInput({
    ownerId: userId,
    name: campaign.name,
    advertiserName: campaign.advertiserName,
    objective: campaign.objective,
    status: campaign.status,
    dailyBudgetMinor: campaign.dailyBudgetMinor,
    totalBudgetMinor: campaign.totalBudgetMinor,
    currency: campaign.currency,
    bidStrategy: campaign.bidStrategy,
    frequencyCapPerDay: campaign.frequencyCapPerDay,
    targeting: campaign.targeting,
    creatives: campaign.creatives,
    startsAtMs: campaign.startsAtMs,
    endsAtMs: campaign.endsAtMs,
  });

  const publishedAds = await syncCampaignInventory(campaign);
  return { campaign, publishedAds };
}

/** Supprime la campagne de l'utilisateur et TOUT son inventaire de diffusion. */
export async function deleteUserCampaign(userId: string, id: string): Promise<void> {
  const campaign = await getCampaign(userId, id);
  await syncCampaignInventory({ ...campaign, status: "completed" });
  await deleteCampaign(userId, id);
}

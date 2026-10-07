import "server-only";

import { randomUUID } from "node:crypto";

import { adminDb } from "@/lib/firebase/admin";
import { getWallet } from "@/lib/billing/wallet";
import { listCampaigns } from "@/lib/ads/campaigns";
import { getEvolutionBrief } from "@/lib/agents/evolution";
import { createQueuedMission } from "@/lib/queue/mission-queue";
import { missionQueueConfigured, publishMissionTick } from "@/lib/queue/qstash";

/**
 * PULSE BUSINESS AUTONOME (concept post-SaaS #7 « Autonomous Business
 * Cloud ») : un rendez-vous périodique (ou déclenché à la demande) qui lit
 * les KPIs RÉELS du cloud business de l'utilisateur — portefeuille,
 * campagnes publicitaires, écueils d'exécution — puis lance une mission
 * d'ajustement bornée :
 *
 *  - la mission reçoit les FAITS (chiffres réels, jamais d'invention) ;
 *  - son livrable est un RAPPORT : constats → recommandations classées par
 *    impact → prochaine revue. Toute dépense ou action externe reste gated
 *    par HITL ailleurs — le pulse ne peut PAS dépenser ;
 *  - combiné aux planifications (schedule.create), le pulse devient une
 *    boucle : indicateurs → rapport → décisions → indicateurs suivants.
 *
 * Exécution via la file d'attente des missions (résilient, facturé à
 * l'usage, survit aux fenêtres serverless).
 */

const COLLECTION = "businessPulses";

export interface BusinessKpis {
  wallet?: { balanceMinor: number; reservedMinor: number; currency: string };
  ads?: { active: number; paused: number; totalDailyBudgetMinor: number };
  topRisks?: string[];
}

function kpiLine(kpis: BusinessKpis): string {
  const lines: string[] = [];
  if (kpis.wallet) {
    lines.push(`- Portefeuille : ${(kpis.wallet.balanceMinor / 100).toFixed(2)} ${kpis.wallet.currency} disponibles, ${(kpis.wallet.reservedMinor / 100).toFixed(2)} réservés.`);
  }
  if (kpis.ads) {
    lines.push(`- Publicité interne : ${kpis.ads.active} campagne(s) active(s), ${kpis.ads.paused} en pause, budget journalier total ${(kpis.ads.totalDailyBudgetMinor / 100).toFixed(2)} EUR.`);
  }
  for (const risk of kpis.topRisks ?? []) {
    lines.push(`- Écueil d'exécution : ${risk}`);
  }
  return lines.join("\n");
}

/** Collecte FAIL-SOFT des KPIs réels (une panne de source = absence, pas d'invention). */
export async function collectBusinessKpis(userId: string): Promise<BusinessKpis> {
  const kpis: BusinessKpis = {};

  const [wallet, campaigns, evolution] = await Promise.all([
    getWallet(userId)
      .then((wallet) => ({ balanceMinor: wallet.balanceMinor, reservedMinor: wallet.reservedMinor, currency: wallet.currency }))
      .catch(() => undefined),
    listCampaigns(userId)
      .then((campaigns) => ({
        active: campaigns.filter((campaign) => campaign.status === "active").length,
        paused: campaigns.filter((campaign) => campaign.status === "paused").length,
        totalDailyBudgetMinor: campaigns
          .filter((campaign) => campaign.status === "active")
          .reduce((sum, campaign) => sum + (campaign.dailyBudgetMinor ?? 0), 0),
      }))
      .catch(() => undefined),
    getEvolutionBrief(userId),
  ]);

  if (wallet) kpis.wallet = wallet;
  if (campaigns) kpis.ads = campaigns;
  if (evolution.clusters.length > 0) {
    kpis.topRisks = evolution.clusters.slice(0, 3).map((cluster) => `${cluster.errorClass} (${cluster.occurrences}×)`);
  }
  return kpis;
}

/** Objectif de mission du pulse (fait construit hors LLM — aucune invention). */
export function buildPulseObjective(kpis: BusinessKpis): string {
  const facts = kpiLine(kpis);
  return [
    "PULSE BUSINESS GEN3IA — analyse des indicateurs réels et recommandations d'ajustement.",
    "INDICATEURS ACTUELS :",
    facts || "- Aucun indicateur disponible pour l'instant.",
    "",
    "MISSION :",
    "1. Analyse ces indicateurs et identifie les 2 à 4 points d'attention les plus significatifs (budget, risques récurrents d'exécution, campagnes en pause).",
    "2. Pour chaque point, propose un ajustement CONCRET : ce qui changerait, pourquoi, effet attendu, premier pas de mise en œuvre.",
    "3. Interdis-toi toute dépense : ces recommandations seront revues par le propriétaire avant toute action externe.",
    "4. Rédige le rapport final dans ta réponse : constats → recommandations classées par impact → prochaine revue recommandée. Ce rapport EST le livrable de la mission.",
  ].join("\n");
}

export interface PulseLaunch {
  executed: boolean;
  runId?: string;
  statusUrl?: string;
  reason?: string;
}

/**
 * Lance le pulse (ou retourne la proposition en dry-run). La mission est
 * enfilée dans la file RÉELLE — jamais exécutée en ligne (le pulse est un
 * travail d'arrière-plan résilient).
 */
export async function runBusinessPulse(input: { userId: string; orgId?: string; dryRun?: boolean }): Promise<{ kpis: BusinessKpis; objective: string } & PulseLaunch> {
  const kpis = await collectBusinessKpis(input.userId);
  const objective = buildPulseObjective(kpis);

  if (input.dryRun) {
    return { kpis, objective, executed: false, reason: "dry-run" };
  }
  if (!missionQueueConfigured()) {
    return { kpis, objective, executed: false, reason: "File d'attente non configurée — le pulse nécessite la file QStash." };
  }

  const executionId = randomUUID();
  const runId = randomUUID();
  // AUTONOMIE « FAÇON HUMAIN » (exigence production) : le pulse n'est plus
  // un plan à UNE étape codé en dur — l'objectif passe par le PLANIFICATEUR
  // UNIVERSEL, qui compose un vrai plan multi-étapes outillé (recherche web
  // pour les références de marché, analyse, livrable artifact.create
  // téléchargeable). Échec du planificateur → repli sur le plan simple.
  let plan;
  try {
    const { planUniversalAgent } = await import("@/lib/agents/runtime/unified-agent");
    plan = await planUniversalAgent(input.userId, objective);
  } catch {
    plan = {
      executionId,
      objective,
      steps: [
        {
          id: "pulse_analysis",
          type: "llm" as const,
          name: "Analyse + recommandations",
          description: objective,
          dependencies: [],
          status: "pending" as const,
          input: {},
          skillIds: [],
          maxRetries: 2,
          timeoutMs: 120_000,
          sideEffect: false,
          requiresApproval: false,
          agentRole: "analytics",
        },
      ],
      maxConcurrency: 1,
      maxIterations: 6,
    };
  }
  await createQueuedMission({
    runId,
    executionId,
    userId: input.userId,
    objective,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    plan: { ...plan, executionId },
  });
  // ORIGINE CANONIQUE (fix CodeQL request-forgery) : publishMissionTick
  // résout GEN3IA_APP_ORIGIN en interne (allowlist serveur).
  await publishMissionTick(runId);

  await adminDb.collection(COLLECTION).add({
    userId: input.userId,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    runId,
    launchedAtMs: Date.now(),
  }).catch(() => undefined);

  return {
    kpis,
    objective,
    executed: true,
    runId,
    statusUrl: `/api/agents/runs/${runId}`,
  };
}

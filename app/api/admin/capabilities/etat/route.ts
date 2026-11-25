import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { obtenirGestionnaireCapacites } from "@/lib/capabilities/core/capability-manager";
import { santeGlobale } from "@/lib/capabilities/monitoring/capability-health";
import { performanceGlobale } from "@/lib/capabilities/monitoring/performance-monitor";
import { analyserEchecs } from "@/lib/capabilities/monitoring/failure-analyzer";
import { usageParCapacite } from "@/lib/capabilities/monitoring/resource-monitor";
import { lister } from "@/lib/capabilities/storage/capability-repository";
import { historiqueRollbacks } from "@/lib/capabilities/versioning/rollback-manager";
import { niveauAutonomieActuel } from "@/lib/capabilities/autonomy/autonomy-policy-engine";
import { insuffisancesRecentes } from "@/lib/capabilities/autonomy/capability-gap-analyzer";
import { decisionsRecentes } from "@/lib/capabilities/core/capability-decision";
import { plansRecents } from "@/lib/capabilities/autonomy/capability-improvement-planner";
import { cyclesRecents } from "@/lib/capabilities/core/cycle-persistant";
import type { CapabilityRollback, CapabilityVersion } from "@/lib/capabilities/core/capability-contract";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/capabilities/etat — tableau de bord UCE (mission §10) :
 * les 12 indicateurs demandés, TOUS mesurés (aucun faux indicateur
 * d'autonomie). Lecture seule, bornée.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const gestionnaire = obtenirGestionnaireCapacites();
  const [stats, uce, sante, performances, echecs, ressources, rollbacks, versions] = await Promise.all([
    gestionnaire.statistiques(),
    gestionnaire.listerUce(),
    santeGlobale(),
    performanceGlobale(),
    analyserEchecs(),
    usageParCapacite(),
    historiqueRollbacks(undefined),
    lister<CapabilityVersion>("versions", undefined, 100),
  ]);

  const maintenant = Date.now();
  const jourMs = 24 * 3_600_000;
  const decouvertesRecentes = uce
    .filter((c) => c.origin === "decouverte" && maintenant - Date.parse(c.creeLe) < 7 * jourMs)
    .sort((a, b) => b.creeLe.localeCompare(a.creeLe))
    .slice(0, 12)
    .map((c) => ({ id: c.id, nom: c.card.nom, source: c.card.source, creeLe: c.creeLe, score: c.score ?? null }));

  const enTest = uce.filter((c) => c.status === "evaluee" || c.status === "benchmarquee").length;
  const necessitantAutorisation = uce
    .filter((c) => c.status === "proposee")
    .slice(0, 12)
    .map((c) => ({ id: c.id, nom: c.card.nom, score: c.score ?? null, source: c.card.source }));

  const marqueurEvolutions = path.join(process.cwd(), "var", "capabilities", "evolutions-suspendues.json");
  let evolutionsSuspendues = false;
  try {
    evolutionsSuspendues = (await fs.readFile(marqueurEvolutions, "utf8")).trim().length > 0;
  } catch {
    evolutionsSuspendues = false;
  }

  // V1.1 Phase 13 — AUTONOMIE : insuffisances, décisions du cerveau, plans,
  // cycles persistants (chiffres MESURÉS, aucun indicateur simulé).
  const [politique, insuffisances, decisions, plans, cycles, executions] = await Promise.all([
    niveauAutonomieActuel(),
    insuffisancesRecentes(undefined, 100),
    decisionsRecentes(undefined, 100),
    plansRecents(undefined, 100),
    cyclesRecents(undefined, 100),
    lister<{ id: string; status: string }>("executions", undefined, 500),
  ]);
  const ETATS_TERMINAUX = new Set(["completed", "failed", "cancelled", "rolled_back"]);
  const cyclesEnCours = cycles.filter((c) => !ETATS_TERMINAUX.has(c.etat)).length;
  const cyclesTermines = cycles.filter((c) => c.etat === "completed").length;
  const cyclesEchoues = cycles.filter((c) => c.etat === "failed" || c.etat === "cancelled" || c.etat === "rolled_back").length;
  const tentativesBloquees = executions.filter((e) => e.status === "refusee").length;

  return NextResponse.json({
    date: new Date().toISOString(),
    total: stats.total,
    parStatut: stats.parStatut,
    parKind: stats.parKind,
    operationnels: stats.nativesEnregistrees,
    annonces: stats.nativesAnnoncees,
    indisponibles: sante.enEchec + sante.degradees,
    enTest,
    decouvertesRecentes,
    necessitantAutorisation,
    performances: performances.slice(0, 10),
    incidentsOuverts: echecs.incidentsOuverts,
    categoriesEchecs: echecs.categories,
    recommandations: echecs.recommandations,
    ressources: ressources.slice(0, 10),
    versionsRecentes: versions.slice(0, 12).map((v) => ({ id: v.id, capabilityId: v.capabilityId, version: v.version, statut: v.statut, creeLe: v.creeLe })),
    rollbacks: (rollbacks as CapabilityRollback[]).slice(0, 10),
    evolutionsSuspendues,
    autonomie: {
      niveau: politique.niveau,
      niveauPosePar: politique.par ?? null,
      insuffisancesDetectees: insuffisances.length,
      insuffisancesRecentes: insuffisances.slice(0, 10).map((i) => ({ id: i.id, categorie: i.categorie, description: i.description.slice(0, 120), priorite: i.priorite, detecteeLe: i.detecteeLe })),
      decisions: {
        total: decisions.length,
        parStatut: decisions.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.statut]: (acc[d.statut] ?? 0) + 1 }), {}),
        recentes: decisions.slice(0, 10).map((d) => ({ decisionId: d.decisionId, action: d.action, objective: d.objective.slice(0, 120), statut: d.statut, priorite: d.priorite, approbationRequise: d.constraints.requiresApproval, produiteLe: d.produiteLe })),
      },
      plans: {
        total: plans.length,
        parStatut: plans.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.statut]: (acc[p.statut] ?? 0) + 1 }), {}),
        recents: plans.slice(0, 10).map((p) => ({ id: p.id, action: p.action, objectif: p.objectif.slice(0, 120), statut: p.statut, niveauRisque: p.niveauRisque })),
      },
      cycles: {
        enCours: cyclesEnCours,
        termines: cyclesTermines,
        echoues: cyclesEchoues,
        recents: cycles.slice(0, 10).map((c) => ({ id: c.id, etat: c.etat, besoin: c.besoin.slice(0, 100), tentatives: c.tentatives, causeEchec: c.causeEchec?.slice(0, 120) ?? null, majLe: c.majLe })),
      },
    },
    tentativesBloquees,
    limites: [
      "les chiffres reflètent les mesures persistées localement (repli) et Firestore quand disponible",
      "aucune intégration n'est automatique : le statut « proposee » exige une autorisation humaine",
    ],
  });
}

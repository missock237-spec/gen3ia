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
    limites: [
      "les chiffres reflètent les mesures persistées localement (repli) et Firestore quand disponible",
      "aucune intégration n'est automatique : le statut « proposee » exige une autorisation humaine",
    ],
  });
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { protectRoute } from "@/lib/security/route-guard";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { getAgentById, getAgentForUser } from "@/lib/agents/repository";
import { getAgentAnalytics } from "@/lib/agents/analytics";

/**
 * ANALYTIQUE PAR AGENT (Task 131 — axe « Analytique »).
 *
 *   GET /api/agents/[agentId]/analytics?days=7 — métriques de performance
 *   de l'agent sur les N derniers jours : totaux (messages, appels d'outils,
 *   erreurs, tokens), latence p50/p95 calculée depuis les échantillons stockés
 *   et série quotidienne chronologique.
 *
 * Route protégée (protectRoute, même garde que /api/settings/api-keys) :
 * session obligatoire + rate-limit. L'accès suit la politique des autres
 * routes agents (accès org-aware via getAgentForUser) — la distinction
 * 403/404 utilise l'index global : un agent qui existe mais n'est pas
 * accessible depuis ce compte répond 403, un agent inexistant répond 404.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agentId: string }>;
}

const QuerySchema = z.object({
  // Horizon de lecture : défaut 7 jours, maximum 90 (bornage identique à la
  // couche analytics — une valeur non entière ou hors bornes est rejetée).
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await protectRoute(request, { key: "agents-analytics-read" });
  if (!guard.ok) return guard.response;

  try {
    const { agentId } = await context.params;

    // Query string validée par zod : ?days=7|30|…|90 (défaut 7).
    const params = new URL(request.url).searchParams;
    const parsed = QuerySchema.safeParse({ days: params.get("days") ?? 7 });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Paramètre « days » invalide (entier entre 1 et 90).", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    // Propriété (comme les autres routes agents) : accès org-aware complet
    // via getAgentForUser ; sinon distinction 404 (inexistant) / 403 (existe
    // mais pas accessible depuis ce compte).
    const agent = await getAgentForUser(guard.context.userId, agentId);
    if (!agent) {
      const existant = await getAgentById(agentId);
      if (!existant) {
        return NextResponse.json({ error: "Agent introuvable." }, { status: 404 });
      }
      return NextResponse.json({ error: "Cet agent n'est pas accessible depuis votre compte." }, { status: 403 });
    }

    const analytics = await getAgentAnalytics(agentId, parsed.data.days);
    return NextResponse.json(
      { agentId, days: parsed.data.days, analytics },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      errorBody(error, "Analytique de l'agent indisponible."),
      { status: errorStatus(error) },
    );
  }
}

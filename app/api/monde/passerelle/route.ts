import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { errorStatus } from "@/lib/security/http-errors";
import { getNeuralRuntime } from "@/lib/neural/runtime";

/**
 * PASSERELLE DU MONDE VIRTUEL — entraînement des IA DES UTILISATEURS
 * (it.114 — demande propriétaire : le monde virtuel « sert aussi de
 * passerelle entre gen3 et les IA des utilisateurs qui pourraient être
 * entraînées »).
 *
 * Boucle d'entraînement scientifique, reproductible (le Monde est
 * déterministe : mêmes paramètres → même réalité) :
 *   1. enregistrer-agent — l'IA de l'utilisateur s'enregistre (id stable) ;
 *   2. observation       — Gen3 SIMULE un scénario (caps du Monde appliqués)
 *                          et publie le scalaire cible SANS sa valeur ;
 *   3. predire           — l'IA de l'utilisateur soumet sa prédiction ;
 *   4. evaluer           — Gen3 compare à la valeur RÉELLE mesurée : erreur
 *                          relative + score 0..1 + appréciation (feedback).
 *
 * GARDE : utilisateur requis + rate limit. Aucune valeur fabriquée : les
 * scores viennent des simulations réelles (lib/monde — solveurs caps).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SchemaSpec = z.object({
  type: z.string().min(1).max(40),
}).passthrough();

const SchemaCorps = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enregistrer-agent"), nom: z.string().min(1).max(80) }),
  z.object({ action: z.literal("observation"), spec: SchemaSpec, cible: z.string().max(80).optional() }),
  z.object({
    action: z.literal("predire"),
    agentId: z.string().min(1).max(120),
    observationId: z.string().min(1).max(120),
    valeur: z.number().finite(),
  }),
  z.object({ action: z.literal("evaluer"), observationId: z.string().min(1).max(120) }),
]);

export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
    const limite = await enforceRateLimit("monde-passerelle-get", { limit: 60, windowMs: 60_000 });
    if (!limite.allowed) {
      return NextResponse.json({ error: "Trop de consultations." }, { status: 429 });
    }
    const { compartiments } = getNeuralRuntime();
    return NextResponse.json({
      passerelle: compartiments.passerelle.statistiques(),
      agents: compartiments.passerelle.litAgents(),
      protocole: ["enregistrer-agent", "observation", "predire", "evaluer"],
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: errorStatus(error, 500) },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const limite = await enforceRateLimit(`monde-passerelle-post:${user.uid}`, { limit: 30, windowMs: 60_000 });
    if (!limite.allowed) {
      return NextResponse.json(
        { error: "Trop d'appels rapprochés. Réessayez dans quelques instants." },
        { status: 429, headers: { "retry-after": String(Math.ceil((limite.retryAfterMs ?? 60_000) / 1000)) } },
      );
    }

    const corps = SchemaCorps.safeParse(await request.json());
    if (!corps.success) {
      return NextResponse.json(
        { error: "Corps invalide : { action, ... } — actions : enregistrer-agent | observation | predire | evaluer.", issues: corps.error.flatten() },
        { status: 400 },
      );
    }

    const { compartiments } = getNeuralRuntime();
    const passerelle = compartiments.passerelle;

    switch (corps.data.action) {
      case "enregistrer-agent": {
        const agent = passerelle.enregistrerAgent(corps.data.nom);
        if (!agent) {
          return NextResponse.json({ error: "Nom d'agent invalide." }, { status: 400 });
        }
        return NextResponse.json({ agentId: agent.id, dejaEnregistree: agent.dejaEnregistree });
      }
      case "observation": {
        const emise = passerelle.emettreObservation(corps.data.spec as never, corps.data.cible);
        if (!emise) {
          return NextResponse.json(
            { error: "Simulation refusée : spécification inconnue du Monde ou scalaire cible introuvable (caps appliqués)." },
            { status: 422 },
          );
        }
        return NextResponse.json(emise);
      }
      case "predire": {
        const ok = passerelle.soumettrePrediction(corps.data.agentId, corps.data.observationId, corps.data.valeur);
        if (!ok) {
          return NextResponse.json(
            { error: "Prédiction refusée : agent ou observation inconnu, valeur non finie, ou prédiction déjà soumise." },
            { status: 409 },
          );
        }
        return NextResponse.json({ ok: true, observationId: corps.data.observationId });
      }
      case "evaluer": {
        const feedbacks = passerelle.evaluerObservation(corps.data.observationId);
        if (!feedbacks) {
          return NextResponse.json({ error: "Observation inconnue." }, { status: 404 });
        }
        return NextResponse.json({ feedbacks });
      }
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erreur inconnue." },
      { status: errorStatus(error, 500) },
    );
  }
}

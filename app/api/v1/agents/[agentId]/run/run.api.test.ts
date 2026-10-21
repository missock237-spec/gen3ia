import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

/**
 * SYSTÈME AGENT RÉSERVÉ (demande utilisateur n°5) — résolution de fusion
 * avec la facturation tokens API (demande n°9).
 *
 * POST /api/v1/agents/{agentId}/run est FERMÉ : quel que soit l'appelant
 * (clé API entreprise valide, chaîne développeur, session), la route répond
 * 403 « réservé au système IA » AVANT toute authentification. Contrats
 * verrouillés :
 *  1. 403 explicite pour tout appelant (aucune exécution par clé) ;
 *  2. le message exige le chemin système IA (chat → activation interne) ;
 *  3. un requestId est renvoyé pour la corrélation ;
 *  4. le refus est émis SANS consommer l'authentification (aucun module
 *     de clé API/mock nécessaire : la route n'y touche plus) ;
 *  5. conséquence facturation (n°9) : aucun appel ne pouvant aboutir ici,
 *     aucun débit n'a lieu sur cette route — la facturation tokens reste
 *     testée et active sur les endpoints API autorisés (lib/billing/api-usage).
 */

import { POST } from "./route";

function makeRequest(agentId = "agent_1") {
  return new NextRequest(`http://localhost/api/v1/agents/${agentId}/run`, {
    method: "POST",
    body: JSON.stringify({ objective: "Surveille le marché des drones" }),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer g3a_test-entreprise-key",
    },
  });
}

const CONTEXT = (agentId = "agent_1") => ({ params: Promise.resolve({ agentId }) });

describe("POST /api/v1/agents/[agentId]/run — surface fermée (agent système réservé)", () => {
  it("renvoie 403 « réservé au système IA » même avec une clé entreprise valide", async () => {
    const response = await POST(makeRequest(), CONTEXT());
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/réservé au système IA/i);
    expect(body.code).toBe("FORBIDDEN");
    expect(body.requestId).toBeTruthy();
  });

  it("ne mentionne ni agent ni exécution ni facturation dans la charge utile de refus", async () => {
    const response = await POST(makeRequest("agent_other"), CONTEXT("agent_other"));
    const body = await response.json();
    expect(body.agent).toBeUndefined();
    expect(body.outputs).toBeUndefined();
    expect(body.billing).toBeUndefined();
    expect(body.apiUsage).toBeUndefined();
  });
});

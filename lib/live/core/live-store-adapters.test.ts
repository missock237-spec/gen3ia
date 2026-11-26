import { describe, expect, it, vi } from "vitest";

// Mock AVANT import : repository.ts charge firebase admin au top-level —
// le test reste sans Firebase (l'adaptateur charge en dynamique). Les
// captures vivent DANS la factory (pas de TDZ avec le hoisting vitest).
vi.mock("../repository", () => {
  const captures: Array<{ id: string; event: Record<string, unknown> }> = [];
  return {
    recordLiveEvent: async (id: string, event: Record<string, unknown>) => {
      captures.push({ id, event });
    },
    __captures: captures,
  };
});

import * as repoMocke from "../repository";
import { adapterEvenementsAgent, mapperSessionCoreVersAgent, storeProduction } from "./live-store-adapters";
import { nouvelleSession } from "./live-core-types";
import { obtenirBusEvenements, reinitialiserBus } from "./live-event-bus";

const captures = (repoMocke as unknown as { __captures: Array<{ id: string; event: Record<string, unknown> }> }).__captures;

/**
 * TESTS LOT 1 — connexions réelles moteur central ↔ composants existants.
 * L'adaptateur événements→recordLiveEvent est testé avec le mock de
 * repository : la persistance Firestore RÉELLE n'est pas exécutable en
 * sandbox et reste déclarée non validée (règle 12 mission).
 */

describe("adaptateur événements → recordLiveEvent existant (réutilisation stricte)", () => {
  it("écriture mappée : type/source/emetteur/charge/horodatage transmis à recordLiveEvent", async () => {
    const adapter = adapterEvenementsAgent("session-agent-1");
    await adapter.ajouter({
      id: "e1",
      sessionId: "session-agent-1",
      type: "mode.active",
      source: "vocal",
      emetteur: "u1",
      horodatage: 1_700_000_000_000,
      charge: { mode: "vocal" },
    });
    expect(captures).toHaveLength(1);
    const { id, event } = captures[0];
    expect(id).toBe("session-agent-1");
    expect(event).toMatchObject({
      type: "mode.active",
      source: "vocal",
      emetteur: "u1",
      charge: { mode: "vocal" },
      horodatage: 1_700_000_000_000,
    });
  });

  it("lecture refusée avec renvoi vers la route existante (aucun doublon d'historique)", async () => {
    const adapter = adapterEvenementsAgent("session-agent-1");
    await expect(adapter.historique("session-agent-1")).rejects.toThrow("/api/live/sessions/:id/events");
  });

  it("bus branché à l'adaptateur : publication → recordLiveEvent appelé", async () => {
    reinitialiserBus();
    const bus = obtenirBusEvenements(adapterEvenementsAgent("session-agent-2"));
    const evenement = await bus.publier({ sessionId: "session-agent-2", type: "session.creee", source: "systeme" });
    expect(evenement.type).toBe("session.creee");
    expect(captures.some((c) => c.id === "session-agent-2" && c.event.type === "session.creee")).toBe(true);
    reinitialiserBus();
  });
});

describe("store de production multimodes (mémoire process-global, borné)", () => {
  it("singleton : la même instance est retournée, sessions isolées", async () => {
    const store = storeProduction();
    const encore = storeProduction();
    expect(encore).toBe(store);
    const session = nouvelleSession({ proprietaireId: "prod-1" });
    await store.creer(session);
    expect((await store.lire(session.id))?.proprietaireId).toBe("prod-1");
  });

  it("mapperSessionCoreVersAgent : champs partagés sans fuite", () => {
    const session = nouvelleSession({ proprietaireId: "u1" });
    const m = mapperSessionCoreVersAgent(session);
    expect(Object.keys(m).sort()).toEqual(["id", "modesActifs", "ownerId"]);
    expect(m.ownerId).toBe("u1");
  });
});

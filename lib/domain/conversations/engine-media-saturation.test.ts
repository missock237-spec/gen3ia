import { describe, expect, it } from "vitest";
import { estErreurTransitoireStockage } from "./engine-media";

/**
 * Garde du fix capture 08:54 (2026-11-14) : l'échec de lancement vu par
 * l'utilisateur (« Le lancement de la production vidéo a échoué ») venait
 * d'une saturation passager du stockage NON reconnue par l'ancienne
 * regex — l'erreur réelle était avalée sans journal. La classification
 * élargie doit reconnaître TOUTES les formes documentées d'incident
 * transitoire pour déclencher le message honnête + la relance auto.
 */
describe("estErreurTransitoireStockage — saturation reconnue (fix capture 08:54)", () => {
  it("reconnaît le disjoncteur quota Firestore (message de la couche résiliente)", () => {
    expect(estErreurTransitoireStockage("Error: Firestore sous quota : disjoncteur ouvert, appel court-circuité (reprise après cooldown).")).toBe(true);
  });

  it("reconnaît les erreurs gRPC de quota quotidien (« Resource exhausted »)", () => {
    expect(estErreurTransitoireStockage("Error: 8 RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).")).toBe(true);
    expect(estErreurTransitoireStockage("Resource_exhausted")).toBe(true);
  });

  it("reconnaît les incidents réseau du datacenter", () => {
    expect(estErreurTransitoireStockage("Error: ETIMEDOUT")).toBe(true);
    expect(estErreurTransitoireStockage("Error: connect ECONNRESET")).toBe(true);
    expect(estErreurTransitoireStockage("TypeError: fetch failed")).toBe(true);
    expect(estErreurTransitoireStockage("Error: Deadline exceeded")).toBe(true);
  });

  it("reconnaît les réponses HTTP de surcharge", () => {
    expect(estErreurTransitoireStockage("Error: HTTP 429: too many requests")).toBe(true);
    expect(estErreurTransitoireStockage("Error: 503 Service Unavailable")).toBe(true);
    expect(estErreurTransitoireStockage("stockage indisponible (stall 6 s)")).toBe(true);
  });

  it("ne classifie PAS une erreur fatale (validation, limite, configuré)", () => {
    expect(estErreurTransitoireStockage("Error: Limite de 20 projets actifs atteinte.")).toBe(false);
    expect(estErreurTransitoireStockage("Error: titre trop court")).toBe(false);
    expect(estErreurTransitoireStockage("")).toBe(false);
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import { annulerTache, echecGpu, etatSecurite, executerProtege, gpuAutoriseParBreaker, succesGpu } from "./compute-security";

/**
 * TESTS PHASE 10 — sécurité, stabilité, fallback : circuit breaker GPU,
 * timeout, annulation, anti double-exécution. Une erreur GPU ne bloque
 * jamais le cerveau ; aucun échec présenté comme succès.
 */

beforeEach(() => {
  const s = etatSecurite();
  s.etat = "ferme";
  s.echecsGpuConsecutifs = 0;
  s.ouvertJusquA = 0;
  s.enCours.clear();
  s.erreursRecentes.length = 0;
});

describe("circuit breaker GPU (mission Phase 10-12)", () => {
  it("3 échecs consécutifs → breaker ouvert, GPU refusé", () => {
    for (let i = 0; i < 3; i++) echecGpu(new Error("device perdu"), "test");
    expect(etatSecurite().etat).toBe("ouvert");
    expect(gpuAutoriseParBreaker()).toBe(false);
  });

  it("un succès referme le breaker", () => {
    echecGpu(new Error("oom"));
    echecGpu(new Error("oom"));
    succesGpu();
    expect(etatSecurite().etat).toBe("ferme");
    expect(gpuAutoriseParBreaker()).toBe(true);
  });

  it("après la fenêtre de pause, une sonde demi-ouverte est permise", () => {
    for (let i = 0; i < 3; i++) echecGpu(new Error("device perdu"));
    etatSecurite().ouvertJusquA = Date.now() - 1; // fenêtre écoulée
    expect(gpuAutoriseParBreaker()).toBe(true);
    expect(etatSecurite().etat).toBe("demi-ouvert");
  });

  it("les erreurs sont classifiées et bornées (ring 50)", () => {
    for (let i = 0; i < 60; i++) echecGpu(new Error(`err ${i}`), "ring");
    expect(etatSecurite().erreursRecentes.length).toBe(50);
    expect(etatSecurite().erreursRecentes[49].message).toContain("err 59");
  });
});

describe("exécution protégée (timeout, double-exécution, annulation)", () => {
  it("timeout : échec CLAIR, jamais un faux succès", async () => {
    const res = await executerProtege({ nomTache: "lente", timeoutMs: 50, executer: (signal) => new Promise<number>((_r, rej) => { setTimeout(() => rej(new Error("abort timeout")), 120); void signal; }) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.raison).toContain("échouée");
  });

  it("double-exécution refusée avec raison explicite", async () => {
    const s = etatSecurite();
    s.enCours.set("doublon", 1);
    const res = await executerProtege({ nomTache: "doublon", executer: async () => 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.raison).toContain("déjà en cours");
    s.enCours.delete("doublon");
  });

  it("exécution normale : résultat réel + durée mesurée", async () => {
    const res = await executerProtege({ nomTache: "ok", executer: async () => 42 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.resultat).toBe(42);
  });

  it("annulation d'une tâche en cours", () => {
    etatSecurite().enCours.set("annulable", 1);
    expect(annulerTache("annulable")).toBe(true);
    expect(annulerTache("inexistante")).toBe(false);
  });
});

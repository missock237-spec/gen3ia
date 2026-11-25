import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { publierVersion, promouvoirVersion, historiqueVersions, versionActive } from "../versioning/version-manager";
import { effectuerRollback, historiqueRollbacks } from "../versioning/rollback-manager";
import { enregistrerCompatibilite, historiqueCompatibilite } from "../versioning/compatibility-history";
import { rapportPourCerveau } from "../core/capability-brain-bridge";
import { executerCycleEvolution } from "../core/capability-orchestrator";
import { obtenirGestionnaireCapacites } from "../core/capability-manager";
import { reinitialiserRepositoryUce } from "../storage/capability-repository";

/**
 * TESTS INTEGRATION (mission §11) — versionnement, rollback, pont cerveau,
 * cycle d'évolution sans réseau (sources simulées indisponibles → arrêt
 * honnête), machine à états complète.
 */

let dossier: string;

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-integ-"));
  reinitialiserRepositoryUce();
});

afterEach(async () => {
  reinitialiserRepositoryUce();
  await fs.rm(dossier, { recursive: true, force: true });
});

describe("gestionnaire de versions", () => {
  it("refuse de publier une version sans tests mesurés", async () => {
    const res = await publierVersion({ capabilityId: "test:cap:a", version: "1.0.0", changements: "initiale", tests: [] }, { dossier, forcerLocal: true });
    expect(res.ok).toBe(false);
    expect(res.raison).toContain("tests");
  });

  it("refuse la promotion d'une version avec un test en échec", async () => {
    const pub = await publierVersion({
      capabilityId: "test:cap:b",
      version: "1.0.0",
      changements: "initiale",
      tests: [{ nom: "test-1", ok: false, dureeMs: 10 }],
    }, { dossier, forcerLocal: true });
    expect(pub.ok).toBe(true);
    const promo = await promouvoirVersion(pub.version!.id, { dossier, forcerLocal: true });
    expect(promo.ok).toBe(false);
    expect(promo.raison).toContain("échec");
  });

  it("promotion gated : staged → active, ancienne version retirée (historique complet)", async () => {
    const v1 = await publierVersion({
      capabilityId: "test:cap:c",
      version: "1.0.0",
      changements: "initiale stable",
      tests: [{ nom: "t1", ok: true, dureeMs: 5 }],
    }, { dossier, forcerLocal: true });
    const p1 = await promouvoirVersion(v1.version!.id, { dossier, forcerLocal: true });
    expect(p1.ok).toBe(true);
    const v2 = await publierVersion({
      capabilityId: "test:cap:c",
      version: "1.1.0",
      changements: "amélioration",
      parentVersion: "1.0.0",
      tests: [{ nom: "t1", ok: true, dureeMs: 5 }, { nom: "t2", ok: true, dureeMs: 5 }],
    }, { dossier, forcerLocal: true });
    const p2 = await promouvoirVersion(v2.version!.id, { dossier, forcerLocal: true });
    expect(p2.ok).toBe(true);
    const active = await versionActive("test:cap:c", { dossier, forcerLocal: true });
    expect(active?.version).toBe("1.1.0");
    const historique = await historiqueVersions("test:cap:c", { dossier, forcerLocal: true });
    expect(historique.length).toBe(2);
    expect(historique.find((v) => v.version === "1.0.0")?.statut).toBe("retraitee");
  });
});

describe("rollback", () => {
  it("effectue un rollback traçable vers la version précédente", async () => {
    const v1 = await publierVersion({
      capabilityId: "test:cap:d",
      version: "1.0.0",
      changements: "stable",
      tests: [{ nom: "t1", ok: true, dureeMs: 5 }],
    }, { dossier, forcerLocal: true });
    await promouvoirVersion(v1.version!.id, { dossier, forcerLocal: true });
    const v2 = await publierVersion({
      capabilityId: "test:cap:d",
      version: "1.1.0",
      changements: "régression",
      tests: [{ nom: "t1", ok: true, dureeMs: 5 }],
    }, { dossier, forcerLocal: true });
    await promouvoirVersion(v2.version!.id, { dossier, forcerLocal: true });

    // Enregistrer la capacité au statut integree pour autoriser la machine à états
    const gestionnaire = obtenirGestionnaireCapacites({ dossier, forcerLocal: true });
    await gestionnaire.enregistrerCapacite({
      kind: "tool",
      origin: "construite",
      card: { nom: "cap-d", description: "capacité de test", fonctionnalites: [], source: "test", dependances: [], risques: [], verifieLe: new Date().toISOString() },
      statutInitial: "integree",
      id: "test:cap:d",
    }, { dossier, forcerLocal: true });

    const rollback = await effectuerRollback({ capabilityId: "test:cap:d", versVersionId: v1.version!.id, raison: "régression mesurée", effectuePar: "admin" }, { dossier, forcerLocal: true });
    expect(rollback.ok).toBe(true);
    const active = await versionActive("test:cap:d", { dossier, forcerLocal: true });
    expect(active?.version).toBe("1.0.0");
    const trace = await historiqueRollbacks("test:cap:d", { dossier, forcerLocal: true });
    expect(trace.length).toBe(1);
    expect(trace[0].resultat).toBe("succes");
  });
});

describe("compatibilité versionnée", () => {
  it("enregistre et relit l'historique de compatibilité", async () => {
    await enregistrerCompatibilite({
      capabilityId: "test:cap:e",
      version: "1.0.0",
      verdict: "compatible",
      controles: [{ nom: "node", ok: true }],
    }, { dossier, forcerLocal: true });
    const historique = await historiqueCompatibilite("test:cap:e", { dossier, forcerLocal: true });
    expect(historique.length).toBe(1);
    expect(historique[0].verdict).toBe("compatible");
  });
});

describe("pont cerveau central", () => {
  it("produit un rapport honnête (aucun indicateur inventé) avec les limites explicites", async () => {
    const rapport = await rapportPourCerveau({ dossier, forcerLocal: true });
    expect(rapport.outils.totalAnnonces).toBeGreaterThan(0);
    expect(rapport.limites.length).toBeGreaterThanOrEqual(3);
    expect(rapport.limites[0]).toContain("cerveau central");
  });
});

describe("cycle d'évolution", () => {
  it("s'arrête honnêtement à l'ÉTAPE 2 quand aucune source ne répond (pas de fiche inventée)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("réseau coupé (test)"); }));
    const res = await executerCycleEvolution({ besoin: "calculatrice", sources: ["npm", "pypi"], dossier });
    expect(res.ok).toBe(false);
    const recherche = res.etapes.find((e) => e.nom === "recherche");
    expect(recherche?.statut).toBe("echouee");
    expect(res.raison).toContain("ÉTAPE 2");
  }, 60_000);

  it("s'arrête à l'ÉTAPE 5/8 sans scénario sandbox (aucune intégration sans mesure)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const cible = String(url);
      if (cible.includes("registry.npmjs.org/-/v1/search")) {
        return { ok: true, status: 200, json: async () => ({ objects: [{ package: { name: "cycle-lib", description: "lib trouvée par le cycle", version: "1.0.0" }, score: { detail: { popularity: 0.4 } } }] }) } as unknown as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }));
    const res = await executerCycleEvolution({ besoin: "cycle sans scénario", sources: ["npm"], dossier });
    // Sans scénario : découverte + compatibilité OK mais sélection sans mesure
    // → cycle arrêté honnêtement (aucune intégration sans benchmark réel).
    expect(res.ok).toBe(false);
    expect(res.raison).toContain("benchmark réel");
    expect(res.integree ?? false).toBe(false);
  }, 60_000);
});

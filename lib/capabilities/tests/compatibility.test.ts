import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { sonderEnvironnement, verifierCompatibilite, detecterConflits } from "../evaluation/compatibility-engine";

/**
 * TESTS COMPATIBILITY (mission §11) — vérification technique AVANT
 * intégration : environnement sondé réellement, contrôles bornés, verdicts
 * honnêtes (compatible | risque | incompatible).
 */

let dossier: string;

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-comp-"));
});

afterEach(async () => {
  await fs.rm(dossier, { recursive: true, force: true });
});

describe("moteur de compatibilité", () => {
  it("sonde l'environnement réel (node, système, architecture, mémoire)", async () => {
    const env = await sonderEnvironnement();
    expect(env.node.length).toBeGreaterThan(0);
    expect(env.systeme.length).toBeGreaterThan(0);
    expect(env.architecture.length).toBeGreaterThan(0);
    expect(env.memoireTotalMo).toBeGreaterThan(0);
  });

  it("une exigence sans exigence particulière est compatible", async () => {
    const rapport = await verifierCompatibilite("test-lib", {}, []);
    expect(rapport.verdict).toBe("compatible");
    expect(rapport.capabilityId).toBe("test-lib");
  });

  it("une exigence node impossible est incompatible (contrôle bloquant)", async () => {
    const rapport = await verifierCompatibilite("test-lib", { node: ">=99.0" }, []);
    expect(rapport.verdict).toBe("incompatible");
    const node = rapport.controles.find((c) => c.nom === "node");
    expect(node?.ok).toBe(false);
    expect(node?.bloquant).toBe(true);
  });

  it("une exigence GPU sur une machine sans GPU est honnêtement signalée", async () => {
    const rapport = await verifierCompatibilite("test-gpu-lib", { gpu: true }, []);
    const gpu = rapport.controles.find((c) => c.nom === "gpu");
    // Le verdict dépend de la machine réelle — le contrôle doit exister et être honnête.
    expect(gpu).toBeDefined();
    if (gpu?.ok === false && gpu.bloquant) {
      expect(rapport.verdict).toBe("incompatible");
    }
  });

  it("détecte les conflits de dépendances avec package.json réel", async () => {
    // package.json du dépôt : dépendance réelle présente (ex. zod) → conflit détecté
    const conflits = await detecterConflits(["zod"], process.cwd());
    expect(conflits.length).toBeGreaterThanOrEqual(1);
    // dépendance absente → aucun conflit
    const sans = await detecterConflits(["paquet-totalement-inconnu-xyz"], process.cwd());
    expect(sans.length).toBe(0);
  });
});

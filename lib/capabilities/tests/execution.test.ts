import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { executerCapacite } from "../execution/universal-gateway";
import { construireContexte } from "../execution/execution-context";
import { JournalExecution } from "../execution/execution-logger";
import { reinitialiserRepositoryUce } from "../storage/capability-repository";

/**
 * TESTS EXECUTION (mission §11) — contrat d'exécution UNIFIÉ : validation
 * zod à la frontière, enregistrement normalisé complet (id, demande,
 * permissions, état, durée, journaux, preuve de vérification), refus
 * honnête d'une capacité inconnue ou non intégrée.
 */

let dossier: string;

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-exec-"));
  reinitialiserRepositoryUce();
});

afterEach(async () => {
  reinitialiserRepositoryUce();
  await fs.rm(dossier, { recursive: true, force: true });
});

describe("contrat d'exécution unifié", () => {
  it("rejette honnêtement une demande invalide (zod) avec un enregistrement complet", async () => {
    const resultat = await executerCapacite({
      executionId: "court", // < 6 chars : invalide
      userId: "u1",
      capabilityId: "natif:gen3ia:web.search",
      input: {},
      origine: "chat",
    }, { persister: false });
    expect(resultat.ok).toBe(false);
    expect(resultat.execution.status).toBe("refusee");
    expect(resultat.execution.verification.verifie).toBe(false);
    expect(resultat.execution.permissions.length).toBeGreaterThan(0);
  });

  it("refuse une capacité inconnue (jamais de succès inventé)", async () => {
    const resultat = await executerCapacite({
      executionId: "exec-inconnu-1",
      userId: "u1",
      capabilityId: "decouverte:inconnu:paquet-fantome",
      input: {},
      origine: "chat",
    }, { persister: false });
    expect(resultat.ok).toBe(false);
    expect(["refusee", "echec"]).toContain(resultat.execution.status);
  });

  it("le contexte valide et borne les champs de la demande", () => {
    const ctx = construireContexte({
      executionId: "exec-ctx-valide-1",
      userId: "utilisateur-test",
      capabilityId: "natif:gen3ia:web.search",
      input: { requete: "test" },
      origine: "admin",
    });
    expect(ctx.demande.executionId).toBe("exec-ctx-valide-1");
    expect(() => construireContexte({
      executionId: "x",
      userId: "",
      capabilityId: "",
      input: {},
      origine: "chat",
    })).toThrow();
  });

  it("le journal d'exécution borne et conserve les entrées", () => {
    const journal = new JournalExecution();
    journal.ajouter("étape 1 : résolution");
    journal.ajouter(`secret potentiel : ${"hf_".padEnd(8, "x")}abcdef`);
    const lignes = journal.lignesActuelles();
    expect(lignes[0]).toContain("étape 1");
    expect(lignes.length).toBe(2);
  });
});

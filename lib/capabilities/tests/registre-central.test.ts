import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  entreesNativesSynchrones,
  obtenirRegistreCentral,
  reinitialiserRegistreCentral,
  type EntreeRegistreCapacite,
} from "../core/capability-registry";
import { reinitialiserRepositoryUce } from "../storage/capability-repository";
import { executerCapacite } from "../execution/universal-gateway";

/**
 * TESTS REGISTRE CENTRAL (V1.1 Phase 2) — LE registre de référence unique :
 * contrat obligatoire mission (15 champs), unicité des identifiants,
 * disponibilité honnête (annoncé ≠ réel), contrôle d'activation branché
 * dans le Universal Gateway (une capacité désactivée n'est pas exécutable).
 */

let dossier: string;

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-registre-"));
  reinitialiserRepositoryUce();
  reinitialiserRegistreCentral();
  obtenirRegistreCentral({ dossier, forcerLocal: true });
});

afterEach(async () => {
  reinitialiserRegistreCentral();
  reinitialiserRepositoryUce();
  await fs.rm(dossier, { recursive: true, force: true });
});

describe("contrat obligatoire du registre central", () => {
  const CHAMPS_CONTRAT: Array<keyof EntreeRegistreCapacite> = [
    "id", "name", "version", "category", "description", "inputSchema", "outputSchema",
    "permissions", "dependencies", "environmentRequirements", "availability",
    "executionAdapter", "healthStatus", "createdAt", "updatedAt",
  ];

  it("expose les 15 champs du contrat mission pour chaque capacité native", async () => {
    const entrees = await obtenirRegistreCentral({ dossier, forcerLocal: true }).lister();
    expect(entrees.length).toBeGreaterThanOrEqual(78); // 78 outils annoncés
    for (const champ of CHAMPS_CONTRAT) {
      expect(entrees.every((e) => champ in e), `champ « ${String(champ)} » présent`).toBe(true);
    }
    const webSearch = entrees.find((e) => e.id === "natif:gen3ia:web.search");
    expect(webSearch).toBeDefined();
    expect(webSearch!.name).toBe("web.search");
    expect(webSearch!.category).toBe("tool");
    expect(webSearch!.permissions).toContain("network.read");
    expect(webSearch!.availability).toBe("disponible"); // réellement au registre d'exécution
    expect(webSearch!.executionAdapter).toBe("outil-natif");
  });

  it("garantit l'unicité des identifiants (une capacité n'existe qu'une fois)", async () => {
    const entrees = await obtenirRegistreCentral({ dossier, forcerLocal: true }).lister();
    const ids = entrees.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rend l'écart annonce/réalité honnête (availability, pas de mensonge)", async () => {
    const sync = entreesNativesSynchrones();
    expect(sync.length).toBe(78);
    // Chaque entrée annoncée porte une disponibilité EXPLICITE, jamais inventée.
    for (const e of sync) {
      expect(["disponible", "non-enregistre", "indisponible"]).toContain(e.availability);
    }
    // Tous les outils réellement exécutables dans cet environnement sont « disponibles ».
    const disponibles = sync.filter((e) => e.availability === "disponible");
    expect(disponibles.length).toBeGreaterThan(0);
  });

  it("le schéma d'entrée réel de l'outil est exposé (pas de schéma inventé)", async () => {
    const webSearch = entreesNativesSynchrones().find((e) => e.id === "natif:gen3ia:web.search");
    expect(webSearch?.inputSchema).toBeDefined();
    expect(Array.isArray(webSearch?.entreeSchemaChamps)).toBe(true);
  });
});

describe("contrôle d'activation (branché dans le gateway)", () => {
  const registre = () => obtenirRegistreCentral({ dossier, forcerLocal: true });

  it("une capacité désactivée n'est plus exécutable (refus tracé)", async () => {
    const id = "natif:gen3ia:web.search";
    const desactivation = await registre().desactiver(id, { raison: "test de contrôle", par: "admin-test" });
    expect(desactivation.ok).toBe(true);

    // Le registre refuse la ré-exécution.
    const verdict = await registre().estExecutable(id);
    expect(verdict.ok).toBe(false);
    expect(verdict.raison).toContain("désactivée");

    // Le GATEWAY refuse aussi (contrôle branché au cycle d'exécution étape 4).
    const resultat = await executerCapacite({
      executionId: "exec-desactivee-1",
      userId: "utilisateur-test",
      capabilityId: id,
      input: { toolName: "web.search", input: { requete: "test" } },
      origine: "admin",
    }, { persister: false });
    expect(resultat.ok).toBe(false);
    expect(resultat.execution.status).toBe("refusee");
    expect(resultat.execution.erreur ?? "").toContain("désactivée");
  });

  it("la désactivation sans identifiant humain est refusée (traçabilité)", async () => {
    const res = await registre().desactiver("natif:gen3ia:web.search", { raison: "sans auteur", par: "" });
    expect(res.ok).toBe(false);
    expect(res.raison).toContain("identifiant humain");
  });

  it("une capacité désactivée peut être réactivée (contrôle réversible)", async () => {
    const id = "natif:gen3ia:zip.create";
    await registre().desactiver(id, { raison: "gel temporaire", par: "admin-test" });
    const reactivation = await registre().reactiver(id, { raison: "fin du gel", par: "admin-test" });
    expect(reactivation.ok).toBe(true);
    expect((await registre().estExecutable(id)).ok).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { EspaceFiltreResonant } from "../core/resonant-space";
import { SystemeExploitationOutils } from "./tool-os";

/**
 * TOOL OS — tests unitaires :
 *  - enregistrement d'un outil ;
 *  - exécution RÉELLE d'une fonction de test via le sandbox ;
 *  - outil introuvable → ECHEC (message corrigé du bug f-string) ;
 *  - métriques d'usage : utilisations, succesHistorique (×1.05 cap 1.0,
 *    ×0.8 plancher 0.1) ;
 *  - gating : aucune exécution sous 0.80 de résonance.
 */

describe("SystemeExploitationOutils", () => {
  it("enregistre l'outil et le pool de sortie EXECUTER_OUTIL_OS", () => {
    const espace = new EspaceFiltreResonant();
    const toolOs = new SystemeExploitationOutils(espace);

    toolOs.enregistrerOutil(
      "double",
      (args) => Number(args["n"]) * 2,
      "double un nombre",
    );

    const outil = toolOs.registreOutils.get("double");
    expect(outil).toBeDefined();
    expect(outil?.description).toBe("double un nombre");
    expect(outil?.utilisations).toBe(0);
    expect(outil?.succesHistorique).toBe(1);
    expect(espace.outputPools.get("EXECUTER_OUTIL_OS")).toEqual([48, 49]);
  });

  it("exécute réellement la fonction de l'outil dans le sandbox", () => {
    const espace = new EspaceFiltreResonant();
    const toolOs = new SystemeExploitationOutils(espace);
    toolOs.enregistrerOutil(
      "double",
      (args) => Number(args["n"]) * 2,
      "double un nombre",
    );

    const resultats = toolOs.executerEnSandbox("double", { n: 21 });

    expect(resultats).toHaveLength(1);
    expect(resultats[0].status).toBe("SUCCES");
    expect(resultats[0].type).toBe("EXECUTER_OUTIL_OS");
    expect(resultats[0]["outil"]).toBe("double");
    expect(resultats[0]["resultat"]).toBe(42);
    expect(resultats[0]["dureeMs"]).toBeGreaterThanOrEqual(0);

    // Métriques d'usage réellement mises à jour.
    const outil = toolOs.registreOutils.get("double");
    expect(outil?.utilisations).toBe(1);
    // 1.0 × 1.05 plafonné à 1.0.
    expect(outil?.succesHistorique).toBe(1);
  });

  it("outil introuvable → ECHEC avec message clair (bug f-string corrigé)", () => {
    const espace = new EspaceFiltreResonant();
    const toolOs = new SystemeExploitationOutils(espace);

    const resultats = toolOs.executerEnSandbox("outil_absent", {});

    expect(resultats).toHaveLength(1);
    expect(resultats[0].status).toBe("ECHEC");
    expect(resultats[0].details).toBe(
      "Outil 'outil_absent' introuvable dans le Tool OS.",
    );
  });

  it("échec d'exécution → ECHEC, succesHistorique ×0.8 (plancher 0.1)", () => {
    const espace = new EspaceFiltreResonant();
    const toolOs = new SystemeExploitationOutils(espace);
    toolOs.enregistrerOutil("echoue", () => {
      throw new Error("panne simulée de test");
    }, "échoue toujours");

    const resultats = toolOs.executerEnSandbox("echoue", {});

    expect(resultats[0].status).toBe("ECHEC");
    expect(resultats[0]["erreur"]).toBe("panne simulée de test");
    let outil = toolOs.registreOutils.get("echoue");
    expect(outil?.utilisations).toBe(1);
    expect(outil?.succesHistorique).toBeCloseTo(0.8, 12);

    // Un deuxième échec : 0.8 × 0.8 = 0.64.
    toolOs.executerEnSandbox("echoue", {});
    outil = toolOs.registreOutils.get("echoue");
    expect(outil?.succesHistorique).toBeCloseTo(0.64, 12);
  });

  it("succès après échec : succesHistorique remonte (×1.05)", () => {
    const espace = new EspaceFiltreResonant();
    const toolOs = new SystemeExploitationOutils(espace);
    let doitEchouer = true;
    toolOs.enregistrerOutil(
      "intermittent",
      () => {
        if (doitEchouer) {
          doitEchouer = false;
          throw new Error("première tentative ratée");
        }
        return "ok";
      },
      "échoue une fois",
    );

    toolOs.executerEnSandbox("intermittent", {});
    const resultats = toolOs.executerEnSandbox("intermittent", {});

    expect(resultats[0].status).toBe("SUCCES");
    expect(toolOs.registreOutils.get("intermittent")?.succesHistorique).toBeCloseTo(
      0.8 * 1.05,
      12,
    );
  });

  it("gating : résonance < 0.80 → aucune action même avec commande", () => {
    const espace = new EspaceFiltreResonant();
    const toolOs = new SystemeExploitationOutils(espace);
    toolOs.enregistrerOutil("double", (args) => Number(args["n"]) * 2);

    // Un seul neurone du pool [48, 49] a spike : résonance 0.5 < 0.80.
    const actions = toolOs.evaluerEtExecuter([48], {
      nom: "double",
      args: { n: 2 },
    });
    expect(actions).toEqual([]);

    // Aucun spike : résonance 0.
    expect(toolOs.evaluerEtExecuter([], { nom: "double" })).toEqual([]);
    // Aucune exécution en sandbox au passage.
    expect(toolOs.registreOutils.get("double")?.utilisations).toBe(0);
  });

  it("gating : résonance 1.0 + commande valide → exécution via evaluerEtExecuter", () => {
    const espace = new EspaceFiltreResonant();
    const toolOs = new SystemeExploitationOutils(espace);
    toolOs.enregistrerOutil("double", (args) => Number(args["n"]) * 2);

    const actions = toolOs.evaluerEtExecuter([48, 49], {
      nom: "double",
      args: { n: 5 },
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe("SUCCES");
    expect(actions[0]["resultat"]).toBe(10);
    expect(toolOs.registreOutils.get("double")?.utilisations).toBe(1);
  });

  it("contexte sans nom d'outil valide : aucune exécution (garde de type)", () => {
    const espace = new EspaceFiltreResonant();
    const toolOs = new SystemeExploitationOutils(espace);
    toolOs.enregistrerOutil("double", (args) => Number(args["n"]) * 2);

    // Contexte générique transmis par le noyau, sans champ « nom ».
    const actions = toolOs.evaluerEtExecuter([48, 49], {
      prompt: "exécute quelque chose",
    });
    expect(actions).toEqual([]);
    expect(toolOs.registreOutils.get("double")?.utilisations).toBe(0);
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { etatParDefaut, ecrireEtatAuto, lireEtatAuto, reduireEtat } from "./etat";
import type { EtatAutoApprentissage, RapportCycleAuto } from "./types";

/* ------------------------------------------------------------------ */
/* PERSISTANCE DE L'AUTO-APPRENTISSAGE — atomique, tolérante, plafonnée */
/* ------------------------------------------------------------------ */

let dossierTmp: string | null = null;

async function cheminEtat(): Promise<string> {
  dossierTmp ??= await mkdtemp(join(tmpdir(), "gen3ia-auto-"));
  return join(dossierTmp, "etat.json");
}

afterEach(async () => {
  if (dossierTmp) {
    await rm(dossierTmp, { recursive: true, force: true });
    dossierTmp = null;
  }
});

function rapportFactice(id: string): RapportCycleAuto {
  return {
    v: 1,
    id,
    demarreA: new Date().toISOString(),
    dureeMs: 42,
    statut: "termine",
    message: `cycle ${id}`,
    hubs: [
      {
        provider: "huggingface",
        configure: true,
        datasetsConsiderees: 6,
        datasetsIngestes: 1,
        paires: 2,
        echantillons: 3,
        erreurs: ["a", "b", "c", "d", "e", "f"],
      },
    ],
    datasetsIngestes: [`org/${id}`],
  };
}

describe("etat de l'auto-apprentissage", () => {
  it("aller-retour complet : écriture puis lecture identiques", async () => {
    const chemin = await cheminEtat();
    const etat: EtatAutoApprentissage = {
      ...etatParDefaut(),
      cyclesExecutes: 3,
      dernierRapport: rapportFactice("c3"),
      historique: [rapportFactice("c3"), rapportFactice("c2")],
      datasetsIngestes: ["org/c1", "org/c2", "org/c3"],
      pairesCumulees: 10,
      echantillonsCumules: 20,
    };
    expect(await ecrireEtatAuto(etat, chemin)).toBe(true);
    const lu = await lireEtatAuto(chemin);
    expect(lu.cyclesExecutes).toBe(3);
    expect(lu.dernierRapport?.id).toBe("c3");
    expect(lu.datasetsIngestes).toEqual(["org/c1", "org/c2", "org/c3"]);
    expect(lu.pairesCumulees).toBe(10);
  });

  it("fichier absent → état par défaut (boot propre)", async () => {
    const etat = await lireEtatAuto(join(await cheminEtat(), "inexistant.json"));
    expect(etat.cyclesExecutes).toBe(0);
    expect(etat.enCours).toBe(false);
    expect(etat.historique).toEqual([]);
  });

  it("fichier corrompu → état par défaut (jamais d'exception au boot)", async () => {
    const chemin = await cheminEtat();
    await writeFile(chemin, "{ ceci n'est pas du JSON", "utf8");
    const etat = await lireEtatAuto(chemin);
    expect(etat.v).toBe(1);
    expect(etat.cyclesExecutes).toBe(0);
  });

  it("réduction : caps historique (10), datasets (400), erreurs (5)", () => {
    // Ordre du module : les plus récents D'ABORD (invariant de la boucle).
    const historique = Array.from({ length: 25 }, (_, i) => rapportFactice(`r${24 - i}`));
    const datasets = Array.from({ length: 500 }, (_, i) => `org/d${i}`);
    const reduit = reduireEtat({
      ...etatParDefaut(),
      historique,
      datasetsIngestes: datasets,
    });
    expect(reduit.historique).toHaveLength(10);
    // Les plus récents d'abord (r24 est le dernier ajouté en tête).
    expect(reduit.historique[0].id).toBe("r24");
    expect(reduit.datasetsIngestes).toHaveLength(400);
    expect(reduit.historique[0].hubs[0].erreurs).toHaveLength(5);
  });
});

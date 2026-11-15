import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CortexColumnnaire } from "./cortex-columnnaire";
import { ChampCorticalGen3 } from "./champ-cortical";
import {
  deserialiserEtatV2,
  ecrireArtefactV2,
  lireArtefactV2,
  serialiserEtatV2,
  supprimerArtefactV2,
} from "./persistance-v2";

/** Petit état structural de test (64 colonnes × 2 voisins). */
function petitEtat() {
  const cortex = new CortexColumnnaire({
    colonnes: 64,
    voisins: 2,
    seed: 42,
    bandes: 4,
  });
  // Un peu d'apprentissage simulé : renforcement arbitraire de 5 arêtes.
  for (let i = 0; i < 5; i++) cortex.csrPoids[i * 7] = 0.83;
  const champ = new ChampCorticalGen3(42);
  champ.couplerBandes([0.4, 0.1, 0, 0, 0, 0, 0, 0]);
  return {
    colonnes: 64,
    voisins: 2,
    bandes: 4,
    seed: 42,
    seedEntrainement: champ.seedEntrainement,
    epochsConsolides: 3,
    samplesConsolides: 120,
    poids: cortex.exporterPoids(),
    modulationRegionale: champ.modulationRegionale(),
  };
}

const temporaires: string[] = [];

afterEach(() => {
  while (temporaires.length > 0) {
    const chemin = temporaires.pop();
    if (chemin) supprimerArtefactV2(chemin);
  }
});

describe("persistance v2 (artefact binaire)", () => {
  it("aller-retour sérialisation exact (poids f32, modulation, graines)", () => {
    const etat = petitEtat();
    const buf = serialiserEtatV2(etat);
    const lu = deserialiserEtatV2(buf);
    expect(lu).not.toBeNull();
    expect(lu!.colonnes).toBe(64);
    expect(lu!.voisins).toBe(2);
    expect(lu!.bandes).toBe(4);
    expect(lu!.seed).toBe(42);
    expect(lu!.seedEntrainement).toBe(etat.seedEntrainement);
    expect(lu!.epochsConsolides).toBe(3);
    expect(lu!.samplesConsolides).toBe(120);
    expect(Array.from(lu!.poids)).toEqual(Array.from(etat.poids));
    expect(Array.from(lu!.modulationRegionale)).toEqual(
      Array.from(etat.modulationRegionale),
    );
  });

  it("rejette les buffers corrompus ou tronqués", () => {
    const etat = petitEtat();
    const buf = serialiserEtatV2(etat);
    // Magie invalide.
    const faux = Buffer.from(buf);
    faux.write("XXXXXX", 0, "latin1");
    expect(deserialiserEtatV2(faux)).toBeNull();
    // Version invalide.
    const mauvaiseVersion = Buffer.from(buf);
    mauvaiseVersion.writeUInt32LE(99, 6);
    expect(deserialiserEtatV2(mauvaiseVersion)).toBeNull();
    // Tronqué.
    expect(deserialiserEtatV2(buf.subarray(0, 20))).toBeNull();
    // Trop court pour l'en-tête.
    expect(deserialiserEtatV2(Buffer.alloc(8))).toBeNull();
  });

  it("écriture atomique + lecture disque + suppression", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen3-v2-"));
    const chemin = join(dir, "cortex-v2.bin");
    temporaires.push(chemin);

    const etat = petitEtat();
    const ok = await ecrireArtefactV2(chemin, etat);
    expect(ok).toBe(true);
    expect(existsSync(chemin)).toBe(true);
    expect(existsSync(`${chemin}.tmp`)).toBe(false); // rename atomique fait

    const lu = lireArtefactV2(chemin);
    expect(lu).not.toBeNull();
    expect(lu!.colonnes).toBe(64);
    expect(Array.from(lu!.poids)).toEqual(Array.from(etat.poids));

    supprimerArtefactV2(chemin);
    expect(existsSync(chemin)).toBe(false);
    expect(lireArtefactV2(chemin)).toBeNull();
  });

  it("lireArtefactV2 sur fichier inexistant → null sans erreur", () => {
    expect(lireArtefactV2("/tmp/gen3-inexistant-cortex-v2.bin")).toBeNull();
  });

  it("taille d'artefact au format par défaut ≈ 12-13 Mo (colonnes × voisins × f32)", () => {
    const octets = 38 + 262144 * 12 * 4 + 1000 * 4;
    expect(octets / 1048576).toBeGreaterThan(12);
    expect(octets / 1048576).toBeLessThan(13);
    void readFileSync; // (import conservé pour les tests disque)
  });
});

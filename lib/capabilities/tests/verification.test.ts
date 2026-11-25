import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { verifierResultat } from "../verification/result-verifier";

/**
 * TESTS VERIFICATION (mission §11) — moteur indépendant de vérification :
 * un résultat non vérifié n'est JAMAIS une réussite confirmée.
 */

let dossier: string;

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-verif-"));
});

afterEach(async () => {
  await fs.rm(dossier, { recursive: true, force: true });
});

describe("vérification indépendante des résultats", () => {
  it("une sortie vide est refusée (pas de succès fantôme)", async () => {
    const res = await verifierResultat({ executionId: "v1", resultat: "", spec: {} });
    expect(res.verifie).toBe(false);
    expect(res.methode).toBeTruthy();
  });

  it("vérifie l'existence réelle d'un fichier produit", async () => {
    const chemin = path.join(dossier, "sortie.txt");
    await fs.writeFile(chemin, "contenu réel non vide", "utf8");
    const res = await verifierResultat({
      executionId: "v2",
      resultat: `fichier écrit : ${chemin}`,
      spec: { fichier: { chemin } },
    });
    expect(res.verifie).toBe(true);
    expect(res.details).toContain("fichier confirmé");
  });

  it("échoue honnêtement si le fichier annoncé n'existe pas", async () => {
    const res = await verifierResultat({
      executionId: "v3",
      resultat: "fichier écrit : /tmp/inexistant-fantome.txt",
      spec: { fichier: { chemin: "/tmp/inexistant-fantome-uce.txt" } },
    });
    expect(res.verifie).toBe(false);
    expect(res.details).toBeTruthy();
  });

  it("vérifie un dossier non vide (artefact)", async () => {
    await fs.writeFile(path.join(dossier, "a.json"), "{}", "utf8");
    const res = await verifierResultat({ executionId: "v4", resultat: dossier, spec: { dossier: { chemin: dossier } } });
    expect(res.verifie).toBe(true);
  });

  it("rejoue du code en sandbox (preuve par exécution réelle)", async () => {
    const res = await verifierResultat({
      executionId: "v5",
      resultat: "42",
      spec: { code: { script: "emettre(6 * 7);", valeurVerite: 42 } },
    });
    expect(res.verifie).toBe(true);
    expect(res.methode).toBe("rejoue-indépendant");
    expect(res.details).toContain("code rejoué");
  }, 30_000);

  it("les marqueurs exigés doivent être présents dans la sortie", async () => {
    const ok = await verifierResultat({ executionId: "v6", resultat: "mission accomplie : 3 fichiers", spec: { marqueurs: ["mission", "3 fichiers"] } });
    expect(ok.verifie).toBe(true);
    const ko = await verifierResultat({ executionId: "v7", resultat: "mission accomplie", spec: { marqueurs: ["3 fichiers"] } });
    expect(ko.verifie).toBe(false);
  });
});

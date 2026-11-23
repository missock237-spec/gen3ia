import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterDepuisModeleEntraîne,
  chargerModeleEntraîne,
  definirEntrepotModeles,
  listerModelesEntraînés,
  MAX_OCTETS_MODELE,
  sauverModeleEntraîne,
  supprimerModeleEntraîne,
  creerEntrepotModelesFichiers,
} from "./registre-modeles";

/**
 * REGISTRE DES MODÈLES ENTRAÎNÉS — persistance réelle (fichiers tmpdir) :
 * la mémoire du studio. Sauvegarde, chargement, propriété stricte, liste
 * sans contenu, suppression, garde de taille, restauration en ModeleFourni.
 */
describe("registre-modeles — la mémoire des modèles entraînés", () => {
  beforeEach(() => {
    definirEntrepotModeles(creerEntrepotModelesFichiers(mkdtempSync(join(tmpdir(), "g3m-test-"))));
  });

  const sauvegardeValide = () =>
    sauverModeleEntraîne({
      userId: "utilisateur-1",
      nom: "assistant-support-v1",
      famille: "cortex-langagier",
      contenu: JSON.stringify({ famille: "cortex-langagier", etat: { pairesPersonnalisees: [], poidsUsage: {} } }),
      format: "json",
      banc: { score: 0.94, seuil: 0.9, verdict: "conforme", evaluationEchantillon: "train" },
      niveauCle: "standard",
    });

  it("sauvegarde → chargement aller-retour : contenu EXACT + traçabilité", async () => {
    const sauvegarde = await sauvegardeValide();
    expect(sauvegarde.id.startsWith("mdl-")).toBe(true);
    const doc = await chargerModeleEntraîne("utilisateur-1", sauvegarde.id);
    expect(doc).not.toBeNull();
    expect(doc?.nom).toBe("assistant-support-v1");
    expect(doc?.famille).toBe("cortex-langagier");
    expect(doc?.niveauCle).toBe("standard");
    expect(doc?.banc?.verdict).toBe("conforme");
    expect(doc?.contenu).toBe(JSON.stringify({ famille: "cortex-langagier", etat: { pairesPersonnalisees: [], poidsUsage: {} } }));
  });

  it("propriété stricte : le modèle d'un AUTRE compte est invisible et insupprimable", async () => {
    const { id } = await sauvegardeValide();
    expect(await chargerModeleEntraîne("utilisateur-2", id)).toBeNull();
    expect(await supprimerModeleEntraîne("utilisateur-2", id)).toBe(false);
    const doc = await chargerModeleEntraîne("utilisateur-1", id);
    expect(doc).not.toBeNull(); // le propriétaire, lui, y accède toujours
  });

  it("lister : aperçus légers SANS le contenu complet", async () => {
    await sauvegardeValide();
    await sauverModeleEntraîne({
      userId: "utilisateur-1",
      nom: "politique-monde-v2",
      famille: "tenseur-mlp",
      contenu: JSON.stringify({ famille: "tenseur-mlp", poids: Array(20).fill(0.5) }),
      format: "json",
      banc: null,
      niveauCle: "standard",
    });
    const liste = await listerModelesEntraînés("utilisateur-1");
    expect(liste).toHaveLength(2);
    for (const m of liste) {
      expect("contenu" in m).toBe(false);
      expect(m.apercu.length).toBeLessThanOrEqual(160);
      expect(m.octets).toBeGreaterThan(0);
    }
    expect(liste.map((m) => m.famille).sort()).toEqual(["cortex-langagier", "tenseur-mlp"]);
  });

  it("ids uniques : deux sauvegardes du même nom = deux entrées distinctes (versions)", async () => {
    const a = await sauvegardeValide();
    const b = await sauvegardeValide();
    expect(a.id).not.toBe(b.id);
    expect(await listerModelesEntraînés("utilisateur-1")).toHaveLength(2);
  });

  it("garde de taille : export au-delà de 4 Mo refusé honnêtement", async () => {
    await expect(
      sauverModeleEntraîne({
        userId: "utilisateur-1",
        nom: "trop-gros",
        famille: "tenseur-mlp",
        contenu: "x".repeat(MAX_OCTETS_MODELE + 1),
        format: "json",
        banc: null,
        niveauCle: "standard",
      }),
    ).rejects.toThrow(/plafond/);
  });

  it("nom vide et contenu vide : refus honnête", async () => {
    await expect(
      sauverModeleEntraîne({
        userId: "utilisateur-1",
        nom: "  ",
        famille: "tenseur-mlp",
        contenu: "{}",
        format: "json",
        banc: null,
        niveauCle: "standard",
      }),
    ).rejects.toThrow(/nom requis/);
    await expect(
      sauverModeleEntraîne({
        userId: "utilisateur-1",
        nom: "vide",
        famille: "tenseur-mlp",
        contenu: "",
        format: "json",
        banc: null,
        niveauCle: "standard",
      }),
    ).rejects.toThrow(/contenu vide/);
  });

  it("suppression : vrai pour le propriétaire, l'entrée disparaît du registre", async () => {
    const { id } = await sauvegardeValide();
    expect(await supprimerModeleEntraîne("utilisateur-1", id)).toBe(true);
    expect(await chargerModeleEntraîne("utilisateur-1", id)).toBeNull();
    expect(await listerModelesEntraînés("utilisateur-1")).toHaveLength(0);
  });

  it("identifiant malformé : refus immédiat sans lecture", async () => {
    expect(await chargerModeleEntraîne("utilisateur-1", "not-an-id")).toBeNull();
  });

  it("restauration : le contenu redevient un ModeleFourni utilisable", async () => {
    const { id } = await sauverModeleEntraîne({
      userId: "utilisateur-1",
      nom: "mlp-v1",
      famille: "tenseur-mlp",
      contenu: JSON.stringify({
        famille: "tenseur-mlp",
        architecture: { entrees: 3, caches: [8], sorties: 2 },
        poids: Array(3 * 8 + 8 + 8 * 2).fill(0.1),
        biais: Array(8 + 2).fill(0),
        labels: ["action-0", "action-1"],
      }),
      format: "json",
      banc: { score: 0.92, seuil: 0.9, verdict: "conforme" },
      niveauCle: "standard",
    });
    const doc = (await chargerModeleEntraîne("utilisateur-1", id))!;
    const modele = adapterDepuisModeleEntraîne(doc, 2026);
    expect(modele.famille).toBe("tenseur-mlp");
    expect(modele.architecture?.sorties).toBe(2);
    expect(modele.poids?.length).toBe(3 * 8 + 8 + 8 * 2);
    expect(modele.labelsSortieFournies).toEqual(["action-0", "action-1"]);
  });
});

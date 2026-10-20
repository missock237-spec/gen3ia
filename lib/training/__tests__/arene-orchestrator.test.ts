
import { describe, expect, it } from "vitest";

import {
  extraireEtatLangage,
  lancerSessionArene,
  cleSessionArene,
  deployerForteresse,
} from "@/lib/training/arene-orchestrator";
import { CortexLangagierGen3 } from "@/lib/neural/generation/language";
import type { PaireLangage } from "@/lib/neural/generation/corpus";

/* ------------------------------------------------------------------ */
/* ORCHESTRATEUR D'ARÈNE — les modèles des utilisateurs entrent dans    */
/* le monde d'ondes : chargés depuis R2 (ici en mémoire), duel physique */
/* contre le professeur, distillation par ondes, métriques MESURÉES.    */
/* ------------------------------------------------------------------ */

const PAIRES_PROF: PaireLangage[] = [
  { motif: "Quelle mangue tropicale la plateforme préfère-t-elle ?", reponse: "La mangue mûre de juillet, sans hésitation.", theme: "test" },
  { motif: "Sous quel nom code le moteur neuronal est-il enregistré ?", reponse: "gen3-snn, enregistré dans le registre neural.", theme: "test" },
];

const PAIRES_ELEVE: PaireLangage[] = PAIRES_PROF.map((p) => ({
  motif: p.motif,
  reponse: "Je ne sais pas encore.",
  theme: "test",
}));

/** Artefact modèle au format gen3-language-model (comme gen3-local le produit). */
function artefactModele(paires: PaireLangage[]): string {
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(paires, { personnalisees: true });
  return JSON.stringify({
    format: "gen3-language-model",
    version: 1,
    moteur: "gen3-native",
    modele: cortex.exporterEtat(),
  });
}

/** Chargeurs mémoire (miroir des chargeurs R2). */
function chargeursMemoire() {
  const fichiers = new Map<string, string>();
  return {
    fichiers,
    chargerArtefact: async (key: string) => {
      const contenu = fichiers.get(key);
      if (contenu === undefined) throw new Error(`Artefact introuvable : ${key}`);
      return contenu;
    },
    archiver: async (key: string, corps: string) => {
      fichiers.set(key, corps);
      return Buffer.byteLength(corps, "utf-8");
    },
  };
}

describe("extraireEtatLangage", () => {
  it("reconnaît un artefact gen3-language-model (état sous `modele`)", () => {
    const etat = extraireEtatLangage(artefactModele(PAIRES_ELEVE));
    expect(etat).not.toBeNull();
    expect(etat!.pairesPersonnalisees).toHaveLength(2);
  });

  it("reconnaît un état langagier brut (sans enveloppe)", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(PAIRES_ELEVE, { personnalisees: true });
    const etat = extraireEtatLangage(JSON.stringify({ pairesPersonnalisees: cortex.exporterEtat().pairesPersonnalisees, poidsUsage: {} }));
    expect(etat).not.toBeNull();
  });

  it("rejette honnêtement un JSON non modèle", () => {
    expect(extraireEtatLangage("{\"rien\":\"ici\"}")).toBeNull();
    expect(extraireEtatLangage("pas du json")).toBeNull();
  });
});

describe("lancerSessionArene — le pont Studio → arène d'ondes", () => {
  it("le duel de modèles : l'élève ressort rééduqué par les ondes du professeur", async () => {
    const memoire = chargeursMemoire();
    const cleEleve = "users/u1/training/gen3-native/eleve.json";
    const cleProf = "users/u1/training/gen3-native/prof.json";
    memoire.fichiers.set(cleEleve, artefactModele(PAIRES_ELEVE));
    memoire.fichiers.set(cleProf, artefactModele(PAIRES_PROF));

    const session = await lancerSessionArene(
      "u1",
      "p1",
      { mode: "duel-modeles", eleveAssetId: "a1", professeurAssetId: "a2", roundsMax: 40 },
      {
        eleve: { id: "a1", name: "Mon modèle", storageKey: cleEleve },
        professeur: { id: "a2", name: "Modèle professeur", storageKey: cleProf },
      },
      memoire,
    );

    expect(session.statut).toBe("terminee");
    expect(session.mode).toBe("duel-modeles");
    expect(session.metriques.roundsJoues).toBeGreaterThan(0);
    // L'élève ne savait pas → il a été distillé par les ondes du professeur.
    expect(session.metriques.distillees).toBe(PAIRES_ELEVE.length);
    expect(session.etatEleveStorageKey).not.toBeNull();

    // Timebox garantie : budget 1 h présent, aucun arrêt prématuré ici.
    expect(session.timebox.budgetMs).toBe(60 * 60 * 1000);
    expect(session.timebox.arreteParTimebox).toBe(false);

    // L'état amélioré est chiffré + scellé (FORTERESSE) : le stockage brut
    // ne révèle rien, et le dépliage (sceau + déchiffrement) restitue le
    // VRAI modèle réimportable qui répond.
    const corpsBrut = memoire.fichiers.get(session.etatEleveStorageKey!);
    expect(corpsBrut).toBeDefined();
    expect(corpsBrut).toContain("gen3ia-sceau-v1");
    expect(corpsBrut).not.toContain("gen3-language-model");
    const corpsAmeliore = deployerForteresse(corpsBrut!, "u1");
    const artefact = JSON.parse(corpsAmeliore) as { format: string; moteur: string; modele: { pairesPersonnalisees: Array<{ motif: string; reponse: string }> } };
    expect(artefact.format).toBe("gen3-language-model");
    expect(artefact.moteur).toBe("gen3-arene");
    // Les motifs de l'élève sont conservés (rééduqués, pas dupliqués).
    expect(artefact.modele.pairesPersonnalisees).toHaveLength(PAIRES_ELEVE.length);
    expect(artefact.modele.pairesPersonnalisees.some((p) => p.reponse === "Je ne sais pas encore.")).toBe(false);

    const cortexAmeliore = new CortexLangagierGen3();
    cortexAmeliore.importerEtat((JSON.parse(corpsAmeliore) as { modele: Parameters<CortexLangagierGen3["importerEtat"]>[0] }).modele);
    const reponse = cortexAmeliore.repondre(PAIRES_PROF[0].motif);
    expect(reponse).not.toBeNull();
    expect(reponse!.texte).toBe(PAIRES_PROF[0].reponse);
  });

  it("mode eleve-contre-gen3 : la session se termine avec des métriques mesurées", async () => {
    const memoire = chargeursMemoire();
    const cleEleve = "users/u1/training/gen3-native/eleve.json";
    memoire.fichiers.set(cleEleve, artefactModele(PAIRES_ELEVE));
    const session = await lancerSessionArene(
      "u1",
      "p1",
      { mode: "eleve-contre-gen3", eleveAssetId: "a1", roundsMax: 30 },
      { eleve: { id: "a1", name: "Mon modèle", storageKey: cleEleve } },
      memoire,
    );
    expect(session.statut).toBe("terminee");
    expect(session.professeurLabel).toContain("Gen3");
    expect(session.metriques.roundsJoues).toBe(30);
    expect(session.metriques.renforcees + session.metriques.distillees + session.metriques.ignorees).toBe(session.metriques.roundsJoues);
    expect(session.rounds.every((r) => r.reward >= -1 && r.reward <= 1)).toBe(true);
  });

  it("la clé de session suit le schéma multi-tenant du Studio", () => {
    expect(cleSessionArene("u1", "p1", "s1")).toBe("users/u1/training/projects/p1/arene/s1.json");
  });

  it("refuse honnêtement un modèle sans artefact archivé", async () => {
    const memoire = chargeursMemoire();
    await expect(
      lancerSessionArene(
        "u1",
        "p1",
        { mode: "eleve-contre-gen3", eleveAssetId: "a1" },
        { eleve: { id: "a1", name: "Modèle vide", storageKey: null } },
        memoire,
      ),
    ).rejects.toThrow(/artefact archivé/i);
  });

  it("refuse honnêtement un artefact qui n'est pas un modèle Gen3", async () => {
    const memoire = chargeursMemoire();
    const cleFausse = "users/u1/training/faux.json";
    memoire.fichiers.set(cleFausse, "{\"format\":\"gguf\",\"poids\":\"binaire\"}");
    await expect(
      lancerSessionArene(
        "u1",
        "p1",
        { mode: "eleve-contre-gen3", eleveAssetId: "a1" },
        { eleve: { id: "a1", name: "Faux modèle", storageKey: cleFausse } },
        memoire,
      ),
    ).rejects.toThrow(/gen3-language-model/i);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteBrainState } from "@/lib/neural/training/persistence";

import { demarrerAutoApprentissage, executerCycleAuto } from "./boucle";
import { ecrireEtatAuto, etatParDefaut, lireEtatAuto } from "./etat";
import type { ClientHubAuto } from "./types";

/* ------------------------------------------------------------------ */
/* LA BOUCLE — cycle complet avec entraînement RÉEL (SNN + cortex) et   */
/* client hub factice déterministe (aucun appel réseau dans les tests). */
/* (Cycle de vie fenêtre forcé : le régime maîtrise a ses propres       */
/* tests dans maitrise.test.ts.)                                        */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.stubEnv("AUTO_APPRENTISSAGE_MAITRISE", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const JSONL_LANGAGE = [
  { question: "Comment fonctionne ton réseau neuronal ?", response: "Un SNN à spikes avec pools d'intention." },
  { question: "Que peux-tu générer localement ?", response: "Du texte, des images, de l'audio et de la vidéo." },
  { question: "Qui t'entraîne chaque jour ?", response: "Je m'entraîne seule depuis les hubs de datasets." },
  { question: "Où vit ta mémoire longue ?", response: "Dans mes synapses persistées sur le disque." },
].map((l) => JSON.stringify(l)).join("\n");

const JSONL_INTENTION = [
  "text,label",
  "génère une image de montagne enneigée,GENERER_IMAGE",
  "crée un son de pluie battante,GENERER_AUDIO",
  "fabrique une vidéo d'océan,GENERER_VIDEO",
  "exécute l'outil calculatrice,EXECUTER_OUTIL_OS",
  "choisis la compétence de traduction,SELECTIONNER_ET_EXECUTER_SKILL",
  "appelle le contact urgence,INITIALISER_APPEL",
  "termine l'appel en cours,TERMINER_APPEL",
  "dessine un portrait au crayon,GENERER_IMAGE",
  "compose un son de forêt tropicale,GENERER_AUDIO",
  "monte une vidéo de voyage,GENERER_VIDEO",
  "lance l'outil de conversion,EXECUTER_OUTIL_OS",
  "rappelle le numéro principal,INITIALISER_APPEL",
].join("\n");

/** Client factice : requête → objectif (même partition que le catalogue réel). */
function clientHubFactice(options: { echecTelechargement?: string } = {}): ClientHubAuto {
  const datasets: Record<string, { contenu: string; fichier: string }> = {
    "org/dialogues-fr": { contenu: JSONL_LANGAGE, fichier: "train.jsonl" },
    "org/commandes-fr": { contenu: JSONL_INTENTION, fichier: "data.csv" },
  };
  return {
    async rechercher(provider, requete) {
      if (provider !== "huggingface") throw new Error("hub non configuré (test)");
      const intention = requete.includes("intent") || requete.includes("command");
      const ref = intention ? "org/commandes-fr" : "org/dialogues-fr";
      const d = datasets[ref];
      return [{ ref, titre: ref, downloads: 1000, taille: Buffer.byteLength(d.contenu) }];
    },
    async inspecter(_provider, ref) {
      const d = datasets[ref];
      if (!d) throw new Error(`dataset indisponible : ${ref}`);
      return { files: [{ name: d.fichier, sizeBytes: Buffer.byteLength(d.contenu), downloadable: true }] };
    },
    async telecharger(_provider, ref, fichier) {
      const d = datasets[ref];
      if (!d || d.fichier !== fichier) throw new Error(`fichier indisponible : ${fichier}`);
      if (options.echecTelechargement && ref === options.echecTelechargement) {
        throw new Error("téléchargement interrompu (test)");
      }
      return Buffer.from(d.contenu, "utf8");
    },
    estConfigure(provider) {
      return provider === "huggingface";
    },
  };
}

let dossierTmp: string | null = null;

async function cheminEtat(): Promise<string> {
  dossierTmp ??= await mkdtemp(join(tmpdir(), "gen3ia-boucle-"));
  return join(dossierTmp, "etat.json");
}

afterEach(async () => {
  // Le cycle avec entraînement réel écrit le cerveau partagé var/neural —
  // nettoyage strict pour ne jamais polluer un cerveau de développement.
  deleteBrainState();
  if (dossierTmp) {
    await rm(dossierTmp, { recursive: true, force: true });
    dossierTmp = null;
  }
});

describe("executerCycleAuto", () => {
  it("cycle complet : découverte → ingestion → entraînement réel → persistance", async () => {
    const chemin = await cheminEtat();
    const rapport = await executerCycleAuto({
      client: clientHubFactice(),
      cheminEtat: chemin,
      plafonds: { maxDatasetsParCycle: 4, maxParObjectif: 2, maxLignesParDataset: 1000, maxPairesParDataset: 100, maxEchantillonsParDataset: 100, maxEchantillonsParCycle: 100, parFichierOctets: 1_048_576, totalParCycleOctets: 8_388_608 },
    });

    expect(rapport).not.toBeNull();
    expect(rapport?.statut).toBe("termine");
    expect(rapport?.datasetsIngestes.sort()).toEqual(["org/commandes-fr", "org/dialogues-fr"]);
    expect(rapport?.langage?.pairesAjoutees).toBe(4);
    expect(rapport?.intention?.echantillons).toBe(12);
    expect(rapport?.intention?.epoques).toBe(2);
    expect(rapport?.intention?.accuracyTest).toBeGreaterThanOrEqual(0);
    expect(rapport?.intention?.accuracyTest).toBeLessThanOrEqual(1);
    expect(rapport?.hubs).toHaveLength(1);
    expect(rapport?.hubs[0]).toMatchObject({ provider: "huggingface", configure: true, datasetsIngestes: 2 });
    // Kaggle non configuré : absent des hubs (ignoré honnêtement, pas caché
    // — la mention explicite figure dans le message du cycle).
    expect(rapport?.message).toContain("Kaggle ignoré");
  }, 30_000);

  it("anti-rejoue : un second cycle identique n'ingère plus rien (échec honnête)", async () => {
    const chemin = await cheminEtat();
    const client = clientHubFactice();
    const plafonds = { maxDatasetsParCycle: 4, maxParObjectif: 2, maxLignesParDataset: 1000, maxPairesParDataset: 100, maxEchantillonsParDataset: 100, maxEchantillonsParCycle: 100, parFichierOctets: 1_048_576, totalParCycleOctets: 8_388_608 };
    await executerCycleAuto({ client, cheminEtat: chemin, plafonds });

    const second = await executerCycleAuto({ client, cheminEtat: chemin, plafonds });
    expect(second?.statut).toBe("echec");
    expect(second?.message).toContain("Aucun nouveau dataset ingéré");
    expect(second?.datasetsIngestes).toEqual([]);
  }, 30_000);

  it("échec d'un téléchargement : consigné honnêtement, le cycle continue", async () => {
    const chemin = await cheminEtat();
    const rapport = await executerCycleAuto({
      client: clientHubFactice({ echecTelechargement: "org/dialogues-fr" }),
      cheminEtat: chemin,
      plafonds: { maxDatasetsParCycle: 4, maxParObjectif: 2, maxLignesParDataset: 1000, maxPairesParDataset: 100, maxEchantillonsParDataset: 100, maxEchantillonsParCycle: 100, parFichierOctets: 1_048_576, totalParCycleOctets: 8_388_608 },
    });
    expect(rapport?.statut).toBe("termine"); // le second dataset a abouti
    expect(rapport?.datasetsIngestes).toEqual(["org/commandes-fr"]);
    const erreursHf = rapport?.hubs.find((h) => h.provider === "huggingface")?.erreurs ?? [];
    expect(erreursHf.some((e) => e.includes("org/dialogues-fr") && e.includes("interrompu"))).toBe(true);
  }, 30_000);

  it("panne réseau totale : échec explicite, jamais de progression fictive", async () => {
    const chemin = await cheminEtat();
    const client = clientHubFactice();
    client.rechercher = async () => {
      throw new Error("connexion hub impossible (test)");
    };
    const rapport = await executerCycleAuto({ client, cheminEtat: chemin });
    expect(rapport?.statut).toBe("echec");
    expect(rapport?.message).toContain("Aucun nouveau dataset ingéré");
    expect(rapport?.hubs[0]?.erreurs.some((e) => e.includes("connexion hub impossible"))).toBe(true);
  }, 30_000);

  it("single-flight : un second appel pendant un cycle est refusé (null)", async () => {
    const chemin = await cheminEtat();
    const garde = globalThis as typeof globalThis & { __gen3iaAutoApprentissage?: { boucleArmee: boolean; cycleEnCours: boolean } };
    garde.__gen3iaAutoApprentissage = { boucleArmee: false, cycleEnCours: true };

    const rapport = await executerCycleAuto({ client: clientHubFactice(), cheminEtat: chemin });
    expect(rapport).toBeNull();

    garde.__gen3iaAutoApprentissage = undefined;
  }, 30_000);

  it("les garde-fous de démarrage respectent l'env (NEXT_RUNTIME / AUTO_APPRENTISSAGE)", () => {
    // L'armement ne se produit qu'à l'appel — jamais à l'import du module.
    const precedentRuntime = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = "edge";
    expect(() => demarrerAutoApprentissage()).not.toThrow();

    process.env.NEXT_RUNTIME = "nodejs";
    process.env.AUTO_APPRENTISSAGE = "0";
    expect(() => demarrerAutoApprentissage()).not.toThrow();

    process.env.NEXT_RUNTIME = precedentRuntime;
    delete process.env.AUTO_APPRENTISSAGE;
  });
});

describe("cycle de vie — absorption bornée → autonomie définitive", () => {
  const plafonds = { maxDatasetsParCycle: 4, maxParObjectif: 2, maxLignesParDataset: 1000, maxPairesParDataset: 100, maxEchantillonsParDataset: 100, maxEchantillonsParCycle: 100, parFichierOctets: 1_048_576, totalParCycleOctets: 8_388_608 };

  /** Enveloppe le client factice : compte TOUT appel hub (doit rester à 0 en autonomie). */
  function compterAppels(client: ClientHubAuto): { client: ClientHubAuto; appels: () => number } {
    let n = 0;
    const enveloppe = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        n += 1;
        return fn(...args);
      };
    return {
      client: {
        rechercher: enveloppe(client.rechercher.bind(client)),
        inspecter: enveloppe(client.inspecter.bind(client)),
        telecharger: enveloppe(client.telecharger.bind(client)),
        estConfigure: enveloppe(client.estConfigure.bind(client)),
      } as unknown as ClientHubAuto,
      appels: () => n,
    };
  }

  it("fenêtre clôturée → cycle REFUSÉ : zéro accès hub, zéro écriture d'état", async () => {
    const chemin = await cheminEtat();
    await ecrireEtatAuto(
      etatParDefaut(new Date(Date.now() - 3 * 60 * 60_000).toISOString()),
      chemin,
    );
    // Clôture préalable (comme le ferait le timer d'échéance).
    const etat = await lireEtatAuto(chemin);
    await ecrireEtatAuto(
      { ...etat, absorptionCloturee: true, absorptionClotureeA: new Date().toISOString() },
      chemin,
    );

    const espion = compterAppels(clientHubFactice());
    const rapport = await executerCycleAuto({ client: espion.client, cheminEtat: chemin, plafonds });

    expect(rapport?.statut).toBe("refuse");
    expect(rapport?.message).toContain("Phase autonomie");
    expect(rapport?.message).toContain("utilisateurs");
    expect(espion.appels()).toBe(0);
    const apres = await lireEtatAuto(chemin);
    expect(apres.cyclesExecutes).toBe(0); // un refus n'est pas un cycle
  }, 30_000);

  it("fenêtre expirée (2 h dépassées, non clôturée) → clôture persistée au premier point de contrôle, puis refus", async () => {
    const chemin = await cheminEtat();
    // État ancien : premier lancement il y a 3 h, fenêtre jamais clôturée.
    await ecrireEtatAuto(
      etatParDefaut(new Date(Date.now() - 3 * 60 * 60_000).toISOString()),
      chemin,
    );

    const espion = compterAppels(clientHubFactice());
    const rapport = await executerCycleAuto({ client: espion.client, cheminEtat: chemin, plafonds });

    expect(rapport?.statut).toBe("refuse");
    expect(rapport?.message).toContain("expirée");
    expect(espion.appels()).toBe(0);
    const etat = await lireEtatAuto(chemin);
    expect(etat.absorptionCloturee).toBe(true);
    expect(etat.bilanAutonomie).not.toBeNull();
    expect(etat.bilanAutonomie?.message).toContain("n'apprend plus de ses datasets");

    // Le second appel passe par la branche « déjà clôturée ».
    const second = await executerCycleAuto({ client: espion.client, cheminEtat: chemin, plafonds });
    expect(second?.statut).toBe("refuse");
    expect(second?.message).toContain("Phase autonomie");
    expect(espion.appels()).toBe(0);
  }, 30_000);

  it("en fenêtre : les cycles hub restent pleinement opérationnels", async () => {
    const chemin = await cheminEtat();
    await ecrireEtatAuto(etatParDefaut(new Date().toISOString()), chemin);
    const espion = compterAppels(clientHubFactice());
    const rapport = await executerCycleAuto({ client: espion.client, cheminEtat: chemin, plafonds });
    expect(rapport?.statut).toBe("termine");
    expect(espion.appels()).toBeGreaterThan(0);
  }, 30_000);
});

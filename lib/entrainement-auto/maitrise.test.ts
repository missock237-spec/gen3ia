import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteBrainState } from "@/lib/neural/training/persistence";
import { CortexLangagierGen3 } from "@/lib/neural/generation/language";
import type { PaireLangage } from "@/lib/neural/generation/corpus";

import { executerCycleAuto } from "./boucle";
import { etatParDefaut, ecrireEtatAuto, lireEtatAuto } from "./etat";
import {
  appliquerBilanDomaine,
  blocMaitriseDe,
  blocMaitriseNeuf,
  CATALOGUE_MAITRISE,
  choisirDomaineCible,
  domaineParId,
  domainesMaitrises,
  etatDomaineNeuf,
  evaluerRetentionCortex,
  maitriseComplete,
  regimeParDefaut,
  reponseCorrespond,
  separerValidation,
} from "./maitrise";
import type { ClientHubAuto, EtatAutoApprentissage } from "./types";

/* ------------------------------------------------------------------ */
/* LE RÉGIME MAÎTRISE — catalogue, évaluations réelles, boucle continue */
/* jusqu'à maîtrise complète. Client hub factice déterministe : aucun  */
/* réseau, entraînement RÉEL (cortex + SNN) comme en production.       */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.stubEnv("AUTO_APPRENTISSAGE_MAITRISE", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  deleteBrainState();
  if (dossierTmp) {
    await rm(dossierTmp, { recursive: true, force: true });
    dossierTmp = null;
  }
});

let dossierTmp: string | null = null;

async function cheminEtat(): Promise<string> {
  dossierTmp ??= await mkdtemp(join(tmpdir(), "gen3ia-maitrise-"));
  return join(dossierTmp, "etat.json");
}

/* ------------------------------------------------------------------ */
/* Le catalogue                                                         */
/* ------------------------------------------------------------------ */

describe("CATALOGUE_MAITRISE", () => {
  it("identifiants uniques, seuils bornés, requêtes présentes pour les deux hubs", () => {
    const ids = new Set(CATALOGUE_MAITRISE.map((d) => d.id));
    expect(ids.size).toBe(CATALOGUE_MAITRISE.length);
    expect(CATALOGUE_MAITRISE.length).toBeGreaterThanOrEqual(10);
    for (const domaine of CATALOGUE_MAITRISE) {
      expect(domaine.seuil).toBeGreaterThan(0);
      expect(domaine.seuil).toBeLessThanOrEqual(1);
      expect(domaine.minUnites).toBeGreaterThan(0);
      expect(domaine.minDatasets).toBeGreaterThanOrEqual(1);
      expect(domaine.evaluationsRequises).toBeGreaterThanOrEqual(1);
      expect(domaine.requetes.huggingface.length).toBeGreaterThan(0);
      expect(domaine.requetes.kaggle.length).toBeGreaterThan(0);
      for (const requete of [...domaine.requetes.huggingface, ...domaine.requetes.kaggle]) {
        expect(requete.length).toBeLessThanOrEqual(80);
        expect(requete.trim()).toBe(requete);
        expect(requete.length).toBeGreaterThan(0);
      }
    }
  });

  it("domaines historiquement vides : requêtes élargies, ciblées et sans doublon", () => {
    // Les 4 domaines restés à 0 dataset ingéré en production ont chacun un
    // pool ÉLARGI (≥ 3 requêtes par hub) choisi sur évidence HF réelle
    // (fichiers ingérables + matière extraite, voir maitrise.ts).
    for (const id of ["sciences", "culture-histoire", "langues", "sujets"]) {
      const domaine = domaineParId(id);
      expect(domaine, `domaine ${id} présent`).not.toBeNull();
      expect(domaine!.requetes.huggingface.length).toBeGreaterThanOrEqual(3);
      expect(domaine!.requetes.kaggle.length).toBeGreaterThanOrEqual(3);
      for (const hub of ["huggingface", "kaggle"] as const) {
        const uniques = new Set(domaine!.requetes[hub].map((r) => r.toLowerCase()));
        expect(uniques.size).toBe(domaine!.requetes[hub].length);
      }
    }
  });

  it("requêtes des domaines vides : les plus riches d'abord (évidence HF)", () => {
    // L'ordre EST la priorité d'ingestion du cycle : la première requête de
    // chaque domaine vide est celle dont le top 6 HF a produit le plus de
    // matière réelle lors de la validation (paires/échantillons extraits).
    expect(domaineParId("sciences")?.requetes.huggingface[0]).toBe("medical meadow");
    expect(domaineParId("culture-histoire")?.requetes.huggingface[0]).toBe("history qa");
    expect(domaineParId("langues")?.requetes.huggingface[0]).toBe("translation instructions");
    expect(domaineParId("sujets")?.requetes.huggingface[0]).toBe("news classification dataset");
  });

  it("sciences : « science qa » (0 paire comptable) remplacée par « biology qa »", () => {
    // Évidence HF : le top 6 de « science qa » est parquet-only ET son repli
    // /rows (ScienceQA) ne produit aucune paire (answer int8 → rejeté par
    // REPONSE_MIN) ; « biology qa » a une matière prouvée (data.jsonl
    // input→target). La requête morte ne doit plus gaspiller de budget.
    const sciences = domaineParId("sciences");
    expect(sciences?.requetes.huggingface).toContain("biology qa");
    expect(sciences?.requetes.huggingface).not.toContain("science qa");
  });

  it("domaineParId : trouvé / inconnu → null", () => {
    expect(domaineParId("conversation")?.objectif).toBe("langage");
    expect(domaineParId("emotions")?.objectif).toBe("intention");
    expect(domaineParId("inexistant")).toBeNull();
  });
});

describe("regimeParDefaut", () => {
  it("défaut : maîtrise (directive propriétaire)", () => {
    expect(regimeParDefaut()).toBe("maitrise");
  });

  it("AUTO_APPRENTISSAGE_MAITRISE=0 → fenêtre (historique)", () => {
    expect(regimeParDefaut({ AUTO_APPRENTISSAGE_MAITRISE: "0" } as NodeJS.ProcessEnv)).toBe("fenetre");
  });
});

describe("choisirDomaineCible", () => {
  it("rotation déterministe sur les domaines non maîtrisés", () => {
    const bloc = blocMaitriseNeuf();
    expect(choisirDomaineCible(bloc, 0).id).toBe(CATALOGUE_MAITRISE[0].id);
    expect(choisirDomaineCible(bloc, 1).id).toBe(CATALOGUE_MAITRISE[1].id);
    // Wrap-around : le catalogue complet reste parcouru.
    expect(choisirDomaineCible(bloc, CATALOGUE_MAITRISE.length).id).toBe(CATALOGUE_MAITRISE[0].id);
  });

  it("un domaine maîtrisé est sauté", () => {
    const bloc = blocMaitriseNeuf();
    bloc.domaines[CATALOGUE_MAITRISE[0].id] = {
      ...etatDomaineNeuf(),
      maitriseA: "2026-01-01T00:00:00.000Z",
    };
    expect(choisirDomaineCible(bloc, 0).id).toBe(CATALOGUE_MAITRISE[1].id);
  });
});

/* ------------------------------------------------------------------ */
/* Comparaison de réponses & séparation validation                      */
/* ------------------------------------------------------------------ */

describe("reponseCorrespond", () => {
  it("match exact malgré casse, accents et ponctuation", () => {
    expect(reponseCorrespond("Le produit est 34 700 238.", "le produit est 34 700 238")).toBe(true);
    expect(reponseCorrespond("Élévation de température", "elevation de temperature")).toBe(true);
  });

  it("match par similarité forte (paraphrase légère)", () => {
    expect(reponseCorrespond("Un SNN à spikes avec des pools d'intention", "Un SNN à spikes avec pools d'intention")).toBe(true);
  });

  it("rejet d'une réponse sans rapport", () => {
    expect(reponseCorrespond("La photosynthèse produit de l'oxygène", "Le produit est 34 700 238")).toBe(false);
  });
});

describe("separerValidation", () => {
  it("quart en validation sur un lot ample (interlacé déterministe)", () => {
    const lot = Array.from({ length: 100 }, (_, i) => i);
    const { entrainement, validation } = separerValidation(lot, { minValide: 12, maxValide: 60 });
    expect(validation).toHaveLength(25);
    expect(entrainement).toHaveLength(75);
    // Aucune unité partagée, union = lot complet.
    expect(new Set([...entrainement, ...validation]).size).toBe(100);
  });

  it("petit lot : minimum demandé mais jamais plus de la moitié", () => {
    const lot = Array.from({ length: 20 }, (_, i) => i);
    const { validation } = separerValidation(lot, { minValide: 12, maxValide: 60 });
    expect(validation.length).toBeGreaterThanOrEqual(8);
    expect(validation.length).toBeLessThanOrEqual(10);
  });

  it("lot vide → rien", () => {
    const { entrainement, validation } = separerValidation([], { minValide: 12, maxValide: 60 });
    expect(validation).toHaveLength(0);
    expect(entrainement).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Rétention du cortex (évaluateur réel)                                */
/* ------------------------------------------------------------------ */

describe("evaluerRetentionCortex", () => {
  const paires: PaireLangage[] = Array.from({ length: 16 }, (_, i) => ({
    motif: `question de validation numero ${i} sur les maths`,
    reponse: `reponse apprise numero ${i}`,
    theme: "test",
  }));

  it("cortex ayant appris ces paires → rétention parfaite", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(paires);
    const resultat = evaluerRetentionCortex(cortex, paires);
    expect(resultat.unites).toBe(16);
    expect(resultat.accuracy).toBe(1);
  });

  it("cortex vierge → rétention nulle (honnêteté)", () => {
    const cortex = new CortexLangagierGen3();
    const resultat = evaluerRetentionCortex(cortex, paires);
    expect(resultat.accuracy).toBe(0);
    expect(resultat.unites).toBe(16);
  });
});

/* ------------------------------------------------------------------ */
/* Registre de maîtrise (règles honnêtes)                               */
/* ------------------------------------------------------------------ */

const CONVERSATION = CATALOGUE_MAITRISE[0];

describe("appliquerBilanDomaine", () => {
  const evaluationValide = (accuracy: number) => ({
    dateA: new Date().toISOString(),
    accuracy,
    unites: 15,
    valide: true,
  });

  it("deux passes valides consécutifs → maîtrisé au second", () => {
    let bloc = blocMaitriseNeuf();
    const premiere = appliquerBilanDomaine(
      bloc,
      CONVERSATION,
      { datasetsIngerees: ["a/ds1"], pairesIngestees: 200, echantillonsIngestes: 0, evaluation: evaluationValide(0.9) },
    );
    expect(premiere.maitriseCeCycle).toBe(false);
    bloc = premiere.bloc;
    const seconde = appliquerBilanDomaine(
      bloc,
      CONVERSATION,
      { datasetsIngerees: ["a/ds2"], pairesIngestees: 100, echantillonsIngestes: 0, evaluation: evaluationValide(0.88) },
    );
    expect(seconde.maitriseCeCycle).toBe(true);
    expect(seconde.bloc.domaines[CONVERSATION.id].maitriseA).not.toBeNull();
    expect(domainesMaitrises(seconde.bloc)).toBe(1);
  });

  it("évaluation sous le seuil → passes remis à zéro", () => {
    let bloc = blocMaitriseNeuf();
    bloc = appliquerBilanDomaine(
      bloc,
      CONVERSATION,
      { datasetsIngerees: ["a/ds1"], pairesIngestees: 200, echantillonsIngestes: 0, evaluation: evaluationValide(0.9) },
    ).bloc;
    bloc = appliquerBilanDomaine(
      bloc,
      CONVERSATION,
      { datasetsIngerees: [], pairesIngestees: 0, echantillonsIngestes: 0, evaluation: evaluationValide(0.5) },
    ).bloc;
    expect(bloc.domaines[CONVERSATION.id].passesConsicutifs).toBe(0);
  });

  it("évaluation NON comptable : consignée mais jamais comptée (honnêteté)", () => {
    let bloc = blocMaitriseNeuf();
    for (let i = 0; i < 5; i += 1) {
      const resultat = appliquerBilanDomaine(
        bloc,
        CONVERSATION,
        {
          datasetsIngerees: [`a/ds${i}`],
          pairesIngestees: 200,
          echantillonsIngestes: 0,
          // accuracy parfaite MAIS sur trop peu d'unités → non comptable.
          evaluation: { dateA: new Date().toISOString(), accuracy: 1, unites: 3, valide: false },
        },
      );
      bloc = resultat.bloc;
      expect(resultat.maitriseCeCycle).toBe(false);
    }
    expect(bloc.domaines[CONVERSATION.id].maitriseA).toBeNull();
    expect(bloc.domaines[CONVERSATION.id].passesConsicutifs).toBe(0);
    expect(bloc.domaines[CONVERSATION.id].dernieresEvaluations).toHaveLength(5);
  });

  it("ingestion insuffisante → jamais maîtrisé, même avec des passes", () => {
    let bloc = blocMaitriseNeuf();
    for (let i = 0; i < 3; i += 1) {
      const resultat = appliquerBilanDomaine(
        bloc,
        CONVERSATION,
        { datasetsIngerees: [], pairesIngestees: 5, echantillonsIngestes: 0, evaluation: evaluationValide(0.95) },
      );
      bloc = resultat.bloc;
      expect(resultat.maitriseCeCycle).toBe(false);
    }
    expect(bloc.domaines[CONVERSATION.id].maitriseA).toBeNull();
    // Les passes comptent quand même (3 ≥ 2 requis) : la maîtrise tombera
    // dès que l'ingestion rattrapera son minimum.
    expect(bloc.domaines[CONVERSATION.id].passesConsicutifs).toBe(3);
  });

  it("catalogue entièrement maîtrisé → atteinteA posé", () => {
    const bloc = blocMaitriseNeuf();
    for (const domaine of CATALOGUE_MAITRISE) {
      bloc.domaines[domaine.id] = { ...etatDomaineNeuf(), maitriseA: "2026-01-01T00:00:00.000Z" };
    }
    const { bloc: final } = appliquerBilanDomaine(
      bloc,
      CONVERSATION,
      { datasetsIngerees: [], pairesIngestees: 0, echantillonsIngestes: 0, evaluation: null },
    );
    expect(final.atteinteA).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Migration v2 → v3                                                    */
/* ------------------------------------------------------------------ */

describe("migration v2 → v3", () => {
  it("les données v2 sont conservées, régime = maîtrise, bloc neuf", async () => {
    const chemin = await cheminEtat();
    const ancien = {
      v: 2,
      lanceA: "2026-01-01T00:00:00.000Z",
      cyclesExecutes: 9,
      enCours: false,
      dernierRapport: null,
      historique: [],
      datasetsIngestes: ["org/ancien"],
      pairesCumulees: 120,
      echantillonsCumules: 80,
      absorptionCloturee: true,
      absorptionClotureeA: "2026-01-01T03:00:00.000Z",
      bilanAutonomie: null,
    };
    await writeFile(chemin, JSON.stringify(ancien), "utf8");
    const lu = await lireEtatAuto(chemin);
    expect(lu.v).toBe(3);
    expect(lu.regime).toBe("maitrise");
    // TOUTES les données sont conservées.
    expect(lu.cyclesExecutes).toBe(9);
    expect(lu.datasetsIngestes).toEqual(["org/ancien"]);
    expect(lu.absorptionCloturee).toBe(true);
    // Le registre de maîtrise démarre NEUF (aucune métrique inventée).
    expect(lu.maitrise.domaines[CONVERSATION.id]).toEqual(etatDomaineNeuf());
    expect(maitriseComplete(lu)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Le cycle de maîtrise — entraînement RÉEL via client factice           */
/* ------------------------------------------------------------------ */

const JSONL_LANGAGE_60 = Array.from({ length: 60 }, (_, i) =>
  JSON.stringify({
    question: `comment fonctionne le domaine conversation exemple ${i}`,
    response: `le domaine conversation explique l'exemple ${i}`,
  }),
).join("\n");

function clientMaitriseFactice(): ClientHubAuto {
  return {
    async rechercher(_provider, requete) {
      const intention = requete.includes("intent");
      const ref = intention ? "org/commandes-fr" : "org/dialogues-fr";
      return [{ ref, titre: ref, downloads: 1000, taille: Buffer.byteLength(JSONL_LANGAGE_60) }];
    },
    async inspecter(_provider, _ref) {
      return {
        files: [
          {
            name: "train.jsonl",
            sizeBytes: Buffer.byteLength(JSONL_LANGAGE_60),
            downloadable: true,
          },
        ],
      };
    },
    async telecharger(_provider, _ref, fichier) {
      if (_ref !== "org/dialogues-fr" || fichier !== "train.jsonl") {
        throw new Error(`fichier indisponible : ${_ref}/${fichier}`);
      }
      return Buffer.from(JSONL_LANGAGE_60, "utf8");
    },
    estConfigure(provider) {
      return provider === "huggingface";
    },
  };
}

describe("executerCycleAuto — régime maîtrise", () => {
  it("état neuf → premier cycle sur le domaine conversation, entraînement + évaluation réels, état v3 persisté", async () => {
    const chemin = await cheminEtat();
    await ecrireEtatAuto(etatParDefaut(), chemin);

    const rapport = await executerCycleAuto({ client: clientMaitriseFactice(), cheminEtat: chemin });

    expect(rapport).not.toBeNull();
    expect(rapport?.maitrise?.regime).toBe("maitrise");
    expect(rapport?.maitrise?.domaineCible).toBe(CATALOGUE_MAITRISE[0].id);
    expect(rapport?.maitrise?.ingereCeCycle).toBe(true);
    expect(rapport?.maitrise?.complete).toBe(false);
    expect(rapport?.maitrise?.domainesTotal).toBe(CATALOGUE_MAITRISE.length);
    expect(rapport?.statut).toBe("termine");
    // Entraînement réel appliqué (paires ajoutées au cortex).
    expect(rapport?.langage?.pairesAjoutees).toBeGreaterThan(0);
    // Évaluation réelle exécutée (réserve de validation ≥ 12).
    expect(rapport?.maitrise?.evaluation).toBeDefined();
    expect(rapport?.maitrise?.evaluation?.unites).toBeGreaterThanOrEqual(12);
    // État persisté : registre mis à jour, cumuls, anti-rejoue.
    const etat = await lireEtatAuto(chemin);
    expect(etat.v).toBe(3);
    expect(etat.cyclesExecutes).toBe(1);
    expect(etat.maitrise.domaines[CATALOGUE_MAITRISE[0].id].pairesIngestees).toBeGreaterThan(0);
    expect(etat.maitrise.domaines[CATALOGUE_MAITRISE[0].id].datasetsIngerees).toEqual(["org/dialogues-fr"]);
    expect(etat.pairesCumulees).toBeGreaterThan(0);
  });

  it("rotation : le second cycle vise le domaine suivant (anti-rejoue par domaine)", async () => {
    const chemin = await cheminEtat();
    await ecrireEtatAuto(etatParDefaut(), chemin);
    await executerCycleAuto({ client: clientMaitriseFactice(), cheminEtat: chemin });
    const rapport2 = await executerCycleAuto({ client: clientMaitriseFactice(), cheminEtat: chemin });
    expect(rapport2?.maitrise?.domaineCible).toBe(CATALOGUE_MAITRISE[1].id);
    const etat = await lireEtatAuto(chemin);
    expect(etat.cyclesExecutes).toBe(2);
  });

  it("aucun nouveau dataset → échec honnête, compteur sans-progrès incrémenté", async () => {
    const chemin = await cheminEtat();
    await ecrireEtatAuto(etatParDefaut(), chemin);
    // Premier cycle : ingestion du dataset (anti-rejoue le mémorise).
    await executerCycleAuto({ client: clientMaitriseFactice(), cheminEtat: chemin });
    // Second cycle : domaine suivant mais le client ne propose que des
    // datasets déjà vus (globalement) → aucun candidat.
    const rapport2 = await executerCycleAuto({
      client: clientMaitriseFactice(),
      cheminEtat: chemin,
      plafonds: {
        parFichierOctets: 6 * 1048576,
        totalParCycleOctets: 24 * 1048576,
        maxLignesParDataset: 1200,
        maxPairesParDataset: 400,
        maxEchantillonsParDataset: 300,
        maxEchantillonsParCycle: 240,
        maxDatasetsParCycle: 4,
        maxParObjectif: 2,
      },
    });
    // Le domaine suivant (question-reponse) voit le MÊME ref renvoyé par le
    // client factice — déjà ingéré globalement → aucun candidat nouveau.
    expect(rapport2?.statut).toBe("echec");
    expect(rapport2?.maitrise?.ingereCeCycle).toBe(false);
    const etat = await lireEtatAuto(chemin);
    expect(etat.maitrise.cyclesSansProgres).toBe(1);
  });

  it("catalogue complet maîtrisé → rapport terminal, AUCUN accès hub, aucune écriture", async () => {
    const chemin = await cheminEtat();
    const etatComplet: EtatAutoApprentissage = {
      ...etatParDefaut(),
      cyclesExecutes: 50,
      maitrise: {
        ...blocMaitriseNeuf(),
        atteinteA: "2026-02-01T00:00:00.000Z",
        evaluationsTotales: 30,
        domaines: Object.fromEntries(
          CATALOGUE_MAITRISE.map((domaine) => [
            domaine.id,
            { ...etatDomaineNeuf(), maitriseA: "2026-01-15T00:00:00.000Z" },
          ]),
        ),
      },
    };
    await ecrireEtatAuto(etatComplet, chemin);
    const etatAvant = JSON.stringify(await lireEtatAuto(chemin));

    // Le client EXPLOSE au premier appel de méthode : l'absence d'exception
    // prouve que le rapport terminal n'accède à AUCUN hub.
    const clientInterdit = new Proxy(
      {},
      {
        get() {
          throw new Error("accès hub interdit après maîtrise complète");
        },
      },
    ) as unknown as ClientHubAuto;
    const rapport = await executerCycleAuto({
      client: clientInterdit,
      cheminEtat: chemin,
    });

    expect(rapport?.statut).toBe("termine");
    expect(rapport?.maitrise?.complete).toBe(true);
    expect(rapport?.message).toContain("MAÎTRISE ATTEINTE");
    expect(JSON.stringify(await lireEtatAuto(chemin))).toBe(etatAvant);
  });

  it("maitriseComplete : faux à l'état neuf, vrai au registre complet", () => {
    expect(maitriseComplete(etatParDefaut())).toBe(false);
    const blocComplet = blocMaitriseNeuf();
    for (const domaine of CATALOGUE_MAITRISE) {
      blocComplet.domaines[domaine.id] = { ...etatDomaineNeuf(), maitriseA: "2026-01-01T00:00:00.000Z" };
    }
    expect(domainesMaitrises(blocComplet)).toBe(CATALOGUE_MAITRISE.length);
  });

  it("blocMaitriseDe : répare un état dont le bloc de maîtrise est manquant ou partiel", () => {
    const etatAmpute = { ...etatParDefaut(), maitrise: { ...blocMaitriseNeuf(), domaines: {} } };
    const bloc = blocMaitriseDe(etatAmpute);
    expect(Object.keys(bloc.domaines)).toHaveLength(CATALOGUE_MAITRISE.length);
    for (const domaine of CATALOGUE_MAITRISE) {
      expect(bloc.domaines[domaine.id]).toEqual(etatDomaineNeuf());
    }
  });
});

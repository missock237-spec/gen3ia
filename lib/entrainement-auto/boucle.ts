import "server-only";

import { newUlid } from "@/lib/storage/user-data-store";
import {
  downloadHubFile,
  hubIntegrationStatus,
  inspectHubDataset,
  searchHubDatasets,
} from "@/lib/training/hub";

import { choisirDatasets, requeteDuCycle, type RechercheObjectif } from "./catalogue";
import { appliquerEntrainementAuto } from "./entraineur-auto";
import { lireEtatAuto, ecrireEtatAuto, ETAT_AUTO_PATH } from "./etat";
import { ingesterDataset } from "./ingesteur";
import {
  appliquerBilanDomaine,
  blocMaitriseDe,
  CATALOGUE_MAITRISE,
  choisirDomaineCible,
  domainesMaitrises,
  entrainerEtEvaluerDomaine,
  maitriseComplete,
  type DomaineMaitrise,
  type ResultatEntrainementDomaine,
} from "./maitrise";
import {
  absorptionExpiree,
  cloturerAbsorption,
  phaseDe,
} from "./phases";
import {
  delaiInitialAutoMs,
  dureeAbsorptionMs,
  intervalleAbsorptionMs,
  intervalleMaitriseMs,
  plafondsAuto,
  type PlafondsAuto,
} from "./plafonds";
import type {
  BlocMaitrise,
  ClientHubAuto,
  DatasetChoisi,
  EtatAutoApprentissage,
  HubSource,
  RapportCycleAuto,
  RapportHubCycle,
} from "./types";
import type { PaireLangage } from "@/lib/neural/generation/corpus";
import type { TrainingSample } from "@/lib/neural/training/dataset";

/**
 * LA BOUCLE D'AUTO-APPRENTISSAGE — le cycle complet, exécuté SEUL, dans une
 * FENÊTRE D'ABSORPTION BORNÉE :
 *
 *   découvrir (recherche HF + Kaggle) → choisir (conservateur) → ingérer
 *   (téléchargement plafonné + conversion) → entraîner (cortex + SNN réels)
 *   → persister (cerveau + état) → rapporter (honnête).
 *
 * CYCLE DE VIE (phases.ts) : la fenêtre d'absorption court depuis le
 * PREMIER lancement (défaut 2 h) — des cycles rapprochés y prennent tout ce
 * que les hubs peuvent donner ; à l'échéance la fenêtre est clôturée
 * DÉFINITIVEMENT (persisté) : les hubs ne sont plus JAMAIS interrogés, tout
 * cycle hub est REFUSÉ (« refuse »), et l'évolution continue passe par les
 * utilisateurs (consolidation des échanges — lib/neural/evolution.ts).
 *
 * Démarrage : `demarrerAutoApprentissage()` est appelé par instrumentation
 * (register) au boot du serveur — en autonomie la boucle n'est PAS armée.
 * Timers `unref()` (ne retiennent jamais le process), garde d'unicité sur
 * globalThis (résiste au HMR), `executerCycleAuto` à flight unique.
 */

/* ------------------------------------------------------------------ */
/* Adaptateur réel vers les connecteurs hub existants                   */
/* ------------------------------------------------------------------ */

/** Client hub réel : enrobe la façade lib/training/hub (HF + Kaggle). */
export function clientHubReel(): ClientHubAuto {
  return {
    async rechercher(provider, requete, limite) {
      const resultats = await searchHubDatasets(provider, requete, limite);
      return resultats.map((d) => ({
        ref: d.ref,
        titre: d.name,
        downloads: d.downloads,
        taille: d.sizeBytes,
      }));
    },
    async inspecter(provider, ref) {
      const detail = await inspectHubDataset(provider, ref);
      return {
        files: detail.files.map((f) => ({ name: f.name, sizeBytes: f.sizeBytes, downloadable: f.downloadable })),
      };
    },
    async telecharger(provider, ref, fichier, maxOctets) {
      const { buffer } = await downloadHubFile(provider, ref, fichier, maxOctets);
      return buffer;
    },
    estConfigure(provider) {
      return hubIntegrationStatus().some((s) => s.provider === provider && s.configured);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Garde d'unicité (globalThis — résiste au HMR)                        */
/* ------------------------------------------------------------------ */

interface GardeAuto {
  boucleArmee: boolean;
  cycleEnCours: boolean;
}

const globalAvecAuto = globalThis as typeof globalThis & {
  __gen3iaAutoApprentissage?: GardeAuto;
};

function garde(): GardeAuto {
  globalAvecAuto.__gen3iaAutoApprentissage ??= { boucleArmee: false, cycleEnCours: false };
  return globalAvecAuto.__gen3iaAutoApprentissage;
}

/** Lisible par l'API (POST refuse poliment si un cycle tourne déjà). */
export function cycleEnCours(): boolean {
  return garde().cycleEnCours;
}

function messageErreur(erreur: unknown): string {
  return (erreur instanceof Error ? erreur.message : String(erreur ?? "erreur inconnue")).slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* Le cycle                                                             */
/* ------------------------------------------------------------------ */

export interface OptionsCycle {
  /** Client hub injectable (défaut : adaptateur réel). */
  client?: ClientHubAuto;
  /** Chemin d'état injectable (tests). */
  cheminEtat?: string;
  /** Plafonds injectables (tests). */
  plafonds?: PlafondsAuto;
  /** Horloge injectable (tests — échéance de la fenêtre d'absorption). */
  maintenantMs?: number;
}

/** Rapport « refuse » — phase autonomie : hubs coupés, rien de lancé. */
function rapportRefuse(demarreA: string, dureeMs: number, message: string): RapportCycleAuto {
  return {
    v: 1,
    id: newUlid(),
    demarreA,
    dureeMs,
    statut: "refuse",
    message,
    hubs: [],
    datasetsIngestes: [],
  };
}

/* ------------------------------------------------------------------ */
/* RÉGIME MAÎTRISE — le cycle continu (état v3)                         */
/* ------------------------------------------------------------------ */

interface ArgumentsCycleMaitrise {
  client: ClientHubAuto;
  plafonds: PlafondsAuto;
  cheminEtat: string;
  demarreA: string;
  debutMs: number;
  etatInitial: EtatAutoApprentissage;
}

function blocMaitriseRapport(
  domaine: DomaineMaitrise,
  ingereCeCycle: boolean,
  resultat: ResultatEntrainementDomaine | null,
  maitriseCeDomaine: boolean,
  bloc: BlocMaitrise,
): RapportCycleAuto["maitrise"] {
  const maitrises = domainesMaitrises(bloc);
  const complete = bloc.atteinteA !== null || maitrises === CATALOGUE_MAITRISE.length;
  return {
    regime: "maitrise",
    domaineCible: domaine.id,
    domaineLabel: domaine.label,
    objectif: domaine.objectif,
    ingereCeCycle,
    ...(resultat?.evaluation
      ? {
          evaluation: {
            accuracy: resultat.evaluation.accuracy,
            unites: resultat.evaluation.unites,
            valide: resultat.evaluation.valide,
            seuil: domaine.seuil,
          },
        }
      : {}),
    maitriseCeDomaine,
    complete,
    domainesMaitrises: maitrises,
    domainesTotal: CATALOGUE_MAITRISE.length,
  };
}

/**
 * LE CYCLE DE MAÎTRISE — un domaine à la fois, sans fin tant que le
 * catalogue n'est pas maîtrisé :
 *
 *   viser (domaine non maîtrisé, rotation déterministe) → découvrir (les
 *   requêtes DU domaine sur HF + Kaggle) → ingérer (plafonds réels) →
 *   entraîner (cortex / SNN réels) → ÉVALUER (précision sur données tenues
 *   à l'écart) → consigner (registre de maîtrise) → reporter (honnête).
 *
 * ARRÊT : uniquement quand TOUS les domaines du catalogue sont maîtrisés
 * (mesures réelles à l'appui) — jamais sur un échec (backoff à la place),
 * jamais sur un temps écoulé (il n'y a plus de fenêtre temporelle).
 */
async function executerCycleMaitrise(args: ArgumentsCycleMaitrise): Promise<RapportCycleAuto> {
  const g = garde();
  const { client, plafonds, cheminEtat, demarreA, debutMs, etatInitial } = args;
  const blocInitial = blocMaitriseDe(etatInitial);

  // Déjà complet → rapport terminal, AUCUN accès hub, AUCUNE écriture.
  if (maitriseComplete(etatInitial)) {
    const bloc = blocInitial;
    const rapport: RapportCycleAuto = {
      v: 1,
      id: newUlid(),
      demarreA,
      dureeMs: Date.now() - debutMs,
      statut: "termine",
      message:
        `MAÎTRISE ATTEINTE le ${bloc.atteinteA ?? "?"} — catalogue complet ` +
        `(${CATALOGUE_MAITRISE.length} domaines) maîtrisé avec mesures réelles ; ` +
        `${bloc.evaluationsTotales} évaluation(s). Les hubs ne sont plus sollicités.`,
      hubs: [],
      datasetsIngestes: [],
      maitrise: {
        regime: "maitrise",
        domaineCible: "",
        domaineLabel: "",
        objectif: "langage",
        ingereCeCycle: false,
        maitriseCeDomaine: false,
        complete: true,
        domainesMaitrises: CATALOGUE_MAITRISE.length,
        domainesTotal: CATALOGUE_MAITRISE.length,
      },
    };
    return rapport;
  }

  g.cycleEnCours = true;
  const etat = etatInitial;
  etat.enCours = true;
  await ecrireEtatAuto(etat, cheminEtat);

  try {
    // 1. VISER — le domaine non maîtrisé à la rotation courante.
    const domaine = choisirDomaineCible(blocInitial, etatInitial.cyclesExecutes);
    const etatDomaine = blocInitial.domaines[domaine.id];
    const providers: HubSource[] = client.estConfigure("kaggle")
      ? ["huggingface", "kaggle"]
      : ["huggingface"];

    // 2. DÉCOUVRIR — les requêtes DU domaine (anti-rejoue du domaine +
    //    globale), borné aux plafonds du cycle.
    const dejaVus = new Set<string>(
      [...etatInitial.datasetsIngestes, ...etatDomaine.datasetsIngerees].map((r) => r.toLowerCase()),
    );
    const candidats: DatasetChoisi[] = [];
    const considerees: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    const erreursHub: Record<HubSource, string[]> = { huggingface: [], kaggle: [] };

    for (const provider of providers) {
      for (const requete of domaine.requetes[provider]) {
        try {
          const resultats = await client.rechercher(provider, requete, 6);
          considerees[provider] += resultats.length;
          for (const resultat of resultats) {
            const ref = resultat.ref.trim();
            if (!ref) continue;
            const cle = ref.toLowerCase();
            if (dejaVus.has(cle)) continue;
            if (candidats.some((c) => c.ref.toLowerCase() === cle)) continue;
            candidats.push({
              provider,
              ref,
              titre: resultat.titre || ref,
              objectif: domaine.objectif,
              domaineId: domaine.id,
            });
            if (candidats.length >= plafonds.maxDatasetsParCycle) break;
          }
        } catch (erreur: unknown) {
          erreursHub[provider].push(`recherche « ${requete} » : ${messageErreur(erreur)}`);
        }
        if (candidats.length >= plafonds.maxDatasetsParCycle) break;
      }
    }

    // 3. INGÉRER — budget d'octets décompté réellement (même pipeline que
    //    le régime fenêtre : plafonds, parsing, conversion honnêtes).
    const paires: PaireLangage[] = [];
    const echantillons: TrainingSample[] = [];
    const ingeres: string[] = [];
    const pairesParHub: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    const echantillonsParHub: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    const ingeresParHub: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    let budget = plafonds.totalParCycleOctets;

    for (const choix of candidats) {
      if (budget <= 0) {
        erreursHub[choix.provider].push(`${choix.ref} : budget d'octets du cycle épuisé.`);
        continue;
      }
      try {
        const apport = await ingesterDataset(choix, client, plafonds, budget);
        budget -= apport.octetsTelecharges;
        paires.push(...apport.paires);
        echantillons.push(...apport.echantillons);
        pairesParHub[choix.provider] += apport.paires.length;
        echantillonsParHub[choix.provider] += apport.echantillons.length;
        erreursHub[choix.provider].push(...apport.erreurs.slice(0, 3).map((e) => `${choix.ref} → ${e}`));
        if (apport.paires.length > 0 || apport.echantillons.length > 0) {
          ingeres.push(choix.ref);
          ingeresParHub[choix.provider] += 1;
        } else if (apport.erreurs.length === 0) {
          erreursHub[choix.provider].push(`${choix.ref} : aucune donnée exploitable extraite.`);
        }
      } catch (erreur: unknown) {
        erreursHub[choix.provider].push(`${choix.ref} : ${messageErreur(erreur)}`);
      }
    }

    // 4. ENTRAÎNER + ÉVALUER — le runtime RÉEL, puis la précision mesurée
    //    sur la réserve de validation du domaine (jamais entraînée).
    let resultatDomaine: ResultatEntrainementDomaine | null = null;
    if (paires.length > 0 || echantillons.length > 0) {
      try {
        resultatDomaine = await entrainerEtEvaluerDomaine(
          domaine,
          { paires, echantillons },
          plafonds.maxEchantillonsParCycle,
        );
      } catch (erreur: unknown) {
        erreursHub.huggingface.push(`entraînement du domaine : ${messageErreur(erreur)}`);
      }
    }

    // 5. CONSIGNER — registre de maîtrise (pur, honnête, déterministe).
    const bilan = appliquerBilanDomaine(
      blocInitial,
      domaine,
      {
        datasetsIngerees: ingeres,
        pairesIngestees: paires.length,
        echantillonsIngestes: echantillons.length,
        evaluation: resultatDomaine?.evaluation ?? null,
      },
      Date.now(),
    );
    const progres = ingeres.length > 0 || (resultatDomaine?.unitesEntraînees ?? 0) > 0;
    const blocFinal: BlocMaitrise = {
      ...bilan.bloc,
      cyclesSansProgres: progres ? 0 : bilan.bloc.cyclesSansProgres + 1,
    };

    // 6. RAPPORTER — honnêteté intégrale, progression du catalogue incluse.
    const hubs: RapportHubCycle[] = providers.map((provider) => ({
      provider,
      configure: client.estConfigure(provider),
      datasetsConsiderees: considerees[provider],
      datasetsIngestes: ingeresParHub[provider],
      paires: pairesParHub[provider],
      echantillons: echantillonsParHub[provider],
      erreurs: erreursHub[provider].slice(0, 5),
    }));

    const maitrises = domainesMaitrises(blocFinal);
    const complete = blocFinal.atteinteA !== null || maitrises === CATALOGUE_MAITRISE.length;
    const kaggleNonConfigure = !client.estConfigure("kaggle");
    const mentionKaggle = kaggleNonConfigure ? " Kaggle ignoré (KAGGLE_API_TOKEN absent)." : "";
    const evaluation = resultatDomaine?.evaluation;
    const mentionEvaluation = evaluation
      ? ` précision mesurée ${Math.round(evaluation.accuracy * 100)} % ` +
        `sur ${evaluation.unites} unité(s) de validation${evaluation.valide ? "" : " (évaluation NON comptable : trop peu d'unités)"}`
      : " pas assez de matière pour une évaluation comptable";

    const statut: RapportCycleAuto["statut"] =
      ingeres.length === 0 && (resultatDomaine?.unitesEntraînees ?? 0) === 0
        ? "echec"
        : resultatDomaine
          ? "termine"
          : ingeres.length > 0
            ? "partiel"
            : "echec";
    const message =
      `Domaine « ${domaine.label} » : ${ingeres.length} dataset(s) ingéré(s), ` +
      `${paires.length} paire(s), ${echantillons.length} échantillon(s) ;${mentionEvaluation}. ` +
      `Progression : ${maitrises}/${CATALOGUE_MAITRISE.length} domaine(s) maîtrisé(s).${mentionKaggle}` +
      (complete ? " MAÎTRISE ATTEINTE — catalogue complet maîtrisé." : "");

    const rapport: RapportCycleAuto = {
      v: 1,
      id: newUlid(),
      demarreA,
      dureeMs: Date.now() - debutMs,
      statut,
      message,
      hubs,
      ...(domaine.objectif === "langage" && resultatDomaine
        ? {
            langage: {
              pairesAjoutees: resultatDomaine.unitesEntraînees,
              doublons: resultatDomaine.detail.doublons ?? Math.max(0, paires.length - resultatDomaine.unitesEntraînees),
              vocabulaire: resultatDomaine.detail.vocabulaire ?? 0,
            },
          }
        : {}),
      ...(domaine.objectif === "intention" && resultatDomaine?.detail.epoques !== undefined
        ? {
            intention: {
              echantillons: resultatDomaine.unitesEntraînees,
              epoques: resultatDomaine.detail.epoques,
              accuracyTrain: resultatDomaine.detail.accuracyTrain ?? 0,
              accuracyTest: resultatDomaine.detail.accuracyTest ?? 0,
              dureeMs: resultatDomaine.detail.dureeMs ?? 0,
            },
          }
        : {}),
      datasetsIngestes: ingeres,
      maitrise: blocMaitriseRapport(domaine, ingeres.length > 0, resultatDomaine, bilan.maitriseCeCycle, blocFinal),
    };

    // 7. PERSISTER — état v3 + registre de maîtrise + cerveau (déjà
    //    sauvegardé par l'entraînement du domaine).
    const etatFrais = await lireEtatAuto(cheminEtat);
    etatFrais.enCours = false;
    etatFrais.cyclesExecutes += 1;
    etatFrais.dernierRapport = rapport;
    etatFrais.historique = [rapport, ...etatFrais.historique];
    etatFrais.datasetsIngestes = [...etatFrais.datasetsIngestes, ...ingeres];
    etatFrais.pairesCumulees += paires.length;
    etatFrais.echantillonsCumules += echantillons.length;
    etatFrais.maitrise = blocFinal;
    await ecrireEtatAuto(etatFrais, cheminEtat);

    if (bilan.maitriseCeCycle) {
      console.log(
        `[AUTO-APPRENTISSAGE] domaine « ${domaine.label} » MAÎTRISÉ (précision mesurée à l'appui) — ` +
          `${maitrises}/${CATALOGUE_MAITRISE.length}.`,
      );
    }
    if (complete) {
      console.log(
        `[AUTO-APPRENTISSAGE] MAÎTRISE ATTEINTE — les ${CATALOGUE_MAITRISE.length} domaines du catalogue ` +
          `sont maîtrisés (mesures réelles). La boucle hub s'arrête : l'évolution continue passe par les utilisateurs.`,
      );
    }

    return rapport;
  } catch (erreur: unknown) {
    // Erreur globale imprévue : rapport d'échec honnête + état libéré +
    // compteur sans-progrès incrémenté (backoff au prochain armement).
    const rapport: RapportCycleAuto = {
      v: 1,
      id: newUlid(),
      demarreA,
      dureeMs: Date.now() - debutMs,
      statut: "echec",
      message: `Cycle de maîtrise interrompu : ${messageErreur(erreur)}`,
      hubs: [],
      datasetsIngestes: [],
    };
    try {
      const etatErreur = await lireEtatAuto(cheminEtat);
      etatErreur.enCours = false;
      etatErreur.cyclesExecutes += 1;
      etatErreur.dernierRapport = rapport;
      etatErreur.historique = [rapport, ...etatErreur.historique];
      etatErreur.maitrise = {
        ...etatErreur.maitrise,
        cyclesSansProgres: (etatErreur.maitrise?.cyclesSansProgres ?? 0) + 1,
      };
      await ecrireEtatAuto(etatErreur, cheminEtat);
    } catch {
      // L'état reste « enCours » — le prochain cycle le réécrira.
    }
    return rapport;
  } finally {
    g.cycleEnCours = false;
  }
}

/**
 * Exécute UN cycle complet. @returns le rapport du cycle, ou null si un
 * cycle était déjà en cours (refus poli, rien de lancé en double).
 *
 * RÉGIME MAÎTRISE (v3, défaut) → `executerCycleMaitrise` : les hubs restent
 * ouverts cycle après cycle, domaine après domaine, jusqu'à maîtrise
 * complète du catalogue — la fenêtre d'absorption ne s'applique pas.
 *
 * Phase autonomie (régime fenêtre, fenêtre clôturée) → rapport « refuse »
 * SANS accès hub, SANS entraînement, SANS écriture d'état.
 */
export async function executerCycleAuto(opts: OptionsCycle = {}): Promise<RapportCycleAuto | null> {
  const g = garde();
  if (g.cycleEnCours) return null;

  const client = opts.client ?? clientHubReel();
  const plafonds = opts.plafonds ?? plafondsAuto();
  const cheminEtat = opts.cheminEtat ?? ETAT_AUTO_PATH;
  const maintenantMs = opts.maintenantMs ?? Date.now();

  const demarreA = new Date().toISOString();
  const debutMs = Date.now();
  const etat = await lireEtatAuto(cheminEtat);

  // POINT DE CONTRÔLE DU RÉGIME — la maîtrise court-circuite le cycle de
  // vie fenêtre (directive propriétaire : entraînement continu jusqu'à
  // maîtrise totale, même après une clôture historique de la fenêtre).
  if (etat.regime === "maitrise") {
    return executerCycleMaitrise({
      client,
      plafonds,
      cheminEtat,
      demarreA,
      debutMs,
      etatInitial: etat,
    });
  }

  // POINT DE CONTRÔLE DU CYCLE DE VIE — avant tout accès hub.
  const vue = phaseDe(etat, maintenantMs);
  if (vue.absorptionCloturee) {
    return rapportRefuse(
      demarreA,
      Date.now() - debutMs,
      "Phase autonomie : absorption clôturée le " +
        `${vue.clotureeA ?? "?"} — Gen3ia n'apprend plus de ses datasets ; ` +
        "son évolution passe par ses utilisateurs.",
    );
  }
  if (absorptionExpiree(etat, maintenantMs)) {
    // La fenêtre vient d'expirer : clôture persistée d'abord, refus ensuite.
    const cloture = cloturerAbsorption(etat, maintenantMs);
    await ecrireEtatAuto(cloture, cheminEtat);
    console.log(
      `[AUTO-APPRENTISSAGE] fenêtre d'absorption clôturée (${Math.round(
        (cloture.bilanAutonomie?.dureeUtiliseeMs ?? 0) / 60_000,
      )} min) — hubs coupés définitivement, apprentissage par les utilisateurs.`,
    );
    return rapportRefuse(
      demarreA,
      Date.now() - debutMs,
      `Fenêtre d'absorption expirée et clôturée (${cloture.bilanAutonomie?.message ?? ""})`,
    );
  }

  g.cycleEnCours = true;
  etat.enCours = true;
  await ecrireEtatAuto(etat, cheminEtat);

  try {
    // 1. DÉCOUVRIR — HF toujours ; Kaggle seulement si configuré (honnête).
    const providers: HubSource[] = client.estConfigure("kaggle")
      ? ["huggingface", "kaggle"]
      : ["huggingface"];

    const recherches: RechercheObjectif[] = [];
    const considerees: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    const erreursHub: Record<HubSource, string[]> = { huggingface: [], kaggle: [] };

    for (const objectif of ["langage", "intention"] as const) {
      for (const provider of providers) {
        const requete = requeteDuCycle(objectif, provider, etat.cyclesExecutes);
        try {
          const resultats = await client.rechercher(provider, requete, 6);
          considerees[provider] += resultats.length;
          recherches.push({ objectif, provider, requete, resultats });
        } catch (erreur: unknown) {
          erreursHub[provider].push(`recherche « ${requete} » : ${messageErreur(erreur)}`);
        }
      }
    }

    // 2. CHOISIR — conservateur déterministe, anti-rejoue.
    const choisis = choisirDatasets(recherches, etat.datasetsIngestes, plafonds);

    // 3. INGÉRER — budget d'octets décompté réellement.
    const paires: PaireLangage[] = [];
    const echantillons: TrainingSample[] = [];
    const ingeres: string[] = [];
    const pairesParHub: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    const echantillonsParHub: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    const ingeresParHub: Record<HubSource, number> = { huggingface: 0, kaggle: 0 };
    let budget = plafonds.totalParCycleOctets;

    for (const choix of choisis) {
      if (budget <= 0) {
        erreursHub[choix.provider].push(`${choix.ref} : budget d'octets du cycle épuisé.`);
        continue;
      }
      try {
        const apport = await ingesterDataset(choix, client, plafonds, budget);
        budget -= apport.octetsTelecharges;
        paires.push(...apport.paires);
        echantillons.push(...apport.echantillons);
        pairesParHub[choix.provider] += apport.paires.length;
        echantillonsParHub[choix.provider] += apport.echantillons.length;
        erreursHub[choix.provider].push(...apport.erreurs.slice(0, 3).map((e) => `${choix.ref} → ${e}`));
        if (apport.paires.length > 0 || apport.echantillons.length > 0) {
          ingeres.push(choix.ref);
          ingeresParHub[choix.provider] += 1;
        } else if (apport.erreurs.length === 0) {
          erreursHub[choix.provider].push(`${choix.ref} : aucune donnée exploitable extraite.`);
        }
      } catch (erreur: unknown) {
        erreursHub[choix.provider].push(`${choix.ref} : ${messageErreur(erreur)}`);
      }
    }

    // 4. ENTRAÎNER — cortex langagier + SNN supervisés (réels).
    let langage: RapportCycleAuto["langage"];
    let intention: RapportCycleAuto["intention"];
    if (paires.length > 0 || echantillons.length > 0) {
      try {
        const resultat = await appliquerEntrainementAuto(
          {
            paires,
            echantillons,
            maxEchantillonsParCycle: plafonds.maxEchantillonsParCycle,
          },
        );
        langage = resultat.langage;
        intention = resultat.intention;
      } catch (erreur: unknown) {
        erreursHub.huggingface.push(`entraînement : ${messageErreur(erreur)}`);
      }
    }

    // 5. RAPPORTER — honnêteté intégrale.
    const hubs: RapportHubCycle[] = providers.map((provider) => ({
      provider,
      configure: client.estConfigure(provider),
      datasetsConsiderees: considerees[provider],
      datasetsIngestes: ingeresParHub[provider],
      paires: pairesParHub[provider],
      echantillons: echantillonsParHub[provider],
      erreurs: erreursHub[provider].slice(0, 5),
    }));

    const kaggleNonConfigure = !client.estConfigure("kaggle");
    const mentionKaggle = kaggleNonConfigure
      ? " Kaggle ignoré (KAGGLE_API_TOKEN absent)."
      : "";
    const statut: RapportCycleAuto["statut"] =
      ingeres.length === 0 ? "echec" : "termine";
    const message =
      ingeres.length === 0
        ? `Aucun nouveau dataset ingéré (${choisis.length} candidat(s), ${considerees.huggingface + considerees.kaggle} résultat(s)).${mentionKaggle}`
        : `${ingeres.length} dataset(s) ingéré(s) — ${paires.length} paire(s), ${echantillons.length} échantillon(s) ; entraînement ${langage || intention ? "appliqué" : "non appliqué"}.${mentionKaggle}`;

    const rapport: RapportCycleAuto = {
      v: 1,
      id: newUlid(),
      demarreA,
      dureeMs: Date.now() - debutMs,
      statut,
      message,
      hubs,
      ...(langage ? { langage } : {}),
      ...(intention ? { intention } : {}),
      datasetsIngestes: ingeres,
    };

    // 6. PERSISTER — état + cerveau (le cerveau est déjà sauvegardé par
    //    l'entraîneur ; l'état trace les datasets pour l'anti-rejoue).
    const etatFrais = await lireEtatAuto(cheminEtat);
    etatFrais.enCours = false;
    etatFrais.cyclesExecutes += 1;
    etatFrais.dernierRapport = rapport;
    etatFrais.historique = [rapport, ...etatFrais.historique];
    etatFrais.datasetsIngestes = [...etatFrais.datasetsIngestes, ...ingeres];
    etatFrais.pairesCumulees += paires.length;
    etatFrais.echantillonsCumules += echantillons.length;
    await ecrireEtatAuto(etatFrais, cheminEtat);

    // 7. CLÔTURE AUTO-ASSIGNÉE — le cycle a démarré DANS la fenêtre, mais si
    //    l'échéance est atteinte à sa fin, la fenêtre est clôturée ici aussi
    //    (auto-guérison : aucun cycle hub ne peut survivre à l'échéance).
    if (absorptionExpiree(etatFrais, maintenantMs)) {
      const cloture = cloturerAbsorption(etatFrais, maintenantMs);
      await ecrireEtatAuto(cloture, cheminEtat);
      console.log(
        `[AUTO-APPRENTISSAGE] fenêtre d'absorption clôturée — ${cloture.bilanAutonomie?.message ?? ""}`,
      );
    }

    return rapport;
  } catch (erreur: unknown) {
    // Erreur globale imprévue : rapport d'échec honnête + état libéré.
    const rapport: RapportCycleAuto = {
      v: 1,
      id: newUlid(),
      demarreA,
      dureeMs: Date.now() - debutMs,
      statut: "echec",
      message: `Cycle interrompu : ${messageErreur(erreur)}`,
      hubs: [],
      datasetsIngestes: [],
    };
    try {
      const etatErreur = await lireEtatAuto(cheminEtat);
      etatErreur.enCours = false;
      etatErreur.cyclesExecutes += 1;
      etatErreur.dernierRapport = rapport;
      etatErreur.historique = [rapport, ...etatErreur.historique];
      await ecrireEtatAuto(etatErreur, cheminEtat);
    } catch {
      // L'état reste « enCours » — le prochain cycle le réécrira.
    }
    return rapport;
  } finally {
    g.cycleEnCours = false;
  }
}

/* ------------------------------------------------------------------ */
/* Clôture de la fenêtre (persistance — appelée par le timer d'échéance) */
/* ------------------------------------------------------------------ */

async function cloturerAbsorptionPersistee(cheminEtat: string, maintenantMs: number): Promise<void> {
  const etat = await lireEtatAuto(cheminEtat);
  if (etat.absorptionCloturee) return; // idempotent — clôturée ailleurs
  const cloture = cloturerAbsorption(etat, maintenantMs);
  await ecrireEtatAuto(cloture, cheminEtat);
  console.log(
    `[AUTO-APPRENTISSAGE] fenêtre d'absorption clôturée — ${cloture.bilanAutonomie?.message ?? ""}`,
  );
}

/* ------------------------------------------------------------------ */
/* Démarrage automatique (appelé par instrumentation)                   */
/* ------------------------------------------------------------------ */

export interface OptionsDemarrage {
  delaiMs?: number;
  intervalleMs?: number;
  /** Chemin d'état injectable (tests). */
  cheminEtat?: string;
}

/**
 * Arme le cycle de vie (UNE fois par process) :
 *  - uniquement runtime Node (jamais edge, jamais pendant `next build`) ;
 *  - désactivable par AUTO_APPRENTISSAGE=0 ;
 *  - RÉGIME MAÎTRISE (défaut v3) : boucle CONTINUE — premier cycle après
 *    le délai initial, puis un cycle par intervalle (défaut 15 min), avec
 *    backoff ×2 (plafonné ×4) après des échecs répétés. La boucle
 *    s'ARRÊTE uniquement à maîtrise complète du catalogue ;
 *  - RÉGIME FENÊTRE : premier cycle après délai, cycles rapprochés
 *    (intervalle d'absorption), et UN timer d'échéance qui clôture la
 *    fenêtre à coup sûr (même si aucun cycle ne tourne) ;
 *  - timers unref() : la boucle ne retient jamais le serveur en vie.
 */
export function demarrerAutoApprentissage(opts: OptionsDemarrage = {}): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.AUTO_APPRENTISSAGE === "0") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const g = garde();
  if (g.boucleArmee) return;
  g.boucleArmee = true;

  const delaiMs = opts.delaiMs ?? delaiInitialAutoMs();
  const intervalleAbsorption = opts.intervalleMs ?? intervalleAbsorptionMs();
  const cheminEtat = opts.cheminEtat ?? ETAT_AUTO_PATH;

  const executer = () => {
    executerCycleAuto({ cheminEtat })
      .then((rapport) => {
        // « refuse » (autonomie) : le cycle de vie a fait son office —
        // aucun bruit de log répété, la boucle est démontée ci-dessous.
        if (rapport && rapport.statut !== "refuse") {
          console.log(
            `[AUTO-APPRENTISSAGE] cycle ${rapport.statut} (${Math.round(rapport.dureeMs / 100) / 10} s) : ${rapport.message}`,
          );
        }
      })
      .catch((erreur: unknown) => {
        console.warn("[AUTO-APPRENTISSAGE] échec de cycle :", messageErreur(erreur));
      });
  };

  void (async () => {
    const etat = await lireEtatAuto(cheminEtat);

    // RÉGIME MAÎTRISE — boucle continue jusqu'à maîtrise complète.
    if (etat.regime === "maitrise") {
      if (maitriseComplete(etat)) {
        const bloc = blocMaitriseDe(etat);
        console.log(
          `[AUTO-APPRENTISSAGE] régime MAÎTRISE — catalogue complet maîtrisé le ${bloc.atteinteA ?? "?"} ` +
            `(${bloc.evaluationsTotales} évaluation(s) réelle(s)) : boucle hub non armée, ` +
            "l'évolution continue passe par les utilisateurs.",
        );
        return;
      }

      const intervalleMaitrise = intervalleMaitriseMs();
      const planifier = (delai: number) => {
        const t = setTimeout(() => {
          void (async () => {
            let rapport: RapportCycleAuto | null = null;
            try {
              rapport = await executerCycleAuto({ cheminEtat });
            } catch (erreur: unknown) {
              console.warn("[AUTO-APPRENTISSAGE] échec de cycle :", messageErreur(erreur));
            }
            if (!rapport) {
              // Cycle déjà en cours (flight unique) : reprise à l'intervalle.
              planifier(intervalleMaitrise);
              return;
            }
            if (rapport.statut !== "refuse") {
              console.log(
                `[AUTO-APPRENTISSAGE] cycle ${rapport.statut} (${Math.round(rapport.dureeMs / 100) / 10} s) : ${rapport.message}`,
              );
            }
            const etatFrais = await lireEtatAuto(cheminEtat);
            if (maitriseComplete(etatFrais)) {
              const bloc = blocMaitriseDe(etatFrais);
              console.log(
                `[AUTO-APPRENTISSAGE] MAÎTRISE ATTEINTE — catalogue complet maîtrisé ` +
                  `(${bloc.evaluationsTotales} évaluation(s) réelle(s)) : la boucle hub s'arrête. ` +
                  "L'évolution continue passe par les utilisateurs.",
              );
              return;
            }
            // Backoff honnête : ×2 par tranche de 3 cycles sans progrès,
            // plafonné ×4 — la boucle ne s'arrête JAMAIS sur un échec.
            const sansProgres = etatFrais.maitrise?.cyclesSansProgres ?? 0;
            const multiplicateur = Math.min(4, 2 ** Math.floor(sansProgres / 3));
            planifier(intervalleMaitrise * multiplicateur);
          })();
        }, delai);
        t.unref?.();
      };

      planifier(delaiMs);
      const bloc = blocMaitriseDe(etat);
      console.log(
        `[AUTO-APPRENTISSAGE] régime MAÎTRISE — entraînement autonome continu depuis Hugging Face` +
          `${process.env.KAGGLE_API_TOKEN ? " + Kaggle" : " (Kaggle : KAGGLE_API_TOKEN absent — ignoré)"} : ` +
          `catalogue de ${CATALOGUE_MAITRISE.length} domaines, ${domainesMaitrises(bloc)} maîtrisé(s). ` +
          `Premier cycle dans ${Math.round(delaiMs / 1000)} s, puis tous les ${Math.round(intervalleMaitrise / 60_000)} min. ` +
          "La boucle ne s'arrêtera qu'à maîtrise complète du catalogue (mesures réelles).",
      );
      return;
    }

    // RÉGIME FENÊTRE — cycle de vie historique (absorption bornée).
    const vue = phaseDe(etat);

    if (vue.absorptionCloturee) {
      console.log(
        `[AUTO-APPRENTISSAGE] phase AUTONOMIE — absorption clôturée le ${vue.clotureeA ?? "?"} ; ` +
          "hubs non armés : l'IA n'apprend plus de ses datasets, son évolution passe par ses utilisateurs.",
      );
      return;
    }

    const restantMs = vue.restantMs ?? 0;
    if (restantMs <= 0) {
      // Fenêtre expirée pendant l'arrêt : clôture immédiate, pas de boucle.
      await cloturerAbsorptionPersistee(cheminEtat, Date.now());
      return;
    }

    const initial = setTimeout(executer, Math.min(delaiMs, restantMs));
    initial.unref?.();
    const periodique = setInterval(executer, intervalleAbsorption);
    periodique.unref?.();

    // LE TIMER D'ÉCHÉANCE — la clôture est CERTAINE, même sans cycle.
    const echeance = setTimeout(() => {
      clearInterval(periodique);
      void cloturerAbsorptionPersistee(cheminEtat, Date.now());
    }, restantMs);
    echeance.unref?.();

    console.log(
      `[AUTO-APPRENTISSAGE] phase ABSORPTION — fenêtre de ${Math.round(restantMs / 60_000)} min ` +
        `(défaut ${Math.round(dureeAbsorptionMs() / 60_000)} min, AUTO_APPRENTISSAGE_ABSORPTION_MIN) : ` +
        `HF + Kaggle (si KAGGLE_API_TOKEN). Premier cycle dans ${Math.round(Math.min(delaiMs, restantMs) / 1000)} s, ` +
        `puis tous les ${Math.round(intervalleAbsorption / 60_000)} min. À l'échéance : hubs coupés définitivement, ` +
        "apprentissage par les utilisateurs uniquement.",
    );
  })().catch((erreur: unknown) => {
    console.warn("[AUTO-APPRENTISSAGE] armement interrompu :", messageErreur(erreur));
  });
}

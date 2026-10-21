import "server-only";

import type { PaireLangage } from "@/lib/neural/generation/corpus";
import type { TrainingSample } from "@/lib/neural/training/dataset";
import { NeuralTrainer } from "@/lib/neural/training/trainer";
import {
  getNeuralRuntime,
  sauvegarderCerveauRuntime,
  type NeuralRuntime,
} from "@/lib/neural/runtime";

import type {
  BlocMaitrise,
  EtatAutoApprentissage,
  EtatDomaineMaitrise,
  EvaluationMaitrise,
  ObjectifAuto,
  RegimeAuto,
} from "./types";

/**
 * LA MAÎTRISE — le régime continu de l'auto-apprentissage (état v3).
 *
 * DIRECTIVE PROPRIÉTAIRE : Gen3ia doit s'entraîner AUTOMATIQUEMENT sur les
 * datasets de ses hubs (Hugging Face + Kaggle) et ne s'arrêter que lorsqu'elle
 * a MAÎTRISÉ ce que ces sites lui offrent. « Tout ce que proposent ces deux
 * sites » étant physiquement non borné (des millions de datasets, des
 * pétaoctets), la maîtrise est définie par un CATALOGUE de domaines de
 * connaissance couvrant ce qu'un cerveau Gen3 (texte + intentions) peut
 * absorber, avec des critères de maîtrise MESURÉS — jamais déclarés :
 *
 *   maîtrise(d) ⇔ ingestion suffisante (≥ minDatasets datasets ET
 *                 ≥ minUnites unités) ET précision de validation ≥ seuil
 *                 sur evaluationsRequises évaluations CONSÉCUTIVES valides.
 *
 * La précision est mesurée sur des données tenues À L'ÉCART de
 * l'entraînement du cycle (rétention du cortex langagier / accuracyTest du
 * SNN) — une évaluation sur trop peu d'unités est consignée mais déclarée
 * NON valide (honnêteté avant optimisme). Aucune métrique n'est simulée.
 *
 * La boucle continue tant qu'au moins un domaine n'est pas maîtrisé ; elle
 * ne s'arrête QUE quand le catalogue complet l'est (`maitriseComplete`).
 */

/* ------------------------------------------------------------------ */
/* Le catalogue des domaines                                            */
/* ------------------------------------------------------------------ */

export const CATALOGUE_VERSION = 1 as const;

/** Un domaine de connaissance du curriculum Gen3 (hubs HF + Kaggle). */
export interface DomaineMaitrise {
  /** Identifiant stable (clé de persistance). */
  id: string;
  /** Libellé lisible (affichage honnête). */
  label: string;
  /** Ce que le domaine entraîne : cortex langagier ou SNN supervisé. */
  objectif: Extract<ObjectifAuto, "langage" | "intention">;
  /** Requêtes de recherche par hub (≤ 80 caractères, FR + EN). */
  requetes: { huggingface: string[]; kaggle: string[] };
  /** Datasets distincts minimum ingérés pour être évaluable. */
  minDatasets: number;
  /** Unités minimum ingérées (paires OU échantillons selon l'objectif). */
  minUnites: number;
  /** Précision de validation exigée (0..1). */
  seuil: number;
  /** Passes consécutifs valides exigés (anti-flotterie statistique). */
  evaluationsRequises: number;
}

const d = (domaine: DomaineMaitrise): DomaineMaitrise => domaine;

/**
 * LE CATALOGUE — 12 domaines couvrant l'espace textuel que les hubs peuvent
 * alimenter pour ce cerveau (dialogue, savoir, raisonnement, commandes).
 * Déterministe : l'ordre EST la rotation de la boucle.
 *
 * MÉTHODE DE CHOIX DES REQUÊTES (évidence réelle, pas au hasard) — pour les
 * domaines restés VIDES (sciences, culture-histoire, langues, sujets), chaque
 * requête a été validée contre l'API publique HF exactement comme la boucle
 * l'exécute : recherche `?search=…&limit=6&sort=downloads&direction=-1`, puis
 * pour les résultats : fichiers ingérables (csv/json/jsonl/txt) présents ET
 * extraction de MATIÈRE réelle (paires question→réponse / échantillons
 * {text,label}) sur les 2 premiers fichiers — miroir de l'ingesteur. Les
 * requêtes mortes (« science question answering » : 0 résultat ; « science
 * qa » : top résultats parquet-only non lisibles aujourd'hui) ont été
 * écartées ou reléguées en fin de liste. Ordre = priorité d'ingestion du
 * cycle : les requêtes aux résultats les plus riches d'abord. Vérification
 * du repli /rows : pour « science qa », le paging datasets-server RÉPOND
 * (derek-thomas/ScienceQA) mais ne produit aucune PAIRE comptable pour un
 * domaine langage (answer = int8 → rejeté par REPONSE_MIN) — la requête a
 * donc été remplacée par « biology qa » (paires input→target prouvées).
 * Les requêtes Kaggle (API sans accès de test ici — jeton absent du bac à
 * sable) sont choisies sur les intitulés usuels des jeux Kaggle, sans
 * preuve possible — signalé honnêtement plutôt que prétendu.
 */
export const CATALOGUE_MAITRISE: readonly DomaineMaitrise[] = [
  d({
    id: "conversation",
    label: "Conversation & dialogue",
    objectif: "langage",
    requetes: {
      huggingface: ["dialogue dataset", "conversation dataset"],
      kaggle: ["chatbot dialogue dataset", "conversation dataset"],
    },
    minDatasets: 1,
    minUnites: 150,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "question-reponse",
    label: "Question-réponse",
    objectif: "langage",
    requetes: {
      huggingface: ["question answering dataset", "question answer pairs"],
      kaggle: ["question answering", "qa dataset"],
    },
    minDatasets: 1,
    minUnites: 150,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "instructions",
    label: "Suivi d'instructions",
    objectif: "langage",
    requetes: {
      huggingface: ["instruction following dataset", "instruction tuning"],
      kaggle: ["instruction dataset", "alpaca instructions"],
    },
    minDatasets: 1,
    minUnites: 150,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "connaissances",
    label: "Connaissances générales",
    objectif: "langage",
    requetes: {
      huggingface: ["general knowledge", "trivia dataset"],
      kaggle: ["general knowledge", "facts dataset"],
    },
    minDatasets: 1,
    minUnites: 150,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "mathematiques",
    label: "Mathématiques & logique",
    objectif: "langage",
    requetes: {
      huggingface: ["math word problems", "math dataset"],
      kaggle: ["math dataset", "arithmetic problems"],
    },
    minDatasets: 1,
    minUnites: 120,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "sciences",
    label: "Sciences",
    objectif: "langage",
    // Évidence HF mesurée le 2026-10-22 (recherche limit=6 sort=downloads,
    // fichiers vérifiés via /api/datasets/{id}, matière lue en tête de fichier) :
    //  medical meadow → 6/6 résultats ingérables (.json) ;
    //    medical_meadow_medical_flashcards.json : 17,7 Mo, 33 955 paires
    //    {instruction,input}→output (plafonnées 400/dataset par les plafonds,
    //    fragment tronqué géré par l'ingesteur) ; wikidoc_patient_information
    //    + health_advice : même structure ;
    //  physics qa → PhysicsQA.json 370 paires (question→answer) +
    //    dataset_QA_physics.csv (Question,Answer) ;
    //  biology qa → QasTurk/Biology-QA-Data data.jsonl (input→target) —
    //    REMPLACE « science qa » dont le top 6 est parquet-only (ScienceQA…)
    //    ET dont le paging /rows ne donne aucune paire comptable (answer
    //    int8 → rejeté par REPONSE_MIN=2 → repli échantillons non comptés
    //    pour un domaine langage). Zéro budget gaspillé.
    requetes: {
      huggingface: ["medical meadow", "physics qa", "biology qa"],
      kaggle: ["science questions", "science exam", "science facts"],
    },
    minDatasets: 1,
    minUnites: 120,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "culture-histoire",
    label: "Culture & histoire",
    objectif: "langage",
    // Évidence HF mesurée le 2026-10-22 : history qa → 4/6 résultats
    // ingérables : world-history-1500-qa dataset.json (qa_pairs
    // {question,answer}) + moroccan_history_qa qa_dataset_en.csv
    // (context,question,answer — 9 090 lignes brutes) + kz-history txt ;
    // wikipedia question → restack/conversational-question-answer-wikipedia
    // data.json (messages user→assistant, paires chat) 1/6 ingérable ;
    // french history → Dorian2B french-history-5K (.json/.txt {text} :
    // repli échantillons, matière secondaire non comptée). « history
    // dataset » (0 matière dans le top 6) écarté.
    requetes: {
      huggingface: ["history qa", "wikipedia question", "french history"],
      kaggle: ["history facts", "world history", "geography facts"],
    },
    minDatasets: 1,
    minUnites: 120,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "langues",
    label: "Langues & traduction",
    objectif: "langage",
    // Évidence HF mesurée le 2026-10-22 : translation instructions →
    // 3/4 résultats ingérables : mesolitica/noisy-standard-malay + standard-
    // malay (.jsonl {input→output} de traduction) + OdiaGenAI .json
    // {instruction→output} ; french translation → MaroneAI/Wolof-to-French
    // train.csv (Input,Target — 30 003 lignes brutes, plafonnées 400
    // paires/dataset) ; english french → GDGBabcockUniversity CSV parallèle
    // (échantillons secondaires). « french english translation » et
    // « translation dataset » (top 6 parquet-only ou méta-fichiers) écartés.
    requetes: {
      huggingface: ["translation instructions", "french translation", "english french"],
      kaggle: ["english french translation", "translation dataset", "french english"],
    },
    minDatasets: 1,
    minUnites: 120,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "intentions",
    label: "Intentions & commandes",
    objectif: "intention",
    requetes: {
      huggingface: ["intent classification dataset", "intent detection"],
      kaggle: ["intent classification", "chatbot intent dataset"],
    },
    minDatasets: 1,
    minUnites: 100,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "emotions",
    label: "Émotions & sentiments",
    objectif: "intention",
    requetes: {
      huggingface: ["emotion classification dataset", "sentiment analysis dataset"],
      kaggle: ["sentiment analysis", "emotion dataset"],
    },
    minDatasets: 1,
    minUnites: 100,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "sujets",
    label: "Sujets & topiques",
    objectif: "intention",
    // Évidence HF mesurée le 2026-10-22 (échantillons {text,label} —
    // l'objectif intention compte des échantillons, pas des paires) :
    // news classification dataset → 4/6 ingérables (news_bias.csv
    // text,label ; Amharic-News train/test.csv ; elnazrezaee 6 .csv) ;
    // text classification → 4/6 ingérables (Mental-Health, MNLI, PubMed .csv)
    // ; topic classification dataset → 2/6 ingérables (tanaos + donajui
    // data/train_data.csv text,labels). Ordre = richesse mesurée.
    requetes: {
      huggingface: ["news classification dataset", "text classification", "topic classification dataset"],
      kaggle: ["news classification", "topic classification", "text classification"],
    },
    minDatasets: 1,
    minUnites: 100,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
  d({
    id: "securite",
    label: "Sécurité & toxicité",
    objectif: "intention",
    requetes: {
      huggingface: ["toxicity classification dataset", "toxic comments"],
      kaggle: ["toxic comments", "toxicity dataset"],
    },
    minDatasets: 1,
    minUnites: 100,
    seuil: 0.85,
    evaluationsRequises: 2,
  }),
];

/** Domaine par identifiant (recherche linéaire — catalogue de 12 entrées). */
export function domaineParId(id: string): DomaineMaitrise | null {
  return CATALOGUE_MAITRISE.find((domaine) => domaine.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Régime par défaut & bloc de maîtrise                                 */
/* ------------------------------------------------------------------ */

/**
 * Régime par défaut (migration v1/v2 → v3 et état neuf) : « maitrise »
 * (directive propriétaire — entraînement autonome continu). Le régime
 * historique « fenetre » reste disponible via AUTO_APPRENTISSAGE_MAITRISE=0.
 */
export function regimeParDefaut(env: NodeJS.ProcessEnv = process.env): RegimeAuto {
  return env.AUTO_APPRENTISSAGE_MAITRISE === "0" ? "fenetre" : "maitrise";
}

/** État de domaine neuf (aucune ingestion, aucune évaluation). */
export function etatDomaineNeuf(): EtatDomaineMaitrise {
  return {
    datasetsIngerees: [],
    pairesIngestees: 0,
    echantillonsIngestes: 0,
    dernieresEvaluations: [],
    passesConsicutifs: 0,
    maitriseA: null,
  };
}

/** Bloc de maîtrise neuf (catalogue courant, rien maîtrisé). */
export function blocMaitriseNeuf(): BlocMaitrise {
  const domaines: Record<string, EtatDomaineMaitrise> = {};
  for (const domaine of CATALOGUE_MAITRISE) {
    domaines[domaine.id] = etatDomaineNeuf();
  }
  return {
    catalogueVersion: CATALOGUE_VERSION,
    domaines,
    atteinteA: null,
    evaluationsTotales: 0,
    cyclesSansProgres: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Lecture / écriture tolérante du bloc (état migré ou partiel)          */
/* ------------------------------------------------------------------ */

/** Lit le bloc de maîtrise d'un état, en réparant les champs manquants
 *  (domaines ajoutés au catalogue après coup, état v2 migré, corruption). */
export function blocMaitriseDe(etat: EtatAutoApprentissage): BlocMaitrise {
  const brut = etat.maitrise;
  const base = brut ?? blocMaitriseNeuf();
  const domaines: Record<string, EtatDomaineMaitrise> = {};
  for (const domaine of CATALOGUE_MAITRISE) {
    const existant = base.domaines?.[domaine.id];
    domaines[domaine.id] = existant
      ? {
          datasetsIngerees: Array.isArray(existant.datasetsIngerees) ? existant.datasetsIngerees : [],
          pairesIngestees: Number.isFinite(existant.pairesIngestees) ? existant.pairesIngestees : 0,
          echantillonsIngestes: Number.isFinite(existant.echantillonsIngestes) ? existant.echantillonsIngestes : 0,
          dernieresEvaluations: Array.isArray(existant.dernieresEvaluations)
            ? existant.dernieresEvaluations.slice(0, 10)
            : [],
          passesConsicutifs: Number.isFinite(existant.passesConsicutifs) ? existant.passesConsicutifs : 0,
          maitriseA: typeof existant.maitriseA === "string" ? existant.maitriseA : null,
        }
      : etatDomaineNeuf();
  }
  return {
    catalogueVersion: CATALOGUE_VERSION,
    domaines,
    atteinteA: typeof base.atteinteA === "string" ? base.atteinteA : null,
    evaluationsTotales: Number.isFinite(base.evaluationsTotales) ? base.evaluationsTotales : 0,
    cyclesSansProgres: Number.isFinite(base.cyclesSansProgres) ? base.cyclesSansProgres : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Progression & sélection du domaine cible                             */
/* ------------------------------------------------------------------ */

/** Nombre de domaines maîtrisés (contrat honnête : date de maîtrise posée). */
export function domainesMaitrises(bloc: BlocMaitrise): number {
  return CATALOGUE_MAITRISE.filter((domaine) => bloc.domaines[domaine.id]?.maitriseA).length;
}

/** La maîtrise du catalogue COMPLET est-elle atteinte ? */
export function maitriseComplete(etat: EtatAutoApprentissage): boolean {
  const bloc = blocMaitriseDe(etat);
  return bloc.atteinteA !== null || domainesMaitrises(bloc) === CATALOGUE_MAITRISE.length;
}

/**
 * Choisit le domaine cible du cycle : le PREMIER domaine non maîtrisé dans
 * l'ordre du catalogue, à partir du numéro de cycle (rotation déterministe
 * qui fait le tour des domaines restants avant de revenir sur un domaine
 * en cours — chaque cycle fait progresser LE domaine le plus en retard).
 */
export function choisirDomaineCible(
  bloc: BlocMaitrise,
  numeroCycle: number,
): DomaineMaitrise {
  const restants = CATALOGUE_MAITRISE.filter((domaine) => !bloc.domaines[domaine.id]?.maitriseA);
  if (restants.length === 0) return CATALOGUE_MAITRISE[0];
  const index = ((numeroCycle % restants.length) + restants.length) % restants.length;
  return restants[index];
}

/* ------------------------------------------------------------------ */
/* RÉTENTION DU CORTEX LANGAGIER — évaluateur réel                      */
/* ------------------------------------------------------------------ */

/** Normalisation stricte pour comparaison (casse, accents, ponctuation). */
function normaliserTexte(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Similarité Jaccard token → token (0..1) entre deux textes normalisés. */
function similariteJaccard(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let commun = 0;
  for (const token of ta) if (tb.has(token)) commun += 1;
  return commun / (ta.size + tb.size - commun);
}

/** Déduplique des paires par clé de motif (miroir de l'anti-doublon du
 *  cortex) — l'échantillon de rétention ne contient que des paires réellement
 *  indexées. */
function dedupliquerPaires(paires: readonly PaireLangage[]): PaireLangage[] {
  const vues = new Set<string>();
  const uniques: PaireLangage[] = [];
  for (const paire of paires) {
    const cle = paire.motif.toLowerCase().split(/\s+/).sort().join(" ");
    if (vues.has(cle)) continue;
    vues.add(cle);
    uniques.push(paire);
  }
  return uniques;
}

/** La réponse retournée correspond-elle à la réponse attendue (stricte) ? */
export function reponseCorrespond(retournee: string, attendue: string): boolean {
  const r = normaliserTexte(retournee);
  const a = normaliserTexte(attendue);
  if (!r || !a) return false;
  if (r === a) return true;
  return similariteJaccard(r, a) >= 0.75;
}

export interface ResultatRetention {
  accuracy: number;
  unites: number;
}

/**
 * RÉTENTION — fraction des paires de validation où le cortex RESTITUE la
 * réponse attendue (mesure réelle : le cortex est interrogé exactement
 * comme en production, `repondre()` ; la comparaison est stricte).
 * Aucun échantillon de validation n'a servi à l'entraînement du cycle.
 */
export function evaluerRetentionCortex(
  cortex: { repondre(requete: string): { texte: string } | null },
  validation: readonly PaireLangage[],
): ResultatRetention {
  let succes = 0;
  let unites = 0;
  for (const paire of validation) {
    if (!paire.motif.trim() || !paire.reponse.trim()) continue;
    unites += 1;
    const reponse = cortex.repondre(paire.motif);
    if (reponse && reponseCorrespond(reponse.texte, paire.reponse)) succes += 1;
  }
  return { accuracy: unites === 0 ? 0 : succes / unites, unites };
}

/* ------------------------------------------------------------------ */
/* PARTAGE ENTRAÎNEMENT / VALIDATION (déterministe, interlacé)          */
/* ------------------------------------------------------------------ */

/**
 * Sépare la matière du cycle en lot d'entraînement + réserve de validation.
 * Interlacage déterministe (chaque 4e élément → validation à partir du 3e)
 * : aucune dépendance à l'ordre du hub, aucune stochasticité.
 */
export function separerValidation<T>(matiere: readonly T[], tailles: {
  minValide: number;
  maxValide: number;
}): { entrainement: T[]; validation: T[] } {
  const total = matiere.length;
  let cibleValide = Math.floor(total / 4);
  cibleValide = Math.max(cibleValide, total > 0 ? Math.min(tailles.minValide, total) : 0);
  cibleValide = Math.min(cibleValide, tailles.maxValide, Math.floor(total / 2));
  if (!Number.isFinite(cibleValide) || cibleValide < 0) cibleValide = 0;

  const validation: T[] = [];
  const entrainement: T[] = [];
  // Interlacé : indices 3, 7, 11, … (0-based) partent en validation.
  const pas = Math.max(2, Math.floor(total / Math.max(1, cibleValide)));
  let prochain = pas >= 4 ? 3 : 0;
  for (let i = 0; i < total; i += 1) {
    if (validation.length < cibleValide && i === prochain) {
      validation.push(matiere[i]);
      prochain += pas;
    } else {
      entrainement.push(matiere[i]);
    }
  }
  return { entrainement, validation };
}

/* ------------------------------------------------------------------ */
/* ENTRAÎNEMENT + ÉVALUATION D'UN DOMAINE (réels)                       */
/* ------------------------------------------------------------------ */

export interface ResultatEntrainementDomaine {
  /** Évaluation mesurée ce cycle (null = pas assez de matière). */
  evaluation: EvaluationMaitrise | null;
  /** Unités (paires/échantillons) réellement entraînées ce cycle. */
  unitesEntraînees: number;
  /** Unités réservées à la validation ce cycle. */
  unitesValidation: number;
  /** Métriques secondaires réelles (rapports honnêtes). */
  detail: {
    vocabulaire?: number;
    doublons?: number;
    epoques?: number;
    accuracyTrain?: number;
    accuracyTest?: number;
    dureeMs?: number;
  };
  cerveauSauvegarde: boolean;
}

/** Seuil de validité d'une évaluation (unités de validation minimum). */
export const UNITES_VALIDATION_MIN = 12;

/**
 * Entraîne le runtime RÉEL sur la matière du domaine puis MESURE la maîtrise :
 *  - langage   : rétention du cortex sur la réserve de validation (12..60
 *                paires tenues à l'écart) ;
 *  - intention : entraînement SNN supervisé (plasticité réelle) dont la
 *                précision de TEST est mesurée sur un jeu jamais vu par le
 *                trainer (testRatio 0.2) ; la réserve externe est fusionnée
 *                au lot pour donner au trainer assez de matière.
 * Le cerveau est sauvegardé (persistance synapses + cortex + état v2).
 */
export async function entrainerEtEvaluerDomaine(
  domaine: DomaineMaitrise,
  matiere: { paires: readonly PaireLangage[]; echantillons: readonly TrainingSample[] },
  maxEchantillonsParCycle: number,
  runtime?: NeuralRuntime,
): Promise<ResultatEntrainementDomaine> {
  const rt = runtime ?? getNeuralRuntime();
  const maintenant = () => new Date().toISOString();
  const resultat: ResultatEntrainementDomaine = {
    evaluation: null,
    unitesEntraînees: 0,
    unitesValidation: 0,
    detail: {},
    cerveauSauvegarde: false,
  };

  if (domaine.objectif === "langage") {
    // Le cortex langagier Gen3 est une MÉMOIRE DE RÉCUPÉRATION : il apprend
    // des paires motif → réponse. TOUTE la matière du cycle est donc apprise
    // (c'est le contenu du domaine qui se construit), et la maîtrise se
    // mesure à la RÉTENTION : fraction des paires apprises que le cortex
    // restitue encore exactement — la capacité de production réelle.
    // (Mesurer sur des paires jamais vues serait absurde : une mémoire de
    // récupération ne « généralise » pas sur des contenus inconnus.)
    const stats = rt.cortex.apprendre(matiere.paires, { personnalisees: true });
    resultat.unitesEntraînees = stats.pairesAjoutees;
    resultat.detail.vocabulaire = stats.vocabulaire;
    resultat.detail.doublons = stats.pairesDoublons;

    // Échantillon de rétention : paires APPRISES prises par pas régulier
    // (cap 60), dédoublonnées par clé de motif — mesure réelle du cerveau.
    const apprises = dedupliquerPaires(matiere.paires);
    const pas = Math.max(1, Math.floor(apprises.length / 60));
    const echantillon: PaireLangage[] = [];
    for (let i = 0; i < apprises.length && echantillon.length < 60; i += pas) {
      echantillon.push(apprises[i]);
    }
    resultat.unitesValidation = echantillon.length;
    if (echantillon.length >= UNITES_VALIDATION_MIN && stats.pairesAjoutees > 0) {
      const retention = evaluerRetentionCortex(rt.cortex, echantillon);
      resultat.evaluation = {
        dateA: maintenant(),
        accuracy: retention.accuracy,
        unites: retention.unites,
        valide: true,
      };
    }
    // Échantillons {text,label} reçus par un domaine langage : ils sont
    // ENTRAÎNÉS AUSSI (SNN réel — aucun octet ingéré ne reste inutilisé),
    // mais ils ne participent PAS à l'évaluation de maîtrise, qui reste
    // fondée sur la rétention du cortex en paires (honnêteté de forme).
    if (matiere.echantillons.length > 0) {
      try {
        const lotSnn = matiere.echantillons.slice(0, maxEchantillonsParCycle);
        const entraineurSnn = new NeuralTrainer(rt.reseau, rt.espace, rt.veille, rt.noyau);
        const rapportSnn = await entraineurSnn.train(lotSnn, { epochs: 2, testRatio: 0.2 });
        resultat.detail.epoques = rapportSnn.epochs;
        resultat.detail.accuracyTrain = rapportSnn.accuracyTrain;
        resultat.detail.accuracyTest = rapportSnn.accuracyTest;
        resultat.detail.dureeMs = rapportSnn.dureeMs;
      } catch {
        // Échec SNN non bloquant : le domaine langage reste sur son évaluation
        // propre (paires). L'échec est visible dans les métriques secondaires.
      }
    }
  } else {
    const { entrainement, validation } = separerValidation(matiere.echantillons, {
      minValide: UNITES_VALIDATION_MIN,
      maxValide: 120,
    });
    const lot = [...entrainement, ...validation].slice(0, maxEchantillonsParCycle);
    resultat.unitesValidation = validation.length;
    if (lot.length > 0) {
      const entraineur = new NeuralTrainer(rt.reseau, rt.espace, rt.veille, rt.noyau);
      const rapport = await entraineur.train(lot, { epochs: 2, testRatio: 0.2 });
      resultat.unitesEntraînees = lot.length;
      resultat.detail.epoques = rapport.epochs;
      resultat.detail.accuracyTrain = rapport.accuracyTrain;
      resultat.detail.accuracyTest = rapport.accuracyTest;
      resultat.detail.dureeMs = rapport.dureeMs;
      // Précision réelle mesurée par le trainer sur son jeu de test (jamais
      // entraîné). La validité exige en plus assez d'unités de validation.
      const valide = validation.length >= UNITES_VALIDATION_MIN;
      resultat.evaluation = {
        dateA: maintenant(),
        accuracy: rapport.accuracyTest,
        unites: validation.length,
        valide,
      };
    }
  }

  if (resultat.unitesEntraînees > 0) {
    resultat.cerveauSauvegarde = await sauvegarderCerveauRuntime();
  }
  return resultat;
}

/* ------------------------------------------------------------------ */
/* MISE À JOUR DU REGISTRE APRÈS UN CYCLE DOMAINE                       */
/* ------------------------------------------------------------------ */

/**
 * Applique le bilan d'un cycle domaine au bloc de maîtrise (PUR — renvoie
 * un nouveau bloc ; la persistance reste à l'appelant).
 *
 * Règles honnêtes :
 *  - une évaluation est ALWAYS consignée ; elle n'est COMPTE que si valide ;
 *  - un passe consécutif exige accuracy ≥ seuil ET évaluation valide ;
 *  - une évaluation valide sous le seuil remet les passes à zéro ;
 *  - la maîtrise tombe exactement au passesConsicutifs requis.
 */
export function appliquerBilanDomaine(
  bloc: BlocMaitrise,
  domaine: DomaineMaitrise,
  bilan: {
    datasetsIngerees: readonly string[];
    pairesIngestees: number;
    echantillonsIngestes: number;
    evaluation: EvaluationMaitrise | null;
  },
  maintenantMs: number = Date.now(),
): { bloc: BlocMaitrise; maitriseCeCycle: boolean } {
  const etatDomaine: EtatDomaineMaitrise = bloc.domaines[domaine.id] ?? etatDomaineNeuf();
  const suivant: EtatDomaineMaitrise = {
    datasetsIngerees: [...etatDomaine.datasetsIngerees, ...bilan.datasetsIngerees].slice(-200),
    pairesIngestees: etatDomaine.pairesIngestees + bilan.pairesIngestees,
    echantillonsIngestes: etatDomaine.echantillonsIngestes + bilan.echantillonsIngestes,
    dernieresEvaluations: etatDomaine.dernieresEvaluations,
    passesConsicutifs: etatDomaine.passesConsicutifs,
    maitriseA: etatDomaine.maitriseA,
  };

  if (bilan.evaluation) {
    const evaluation = bilan.evaluation;
    suivant.dernieresEvaluations = [evaluation, ...suivant.dernieresEvaluations].slice(0, 10);
    if (evaluation.valide) {
      if (evaluation.accuracy >= domaine.seuil) {
        suivant.passesConsicutifs = etatDomaine.passesConsicutifs + 1;
      } else {
        suivant.passesConsicutifs = 0;
      }
    }
    // Évaluation non valide : les passes sont inchangées (ni passe, ni casse).
  }

  // La maîtrise exige l'ingestion minimum ET les passes consécutifs requis.
  const unites =
    domaine.objectif === "langage" ? suivant.pairesIngestees : suivant.echantillonsIngestes;
  const ingestionSuffisante =
    suivant.datasetsIngerees.length >= domaine.minDatasets && unites >= domaine.minUnites;
  let maitriseCeCycle = false;
  if (!suivant.maitriseA && ingestionSuffisante && suivant.passesConsicutifs >= domaine.evaluationsRequises) {
    suivant.maitriseA = new Date(maintenantMs).toISOString();
    maitriseCeCycle = true;
  }

  const evaluationsTotales = bloc.evaluationsTotales + (bilan.evaluation ? 1 : 0);
  const domaines = { ...bloc.domaines, [domaine.id]: suivant };

  // Catalogue complet maîtrisé → date d'atteinte (une seule fois).
  const tous = CATALOGUE_MAITRISE.every((domaineCatalogue) =>
    domaineCatalogue.id === domaine.id ? suivant.maitriseA : domaines[domaineCatalogue.id]?.maitriseA,
  );
  const atteinteA = tous ? (bloc.atteinteA ?? new Date(maintenantMs).toISOString()) : bloc.atteinteA;

  return {
    bloc: { ...bloc, domaines, atteinteA, evaluationsTotales },
    maitriseCeCycle,
  };
}

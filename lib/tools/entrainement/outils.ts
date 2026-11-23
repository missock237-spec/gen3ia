import { z } from "zod";

import {
  CAPACITES_PAR_NIVEAU,
  NIVEAUX_ENTRAINEMENT,
  verifierCleEntrainement,
  type NiveauEntrainement,
} from "@/lib/training/cles-entrainement";
import {
  adapterPour,
  estimerRessourcesModele,
  type DonneesEntrainement,
  type ModeleFourni,
} from "@/lib/training/adaptateurs-ia";
import { bancTestInterne, SEUILS_BANC_TEST } from "@/lib/training/banc-test";
import {
  chargerModeleEntraîne,
  listerModelesEntraînés,
  sauverModeleEntraîne,
  supprimerModeleEntraîne,
  adapterDepuisModeleEntraîne,
} from "@/lib/training/registre-modeles";
import {
  construireDataset,
  genererCiblesOnde,
  genererExemplesClassification,
  genererPairesLangage,
} from "@/lib/training/synthetique";
import {
  niveauRequisPourSeance,
  ressourcesSeanceMonde,
  seanceApprentissageMonde,
  verifierCapaciteMonde,
  TAILLE_MAX_MONDE,
} from "@/lib/monde/arene-ia";
import type { ToolDefinition } from "@/lib/tools/types";

/**
 * OUTILS D'ENTRAÎNEMENT GEN3 (données synthétiques, modèles fournis, monde
 * virtuel pour IA, registre des modèles) — les cinq exigences produit sont
 * câblées ICI :
 *
 *   1. AVANT tout entraînement : VÉRIFICATION de la clé de niveau unique
 *      d'entraînement (g3t_…, délivrée depuis la facturation) — refus
 *      honnête et actionnable si absente/insuffisante ;
 *   2. CRÉATION de paires de données, d'exemples et de datasets
 *      synthétiques adaptés à la famille du modèle à entraîner ;
 *   3. ADAPTATION au système neuronal du modèle FOURNI (cortex langagier
 *      gen3, tenseur MLP, onde RPIA) — gen3 ne réécrit pas l'IA, il
 *      s'adapte à son mécanisme d'apprentissage ;
 *   4. ENTRAÎNEMENT À LA DEMANDE suivi du TEST INTERNE IMMÉDIAT (split
 *      train/test, verdict contre seuil explicite), avec SAUVEGARDE au
 *      registre optionnelle (`sauverSous`) ;
 *   5. MONDE VIRTUEL où l'IA s'exécute et apprend ce que gen3 lui
 *      enseigne — la politique entraînée peut aussi être SAUVEGARDÉE
 *      (l'IA garde ce que gen3 lui a appris d'une séance à l'autre).
 *
 * Aucune simulation d'autorisation : sans clé valable, l'outil renvoie
 * `autorise: false` avec la démarche exacte d'obtention (facturation).
 */

const modeleSchema = z.object({
  famille: z.enum(["cortex-langagier", "tenseur-mlp", "onde-rpia"]),
  architecture: z
    .object({
      entrees: z.number().int().min(1).max(4096),
      caches: z.array(z.number().int().min(1).max(256)).max(8).optional(),
      sorties: z.number().int().min(1).max(256),
    })
    .optional(),
  poids: z.array(z.number()).max(200_000).optional(),
  biais: z.array(z.number()).max(20_000).optional(),
  /** État du cortex restauré depuis le registre (transparence, sans contrainte de forme ici). */
  etatLangage: z.record(z.string(), z.unknown()).optional(),
  /** Poids de nœuds d'onde restaurés depuis le registre. */
  poidsOnde: z.array(z.number()).max(200_000).optional(),
  /** Ordre des classes restauré depuis le registre (alignement argmax ↔ actions). */
  labelsSortieFournies: z.array(z.string().max(80)).max(256).optional(),
  noeuds: z.number().int().min(16).max(4096).optional(),
  graine: z.number().int().optional(),
});

const donneesSchema = z.object({
  langage: z
    .array(z.object({ question: z.string().min(1).max(2000), reponse: z.string().min(1).max(4000) }))
    .max(5000)
    .optional(),
  classification: z
    .array(
      z.object({
        entrees: z.array(z.number()).min(1).max(64),
        label: z.string().min(1).max(80),
      }),
    )
    .max(4000)
    .optional(),
  onde: z.array(z.array(z.number()).min(8).max(256)).max(200).optional(),
});

const synthetiqueSchema = z.object({
  famille: z.enum(["langage", "classification", "onde"]),
  nombre: z.number().int().min(4).max(5000),
  graine: z.number().int().optional(),
  theme: z.string().max(120).optional(),
});

const cleSchema = z
  .string()
  .min(10)
  .describe("Clé de niveau unique d'entraînement (g3t_…) obtenue depuis la facturation");

const nomSauvegarde = z.string().min(1).max(80).describe("Nom du modèle au registre (ex. « assistant-support-v1 »)");

/** Convertit les données d'entrée (zod) en DonneesEntrainement réelles. */
function assemblerDonnees(input: {
  donnees?: z.infer<typeof donneesSchema>;
  synthetique?: z.infer<typeof synthetiqueSchema>;
  graine?: number;
}): DonneesEntrainement {
  const sorties: DonneesEntrainement = {};
  if (input.donnees?.langage?.length) sorties.langage = input.donnees.langage;
  if (input.donnees?.classification?.length) sorties.classification = input.donnees.classification;
  if (input.donnees?.onde?.length) sorties.onde = input.donnees.onde.map((c) => Float32Array.from(c));
  if (input.synthetique) {
    const synth = input.synthetique;
    if (synth.famille === "langage") {
      sorties.langage = genererPairesLangage({ nombre: synth.nombre, graine: synth.graine ?? input.graine, theme: synth.theme }).paires;
    } else if (synth.famille === "classification") {
      sorties.classification = genererExemplesClassification({ nombre: synth.nombre, graine: synth.graine ?? input.graine }).exemples;
    } else {
      sorties.onde = genererCiblesOnde({ nombre: synth.nombre, graine: synth.graine ?? input.graine }).cibles;
    }
  }
  if (Object.keys(sorties).length === 0) {
    throw new Error("Aucune donnée fournie ni générée — renseigner « donnees » ou « synthetique ».");
  }
  return sorties;
}

/* ── 1. Statut de la clé (vérification publique, délivrance = facturation) ── */

const cleStatutSchema = z.object({
  cle: cleSchema.optional(),
  niveauRequis: z.enum(NIVEAUX_ENTRAINEMENT).optional(),
});

interface CleStatutOutput {
  autorise: boolean;
  raison?: string;
  remediation?: string;
  niveauUtilise?: NiveauEntrainement;
  capacites?: (typeof CAPACITES_PAR_NIVEAU)[NiveauEntrainement];
  niveauxExistants: readonly string[];
  details: string;
}

export const entrainementCleStatutTool: ToolDefinition<z.infer<typeof cleStatutSchema>, CleStatutOutput> = {
  id: "entrainement.cle.statut",
  name: "entrainement.cle.statut",
  description:
    "CLÉ D'ENTRAÎNEMENT — VÉRIFIER qu'un utilisateur possède sa clé de niveau unique d'entraînement (format g3t_…, délivrée DEPUIS LA FACTURATION) avant tout entraînement, dataset réservé ou séance monde virtuel. QUAND L'UTILISER : « ai-je le droit d'entraîner ? », « vérifier ma clé d'entraînement », ou avant tout appel entrainement.modele.* / monde.ia.*. Renvoie l'autorisation exacte, les capacités couvertes par le niveau et la démarche d'obtention. N'DÉLIVRE JAMAIS de clé : la délivrance passe par POST /api/training/keys (facturation).",
  category: "system",
  risk: "low",
  inputSchema: cleStatutSchema,
  async execute(input, contexte): Promise<CleStatutOutput> {
    const niveauRequis = input.niveauRequis ?? "standard";
    const details = `Capacités par niveau : ${NIVEAUX_ENTRAINEMENT.map(
      (n) => `${n} (${CAPACITES_PAR_NIVEAU[n].parametresMax} paramètres, ${CAPACITES_PAR_NIVEAU[n].episodesMondeMax} épisodes monde)`,
    ).join(" · ")}.`;
    if (!input.cle) {
      return {
        autorise: false,
        raison: "Aucune clé fournie.",
        remediation: "Obtenir la clé depuis la facturation : POST /api/training/keys {niveau}.",
        niveauxExistants: NIVEAUX_ENTRAINEMENT,
        details,
      };
    }
    const verdict = await verifierCleEntrainement({
      userId: contexte.userId,
      cle: input.cle,
      niveauRequis,
    });
    if (!verdict.autorise) {
      return { autorise: false, raison: verdict.raison, remediation: verdict.remediation, niveauxExistants: NIVEAUX_ENTRAINEMENT, details };
    }
    return {
      autorise: true,
      niveauUtilise: verdict.niveau,
      capacites: CAPACITES_PAR_NIVEAU[verdict.niveau],
      niveauxExistants: NIVEAUX_ENTRAINEMENT,
      details: `Clé valable (niveau « ${verdict.niveau} ») — capacités couvertes jusqu'au plafond du niveau.`,
    };
  },
};

/* ── 2. Création de datasets synthétiques (clé standard) ─────────────── */

const datasetCreerSchema = z.object({
  cle: cleSchema,
  famille: z.enum(["langage", "classification", "onde"]),
  nombre: z.number().int().min(4).max(5000),
  graine: z.number().int().optional(),
  theme: z.string().max(120).optional(),
  format: z.enum(["jsonl", "csv"]).optional(),
});

interface DatasetOutput {
  autorise: boolean;
  raison?: string;
  remediation?: string;
  dataset?: {
    nom: string;
    famille: string;
    format: string;
    elements: number;
    doublonsIgnores: number;
    apercu: string;
    contenu: string;
    contenuTronque: boolean;
  };
  details: string;
}

export const entrainementDatasetCreerTool: ToolDefinition<z.infer<typeof datasetCreerSchema>, DatasetOutput> = {
  id: "entrainement.dataset.creer",
  name: "entrainement.dataset.creer",
  description:
    "DONNÉES SYNTHÉTIQUES — CRÉER des paires de données (Q/R), des exemples classés ou des cibles d'onde, DÉTERMINISTES (graine reproductible), au format jsonl/csv compatible avec le studio d'entraînement. Le format s'ADAPTE au système neuronal de l'IA à entraîner : langage → cortex gen3, classification → tenseur MLP, onde → nœuds RPIA. QUAND L'UTILISER : « génère un dataset », « crée des données d'entraînement », préparation avant entrainement.modele.entrainer. Réponses calculées par code (arithmétique, conversions) — jamais inventées. Nécessite une clé de niveau standard (facturation).",
  category: "system",
  risk: "low",
  inputSchema: datasetCreerSchema,
  async execute(input, contexte): Promise<DatasetOutput> {
    const verdict = await verifierCleEntrainement({ userId: contexte.userId, cle: input.cle, niveauRequis: "standard" });
    if (!verdict.autorise) {
      return { autorise: false, raison: verdict.raison, remediation: verdict.remediation, details: "Dataset synthétique réservé au niveau standard minimum." };
    }
    const dataset = construireDataset({
      famille: input.famille,
      nombre: input.nombre,
      graine: input.graine,
      theme: input.theme,
      format: input.format,
    });
    const lignes = dataset.contenu.split("\n");
    const tronquer = lignes.length > 100;
    return {
      autorise: true,
      dataset: {
        nom: dataset.nom,
        famille: dataset.famille,
        format: dataset.format,
        elements: dataset.elements,
        doublonsIgnores: dataset.doublonsIgnores,
        apercu: dataset.apercu,
        contenu: tronquer ? lignes.slice(0, 100).join("\n") : dataset.contenu,
        contenuTronque: tronquer,
      },
      details: `Dataset « ${dataset.nom} » : ${dataset.elements} élément(s) ${dataset.format} (${dataset.doublonsIgnores} doublon(s) ignoré(s)) — graine ${input.graine ?? "défault"} pour reproduire à l'identique.`,
    };
  },
};

/* ── 3. Entraînement à la demande + test interne immédiat (+ sauvegarde) ── */

const entrainerSchema = z.object({
  cle: cleSchema,
  modele: modeleSchema,
  donnees: donneesSchema.optional(),
  synthetique: synthetiqueSchema.optional(),
  ratioTest: z.number().min(0.1).max(0.5).optional(),
  epoques: z.number().int().min(1).max(600).optional(),
  sauverSous: nomSauvegarde.optional(),
});

interface EntrainementOutput {
  autorise: boolean;
  raison?: string;
  remediation?: string;
  niveauRequis?: NiveauEntrainement;
  niveauUtilise?: NiveauEntrainement;
  famille?: string;
  modelId?: string;
  ressources?: { parametres: number; memoireMoEstimee: number; cpuMsEstimeParEpoch: number };
  banc?: {
    score: number;
    seuil: number;
    verdict: string;
    evaluationEchantillon?: string;
    trainCount: number;
    testCount: number;
    dureeMs: number;
    metriques: Array<{ nom: string; valeur: number }>;
  };
  entrainement?: { epoques: number; erreurInitiale: number; erreurFinale: number; convergence: boolean };
  export?: { format: string; octets: number; resume: string };
  details: string;
}

export const entrainementModeleEntrainerTool: ToolDefinition<z.infer<typeof entrainerSchema>, EntrainementOutput> = {
  id: "entrainement.modele.entrainer",
  name: "entrainement.modele.entrainer",
  description:
    "ENTRAÎNEMENT À LA DEMANDE — entraîner le modèle FOURNI selon SON système neuronal, puis le TESTER DIRECTEMENT EN INTERNE. gen3 s'adapte au mécanisme d'apprentissage de l'IA : cortex-langagier (paires Q/R, rappel résonant), tenseur-mlp (rétropropagation softmax réelle, poids et biais utilisateur acceptés), onde-rpia (interférence, miroir du shader WebGPU). Données fournies OU synthétiques auto-générées ; split train/test seedé ; rapport honnête (courbe d'erreur, exactitude mesurée, verdict contre seuil). Option `sauverSous` : le modèle CONFORME est enregistré au registre (rechargeable via entrainement.modele.registre, action « charger »). QUAND L'UTILISER : « entraîne ce modèle », « apprend ça à mon IA », après un dataset. Vérifie la clé d'entraînement (facturation) au niveau requis par les ressources estimées — refuse sans clé valable.",
  category: "system",
  risk: "medium",
  inputSchema: entrainerSchema,
  async execute(input, contexte): Promise<EntrainementOutput> {
    // Garde PRÉ-ENTRAÎNEMENT : le niveau requis est déduit des ressources du modèle.
    let donnees: DonneesEntrainement;
    try {
      donnees = assemblerDonnees(input);
    } catch (erreur) {
      return { autorise: true, details: (erreur as Error).message };
    }
    // Cast assumé : l'entrée vient de notre schéma zod (etatLangage en
    // Record permissif) — les données de restauration proviennent du registre.
    const modele = input.modele as ModeleFourni;
    const entreesEffectives = donnees.classification?.[0]?.entrees.length;
    const sortiesEffectives = new Set(donnees.classification?.map((e) => e.label) ?? []).size || undefined;
    const ressources = estimerRessourcesModele(modele, { entrees: entreesEffectives, sorties: sortiesEffectives });
    const verdict = await verifierCleEntrainement({
      userId: contexte.userId,
      cle: input.cle,
      niveauRequis: ressources.niveauRequis,
    });
    if (!verdict.autorise) {
      return { autorise: false, raison: verdict.raison, remediation: verdict.remediation, niveauRequis: ressources.niveauRequis, details: "Entraînement refusé AVANT toute exécution — exigence produit." };
    }
    const adaptateur = adapterPour(modele);
    const banc = await bancTestInterne({
      adaptateur,
      donnees,
      ratioTest: input.ratioTest,
      epoques: input.epoques,
      graine: input.modele.graine,
    });
    const exportation = adaptateur.exporter();
    let modelId: string | undefined;
    let noteSauvegarde = "";
    if (input.sauverSous) {
      if (banc.verdict !== "conforme") {
        noteSauvegarde = " Sauvegarde refusée : le banc de test interne est INSUFFISANT — un modèle non conforme n'entre pas au registre.";
      } else {
        try {
          const sauvegarde = await sauverModeleEntraîne({
            userId: contexte.userId,
            nom: input.sauverSous,
            famille: adaptateur.famille,
            contenu: exportation.contenu,
            format: exportation.format,
            banc: { score: banc.score, seuil: banc.seuil, verdict: banc.verdict, evaluationEchantillon: banc.evaluationEchantillon },
            niveauCle: verdict.niveau,
            description: banc.details,
          });
          modelId = sauvegarde.id;
          noteSauvegarde = ` Modèle sauvegardé au registre sous « ${input.sauverSous} » (${sauvegarde.id}) — rechargeable via entrainement.modele.registre.`;
        } catch (erreur) {
          noteSauvegarde = ` Sauvegarde refusée : ${(erreur as Error).message}`;
        }
      }
    }
    return {
      autorise: true,
      niveauRequis: ressources.niveauRequis,
      niveauUtilise: verdict.niveau,
      famille: adaptateur.famille,
      modelId,
      ressources: {
        parametres: adaptateur.ressources.parametres,
        memoireMoEstimee: adaptateur.ressources.memoireMoEstimee,
        cpuMsEstimeParEpoch: adaptateur.ressources.cpuMsEstimeParEpoch,
      },
      banc: {
        score: banc.score,
        seuil: banc.seuil,
        verdict: banc.verdict,
        evaluationEchantillon: banc.evaluationEchantillon,
        trainCount: banc.trainCount,
        testCount: banc.testCount,
        dureeMs: banc.dureeMs,
        metriques: banc.metriques,
      },
      entrainement: {
        epoques: banc.entrainement.epoques,
        erreurInitiale: banc.entrainement.erreurInitiale,
        erreurFinale: banc.entrainement.erreurFinale,
        convergence: banc.entrainement.convergence,
      },
      export: { format: exportation.format, octets: exportation.octets, resume: exportation.resume },
      details: `${banc.details} ${banc.entrainement.details}${noteSauvegarde}`,
    };
  },
};

/* ── 4. Banc de test interne pur (modèle fourni, sans entraînement) ──── */

const testerSchema = z.object({
  cle: cleSchema,
  modele: modeleSchema,
  donnees: donneesSchema,
  pasParCible: z.number().int().min(1).max(100).optional(),
});

interface TestOutput {
  autorise: boolean;
  raison?: string;
  remediation?: string;
  famille?: string;
  score?: number | null;
  seuil?: number;
  verdict?: string;
  metriques?: Array<{ nom: string; valeur: number }>;
  echantillons?: number;
  details: string;
}

export const entrainementModeleTesterTool: ToolDefinition<z.infer<typeof testerSchema>, TestOutput> = {
  id: "entrainement.modele.tester",
  name: "entrainement.modele.tester",
  description:
    "BANC DE TEST INTERNE — évaluer un modèle FOURNI (avec ses poids) sur des données SANS l'entraîner : exactitude mesurée (cortex/MLP) ou vitesse de convergence RPIA, verdict honnête contre le seuil de la famille. QUAND L'UTILISER : « teste ce modèle », « quelle est sa précision ? », contrôle avant réutilisation d'un modèle chargé du registre. Le test N'EST JAMAIS simulé : chaque métrique vient d'une exécution réelle. Nécessite une clé de niveau standard.",
  category: "system",
  risk: "low",
  inputSchema: testerSchema,
  async execute(input, contexte): Promise<TestOutput> {
    const verdictCle = await verifierCleEntrainement({ userId: contexte.userId, cle: input.cle, niveauRequis: "standard" });
    if (!verdictCle.autorise) {
      return { autorise: false, raison: verdictCle.raison, remediation: verdictCle.remediation, details: "Test interne réservé au niveau standard minimum." };
    }
    const adaptateur = adapterPour(input.modele as ModeleFourni);
    const donnees = assemblerDonnees({ donnees: input.donnees });
    const evaluation = await adaptateur.evaluer(donnees, { pasParCible: input.pasParCible });
    const seuil = SEUILS_BANC_TEST[adaptateur.famille] ?? 0.9;
    const score =
      adaptateur.famille === "onde-rpia"
        ? (evaluation.metriques.find((m) => m.nom === "cibles_convergees_rapide")?.valeur ?? 0)
        : evaluation.exactitude;
    const verdict =
      score === null
        ? "insuffisant"
        : score >= seuil
          ? "conforme"
          : "insuffisant";
    return {
      autorise: true,
      famille: adaptateur.famille,
      score: score === null ? null : Number(score.toFixed(4)),
      seuil,
      verdict,
      metriques: evaluation.metriques,
      echantillons: evaluation.echantillons,
      details: `${evaluation.details} Verdict contre seuil ${seuil} : ${verdict}.`,
    };
  },
};

/* ── 5. Registre des modèles entraînés (lister / charger / supprimer) ── */

const registreSchema = z.object({
  cle: cleSchema,
  action: z.enum(["lister", "charger", "supprimer"]),
  modelId: z.string().max(64).optional(),
});

interface RegistreOutput {
  autorise: boolean;
  raison?: string;
  remediation?: string;
  modeles?: Array<{ id: string; nom: string; famille: string; niveauCle: string; enregistreLe: string; bancVerdict?: string; octets: number }>;
  modele?: {
    id: string;
    nom: string;
    famille: string;
    niveauCle: string;
    banc: { score: number; verdict: string } | null;
    /** Descripteur PRÊT À PASSER à entrainement.modele.tester ou monde.ia.seance. */
    modeleFourni: Record<string, unknown>;
  };
  details: string;
}

export const entrainementModeleRegistreTool: ToolDefinition<z.infer<typeof registreSchema>, RegistreOutput> = {
  id: "entrainement.modele.registre",
  name: "entrainement.modele.registre",
  description:
    "REGISTRE DES MODÈLES ENTRAÎNÉS — lister, charger ou supprimer les modèles sauvegardés de l'utilisateur (sauvegarde : `sauverSous` sur entrainement.modele.entrainer ou monde.ia.seance). L'action « charger » renvoie un descripteur `modeleFourni` PRÊT À PASSER à entrainement.modele.tester ou monde.ia.seance : le modèle restauré revient EXACTEMENT à l'état où l'entraînement l'a laissé (poids, biais, labels, état du cortex, nœuds d'onde). QUAND L'UTILISER : « montre mes modèles entraînés », « recharge mon modèle X », « supprime le modèle X », poursuite d'apprentissage entre sessions. Propriété stricte : les modèles d'un autre compte ne sont ni visibles ni chargeables. Nécessite une clé de niveau standard.",
  category: "system",
  risk: "low",
  inputSchema: registreSchema,
  async execute(input, contexte): Promise<RegistreOutput> {
    const verdictCle = await verifierCleEntrainement({ userId: contexte.userId, cle: input.cle, niveauRequis: "standard" });
    if (!verdictCle.autorise) {
      return { autorise: false, raison: verdictCle.raison, remediation: verdictCle.remediation, details: "Registre réservé au niveau standard minimum." };
    }
    if (input.action === "lister") {
      const modeles = await listerModelesEntraînés(contexte.userId);
      return {
        autorise: true,
        modeles: modeles.map((m) => ({
          id: m.id,
          nom: m.nom,
          famille: m.famille,
          niveauCle: m.niveauCle,
          enregistreLe: m.enregistreLe,
          bancVerdict: m.banc?.verdict,
          octets: m.octets,
        })),
        details: `${modeles.length} modèle(s) au registre pour ce compte — sauvegarder avec l'option « sauverSous » sur entrainement.modele.entrainer ou monde.ia.seance.`,
      };
    }
    if (!input.modelId) {
      return { autorise: true, details: "modelId requis pour charger ou supprimer (action « lister » d'abord pour trouver l'identifiant)." };
    }
    if (input.action === "charger") {
      const doc = await chargerModeleEntraîne(contexte.userId, input.modelId);
      if (!doc) {
        return { autorise: true, details: `Aucun modèle « ${input.modelId} » pour ce compte (propriété stricte) — lister d'abord.` };
      }
      const modeleFourni = adapterDepuisModeleEntraîne(doc);
      return {
        autorise: true,
        modele: {
          id: doc.id,
          nom: doc.nom,
          famille: doc.famille,
          niveauCle: doc.niveauCle,
          banc: doc.banc ? { score: doc.banc.score, verdict: doc.banc.verdict } : null,
          modeleFourni: modeleFourni as unknown as Record<string, unknown>,
        },
        details: `Modèle « ${doc.nom} » chargé (${doc.famille}, banc ${doc.banc?.verdict ?? "n/a"}) — passer le descripteur modeleFourni tel quel à entrainement.modele.tester ou monde.ia.seance.`,
      };
    }
    // supprimer
    const supprime = await supprimerModeleEntraîne(contexte.userId, input.modelId);
    return {
      autorise: true,
      details: supprime
        ? `Modèle « ${input.modelId} » supprimé du registre.`
        : `Aucun modèle « ${input.modelId} » supprimé (inexistant ou propriété d'un autre compte).`,
    };
  },
};

/* ── 6. Monde virtuel : séance d'exécution + apprentissage (+ sauvegarde) ── */

const mondeSeanceSchema = z.object({
  cle: cleSchema,
  graine: z.number().int().optional(),
  taille: z.number().int().min(6).max(TAILLE_MAX_MONDE).optional(),
  episodes: z.number().int().min(6).max(600).optional(),
  epoquesImitation: z.number().int().min(1).max(200).optional(),
  modeleFourni: modeleSchema.optional(),
  sauverSous: nomSauvegarde.optional(),
});

interface MondeOutput {
  autorise: boolean;
  raison?: string;
  remediation?: string;
  niveauRequis?: NiveauEntrainement;
  niveauUtilise?: NiveauEntrainement;
  modelId?: string;
  rapport?: {
    leconsGen3: number;
    episodes: number;
    recompenseAvant: number;
    recompenseApres: number;
    progression: number;
    tauxReussiteAvant: number;
    tauxReussiteApres: number;
    fragmentsMoyensApres: number;
    pasMoyensApres: number;
    verdict: string;
  };
  ressources?: { memoireMoEstimee: number; cpuMsEstime: number; parametresPolitique: number };
  details: string;
}

export const mondeIaSeanceTool: ToolDefinition<z.infer<typeof mondeSeanceSchema>, MondeOutput> = {
  id: "monde.ia.seance",
  name: "monde.ia.seance",
  description:
    "MONDE VIRTUEL POUR IA — séance épisodique où l'IA S'EXÉCUTE et APPREND ce que gen3 lui enseigne : monde déterministe (grille seedée, murs, fragments gen3, coût de pas), leçons expertes BFS (le curriculum gen3), imitation supervisée puis renforcement léger sur les trajectoires productives. Rapport de progression MESURÉ (récompense, réussite, fragments/épisode avant/après). `modeleFourni` : reprendre une politique sauvegardée (descripteur de entrainement.modele.registre action « charger ») ; `sauverSous` : enregistrer la politique entraînée pour la séance suivante — l'IA GARDE ce que gen3 lui a appris. Ressources plafonnées par le niveau de clé (facturation). QUAND L'UTILISER : « fais apprendre l'IA dans le monde », « simulation d'apprentissage virtuel », « l'IA doit s'entraîner par l'expérience », « continuer l'apprentissage de mon modèle ».",
  category: "system",
  risk: "medium",
  inputSchema: mondeSeanceSchema,
  async execute(input, contexte): Promise<MondeOutput> {
    const episodes = input.episodes ?? 40;
    const niveauRequis = niveauRequisPourSeance(episodes);
    const verdictCle = await verifierCleEntrainement({ userId: contexte.userId, cle: input.cle, niveauRequis });
    if (!verdictCle.autorise) {
      return { autorise: false, raison: verdictCle.raison, remediation: verdictCle.remediation, niveauRequis, details: "Séance monde virtuel refusée AVANT exécution — exigence produit." };
    }
    const capacite = verifierCapaciteMonde(verdictCle.niveau, { episodes, taille: input.taille ?? 12 });
    if (!capacite.autorise) {
      return { autorise: false, raison: capacite.raison, remediation: "Réduire la séance ou monter de niveau via la facturation.", niveauRequis, details: "Garde de capacité matérielle du monde virtuel." };
    }
    const seance = await seanceApprentissageMonde({
      graine: input.graine,
      taille: input.taille,
      episodes,
      epoquesImitation: input.epoquesImitation,
      niveau: verdictCle.niveau,
      modeleFourni: input.modeleFourni?.famille === "tenseur-mlp" ? (input.modeleFourni as ModeleFourni) : undefined,
    });
    let modelId: string | undefined;
    let noteSauvegarde = "";
    if (input.sauverSous) {
      try {
        const exportation = seance.adaptateur.exporter();
        const sauvegarde = await sauverModeleEntraîne({
          userId: contexte.userId,
          nom: input.sauverSous,
          famille: seance.adaptateur.famille,
          contenu: exportation.contenu,
          format: exportation.format,
          banc: null,
          niveauCle: verdictCle.niveau,
          description: `Politique du monde virtuel : ${seance.rapport.details}`,
        });
        modelId = sauvegarde.id;
        noteSauvegarde = ` Politique sauvegardée sous « ${input.sauverSous} » (${sauvegarde.id}) — reprise via entrainement.modele.registre action « charger » puis monde.ia.seance modeleFourni.`;
      } catch (erreur) {
        noteSauvegarde = ` Sauvegarde refusée : ${(erreur as Error).message}`;
      }
    }
    return {
      autorise: true,
      niveauRequis,
      niveauUtilise: verdictCle.niveau,
      modelId,
      rapport: {
        leconsGen3: seance.rapport.leconsGen3,
        episodes: seance.rapport.episodes,
        recompenseAvant: seance.rapport.recompenseAvant,
        recompenseApres: seance.rapport.recompenseApres,
        progression: seance.rapport.progression,
        tauxReussiteAvant: seance.rapport.tauxReussiteAvant,
        tauxReussiteApres: seance.rapport.tauxReussiteApres,
        fragmentsMoyensApres: seance.rapport.fragmentsMoyensApres,
        pasMoyensApres: seance.rapport.pasMoyensApres,
        verdict: seance.rapport.verdict,
      },
      ressources: ressourcesSeanceMonde({ taille: input.taille ?? 12, episodes, pasMax: 160 }),
      details: `${seance.rapport.details}${noteSauvegarde}`,
    };
  },
};

export const outilsEntrainement = [
  entrainementCleStatutTool,
  entrainementDatasetCreerTool,
  entrainementModeleEntrainerTool,
  entrainementModeleTesterTool,
  entrainementModeleRegistreTool,
  mondeIaSeanceTool,
] as const;

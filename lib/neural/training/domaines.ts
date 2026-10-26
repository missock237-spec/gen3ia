import "server-only";

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  POOL_DOM_GENERATION_IMAGES,
  POOL_DOM_VIDEO,
  POOL_DOM_SON,
  POOL_DOM_CLIPS_MUSICAUX,
  POOL_DOM_DEVELOPPEMENT_WEB,
  POOL_DOM_TEST,
  POOL_DOM_REDACTION_DOCUMENTS,
  POOL_DOM_SCIENCES_HUMAINES,
  POOL_DOM_RECHERCHE_SCIENTIFIQUE,
  POOL_DOM_CYBERSECURITE,
  POOL_DOM_RECHERCHE_WEB,
  POOL_DOM_MULTIMODAL,
  POOL_DOM_HACKER,
  POOL_DOM_CONSTRUCTION_MACHINES,
  POOL_DOM_VENTE,
  POOL_DOM_SANTE_MEDICAL,
  POOL_DOM_ANALYSE_DONNEES,
  POOL_DOM_CONSEILLER_COMMERCIAL,
} from "../core/types";
import { tokenize } from "../encoding/text-encoder";
import type { TrainingSample } from "./dataset";
import type { PaireLangage } from "../generation/corpus";

/**
 * LES 18 DOMAINES DE GEN3 — couche d'expertise du réseau neuronal.
 *
 * Sources des données : training/gen3-domain-datasets/ (générateur Python
 * reproductible) — 18 datasets JSONL bilingues FR/EN de 100 000 lignes
 * chacun (1,8 M lignes, hors git), avec 120 échantillons/domaine COMMIS
 * dans le dépôt (data/echantillons/) pour l'entraînement in-app.
 *
 * Rôle dans le système nerveux :
 *  - DOMAIN_POOLS : label → pool de 2 neurones (100..135) — la SNN apprend
 *    à reconnaître le domaine d'un prompt (trainer.trainDomaines) ;
 *  - chargerEchantillonsDomaines : lit les JSONL commis → TrainingSample
 *    { text, label: "DOM_*" } pour l'entraînement supervisé ;
 *  - construirePairesDomaines : extrait des paires conversationnelles
 *    canoniques (instruction → réponse) pour le cortex langagier ;
 *  - predireDomaine : argmax sur les pools de domaine (indépendant des
 *    pools d'action).
 */

/** Définition d'un domaine expert de gen3. */
export interface DomaineGen3 {
  /** Identifiant canonique (= id du dataset JSONL). */
  id: string;
  /** Nom français. */
  nomFr: string;
  /** Nom anglais. */
  nomEn: string;
  /** Pool de neurones de sortie (2 neurones, 100..135). */
  pool: readonly number[];
  /** Mots-clés FR+EN normalisés (sans diacritiques) — métrique de couverture. */
  motsCles: string[];
  /** Types de tâches couverts par le dataset du domaine. */
  taches: string[];
}

/** Labels de domaine (préfixe DOM_ pour ne jamais collide avec les actions). */
export const DOM_GENERATION_IMAGES = "DOM_GENERATION_IMAGES";
export const DOM_VIDEO = "DOM_VIDEO";
export const DOM_SON = "DOM_SON";
export const DOM_CLIPS_MUSICAUX = "DOM_CLIPS_MUSICAUX";
export const DOM_DEVELOPPEMENT_WEB = "DOM_DEVELOPPEMENT_WEB";
export const DOM_TEST = "DOM_TEST";
export const DOM_REDACTION_DOCUMENTS = "DOM_REDACTION_DOCUMENTS";
export const DOM_SCIENCES_HUMAINES = "DOM_SCIENCES_HUMAINES";
export const DOM_RECHERCHE_SCIENTIFIQUE = "DOM_RECHERCHE_SCIENTIFIQUE";
export const DOM_CYBERSECURITE = "DOM_CYBERSECURITE";
export const DOM_RECHERCHE_WEB = "DOM_RECHERCHE_WEB";
export const DOM_MULTIMODAL = "DOM_MULTIMODAL";
export const DOM_HACKER = "DOM_HACKER";
export const DOM_CONSTRUCTION_MACHINES = "DOM_CONSTRUCTION_MACHINES";
export const DOM_VENTE = "DOM_VENTE";
export const DOM_SANTE_MEDICAL = "DOM_SANTE_MEDICAL";
export const DOM_ANALYSE_DONNEES = "DOM_ANALYSE_DONNEES";
export const DOM_CONSEILLER_COMMERCIAL = "DOM_CONSEILLER_COMMERCIAL";

/** Les 18 domaines, dans l'ordre des thèmes demandés. */
export const DOMAINES_GEN3: readonly DomaineGen3[] = [
  {
    id: "generation_images",
    nomFr: "génération d'images",
    nomEn: "image generation",
    pool: POOL_DOM_GENERATION_IMAGES,
    motsCles: ["image", "visuel", "prompt", "style", "photo", "illustration"],
    taches: ["text_to_prompt", "style_guide", "critique_image", "variations_prompt"],
  },
  {
    id: "video",
    nomFr: "vidéo",
    nomEn: "video",
    pool: POOL_DOM_VIDEO,
    motsCles: ["video", "clip", "film", "storyboard", "montage", "rendu"],
    taches: ["storyboard", "scenario_video", "parametres_rendu", "feuille_montage"],
  },
  {
    id: "son",
    nomFr: "son",
    nomEn: "sound",
    pool: POOL_DOM_SON,
    motsCles: ["son", "audio", "voix", "ambiance", "sonore", "sound"],
    taches: ["synthese_sonore", "voix_off", "chaine_audio"],
  },
  {
    id: "clips_musicaux",
    nomFr: "clips musicaux",
    nomEn: "music clips",
    pool: POOL_DOM_CLIPS_MUSICAUX,
    motsCles: ["musique", "clip", "refrain", "bpm", "genre", "music", "musical", "musicale", "compose"],
    taches: ["concept_clip", "structure_musicale", "ecriture_paroles"],
  },
  {
    id: "developpement_web",
    nomFr: "développement web",
    nomEn: "web development",
    pool: POOL_DOM_DEVELOPPEMENT_WEB,
    motsCles: ["web", "html", "css", "javascript", "react", "api", "site"],
    taches: ["implementation_web", "debug_web", "conception_api"],
  },
  {
    id: "test",
    nomFr: "test",
    nomEn: "testing",
    pool: POOL_DOM_TEST,
    motsCles: ["test", "tests", "qualite", "couverture", "ci", "qa"],
    taches: ["plan_test", "cas_limite", "ci_tests"],
  },
  {
    id: "redaction_documents",
    nomFr: "rédaction de documents",
    nomEn: "document writing",
    pool: POOL_DOM_REDACTION_DOCUMENTS,
    motsCles: ["document", "rapport", "rediger", "courrier", "manuel"],
    taches: ["plan_document", "relecture"],
  },
  {
    id: "sciences_humaines",
    nomFr: "sciences humaines",
    nomEn: "humanities",
    pool: POOL_DOM_SCIENCES_HUMAINES,
    motsCles: ["histoire", "sociologie", "philosophie", "culture", "societe", "sociolinguistique", "linguistique", "psychologie", "anthropologie"],
    taches: ["analyse_sh", "pedagogie_sh"],
  },
  {
    id: "recherche_scientifique",
    nomFr: "recherche scientifique",
    nomEn: "scientific research",
    pool: POOL_DOM_RECHERCHE_SCIENTIFIQUE,
    motsCles: ["science", "recherche", "protocole", "hypothese", "experience"],
    taches: ["protocole_recherche", "vulgarisation"],
  },
  {
    id: "cybersecurite",
    nomFr: "cybersécurité",
    nomEn: "cybersecurity",
    pool: POOL_DOM_CYBERSECURITE,
    motsCles: ["securite", "cyber", "incident", "vulnerabilite", "patch", "securiser", "chiffrement", "pare-feu", "brute"],
    taches: ["reponse_incident", "hygiene_numerique"],
  },
  {
    id: "recherche_web",
    nomFr: "recherche web",
    nomEn: "web search",
    pool: POOL_DOM_RECHERCHE_WEB,
    motsCles: ["recherche", "web", "source", "verifier", "internet"],
    taches: ["strategie_recherche", "verification_information"],
  },
  {
    id: "multimodal",
    nomFr: "multimodal",
    nomEn: "multimodal",
    pool: POOL_DOM_MULTIMODAL,
    motsCles: ["multimodal", "ocr", "alignement", "modalite", "pipeline", "multimodale", "multimodaux", "combiner", "combine"],
    taches: ["alignement_multimodal", "pipeline_multimodal"],
  },
  {
    id: "hacker",
    nomFr: "hacker (éthique / CTF)",
    nomEn: "hacker (ethical / CTF)",
    pool: POOL_DOM_HACKER,
    motsCles: ["ctf", "hacker", "flag", "challenge", "pentest"],
    taches: ["ctf_educatif", "analyse_defensive"],
  },
  {
    id: "construction_machines",
    nomFr: "construction des machines",
    nomEn: "machine building",
    pool: POOL_DOM_CONSTRUCTION_MACHINES,
    motsCles: ["machine", "robot", "moteur", "capteur", "arduino", "pid"],
    taches: ["conception_machine", "depannage_machine", "programmation_controle"],
  },
  {
    id: "vente",
    nomFr: "vente",
    nomEn: "sales",
    pool: POOL_DOM_VENTE,
    motsCles: ["vente", "client", "objection", "pitch", "prospect"],
    taches: ["traitement_objection", "pitch_vente"],
  },
  {
    id: "sante_medical",
    nomFr: "santé / médical",
    nomEn: "health / medical",
    pool: POOL_DOM_SANTE_MEDICAL,
    motsCles: ["sante", "medical", "symptome", "traitement", "consultation"],
    taches: ["information_sante", "preparation_consultation"],
  },
  {
    id: "analyse_donnees",
    nomFr: "analyse de données",
    nomEn: "data analysis",
    pool: POOL_DOM_ANALYSE_DONNEES,
    motsCles: ["donnees", "analyse", "graphique", "statistique", "csv"],
    taches: ["nettoyage_donnees", "plan_analyse", "visualisation_donnees"],
  },
  {
    id: "conseiller_commercial",
    nomFr: "conseiller commercial",
    nomEn: "commercial advisor",
    pool: POOL_DOM_CONSEILLER_COMMERCIAL,
    motsCles: ["conseil", "commercial", "recommandation", "suivi", "client"],
    taches: ["recommandation_conseil", "suivi_client"],
  },
];

/** Map label → pool (ordre d'argmax déterministe = ordre du tableau). */
export const DOMAIN_POOLS: Record<string, readonly number[]> =
  Object.fromEntries(DOMAINES_GEN3.map((d) => [`DOM_${d.id.toUpperCase()}`, d.pool]));

/** Map id de dataset → label SNN. */
export const LABEL_PAR_ID: Record<string, string> = Object.fromEntries(
  DOMAINES_GEN3.map((d) => [d.id, `DOM_${d.id.toUpperCase()}`]),
);

/** Map label SNN → domaine. */
export const DOMAINE_PAR_LABEL: Record<string, DomaineGen3> = Object.fromEntries(
  DOMAINES_GEN3.map((d) => [`DOM_${d.id.toUpperCase()}`, d]),
);

/** Directory des échantillons commis (dépôt) — relatif au cwd du process. */
export const DIR_ECHANTILLONS = path.join(
  process.cwd(),
  "training/gen3-domain-datasets/data/echantillons",
);

/** Directory des datasets complets (hors git, présent si généré). */
export const DIR_COMPLET = path.join(
  process.cwd(),
  "training/gen3-domain-datasets/data/complet",
);

/** Échantillon JSONL du dépôt (schéma du générateur Python). */
export interface EchantillonDomaine {
  id: string;
  domain: string;
  language: "fr" | "en";
  task_type: string;
  instruction: string;
  input: string;
  output: string;
  metadata: {
    created_at: string;
    temporal_bucket: string;
    difficulty: string;
    quality_score: number;
    source_style: string;
    bilingual_pair_id: string;
    dedup_hash: string;
    safety_label: string;
    license: string;
  };
  domain_fields?: Record<string, unknown>;
}

/**
 * Lit le fichier JSONL d'un domaine. `complet` = true tente le dataset
 * complet (100 000 lignes, hors git) et retombe sur l'échantillon commis.
 */
export async function lireDatasetDomaine(
  domaineId: string,
  opts: { complet?: boolean } = {},
): Promise<EchantillonDomaine[]> {
  const cible = opts.complet
    ? path.join(DIR_COMPLET, `${domaineId}.jsonl`)
    : path.join(DIR_ECHANTILLONS, `${domaineId}.jsonl`);
  let brut: string | null = null;
  try {
    brut = await readFile(cible, "utf8");
  } catch {
    if (opts.complet) {
      // Retombe sur l'échantillon commis si le complet est absent.
      return lireDatasetDomaine(domaineId, { complet: false });
    }
    return [];
  }
  const lignes: EchantillonDomaine[] = [];
  for (const ligne of brut.split("\n")) {
    const texte = ligne.trim();
    if (!texte) continue;
    try {
      const objet = JSON.parse(texte) as EchantillonDomaine;
      if (objet && typeof objet.instruction === "string" && typeof objet.output === "string") {
        lignes.push(objet);
      }
    } catch {
      // Ligne corrompue : ignorée honnêtement (le reste reste exploitable).
    }
  }
  return lignes;
}

/**
 * TEXTE D'ENTRAÎNEMENT D'UN ÉCHANTILLON — les TOKENS SIGNATURES présents
 * dans l'instruction (voir construireSignaturesDomaines).
 *
 * Pourquoi : l'encodage SNN hache les tokens sur 38 neurones (cap
 * d'intensité) — une instruction longue sature TOUTE la zone d'entrée et
 * tous les domaines produisent le même vecteur (accuracy au hasard). Les
 * tokens SIGNATURES (présents dans ≤ 2 domaines sur les 18) forment des
 * entrées sparses et discriminantes — c'est le même mécanisme que les
 * intentions d'action, qui apprennent leurs mots-clés (« image », « audio »…).
 */
export function texteEntrainement(
  instruction: string,
  signatures: ReadonlySet<string>,
  maxTokens = 6,
): string {
  const vus = new Set<string>();
  for (const token of tokenize(instruction)) {
    if (signatures.has(token) && !vus.has(token)) {
      vus.add(token);
      if (vus.size >= maxTokens) break;
    }
  }
  return [...vus].join(" ");
}

/**
 * SIGNATURES DE DOMAINES — vocabulaire discriminant par domaine (ANCRES).
 *
 * Méthode (documentée, reproductible) :
 *  1. tokeniser les instructions de chaque domaine (échantillon plafonné) ;
 *  2. calculer la fréquence documentaire inter-domaines de chaque token
 *     (dans combien de domaines apparaît-il ?) — signature = présent dans
 *     ≤ 2 domaines ;
 *  3. CAP CRUCIAL : ne retenir que les ~24 ancres les plus FRÉQUENTES du
 *     domaine (mots-clés inclus d'office). Sans ce cap, les milliers de
 *     tokens signatures rares hachés dans la zone d'entrée de 38 neurones
 *     saturent le hachage (~70 tokens/neurone) : chaque neurone finit
 *     connecté aux 18 pools et la classification s'effondre au hasard.
 *     Avec ~24 ancres/domaine (~430 tokens au total, ~11/neurone), les
 *     collisions restent réparables par la punition compétitive — le régime
 *     où le trainer d'actions apprend bien.
 *
 * C'est le miroir des INTENT_KEYWORDS du dataset d'actions, calculé depuis
 * les données réelles des 18 datasets au lieu d'être écrit à la main.
 */
export interface SignaturesDomaines {
  /** label DOM_* → tokens ancres (mots-clés d'abord, puis fréquence décroissante). */
  parLabel: Record<string, string[]>;
  /** Nombre d'ancres par domaine (télémétrie honnête). */
  parDomaine: Record<string, number>;
}

export async function construireSignaturesDomaines(
  opts: { maxParDomaine?: number; complet?: boolean; capAncres?: number } = {},
): Promise<SignaturesDomaines> {
  const cap = Math.max(100, Math.min(20_000, opts.maxParDomaine ?? 4000));
  const capAncres = Math.max(8, Math.min(64, opts.capAncres ?? 24));
  const tokensParDomaine: Record<string, Map<string, number>> = {};
  const frequence: Record<string, number> = {};

  for (const domaine of DOMAINES_GEN3) {
    const echantillons = await lireDatasetDomaine(domaine.id, {
      complet: opts.complet ?? true,
    });
    const tokens = new Map<string, number>();
    for (const echantillon of echantillons.slice(0, cap)) {
      for (const token of tokenize(echantillon.instruction)) {
        if (token.length < 3) continue;
        tokens.set(token, (tokens.get(token) ?? 0) + 1);
      }
    }
    tokensParDomaine[domaine.id] = tokens;
  }
  for (const tokens of Object.values(tokensParDomaine)) {
    for (const token of tokens.keys()) {
      frequence[token] = (frequence[token] ?? 0) + 1;
    }
  }

  const parLabel: Record<string, string[]> = {};
  const parDomaine: Record<string, number> = {};
  for (const domaine of DOMAINES_GEN3) {
    const frequentes = [...tokensParDomaine[domaine.id].entries()]
      .filter(([token, occurrences]) => frequence[token] <= 2 && occurrences >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([token]) => token)
      .slice(0, capAncres);
    // Mots-clés d'office (vocabulaire noyau du domaine) en tête, sans doublon.
    const ancres = [...new Set([...domaine.motsCles, ...frequentes])].slice(0, capAncres);
    parLabel[`DOM_${domaine.id.toUpperCase()}`] = ancres;
    parDomaine[domaine.id] = ancres.length;
  }
  return { parLabel, parDomaine };
}

/** Options de chargement des échantillons d'entraînement. */
export interface OptionsChargement {
  /** Nombre maximal d'échantillons par domaine (défaut 120). */
  maxParDomaine?: number;
  /** Utiliser le dataset complet si présent (défaut false : échantillons commis). */
  complet?: boolean;
  /** Domaines spécifiques (ids) — défaut : les 18. */
  domaines?: string[];
}

/** Résultat de chargement : échantillons + statistiques honnêtes. */
export interface ChargementDomaines {
  samples: TrainingSample[];
  parDomaine: Record<string, number>;
  parLangue: Record<string, number>;
  fichiersAbsents: string[];
}

/**
 * Charge les échantillons d'entraînement des 18 domaines depuis les JSONL
 * du dépôt (échantillons commis ou datasets complets si disponibles).
 *
 * Le texte d'entraînement de chaque échantillon = ses TOKENS SIGNATURES
 * (construireSignaturesDomaines) présents dans l'instruction — entrées
 * sparses discriminantes. Les échantillons sans aucun token signature sont
 * sautés (honnêteté : rien à apprendre d'un texte sans vocabulaire propre).
 */
export async function chargerEchantillonsDomaines(
  opts: OptionsChargement = {},
): Promise<ChargementDomaines> {
  const maxParDomaine = Math.max(10, Math.min(2000, opts.maxParDomaine ?? 120));
  const cibles = opts.domaines?.length
    ? DOMAINES_GEN3.filter((d) => opts.domaines!.includes(d.id))
    : DOMAINES_GEN3;

  const signatures = await construireSignaturesDomaines({
    complet: opts.complet,
  });

  const samples: TrainingSample[] = [];
  const parDomaine: Record<string, number> = {};
  const parLangue: Record<string, number> = {};
  const fichiersAbsents: string[] = [];

  for (const domaine of cibles) {
    const echantillons = await lireDatasetDomaine(domaine.id, {
      complet: opts.complet,
    });
    if (echantillons.length === 0) {
      fichiersAbsents.push(domaine.id);
      continue;
    }
    const label = `DOM_${domaine.id.toUpperCase()}`;
    const signaturesDomaine = new Set(signatures.parLabel[label] ?? []);
    // AMORÇAGE LEXICAL : les mots-clés du domaine (FR + EN) sont eux-mêmes
    // des échantillons (comme les phrases d'amorçage SEED_EXAMPLES des
    // actions) — garantie que chaque pool a au moins son vocabulaire noyau.
    for (const motCle of domaine.motsCles) {
      samples.push({ text: motCle, label });
      parDomaine[domaine.id] = (parDomaine[domaine.id] ?? 0) + 1;
    }
    let pris = 0;
    for (const echantillon of echantillons) {
      if (pris >= maxParDomaine) break;
      const texte = texteEntrainement(
        echantillon.instruction,
        signaturesDomaine,
      );
      if (texte.length < 3) continue;
      samples.push({ text: texte, label });
      pris += 1;
      parDomaine[domaine.id] = (parDomaine[domaine.id] ?? 0) + 1;
      parLangue[echantillon.language] = (parLangue[echantillon.language] ?? 0) + 1;
    }
  }

  return { samples, parDomaine, parLangue, fichiersAbsents };
}

/** Nombre maximal de paires langagières de domaine apprises par le cortex. */
export const MAX_PAIRES_CORTEX_DOMAINES = 220;

/**
 * Construit les paires conversationnelles du cortex langagier à partir des
 * datasets : pour chaque domaine, UNE paire canonique FR et UNE paire EN
 * (l'instruction sert de motif, la réponse d'énoncé — données réelles du
 * générateur, plafonnées à MAX_PAIRES_CORTEX_DOMAINES).
 */
export async function construirePairesDomaines(): Promise<PaireLangage[]> {
  const paires: PaireLangage[] = [];
  for (const domaine of DOMAINES_GEN3) {
    if (paires.length >= MAX_PAIRES_CORTEX_DOMAINES) break;
    const echantillons = await lireDatasetDomaine(domaine.id, {
      complet: false,
    });
    for (const langue of ["fr", "en"] as const) {
      if (paires.length >= MAX_PAIRES_CORTEX_DOMAINES) break;
      const exemplaire = echantillons.find((e) => e.language === langue);
      if (!exemplaire) continue;
      // Motif court : la première phrase de l'instruction (le cortex matche
      // par tokens — une phrase entière serait trop spécifique).
      const motif = exemplaire.instruction.split(/[.!?]/)[0].trim();
      if (motif.length < 12) continue;
      paires.push({
        motif,
        reponse: exemplaire.output,
        theme: `domaine:${domaine.id}`,
      });
    }
  }
  return paires;
}

/**
 * Prédiction de domaine à partir des résonances : argmax STRICT sur les
 * pools de domaine uniquement (pools d'action exclus — lecture bivouac).
 * Retourne null si aucune résonance de domaine (aucun domaine reconnu).
 */
export function predireDomaine(
  resonances: Record<string, number>,
): { label: string; score: number } | null {
  let meilleur: string | null = null;
  let meilleurScore = 0;
  for (const label of Object.keys(DOMAIN_POOLS)) {
    const score = resonances[label] ?? 0;
    if (score > meilleurScore) {
      meilleur = label;
      meilleurScore = score;
    }
  }
  return meilleur && meilleurScore > 0 ? { label: meilleur, score: meilleurScore } : null;
}

/**
 * DÉTECTION LEXICALE DE DOMAINE (primaire) — miroir exact de labelText
 * (dataset.ts) pour la couche d'actions : les mots-clés FR+EN de chaque
 * domaine sont le signal de routage fiable, déterministe et testable.
 *
 * Pourquoi lexicale en primaire : la zone d'entrée SNN (38 neurones de
 * hachage) ne peut pas séparer 18 classes aux vocabulaires qui se
 * recouvrent — les ancres de domaines distincts se partagent des neurones
 * et toutes les résonances convergeaient (mesuré : accuracy au hasard).
 * Le pattern du dépôt pour les ACTIONS est identique : étiquetage lexical
 * primaire (INTENT_KEYWORDS) + apprentissage SNN en plasticité (le
 * substrat vivant continue d'apprendre, accuracy rapportée honnêtement).
 *
 * Score : 2 points par mot-clé du domaine reconnu (mots-clés noyau), 1
 * point par ancre étendue (vocabulaire métier statique). null si aucun
 * match (honnêteté : pas de domaine inventé).
 */
export interface DetectionDomaine {
  label: string;
  id: string;
  nomFr: string;
  nomEn: string;
  /** Score lexicale brut (2/mot-clé noyau + 1/mot-clé étendu). */
  score: number;
  /** Tokens reconnus (traçabilité). */
  matched: string[];
}

/** Ancres étendues statiques (complément des motsCles — sans I/O). */
const ANCRES_ETENDUES: Record<string, string[]> = {
  generation_images: ["rendu", "photorealiste", "photorealistic", "watercolor", "aquarelle", "variation"],
  video: ["scenario", "script", "plan", "shot", "fps", "codec", "montage", "editing"],
  son: ["podcast", "mixage", "lufs", "synthese", "synthesis", "voiceover", "voice"],
  clips_musicaux: ["chorus", "paroles", "lyrics", "beat", "afrobeat", "amapiano", "album"],
  developpement_web: ["frontend", "backend", "route", "component", "composant", "deploy", "bug", "endpoint"],
  test: ["unitaire", "unit", "integration", "e2e", "mock", "coverage", "regression", "flaky"],
  redaction_documents: ["redaction", "writing", "outline", "plan", "relire", "proofread", "resume", "summary"],
  sciences_humaines: ["archive", "societe", "epoque", "philosophique", "geographie", "anthropologie"],
  recherche_scientifique: ["experiment", "falsifiable", "randomisation", "effect", "reproducibilite", "peer"],
  cybersecurite: ["defensive", "defense", "phishing", "ransomware", "firewall", "parefeu", "sbom", "audit", "contain", "contenir"],
  recherche_web: ["google", "moteur", "search", "url", "archive", "factcheck", "verifier", "source"],
  multimodal: ["crossmodal", "ocr", "transcript", "receipt", "recu", "invoice", "facture", "modalite"],
  hacker: ["writeup", "payload", "bénin", "benign", "vm", "challenge", "flag", "reversing"],
  construction_machines: ["actionneur", "actuator", "watchdog", "asservissement", "firmware", "microcontroller"],
  vente: ["closing", "devis", "quote", "upsell", "crm", "offre", "proposal", "pipeline"],
  sante_medical: ["hydratation", "hydration", "paludisme", "malaria", "ordonnance", "prescription", "patient"],
  analyse_donnees: ["pandas", "sql", "dataset", "median", "mediane", "histogramme", "correlation", "nettoyage"],
  conseiller_commercial: ["recommendation", "recommander", "prioriser", "roadmap", "suivi", "followup"],
};

export function predireDomaineLexical(texte: string): DetectionDomaine | null {
  const tokens = new Set(tokenize(texte));
  if (tokens.size === 0) return null;

  let meilleur: DetectionDomaine | null = null;
  for (const domaine of DOMAINES_GEN3) {
    const label = `DOM_${domaine.id.toUpperCase()}`;
    let score = 0;
    const matched: string[] = [];
    for (const motCle of domaine.motsCles) {
      if (tokens.has(motCle)) {
        score += 2;
        matched.push(motCle);
      }
    }
    for (const ancre of ANCRES_ETENDUES[domaine.id] ?? []) {
      if (tokens.has(ancre)) {
        score += 1;
        matched.push(ancre);
      }
    }
    if (score <= 0) continue;
    if (!meilleur || score > meilleur.score) {
      meilleur = { label, id: domaine.id, nomFr: domaine.nomFr, nomEn: domaine.nomEn, score, matched };
    }
  }
  return meilleur;
}

/** Statistiques des fichiers de datasets (pour l'API + le Studio). */
export interface StatsDatasets {
  id: string;
  nomFr: string;
  nomEn: string;
  /** Lignes disponibles dans le fichier lu (échantillon ou complet). */
  lignesDisponibles: number;
  /** Lignes du dataset complet si présent sur disque (sinon null). */
  lignesComplet: number | null;
  echantillonsCommis: boolean;
  taches: string[];
}

/** Inventaire honnête des datasets présents sur disque. */
export async function statsDatasets(): Promise<StatsDatasets[]> {
  let commis: Set<string> = new Set();
  let complet: Set<string> = new Set();
  try {
    commis = new Set(
      (await readdir(DIR_ECHANTILLONS))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(/\.jsonl$/, "")),
    );
  } catch {
    // Directory absent : aucun échantillon commis.
  }
  try {
    complet = new Set(
      (await readdir(DIR_COMPLET))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(/\.jsonl$/, "")),
    );
  } catch {
    // Datasets complets non générés sur cette machine (normal en prod).
  }

  const stats: StatsDatasets[] = [];
  for (const domaine of DOMAINES_GEN3) {
    const aCommis = commis.has(domaine.id);
    const aComplet = complet.has(domaine.id);
    let lignesDisponibles = 0;
    let lignesComplet: number | null = null;
    if (aCommis) {
      lignesDisponibles = (await lireDatasetDomaine(domaine.id)).length;
    }
    if (aComplet) {
      const tout = await lireDatasetDomaine(domaine.id, { complet: true });
      lignesComplet = tout.length;
      lignesDisponibles = Math.max(lignesDisponibles, 0);
    }
    stats.push({
      id: domaine.id,
      nomFr: domaine.nomFr,
      nomEn: domaine.nomEn,
      lignesDisponibles,
      lignesComplet,
      echantillonsCommis: aCommis,
      taches: domaine.taches,
    });
  }
  return stats;
}

import "server-only";

import { randomUUID } from "node:crypto";

import type {
  AIRequest,
  AIResponse,
  AIUsage,
} from "@/lib/ai/models";

import type { CycleReport, MetabolismeEffecteurs } from "./core/types";
import type { NoyauCentralGen3 } from "./core/central-core";
import type { EspaceFiltreResonant } from "./core/resonant-space";
import { encodeText } from "./encoding/text-encoder";
// ABRÉVIATIONS FR/EN : tout prompt entrant est enrichi de la forme longue de
// chaque abréviation connue AVANT l'encodage neuronal (compréhension
// structurelle — le dataset datasets/abbreviations est la source de vérité).
import { promptAvecAbréviations } from "./abbreviations";
import { decodeResponse, poidsResonanceParCycle } from "./decoding/response-decoder";
import type { NeuralDecodedResponse } from "./decoding/response-decoder";
import type { CortexLangagierGen3, ContexteLangage } from "./generation/language";
import { creerCacheReponses } from "./generation/cache-reponses";
import { reponseInstantiee } from "../gen3/reponses-instantiees";
import { HippocampusMemory } from "./memory/hippocampus";
import { MoteurEvolutionGen3 } from "./evolution";
import type { ResultatConsolidation } from "./evolution";
import { composerDepuisConnaissances } from "./connaissances-pont";
import { composerDepuisVocation } from "./vocation-pont";
import { detecterMethodeRaisonnement } from "../gen3/familles-methodes";
// it.73 — SOBRIÉTÉ ÉNERGÉTIQUE : profils plein (historique exact) / eco /
// telephone — cf. lib/neural/core/v2/energie.ts (module pur partagé).
// it.74 — canal VERSIONNÉ : le profil actif peut venir du fichier committé
// assets/config/profil-energie-production.json (priorité env > fichier >
// plein — cf. profil-production.ts) ; chaque économie reste DÉCLARÉE et le
// compteur de fenêtres (évitées / exécutées) mesure la réduction réelle.
import { PROFILS_ENERGIE } from "./core/v2/energie";
import type { ProfilEnergie } from "./core/v2/energie";
import { profilEnergieActif } from "./core/v2/profil-production";
import {
  enregistrerFenetreExecutee,
  enregistrerFenetreEvitee,
} from "./core/v2/compteur-energie-process";
import { nouvelleFenetreNeuronale } from "./core/v2/effecteur-cortex";
import type { CoucheOndesNeuronales } from "./core/couche-rpia";
import { INTENSITE_MAX_PAR_NEURONE } from "./encoding/text-encoder";
import { predireDomaineLexical } from "./training/domaines";
// it.114 — COMPARTIMENTS CALCULABLES (demande propriétaire) : quatre organes
// branchés au cerveau — math, sciences/monde virtuel, code/terminal virtuel,
// raisonnement — plus la passerelle à IA utilisatrices. Injection de
// dépendance : absent (tests, intégrations minimales) → comportement inchangé.
import type { CompartimentsGen3 } from "./compartiments/compartiments";

/** Nombre d'époques de résonance RPIA par tour de chat (latence bornée : chaque époque = O(100) ops). */
export const EPOQUES_RPIA_CHAT = 12;

/** Source du langage de la réponse (télémétrie honnête). */
export type SourceLangage =
  | "cortex_corpus"
  | "cortex_personnalisee"
  | "cortex_contexte"
  | "decoder_intention"
  | "pilotage"
  | "connaissances_utilisateur"
  | "vocation"
  | "compartiment_math"
  | "compartiment_monde"
  | "compartiment_terminal"
  | "memoire_utilisateur"
  | "memoire_dev_web";

/** Résultat de consultation de la mémoire utilisateur (Studio) — le texte
 * servi et son score d'appariement réels. */
export interface ReponseMemoireUtilisateurMoteur {
  readonly texte: string;
  /** Thème de traçabilité (ex. "studio:botanique"). */
  readonly theme?: string;
  /** Score d'appariement réel de la consultation (0..1). */
  readonly score?: number;
}

/**
 * STUDIO D'ENTRAÎNEMENT — CONSULTATION DE LA MÉMOIRE UTILISATEUR (point
 * d'injection du savoir entraîné dans les réponses du cerveau) : implémenté
 * par lib/studio/memoire-utilisateur.ts (consulterMemoireUtilisateur) et
 * câblé par lib/neural/runtime.ts. Signature découplée (pas d'import
 * direct) : absent (tests, intégrations minimales) → comportement inchangé.
 */
export type ConsultationMemoireUtilisateur = (
  message: string,
  userId: string,
) => Promise<ReponseMemoireUtilisateurMoteur | null>;

/** Composition finale : texte émis + provenance (traçabilité). */
export interface CompositionReponse {
  texte: string;
  source: SourceLangage;
  /** Thème du corpus quand la réponse vient du cortex (sinon undefined). */
  theme?: string;
  /** Score d'appariement du cortex (sinon undefined). */
  scoreAppariement?: number;
  /** Clé de motif de la paire gagnante — cible de la plasticité par feedback. */
  clePair?: string;
  /** « hit » si la réponse vient du cache d'inférence (télémétrie honnête). */
  cache?: "hit" | "miss";
}

/**
 * MOTEUR NEURONAL — adaptateur du système SNN Gen3 au contrat IA du projet
 * (lib/ai/models.ts). Signature et format de retour calqués sur
 * lib/ai/router.ts (generate / generateStream) pour que l'intégration
 * (Tâche 3) soit transparente :
 *  - `generate(options)` : encode le prompt, exécute 3 cycles réels via le
 *    noyau, décode la réponse honnête et retourne un objet conforme AIResponse ;
 *  - `generateStream(options, handlers)` : mêmes règles, avec transmission
 *    des fragments réels via `onDelta` (progression cycle par cycle PUIS
 *    texte décodé par segments) et signal `onProviderSelected` avant le
 *    premier delta — comme le routeur. La variante générateur est exposée via
 *    `streamDeltas` (AsyncGenerator) pour les intégrations directes.
 *
 * ADAPTATION DE TYPE (documentée) : `AIResponse.provider` est une union
 * fermée de fournisseurs LLM externes (AIProvider dans lib/ai/models.ts) qui
 * ne peut pas contenir le moteur neuronal sans modifier lib/ai (interdit ici
 * — Tâche 3). NeuralAIResponse reprend donc TOUS les champs d'AIResponse
 * avec `provider: "gen3-snn"` : dès que la Tâche 3 élargit AIProvider pour
 * inclure "gen3-snn", l'objet devient assignable tel quel.
 *
 * HONNÊTETÉ : les tokens d'usage sont des ESTIMATIONS documentées (mots du
 * prompt / de la réponse — un SNN ne compte pas des tokens de LLM), la
 * latence est mesurée réellement, et `raw` transporte les données réelles du
 * cycle (résonances, intention, rapport).
 */

/** Fournisseur logique du moteur neuronal. */
export type NeuralProvider = "gen3-snn";

/** Modèle logique du moteur neuronal. */
export const NEURAL_MODEL = "gen3-snn-v1";

/** Nombre de cycles du noyau par génération (identique au trainer par défaut). */
export const NEURAL_CYCLES_PAR_GENERATION = 4;

/** Nombre maximal de mots-clés remontés dans la réponse décodée. */
export const MAX_MOTS_CLES = 8;

/**
 * Nombre de tours antérieurs que le cortex langagier consulte pour les
 * reprises (en plus du tour N-1) : aligné sur MAX_TOURS_CONTEXTE de
 * lib/neural/generation/language.ts (+1 pour le tour courant exclu du slice).
 */
export const MAX_TOURS_MEMOIRE_CORTEX = 3;

/** it.85 — SEUIL CORPUS PRIORITAIRE : au-dessus de ce score d'appariement,
 *  le savoir APPRIS du cortex langagier (corpus commis) répond AVANT le pont
 *  vocation — un raisonnement appris bat l'ancrage générique d'un domaine.
 *  Calibré par mesure : l'appariement exact d'une paire apprise vaut 5,67
 *  (test réel au chat), un recouvrement de mots-clés seul reste ≪ 1 — le
 *  pont vocation garde donc la main sur tout ce que le corpus ne connaît
 *  pas fortement. */
export const SEUIL_CORPUS_PRIORITAIRE = 3;

/** Réponse du moteur neuronal : AIResponse complet, provider neural. */
export interface NeuralAIResponse extends Omit<AIResponse, "provider"> {
  provider: NeuralProvider;
  model: typeof NEURAL_MODEL;
}

/**
 * Télémétrie de la résonance RPIA du tour (données 100 % mesurées :
 * courbe d'erreur réelle de la couche d'ondes, temps global accumulé).
 */
export interface TelemetrieRPIA {
  /** Temps global d'interférence accumulé par la couche (tous tours). */
  pasTotaux: number;
  /** Époques de résonance exécutées pour CE tour (bornées). */
  epoques: number;
  /** Erreur d'interférence moyenne avant la première époque. */
  erreurInitiale: number;
  /** Erreur d'interférence moyenne après la dernière époque. */
  erreurFinale: number;
  /** true si l'erreur finale < erreur initiale (progrès réel). */
  convergence: boolean;
  /** Nombre de neurones énergisés par la résonance (injectés cycle 1). */
  noeudsEnergises: number;
}

/**
 * MÉTABOLISME DU TOUR (architecture « cerveau humain ») — travail réellement
 * effectué par le réseau pour CE tour (somme exacte des pas des cycles) :
 * le coût suit l'activité, pas la taille du réseau. Chiffres 100 % mesurés.
 */
export interface MetabolismeTour {
  /** Neurones réellement évalués (décroissance + test de seuil). */
  neuronesEvalues: number;
  /** Neurones restés au repos (coût zéro — énergie nulle sans stimulation). */
  neuronesReposes: number;
  /** Spikes émis pendant les cycles du tour. */
  spikes: number;
  /** Transmissions synaptiques réelles (sources spikées uniquement). */
  transmissions: number;
  /** Synapses qu'un scan dense AURAIT visitées (référence d'économie). */
  synapsesDenses: number;
  /** Transmissions évitées par la propagation événementielle. */
  transmissionsEvitees: number;
  /** Part du scan dense réellement payée (0–1, moins c'est mieux). */
  tauxActivite: number;
  /**
   * Métabolisme du CORPS SÉMANTIQUE pour ce tour (coût réel mesuré des
   * effecteurs déclenchés) — null si aucun rapport ne le porte (jamais un
   * chiffre inventé).
   */
  effecteurs: MetabolismeEffecteurs | null;
}

/** Handlers de streaming — signature identique à lib/ai/router.ts. */
export interface NeuralStreamHandlers {
  onDelta: (delta: string) => void | Promise<void>;
  /** Appelé avant le premier delta du moteur (comme le routeur). */
  onProviderSelected?: (
    provider: NeuralProvider,
    model: string,
  ) => void | Promise<void>;
}

/**
 * DÉTECTION DU DOMAINE (couche des 18 domaines, v3) — détection lexicale
 * (predireDomaineLexical), pattern exact de labelText pour les actions :
 * déterministe, testable, ancrée dans les mots-clés réels des datasets.
 *
 * Pourquoi pas la résonance SNN en repli : mesuré empiriquement, la zone
 * d'entrée SNN (38 neurones de hachage) ne sépare pas 18 classes aux
 * vocabulaires recouvrants — les résonances des pools de domaine
 * convergent et l'argmax serait biaisé (bruit). La couche SNN des domaines
 * reste entraînée (plasticité réelle, accuracy rapportée au Studio) comme
 * substrat vivant ; le ROUTAGE, lui, est lexical — même architecture que
 * la couche d'actions (INTENT_KEYWORDS + labelText).
 */
function detecterDomaine(
  texte: string,
): { label: string; nom: string; nomEn: string | null; score: number; source: "lexical" } | null {
  const lexicale = predireDomaineLexical(texte);
  if (!lexicale) return null;
  return {
    label: lexicale.label,
    nom: lexicale.nomFr,
    nomEn: lexicale.nomEn,
    score: lexicale.score,
    source: "lexical",
  };
}

/**
 * Phrase de domaine — honnête : elle rapporte les mots-clés réellement
 * reconnus (score lexical) sans prétendre exécuter quoi que ce soit ici.
 */
function phraseDomaine(nomFr: string, score: number): string {
  return `(Domaine reconnu : ${nomFr} — mots-clés de domaine, score ${score}. Je peux aider sur ce domaine : formulez votre demande précise.)`;
}

export class NeuralEngine {
  /**
   * CACHE D'INFÉRENCE (par moteur — cf. creerCacheReponses) : les redites
   * identiques au sein d'une même conversation court-circuitent le scoring
   * du cortex. Scopé par compte/conversation (voir cleMemoirePour).
   */
  private readonly cacheReponses = creerCacheReponses();

  /**
   * it.73 — PROFIL D'ÉNERGIE (GEN3_PROFIL_ENERGIE=eco|telephone|plein).
   * Défaut « plein » : comportement historique BIT À BIT (aucune
   * économie, aucune différence). « eco » / « telephone » : quand la
   * question tombe dans le cadre (pilotage, connaissances, pont vocation —
   * composés SANS fenêtre neuronale), la réponse part DIRECTEMENT —
   * zéro RPIA, zéro cycle du noyau, même texte. cf. PROFILS_ENERGIE.
   */
  private readonly profilEnergie: ProfilEnergie = profilEnergieActif().profil;

  constructor(
    private readonly noyau: NoyauCentralGen3,
    private readonly espace: EspaceFiltreResonant,
    private readonly cortex?: CortexLangagierGen3,
    private readonly hippocampe?: HippocampusMemory,
    /**
     * ÉVOLUTION CONTINUE : chaque échange réussi est observé, puis périodiquement
     * consolidé en mémoire longue (paires personnalisées du cortex). Sans ce
     * moteur, l'IA reste statique entre deux sessions d'entraînement.
     */
    private readonly evolution?: MoteurEvolutionGen3,
    /** Callback de persistance appelé après chaque consolidation effective. */
    private readonly surConsolidation?: (resultat: ResultatConsolidation) => void,
    /**
     * PILOTAGE PLATEFORME : hook async optionnel (câblé par le runtime avec
     * les dépôts réels). Si le message est une commande de pilotage (« état
     * de la plateforme », « mes automatisations »…), la composition renvoyée
     * — fondée sur des données réelles — PRIME sur cortex et décodeur.
     * Module pur côté moteur : aucune I/O ici, injection de dépendance.
     */
    private readonly pilotage?: (
      message: string,
      options: AIRequest,
    ) => Promise<CompositionReponse | null>,
    /**
     * COUCHE RPIA (BRANCHÉE AU FLUX DU CHAT) : avant chaque génération, le
     * message utilisateur est mis en résonance sur la couche d'ondes et les
     * énergies obtenues sont fusionnées dans la volée unique du cycle 1 —
     * le cerveau « ressent » la requête avant de décoder. Absente (tests,
     * intégrations minimales) → le moteur tourne comme avant.
     */
    private readonly coucheRPIA?: CoucheOndesNeuronales,
    /**
     * it.114 — COMPARTIMENTS CALCULABLES : math (calcul exact connecté au
     * cerveau), sciences (monde virtuel + passerelle à IA utilisatrices),
     * code (terminal virtuel sandboxé), raisonnement (orchestrateur qui
     * analyse → rappelle → évalue → choisit à chaque requête). Absent
     * (tests existants) → la chaîne historique tourne à l'identique.
     */
    private readonly compartiments?: CompartimentsGen3,
    /**
     * STUDIO D'ENTRAÎNEMENT — mémoire de domaine PAR UTILISATEUR (câblée par
     * le runtime) : consultée à CHAQUE réponse avec l'userId du compte —
     * l'IA entraînée par l'utilisateur répond depuis SA connaissance ingérée
     * (textes, datasets, URLs du Studio). Absent → chaîne historique.
     */
    private readonly memoireUtilisateur?: ConsultationMemoireUtilisateur,
  ) {}

  /**
   * MÉMOIRE DE TRAVAIL PAR CONVERSATION (durcissement 2026-10-22 — P0) :
   * l'hippocampe historique est un singleton partagé par TOUS les comptes —
   * l'anaphore « et toi ? » d'un utilisateur pouvait capter le dernier tour
   * d'un AUTRE (fuite de contexte entre comptes). Désormais, chaque couple
   * (userId, conversationId) présent dans `metadata` dispose de sa PROPRE
   * fenêtre glissante (LRU bornée) ; sans identité (appels système, tests,
   * scripts), le comportement historique est conservé.
   */
  private readonly fenetresMemoire = new Map<
    string,
    { memoire: HippocampusMemory; dernierAcces: number }
  >();

  /** Plafond de fenêtres vivantes : au-delà, la moins récemment utilisée est
   * évacuée (une fenêtre = ~10 tours × 2 × 2000 caractères au pire). */
  private static readonly LIMITE_FENETRES_MEMOIRE = 500;

  private memoirePour(options: AIRequest): HippocampusMemory | undefined {
    if (!this.hippocampe) return undefined;
    const meta = options.metadata ?? {};
    const userId = typeof meta.userId === "string" ? meta.userId : "";
    const conversationId =
      typeof meta.conversationId === "string" ? meta.conversationId : "";
    if (!userId && !conversationId) return this.hippocampe;

    const cle = `${userId || "sans-compte"}|${conversationId || "hors-conversation"}`;
    let entree = this.fenetresMemoire.get(cle);
    if (!entree) {
      if (this.fenetresMemoire.size >= NeuralEngine.LIMITE_FENETRES_MEMOIRE) {
        let clePlusAncienne: string | null = null;
        let plusAncien = Number.POSITIVE_INFINITY;
        for (const [cleExistante, valeur] of this.fenetresMemoire) {
          if (valeur.dernierAcces < plusAncien) {
            plusAncien = valeur.dernierAcces;
            clePlusAncienne = cleExistante;
          }
        }
        if (clePlusAncienne) this.fenetresMemoire.delete(clePlusAncienne);
      }
      entree = {
        memoire: new HippocampusMemory(this.hippocampe.tailleFenetre()),
        dernierAcces: Date.now(),
      };
      this.fenetresMemoire.set(cle, entree);
    }
    entree.dernierAcces = Date.now();
    return entree.memoire;
  }

  /**
   * RÉSONANCE RPIA DU TOUR DE CHAT : entraîne la couche d'ondes vers le
   * message (nombre d'époques BORNÉ — la latence du tour reste dominée par
   * les cycles du noyau) et retourne les énergies + télémétrie honnête.
   * La couche est PERSISTANTE : chaque message enrichit l'état résonnant
   * (le temps global avance — c'est le mode d'apprentissage natif de gen3).
   */
  private resonnerRPIA(message: string): {
    energies: Record<number, number>;
    telemetrie: TelemetrieRPIA;
  } | null {
    if (!this.coucheRPIA || message.trim().length === 0) return null;
    const { rapport, energies } = this.coucheRPIA.resonnerVersTexte(
      message,
      EPOQUES_RPIA_CHAT,
    );
    return {
      energies,
      telemetrie: {
        pasTotaux: this.coucheRPIA.pasTotaux,
        epoques: rapport.epoques,
        erreurInitiale: Math.round(rapport.erreurInitiale * 1e6) / 1e6,
        erreurFinale: Math.round(rapport.erreurFinale * 1e6) / 1e6,
        convergence: rapport.convergence,
        noeudsEnergises: Object.keys(energies).length,
      },
    };
  }

  /**
   * Fusionne les énergies de résonance dans les entrées du cycle 1 (même
   * format { idNeurone → intensité }, plafond identique à l'encodage : la
   * résonance RENFORCE les neurones déjà excités par les tokens et en
   * éveille d'autres — jamais un dépassement de plafond).
   */
  private fusionnerEnergies(
    inputs: Record<number, number>,
    energies: Record<number, number>,
  ): Record<number, number> {
    const fusionnes: Record<number, number> = { ...inputs };
    for (const [idBrut, energie] of Object.entries(energies)) {
      const id = Number(idBrut);
      if (!Number.isInteger(id) || !Number.isFinite(energie)) continue;
      fusionnes[id] = Math.min(
        INTENSITE_MAX_PAR_NEURONE,
        (fusionnes[id] ?? 0) + energie,
      );
    }
    return fusionnes;
  }

  /**
   * Clé d'identité de la fenêtre de mémoire (même logique que memoirePour) :
   * sert à SCOPER le cache d'inférence par compte/conversation — les paires
   * personnalisées (enseignées) d'un utilisateur ne doivent JAMAIS servir de
   * réponse en cache à un autre.
   */
  private cleMemoirePour(options: AIRequest): string {
    const meta = options.metadata ?? {};
    const userId = typeof meta.userId === "string" ? meta.userId : "";
    const conversationId =
      typeof meta.conversationId === "string" ? meta.conversationId : "";
    return `${userId || "sans-compte"}|${conversationId || "hors-conversation"}`;
  }

  /**
   * Génération neuronale complète : encodage du prompt (texte extrait des
   * messages), fenêtre de cycles réels du noyau avec inférence propre
   * (adaptation (d) : reset complet des énergies — la mémoire vit dans les
   * synapses apprises, pas dans les potentiels transitoires), lecture des
   * résonances (maximum par pool sur la fenêtre), décodage honnête en français.
   */
  async generate(options: AIRequest): Promise<NeuralAIResponse> {
    const debut = Date.now();
    const prompt = promptAvecAbréviations(extrairePrompt(options));

    const encodage = encodeText(prompt);
    const motsCles = selectionnerMotsCles(encodage.tokens);
    const messageUtilisateur = extraireDernierMessageUtilisateur(options);

    // it.73 — COURT-CIRCUIT ÉNERGÉTIQUE (profils eco/telephone) : la
    // composition pilotage → connaissances → pont vocation est testée
    // AVANT la fenêtre neuronale. Si elle répond : réponse directe, même
    // texte (mêmes fonctions pures), zéro RPIA et zéro cycle. Sinon :
    // chemin historique complet, inchangé.
    if (this.profilEnergie !== "plein") {
      const economique = await this.tenterCourtCircuitEnergie(
        options,
        messageUtilisateur,
        debut,
        prompt,
      );
      if (economique) return economique;
    }

    // RÉSONANCE RPIA (branchée au flux du chat) : le MESSAGE (pas la charte
    // système) est mis en résonance, puis ses énergies fusionnent dans la
    // volée unique du cycle 1 — même format et même plafond que l'encodage.
    const resonance = this.resonnerRPIA(messageUtilisateur || prompt);
    const entreesCycle1 = resonance
      ? this.fusionnerEnergies(encodage.inputs, resonance.energies)
      : encodage.inputs;

    // Adaptation (d) : inférence propre — reset complet des énergies.
    this.reinitialiserEnergies();

    const resonances: Record<string, number> = {};
    let dernierRapport: CycleReport | undefined;
    const rapports: CycleReport[] = [];
    // Fenêtre neuronale : identifiant unique — le Cortex v2 (effecteur)
    // remet ses énergies columnnaires à zéro à chaque nouvelle fenêtre
    // (miroir de l'adaptation (d), cf. effecteur-cortex.ts).
    const fenetre = nouvelleFenetreNeuronale();
    // Injection en VOLÉE UNIQUE (cycle 1) puis propagation libre — cf. trainer.
    for (let cycle = 1; cycle <= NEURAL_CYCLES_PAR_GENERATION; cycle++) {
      dernierRapport = this.noyau.executerCycle(
        cycle === 1
          ? { intensite: 0, inputsDirects: entreesCycle1 }
          : { intensite: 0 },
        { prompt, __fenetreNeuronale: fenetre },
      );
      rapports.push(dernierRapport);
      this.majResonancesMax(
        resonances,
        dernierRapport.spikedNeurones,
        cycle - 1,
      );
    }
    if (!dernierRapport) {
      throw new Error("Aucun cycle neuronal n'a pu être exécuté.");
    }
    // it.74 — compteur d'énergie du processus : fenêtre complète exécutée.
    enregistrerFenetreExecutee();

    const decode = decodeResponse(dernierRapport, resonances, motsCles);
    // PILOTAGE PLATEFORME d'abord (données réelles du compte) — puis le PONT
    // CONNAISSANCES (fragments réellement recherchés pour ce tour — c'est ce
    // qui rend les documents ingérés visibles dans les réponses), puis
    // cortex et décodeur, comme avant.
    const knowledgeContext = options.knowledgeContext?.trim() ?? "";
    const memoire = this.memoirePour(options);
    // COUCHE DES 18 DOMAINES : détection lexicale du tour utilisateur.
    const domaine = detecterDomaine(messageUtilisateur);
    // PONT VOCATION (it.66) : une question qui tombe dans le cadre
    // d'apprentissage (19 domaines de la charte) reçoit une réponse
    // ancrée dans ce cadre — AVANT le repli cortex/décodeur.
    const composition =
      (await this.pilotage?.(messageUtilisateur, options)) ??
      (knowledgeContext ? composerDepuisConnaissances(messageUtilisateur, knowledgeContext) : null) ??
      // STUDIO D'ENTRAÎNEMENT — MÉMOIRE UTILISATEUR : l'IA entraînée répond
      // depuis la connaissance ingérée du compte (domaines du Studio), AVANT
      // les organes génériques — c'est le point d'injection du savoir
      // fourni par l'utilisateur (évalué avant/après par le pipeline).
      (await this.compositionMemoireUtilisateur(messageUtilisateur, options)) ??
      // it.114 — COMPARTIMENTS CALCULABLES : la demande de calcul, de
      // simulation ou d'exécution reçoit une réponse CALCULÉE par l'organe
      // du cerveau concerné (preuve, pas récitation) — avant le corpus.
      // Pour une intention « connaissance », l'orchestrateur renvoie null
      // et la chaîne historique tourne EXACTEMENT comme avant.
      this.compositionCompartiments(messageUtilisateur) ??
      // it.85 — CORPUS PRIORITAIRE SUR MATCH FORT : une paire apprise avec
      // un appariement fort répond AVANT le pont vocation (le raisonnement
      // appris bat l'ancrage générique — mesure : appariement exact 5,67).
      this.compositionCorpusPrioritaire(messageUtilisateur) ??
      // DÉV WEB/DNS — MÉMOIRE COMMISE : rappel des unités ingérées au boot
      // (seuil de pertinence interne) — APRÈS corpus prioritaire, AVANT le
      // pont vocation (voir compositionMemoireDevWeb).
      this.compositionMemoireDevWeb(messageUtilisateur) ??
      composerDepuisVocation(messageUtilisateur) ??
      this.composer(messageUtilisateur, decode, memoire, this.cleMemoirePour(options), domaine);
    this.memoriser(messageUtilisateur, composition.texte, memoire);
    this.evoluer(messageUtilisateur, composition);

    return this.construireReponse(
      prompt,
      composition,
      decode,
      Date.now() - debut,
      resonance?.telemetrie,
      domaine,
      this.sommerMetabolismeTour(rapports),
    );
  }

  /**
   * Variante en flux — signature calquée sur lib/ai/router.ts generateStream :
   * les fragments réels sont transmis à `onDelta` au fil de l'exécution
   * (progression cycle par cycle, puis texte décodé par segments de phrases),
   * `onProviderSelected` est appelé avant le premier delta, et la réponse
   * complète (AIResponse) est retournée à la fin.
   */
  async generateStream(
    options: AIRequest,
    handlers: NeuralStreamHandlers,
  ): Promise<NeuralAIResponse> {
    const debut = Date.now();
    const prompt = promptAvecAbréviations(extrairePrompt(options));

    const encodage = encodeText(prompt);
    const motsCles = selectionnerMotsCles(encodage.tokens);
    const messageUtilisateur = extraireDernierMessageUtilisateur(options);

    let providerSignale = false;
    const emettre = async (delta: string): Promise<void> => {
      if (!providerSignale) {
        providerSignale = true;
        const signal = handlers.onProviderSelected?.("gen3-snn", NEURAL_MODEL);
        if (signal) await Promise.resolve(signal);
      }
      await handlers.onDelta(delta);
    };

    // it.73 — COURT-CIRCUIT ÉNERGÉTIQUE (cf. generate) : AVANT toute
    // résonance RPIA (travail neuronal), le pont répond si la question y
    // tombe — même texte émis par segments, zéro fenêtre neuronale.
    if (this.profilEnergie !== "plein") {
      const economique = await this.tenterCourtCircuitEnergie(
        options,
        messageUtilisateur,
        debut,
        prompt,
      );
      if (economique) {
        for (const segment of segmenterTexte(economique.text)) {
          await emettre(segment);
          // Rend la main à l'event loop entre les segments (flux réel, sans
          // délai artificiel).
          await new Promise<void>((resoudre) => setImmediate(resoudre));
        }
        return economique;
      }
    }

    // RÉSONANCE RPIA (cf. generate) — même contrat, même plafond.
    const resonance = this.resonnerRPIA(messageUtilisateur || prompt);
    const entreesCycle1 = resonance
      ? this.fusionnerEnergies(encodage.inputs, resonance.energies)
      : encodage.inputs;

    // Adaptation (d) : inférence propre — reset complet des énergies.
    this.reinitialiserEnergies();

    // Fragments : la progression des cycles n'est PLUS émise dans le flux
    // conversationnel (bruit) — les télémétries réelles restent dans raw.
    const resonances: Record<string, number> = {};
    let dernierRapport: CycleReport | undefined;
    const rapports: CycleReport[] = [];
    // Fenêtre neuronale (cf. generate) — le Cortex v2 suit chaque fenêtre.
    const fenetre = nouvelleFenetreNeuronale();
    // Injection en VOLÉE UNIQUE (cycle 1) puis propagation libre — cf. trainer.
    for (let cycle = 1; cycle <= NEURAL_CYCLES_PAR_GENERATION; cycle++) {
      dernierRapport = this.noyau.executerCycle(
        cycle === 1
          ? { intensite: 0, inputsDirects: entreesCycle1 }
          : { intensite: 0 },
        { prompt, __fenetreNeuronale: fenetre },
      );
      rapports.push(dernierRapport);
      this.majResonancesMax(
        resonances,
        dernierRapport.spikedNeurones,
        cycle - 1,
      );
    }
    if (!dernierRapport) {
      throw new Error("Aucun cycle neuronal n'a pu être exécuté.");
    }
    // it.74 — compteur d'énergie du processus : fenêtre complète exécutée.
    enregistrerFenetreExecutee();

    const decode = decodeResponse(dernierRapport, resonances, motsCles);
    const knowledgeContext = options.knowledgeContext?.trim() ?? "";
    // FLUX = CHEMIN RÉEL DU CHAT : la mémoire de travail DOIT être consultée
    // ici aussi (correction — avant, seul generate() non-flux la consultait :
    // les reprises anaphoriques ne fonctionnaient jamais en production).
    const memoire = this.memoirePour(options);
    // COUCHE DES 18 DOMAINES : détection lexicale du tour utilisateur.
    const domaine = detecterDomaine(messageUtilisateur);
    // PONT VOCATION (it.66) : même chaîne que generate() — le chemin réel
    // du chat répond depuis le cadre d'apprentissage quand la question y tombe.
    const composition =
      (await this.pilotage?.(messageUtilisateur, options)) ??
      (knowledgeContext ? composerDepuisConnaissances(messageUtilisateur, knowledgeContext) : null) ??
      // STUDIO D'ENTRAÎNEMENT — MÉMOIRE UTILISATEUR (même règle que generate).
      (await this.compositionMemoireUtilisateur(messageUtilisateur, options)) ??
      // it.114 — COMPARTIMENTS CALCULABLES (même règle que generate).
      this.compositionCompartiments(messageUtilisateur) ??
      // it.85 — CORPUS PRIORITAIRE SUR MATCH FORT (même règle que generate).
      this.compositionCorpusPrioritaire(messageUtilisateur) ??
      // DÉV WEB/DNS — MÉMOIRE COMMISE : rappel borné (voir compositionMemoireDevWeb).
      this.compositionMemoireDevWeb(messageUtilisateur) ??
      composerDepuisVocation(messageUtilisateur) ??
      this.composer(messageUtilisateur, decode, memoire, this.cleMemoirePour(options), domaine);

    // La réponse composée est émise par segments (phrases réelles). Les
    // télémétries de cycles restent disponibles dans raw (plus de bruit de
    // progression dans le flux conversationnel).
    for (const segment of segmenterTexte(composition.texte)) {
      await emettre(segment);
      // Rend la main à l'event loop entre les segments (flux réel, sans
      // délai artificiel).
      await new Promise<void>((resoudre) => setImmediate(resoudre));
    }

    this.memoriser(messageUtilisateur, composition.texte, memoire);
    this.evoluer(messageUtilisateur, composition);
    return this.construireReponse(
      prompt,
      composition,
      decode,
      Date.now() - debut,
      resonance?.telemetrie,
      domaine,
      this.sommerMetabolismeTour(rapports),
    );
  }

  /**
   * Variante générateur (AsyncGenerator de fragments) pour les intégrations
   * directes : yield les mêmes fragments que generateStream, retourne la
   * réponse complète en valeur finale.
   */
  async *streamDeltas(
    options: AIRequest,
  ): AsyncGenerator<string, NeuralAIResponse, void> {
    const debut = Date.now();
    const prompt = promptAvecAbréviations(extrairePrompt(options));

    const encodage = encodeText(prompt);
    const motsCles = selectionnerMotsCles(encodage.tokens);
    const messageUtilisateur = extraireDernierMessageUtilisateur(options);

    // RÉSONANCE RPIA (cf. generate) — même contrat, même plafond.
    const resonance = this.resonnerRPIA(messageUtilisateur || prompt);
    const entreesCycle1 = resonance
      ? this.fusionnerEnergies(encodage.inputs, resonance.energies)
      : encodage.inputs;

    // Adaptation (d) : inférence propre — reset complet des énergies.
    this.reinitialiserEnergies();

    const resonances: Record<string, number> = {};
    let dernierRapport: CycleReport | undefined;
    const rapports: CycleReport[] = [];
    // Fenêtre neuronale (cf. generate) — le Cortex v2 suit chaque fenêtre.
    const fenetre = nouvelleFenetreNeuronale();
    // Injection en VOLÉE UNIQUE (cycle 1) puis propagation libre — cf. trainer.
    for (let cycle = 1; cycle <= NEURAL_CYCLES_PAR_GENERATION; cycle++) {
      dernierRapport = this.noyau.executerCycle(
        cycle === 1
          ? { intensite: 0, inputsDirects: entreesCycle1 }
          : { intensite: 0 },
        { prompt, __fenetreNeuronale: fenetre },
      );
      rapports.push(dernierRapport);
      this.majResonancesMax(
        resonances,
        dernierRapport.spikedNeurones,
        cycle - 1,
      );
      yield `Cycle ${cycle}/${NEURAL_CYCLES_PAR_GENERATION} — ${dernierRapport.neuronesActifs} neurones actifs (${dernierRapport.mode}).\n`;
    }
    if (!dernierRapport) {
      throw new Error("Aucun cycle neuronal n'a pu être exécuté.");
    }
    // it.74 — compteur d'énergie du processus : fenêtre complète exécutée.
    enregistrerFenetreExecutee();

    const decode = decodeResponse(dernierRapport, resonances, motsCles);
    const memoire = this.memoirePour(options);
    // COUCHE DES 18 DOMAINES : détection lexicale du tour utilisateur.
    const domaine = detecterDomaine(messageUtilisateur);
    // PONT VOCATION (it.66) : variante générateur — même ancrage vocation
    // que les deux chemins principaux (génération et flux).
    const composition =
      (await this.pilotage?.(messageUtilisateur, options)) ??
      // STUDIO D'ENTRAÎNEMENT — MÉMOIRE UTILISATEUR (même règle que generate).
      (await this.compositionMemoireUtilisateur(messageUtilisateur, options)) ??
      // it.114 — COMPARTIMENTS CALCULABLES (même règle que generate).
      this.compositionCompartiments(messageUtilisateur) ??
      // it.85 — CORPUS PRIORITAIRE SUR MATCH FORT (même règle que generate).
      this.compositionCorpusPrioritaire(messageUtilisateur) ??
      // DÉV WEB/DNS — MÉMOIRE COMMISE : rappel borné (voir compositionMemoireDevWeb).
      this.compositionMemoireDevWeb(messageUtilisateur) ??
      composerDepuisVocation(messageUtilisateur) ??
      this.composer(messageUtilisateur, decode, memoire, this.cleMemoirePour(options), domaine);

    for (const segment of segmenterTexte(composition.texte)) {
      yield segment;
    }

    this.memoriser(messageUtilisateur, composition.texte, memoire);
    this.evoluer(messageUtilisateur, composition);
    return this.construireReponse(
      prompt,
      composition,
      decode,
      Date.now() - debut,
      resonance?.telemetrie,
      domaine,
      this.sommerMetabolismeTour(rapports),
    );
  }

  /**
   * Adaptation (d) — reset complet des énergies : chaque génération est un
   * essai propre, la prédiction ne reflète QUE la structure synaptique
   * apprise (les énergies résiduelles d'un tour précédent ne doivent pas
   * polluer l'inférence du tour courant).
   */
  private reinitialiserEnergies(): void {
    for (const neurone of this.noyau.cerveau.neurones.values()) {
      neurone.energy = 0;
    }
  }

  /**
   * Résonance pondérée PAR LATENCE par pool = maximum observé sur la fenêtre
   * de cycles (cf. poidsResonanceParCycle) : un pool entraîné spiker tôt
   * dans la fenêtre — poids fort — alors qu'un pool activé par le bruit
   * synaptique aléatoire n'atteint le seuil qu'en fin de fenêtre.
   */
  private majResonancesMax(
    resonances: Record<string, number>,
    spikedNeurones: number[],
    indexCycle: number,
  ): void {
    const poids = poidsResonanceParCycle(indexCycle);
    for (const canal of this.espace.outputPools.keys()) {
      const score = this.espace.readResonance(spikedNeurones, canal) * poids;
      if (score > (resonances[canal] ?? 0)) resonances[canal] = score;
    }
  }

  /**
   * STUDIO D'ENTRAÎNEMENT — COMPOSITION DEPUIS LA MÉMOIRE UTILISATEUR :
   * consulte la mémoire de domaine du COMPTE (metadata.userId) sur le
   * message brut. Sous le seuil ou sans compte : null — la chaîne normale
   * reprend la main, inchangée. Toute panne de la consultation dégrade en
   * null (jamais de conversation cassée par une mémoire).
   */
  private async compositionMemoireUtilisateur(
    messageUtilisateur: string,
    options: AIRequest,
  ): Promise<CompositionReponse | null> {
    if (!this.memoireUtilisateur || messageUtilisateur.trim().length === 0) return null;
    const userId =
      typeof options.metadata?.userId === "string" ? options.metadata.userId : "";
    if (userId.length === 0) return null;
    try {
      const reponse = await this.memoireUtilisateur(messageUtilisateur, userId);
      if (!reponse || reponse.texte.trim().length === 0) return null;
      return {
        texte: reponse.texte,
        source: "memoire_utilisateur",
        theme: reponse.theme,
        scoreAppariement: reponse.score,
      };
    } catch {
      // Une mémoire indisponible ne doit jamais casser la conversation.
      return null;
    }
  }

  /**
   * it.114 — COMPOSITION PAR COMPARTIMENTS CALCULABLES : l'orchestrateur de
   * raisonnement analyse la requête (calcul / simulation / exécution /
   * connaissance), sollicite l'organe du cerveau concerné (math, monde
   * virtuel, terminal virtuel) et — seulement si un compartiment produit
   * une réponse servable — la renvoie avec sa provenance honnête. Pour une
   * intention « connaissance » (ou compartiments non câblés), retourne
   * null : la chaîne historique (corpus → vocation → cortex) répond
   * EXACTEMENT comme avant — zéro régression structurelle.
   */
  private compositionCompartiments(messageUtilisateur: string): CompositionReponse | null {
    if (!this.compartiments) return null;
    try {
      const resultat = this.compartiments.orchestrateur.resoudre(messageUtilisateur);
      if (!resultat) return null;
      return { texte: resultat.texte, source: resultat.source };
    } catch {
      // Un compartiment en échec ne doit jamais casser la conversation.
      return null;
    }
  }

  /**
   * DÉVELOPPEMENT WEB/DNS — MÉMOIRE COMMISE (demande propriétaire 2026-11-13 :
   * « entraîne gen3 sur le développement web et le DNS ») : consulte l'annexe
   * dev web ingérée au démarrage du runtime (2 441 unités). Le rappel est
   * DÉJÀ borné par un seuil de pertinence (jaccard + contenance, hors sujet →
   * null) : la chaîne historique répond EXACTEMENT comme avant — cette étape
   * ne peut qu'augmenter le service, jamais court-circuiter une réponse
   * plus forte (elle est placée APRÈS corpus prioritaire).
   */
  private compositionMemoireDevWeb(messageUtilisateur: string): CompositionReponse | null {
    if (!this.compartiments) return null;
    try {
      const texte = this.compartiments.memoireDomaines?.repondreIngestion(messageUtilisateur) ?? null;
      if (texte === null || texte.length < 40) return null;
      return { texte, source: "memoire_dev_web", theme: "developpement-web" };
    } catch {
      // Une annexe mémoire en échec ne doit jamais casser la conversation.
      return null;
    }
  }

  /**
   * it.85 — CORPUS PRIORITAIRE : consulte le cortex langagier sur le message
   * brut et ne retient la réponse que si l'appariement est FORT
   * (≥ SEUIL_CORPUS_PRIORITAIRE). Sous le seuil : null — la chaîne normale
   * (connaissances → vocation → composer) reprend la main, inchangée.
   */
  private compositionCorpusPrioritaire(messageUtilisateur: string): CompositionReponse | null {
    // it.86-b — RÉPONSE INSTANCIÉE D'ABORD : pour les gabarits calculables
    // (addition verbale, heure + durée, chaîne spatiale, syllogisme simple),
    // la réponse est CALCULÉE depuis la question posée — aucune paire
    // apprise ne peut servir des nombres figés d'une autre question
    // (mesure : « 4435 … et 29 » recevait « 3 + 2 = 5 »).
    const instantiee = reponseInstantiee(messageUtilisateur);
    if (instantiee) {
      return { texte: instantiee, source: "cortex_corpus", theme: "calcul:instantie" };
    }
    if (!this.cortex) return null;
    const reponse = this.cortex.repondre(messageUtilisateur);
    if (reponse && reponse.score >= SEUIL_CORPUS_PRIORITAIRE) {
      return {
        texte: reponse.texte,
        source:
          reponse.source === "personnalisee"
            ? "cortex_personnalisee"
            : reponse.source === "contexte"
              ? "cortex_contexte"
              : "cortex_corpus",
        theme: reponse.theme,
        scoreAppariement: reponse.score,
        clePair: reponse.cle,
      };
    }
    // it.85-r — GÉNÉRALISATION PAR MÉTHODE : pas d'appariement fort sur
    // le corpus, mais les signaux d'une famille de raisonnement sont
    // reconnus → la méthode générique de la famille répond, à la place
    // du pont vocation qui était hors-sujet (mesure : « Art et création
    // multimédia » à une question de syllogisme). Honnêteté : la méthode
    // annonce qu'elle est générique, elle ne prétend pas être un exemple
    // mémorisé.
    const methode = detecterMethodeRaisonnement(messageUtilisateur);
    if (methode) {
      return {
        texte: methode.texte,
        source: "cortex_corpus",
        theme: `methode:${methode.famille}`,
      };
    }
    return null;
  }

  /**
   * COMPOSITION DU LANGAGE — le cœur conversationnel du moteur :
   *  1. le cortex langagier (corpus appris) est consulté en priorité avec
   *     le contexte de l'hippocampe (reprises courtes) ;
   *  2. sous le seuil d'appariement, la composition conversationnelle du
   *     décodeur prend le relais (intention détectée + données réelles).
   */
  private composer(
    prompt: string,
    decode: NeuralDecodedResponse,
    memoire?: HippocampusMemory,
    cleMemoire: string = "sans-compte|hors-conversation",
    domaine?: { label: string; nom: string; nomEn: string | null; score: number; source: string } | null,
  ): CompositionReponse {
    if (this.cortex) {
      const contexte: ContexteLangage = {};
      if (memoire) {
        const historique = memoire.getHistory();
        const dernierTour = historique[historique.length - 1];
        if (dernierTour) {
          contexte.messagePrecedent = dernierTour.user;
          contexte.reponsePrecedente = dernierTour.system;
        }
        // FENÊTRE DE CONTEXTE ÉTENDUE : les tours N-2 et N-3 (du plus récent
        // au plus ancien) participent au score lexical avec décroissance —
        // le cortex résout les reprises jusqu'à 3 tours en arrière.
        const anterieurs = historique.slice(
          Math.max(0, historique.length - (MAX_TOURS_MEMOIRE_CORTEX + 1)),
          historique.length - 1,
        );
        if (anterieurs.length > 0) {
          contexte.historique = anterieurs
            .slice()
            .reverse()
            .map((tour) => ({ message: tour.user, reponse: tour.system }));
        }
      }

      // CACHE D'INFÉRENCE (scopé par compte/conversation) : les requêtes
      // identiques au sein d'une MÊME conversation court-circuitent le
      // scoring du cortex pendant la durée de vie courte du cache — gain
      // direct sur les redites, sans jamais fuiter entre comptes.
      const cleCache = this.cacheReponses.cle(cleMemoire, prompt, contexte);
      const enCache = this.cacheReponses.lire(cleCache);
      if (enCache) {
        return { ...enCache, cache: "hit" };
      }

      // it.86-b — RÉPONSE INSTANCIÉE : le calcul exact de la question posée
      // prime toute paire apprise (zéro nombre figé possible).
      const instantiee = reponseInstantiee(prompt);
      if (instantiee) {
        return { texte: instantiee, source: "cortex_corpus", theme: "calcul:instantie" };
      }

      const reponse = this.cortex.repondre(prompt, contexte);
      if (reponse) {
        const composition: CompositionReponse = {
          texte: reponse.texte,
          source:
            reponse.source === "personnalisee"
              ? "cortex_personnalisee"
              : reponse.source === "contexte"
                ? "cortex_contexte"
                : "cortex_corpus",
          theme: reponse.theme,
          scoreAppariement: reponse.score,
          clePair: reponse.cle,
          cache: "miss",
        };
        this.cacheReponses.stocker(cleCache, composition);
        return composition;
      }
    }

    // Repli : composition conversationnelle du décodeur (intention + réelles).
    let texte = decode.texte;
    if (domaine) {
      texte += ` ${phraseDomaine(domaine.nom, domaine.score)}`;
    }
    return { texte, source: "decoder_intention" };
  }

  /**
   * Mémorise l'échange dans l'hippocampe (mémoire de travail) : le tour
   * suivant disposera du contexte de reprise. Échec silencieux (jamais de
   * panne de chat pour une mémoire).
   */
  private memoriser(
    prompt: string,
    reponse: string,
    memoire?: HippocampusMemory,
  ): void {
    if (!memoire) return;
    try {
      memoire.remember(prompt, reponse);
    } catch {
      // Télémétrie perdue, pas la conversation.
    }
  }

  /**
   * ÉVOLUTION CONTINUE — chaque échange réussi est observé par le moteur
   * d'évolution ; quand la périodicité est atteinte, une consolidation
   * transforme les échanges de qualité en connaissances durables (paires
   * personnalisées du cortex) et le callback de persistance est appelé
   * (le cerveau est sauvegardé). Échec silencieux : une panne d'évolution
   * ne doit jamais casser la conversation.
   */
  private evoluer(prompt: string, composition: CompositionReponse): void {
    if (!this.evolution) return;
    try {
      this.evolution.observer({
        question: prompt,
        reponse: composition.texte,
        score: composition.scoreAppariement ?? 0,
        source: composition.source,
      });
      const resultat = this.evolution.consoliderSiPret();
      if (resultat && resultat.enseignees > 0) {
        this.surConsolidation?.(resultat);
      }
    } catch {
      // L'évolution est un gain, jamais une dépendance critique.
    }
  }

  /**
   * Somme exacte du métabolisme des cycles du tour (données mesurées par le
   * réseau à chaque pas). null si aucun rapport ne porte de métabolisme
   * (intégrations minimales) — jamais un chiffre inventé.
   */
  private sommerMetabolismeTour(rapports: CycleReport[]): MetabolismeTour | null {
    let somme: MetabolismeTour | null = null;
    for (const rapport of rapports) {
      // Métabolisme du corps sémantique : agrégé indépendamment du pas réseau
      // (un effecteur déclenché sans pas réseau mesurable reste un coût réel).
      const corps = rapport.metabolismeEffecteurs;
      if (corps) {
        if (!somme) {
          somme = {
            neuronesEvalues: 0,
            neuronesReposes: 0,
            spikes: 0,
            transmissions: 0,
            synapsesDenses: 0,
            transmissionsEvitees: 0,
            tauxActivite: 0,
            effecteurs: null,
          };
        }
        if (!somme.effecteurs) {
          somme.effecteurs = {
            actions: 0,
            actionsMesurees: 0,
            coutMesureMs: 0,
          };
        }
        somme.effecteurs.actions += corps.actions;
        somme.effecteurs.actionsMesurees += corps.actionsMesurees;
        somme.effecteurs.coutMesureMs += corps.coutMesureMs;
      }

      const pas = rapport.metabolisme;
      if (!pas) continue;
      if (!somme) {
        somme = {
          neuronesEvalues: 0,
          neuronesReposes: 0,
          spikes: 0,
          transmissions: 0,
          synapsesDenses: 0,
          transmissionsEvitees: 0,
          tauxActivite: 0,
          effecteurs: null,
        };
      }
      somme.neuronesEvalues += pas.neuronesEvalues;
      somme.neuronesReposes += pas.neuronesReposes;
      somme.spikes += pas.spikes;
      somme.transmissions += pas.transmissions;
      somme.synapsesDenses += pas.synapsesDenses;
    }
    if (!somme) return null;
    somme.transmissionsEvitees =
      somme.synapsesDenses - somme.transmissions;
    somme.tauxActivite =
      somme.synapsesDenses > 0
        ? Math.round((somme.transmissions / somme.synapsesDenses) * 1e4) / 1e4
        : 0;
    return somme;
  }

  /** Construit la réponse conforme AIResponse à partir du décodage réel. */
  private construireReponse(
    prompt: string,
    composition: CompositionReponse,
    decode: NeuralDecodedResponse,
    latencyMs: number,
    telemetrieRPIA?: TelemetrieRPIA,
    domaine?: { label: string; nom: string; nomEn: string | null; score: number; source: string } | null,
    metabolismeTour?: MetabolismeTour | null,
  ): NeuralAIResponse {
    // Estimation honnête documentée : un SNN ne compte pas de tokens de LLM,
    // on rapporte les mots réels du prompt et de la réponse.
    const inputTokens = compterMots(prompt);
    const outputTokens = compterMots(composition.texte);
    const usage: AIUsage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };

    return {
      id: `snn-${randomUUID()}`,
      provider: "gen3-snn",
      model: NEURAL_MODEL,
      text: composition.texte,
      usage,
      finishReason: "stop",
      latencyMs,
      raw: {
        moteur: "snn",
        intention: decode.intention,
        scoreResonance: decode.scoreResonance,
        resonances: decode.resonances,
        motsCles: decode.motsCles,
        langage: {
          source: composition.source,
          theme: composition.theme ?? null,
          scoreAppariement: composition.scoreAppariement ?? null,
          cle: composition.clePair ?? null,
          cache: composition.cache ?? null,
        },
        // COUCHE RPIA BRANCHÉE AU FLUX DU CHAT : télémétrie de la résonance
        // réellement exécutée pour ce tour (null sans couche — jamais un
        // chiffre inventé).
        rpia: telemetrieRPIA ?? null,
        // MÉTABOLISME CÉRÉBRAL : travail réel du réseau pour ce tour
        // (architecture événementielle — le coût suit l'activité, pas la
        // taille du réseau ; null si absent, jamais un chiffre inventé).
        metabolisme: metabolismeTour ?? null,
        // COUCHE DES 18 DOMAINES : domaine reconnu pour ce tour (détection
        // lexicale sur les mots-clés réels des datasets — null si aucun).
        ...(domaine
          ? {
              domaine: {
                label: domaine.label,
                nom: domaine.nom,
                nomEn: domaine.nomEn,
                score: domaine.score,
                source: domaine.source,
              },
            }
          : {}),
      },
    };
  }

  /**
   * it.73 — COURT-CIRCUIT ÉNERGÉTIQUE (profils eco/telephone UNIQUEMENT —
   * le profil « plein » n'appelle JAMAIS cette méthode).
   *
   * Tente la composition SANS fenêtre neuronale : pilotage plateforme →
   * connaissances → pont vocation. Ces trois compositions sont identiques
   * au chemin historique (MÊMES fonctions, MÊME ordre relatif — seuls le
   * repli cortex/décodeur et les télémétries de cycles diffèrent) : la
   * qualité de réponse est donc conservée PAR CONSTRUCTION. Les effets de
   * bord conversationnels (mémoire de travail, évolution continue) sont
   * exécutés comme dans le chemin complet. Retourne null si aucune ne
   * répond → l'appelant exécute le chemin historique complet.
   */
  private async tenterCourtCircuitEnergie(
    options: AIRequest,
    messageUtilisateur: string,
    debut: number,
    prompt: string,
  ): Promise<NeuralAIResponse | null> {
    const knowledgeContext = options.knowledgeContext?.trim() ?? "";
    const composition =
      (await this.pilotage?.(messageUtilisateur, options)) ??
      (knowledgeContext
        ? composerDepuisConnaissances(messageUtilisateur, knowledgeContext)
        : null) ??
      // it.114 — COMPARTIMENTS CALCULABLES (même règle que generate).
      this.compositionCompartiments(messageUtilisateur) ??
      // it.85 — CORPUS PRIORITAIRE SUR MATCH FORT (même règle que generate).
      this.compositionCorpusPrioritaire(messageUtilisateur) ??
      // DÉV WEB/DNS — MÉMOIRE COMMISE : rappel borné (voir compositionMemoireDevWeb).
      this.compositionMemoireDevWeb(messageUtilisateur) ??
      composerDepuisVocation(messageUtilisateur);
    if (!composition) return null;

    const memoire = this.memoirePour(options);
    const domaine = detecterDomaine(messageUtilisateur);
    // Décodage « vide » honnête : aucune fenêtre neuronale n'a tourné —
    // zéro résonance inventée, zéro métabolisme inventé.
    const decodeVide: NeuralDecodedResponse = {
      texte: composition.texte,
      intention: "INTENTION_GENERALE",
      scoreResonance: 0,
      resonances: {},
      motsCles: [],
    };
    const reponse = this.construireReponse(
      prompt,
      composition,
      decodeVide,
      Date.now() - debut,
      undefined,
      domaine,
      null,
    );
    // raw est typé `unknown` dans le contrat IA (lib/ai/models.ts) — la
    // télémétrie d'économie est ajoutée de façon typée et honnête.
    reponse.raw = {
      ...(typeof reponse.raw === "object" && reponse.raw !== null
        ? (reponse.raw as Record<string, unknown>)
        : {}),
      economieEnergie: {
        profil: this.profilEnergie,
        origine: "pont-lexical",
        cyclesNoyauEvites: NEURAL_CYCLES_PAR_GENERATION,
        epoquesRPIAEvitees: EPOQUES_RPIA_CHAT,
        description: PROFILS_ENERGIE[this.profilEnergie].description,
      },
    } as Record<string, unknown>;
    // it.74 — compteur d'énergie du processus : cette fenêtre n'a PAS
    // tourné (somme mesurée, exposée par /api/energie).
    enregistrerFenetreEvitee(EPOQUES_RPIA_CHAT, NEURAL_CYCLES_PAR_GENERATION);
    this.memoriser(messageUtilisateur, composition.texte, memoire);
    this.evoluer(messageUtilisateur, composition);
    return reponse;
  }
}

/**
 * Extrait le DERNIER message utilisateur (le tour courant) : c'est lui que
 * le cortex langagier interroge et que l'hippocampe mémorise — le prompt
 * complet (chartes système, historique) ne doit pas polluer l'appariement.
 * Repli : le message système, puis le prompt brut vide-garde.
 */
export function extraireDernierMessageUtilisateur(options: AIRequest): string {
  for (let i = options.messages.length - 1; i >= 0; i--) {
    const message = options.messages[i];
    if (message.role === "user" && message.content.trim().length > 0) {
      return message.content.trim();
    }
  }
  if (options.system && options.system.trim().length > 0) {
    return options.system.trim();
  }
  return "";
}

/**
 * Extrait le texte du prompt : message système éventuel + contenu de tous
 * les messages de la requête (données réelles, ordre conservé).
 */
export function extrairePrompt(options: AIRequest): string {
  const morceaux: string[] = [];
  if (options.system && options.system.trim().length > 0) {
    morceaux.push(options.system.trim());
  }
  for (const message of options.messages) {
    const contenu = message.content.trim();
    if (contenu.length > 0) morceaux.push(contenu);
  }
  return morceaux.join("\n");
}

/**
 * Sélectionne les mots-clés réellement captés : tokens uniques triés par
 * fréquence d'apparition (puis alphabétique pour le déterminisme), max 8.
 */
export function selectionnerMotsCles(tokens: string[]): string[] {
  const frequences = new Map<string, number>();
  for (const token of tokens) {
    frequences.set(token, (frequences.get(token) ?? 0) + 1);
  }
  return Array.from(frequences.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, MAX_MOTS_CLES)
    .map(([token]) => token);
}

/** Découpe un texte en segments de phrases (pour l'émission en flux). */
export function segmenterTexte(texte: string): string[] {
  const segments = texte
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return [texte];
  // Les séparateurs sont réintégrés : la concaténation des segments
  // restitue exactement le texte d'origine.
  return segments.map((s, i) => (i === 0 ? s : ` ${s}`));
}

/** Compte les mots d'un texte (estimation honnête des tokens). */
function compterMots(texte: string): number {
  return texte.split(/\s+/).filter((m) => m.length > 0).length;
}

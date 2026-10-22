import "server-only";

import { randomUUID } from "node:crypto";

import type {
  AIRequest,
  AIResponse,
  AIUsage,
} from "@/lib/ai/models";

import type { CycleReport } from "./core/types";
import type { NoyauCentralGen3 } from "./core/central-core";
import type { EspaceFiltreResonant } from "./core/resonant-space";
import { encodeText } from "./encoding/text-encoder";
import { decodeResponse, poidsResonanceParCycle } from "./decoding/response-decoder";
import type { NeuralDecodedResponse } from "./decoding/response-decoder";
import type { CortexLangagierGen3, ContexteLangage } from "./generation/language";
import { HippocampusMemory } from "./memory/hippocampus";
import { MoteurEvolutionGen3 } from "./evolution";
import type { ResultatConsolidation } from "./evolution";
import { composerDepuisConnaissances } from "./connaissances-pont";
import { nouvelleFenetreNeuronale } from "./core/v2/effecteur-cortex";

/** Source du langage de la réponse (télémétrie honnête). */
export type SourceLangage =
  | "cortex_corpus"
  | "cortex_personnalisee"
  | "cortex_contexte"
  | "decoder_intention"
  | "pilotage"
  | "connaissances_utilisateur";

/** Composition finale : texte émis + provenance (traçabilité). */
export interface CompositionReponse {
  texte: string;
  source: SourceLangage;
  /** Thème du corpus quand la réponse vient du cortex (sinon undefined). */
  theme?: string;
  /** Score d'appariement du cortex (sinon undefined). */
  scoreAppariement?: number;
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

/** Réponse du moteur neuronal : AIResponse complet, provider neural. */
export interface NeuralAIResponse extends Omit<AIResponse, "provider"> {
  provider: NeuralProvider;
  model: typeof NEURAL_MODEL;
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

export class NeuralEngine {
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
   * Génération neuronale complète : encodage du prompt (texte extrait des
   * messages), fenêtre de cycles réels du noyau avec inférence propre
   * (adaptation (d) : reset complet des énergies — la mémoire vit dans les
   * synapses apprises, pas dans les potentiels transitoires), lecture des
   * résonances (maximum par pool sur la fenêtre), décodage honnête en français.
   */
  async generate(options: AIRequest): Promise<NeuralAIResponse> {
    const debut = Date.now();
    const prompt = extrairePrompt(options);

    const encodage = encodeText(prompt);
    const motsCles = selectionnerMotsCles(encodage.tokens);

    // Adaptation (d) : inférence propre — reset complet des énergies.
    this.reinitialiserEnergies();

    const resonances: Record<string, number> = {};
    let dernierRapport: CycleReport | undefined;
    // Fenêtre neuronale : identifiant unique — le Cortex v2 (effecteur)
    // remet ses énergies columnnaires à zéro à chaque nouvelle fenêtre
    // (miroir de l'adaptation (d), cf. effecteur-cortex.ts).
    const fenetre = nouvelleFenetreNeuronale();
    // Injection en VOLÉE UNIQUE (cycle 1) puis propagation libre — cf. trainer.
    for (let cycle = 1; cycle <= NEURAL_CYCLES_PAR_GENERATION; cycle++) {
      dernierRapport = this.noyau.executerCycle(
        cycle === 1
          ? { intensite: 0, inputsDirects: encodage.inputs }
          : { intensite: 0 },
        { prompt, __fenetreNeuronale: fenetre },
      );
      this.majResonancesMax(
        resonances,
        dernierRapport.spikedNeurones,
        cycle - 1,
      );
    }
    if (!dernierRapport) {
      throw new Error("Aucun cycle neuronal n'a pu être exécuté.");
    }

    const decode = decodeResponse(dernierRapport, resonances, motsCles);
    const messageUtilisateur = extraireDernierMessageUtilisateur(options);
    // PILOTAGE PLATEFORME d'abord (données réelles du compte) — puis le PONT
    // CONNAISSANCES (fragments réellement recherchés pour ce tour — c'est ce
    // qui rend les documents ingérés visibles dans les réponses), puis
    // cortex et décodeur, comme avant.
    const knowledgeContext = options.knowledgeContext?.trim() ?? "";
    const memoire = this.memoirePour(options);
    const composition =
      (await this.pilotage?.(messageUtilisateur, options)) ??
      (knowledgeContext ? composerDepuisConnaissances(messageUtilisateur, knowledgeContext) : null) ??
      this.composer(messageUtilisateur, decode, memoire);
    this.memoriser(messageUtilisateur, composition.texte, memoire);
    this.evoluer(messageUtilisateur, composition);

    return this.construireReponse(
      prompt,
      composition,
      decode,
      Date.now() - debut,
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
    const prompt = extrairePrompt(options);

    const encodage = encodeText(prompt);
    const motsCles = selectionnerMotsCles(encodage.tokens);

    let providerSignale = false;
    const emettre = async (delta: string): Promise<void> => {
      if (!providerSignale) {
        providerSignale = true;
        const signal = handlers.onProviderSelected?.("gen3-snn", NEURAL_MODEL);
        if (signal) await Promise.resolve(signal);
      }
      await handlers.onDelta(delta);
    };

    // Adaptation (d) : inférence propre — reset complet des énergies.
    this.reinitialiserEnergies();

    // Fragments : la progression des cycles n'est PLUS émise dans le flux
    // conversationnel (bruit) — les télémétries réelles restent dans raw.
    const resonances: Record<string, number> = {};
    let dernierRapport: CycleReport | undefined;
    // Fenêtre neuronale (cf. generate) — le Cortex v2 suit chaque fenêtre.
    const fenetre = nouvelleFenetreNeuronale();
    // Injection en VOLÉE UNIQUE (cycle 1) puis propagation libre — cf. trainer.
    for (let cycle = 1; cycle <= NEURAL_CYCLES_PAR_GENERATION; cycle++) {
      dernierRapport = this.noyau.executerCycle(
        cycle === 1
          ? { intensite: 0, inputsDirects: encodage.inputs }
          : { intensite: 0 },
        { prompt, __fenetreNeuronale: fenetre },
      );
      this.majResonancesMax(
        resonances,
        dernierRapport.spikedNeurones,
        cycle - 1,
      );
    }
    if (!dernierRapport) {
      throw new Error("Aucun cycle neuronal n'a pu être exécuté.");
    }

    const decode = decodeResponse(dernierRapport, resonances, motsCles);
    const messageUtilisateur = extraireDernierMessageUtilisateur(options);
    const knowledgeContext = options.knowledgeContext?.trim() ?? "";
    const composition =
      (await this.pilotage?.(messageUtilisateur, options)) ??
      (knowledgeContext ? composerDepuisConnaissances(messageUtilisateur, knowledgeContext) : null) ??
      this.composer(messageUtilisateur, decode);

    // La réponse composée est émise par segments (phrases réelles). Les
    // télémétries de cycles restent disponibles dans raw (plus de bruit de
    // progression dans le flux conversationnel).
    for (const segment of segmenterTexte(composition.texte)) {
      await emettre(segment);
      // Rend la main à l'event loop entre les segments (flux réel, sans
      // délai artificiel).
      await new Promise<void>((resoudre) => setImmediate(resoudre));
    }

    this.memoriser(messageUtilisateur, composition.texte);
    this.evoluer(messageUtilisateur, composition);
    return this.construireReponse(
      prompt,
      composition,
      decode,
      Date.now() - debut,
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
    const prompt = extrairePrompt(options);

    const encodage = encodeText(prompt);
    const motsCles = selectionnerMotsCles(encodage.tokens);

    // Adaptation (d) : inférence propre — reset complet des énergies.
    this.reinitialiserEnergies();

    const resonances: Record<string, number> = {};
    let dernierRapport: CycleReport | undefined;
    // Fenêtre neuronale (cf. generate) — le Cortex v2 suit chaque fenêtre.
    const fenetre = nouvelleFenetreNeuronale();
    // Injection en VOLÉE UNIQUE (cycle 1) puis propagation libre — cf. trainer.
    for (let cycle = 1; cycle <= NEURAL_CYCLES_PAR_GENERATION; cycle++) {
      dernierRapport = this.noyau.executerCycle(
        cycle === 1
          ? { intensite: 0, inputsDirects: encodage.inputs }
          : { intensite: 0 },
        { prompt, __fenetreNeuronale: fenetre },
      );
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

    const decode = decodeResponse(dernierRapport, resonances, motsCles);
    const messageUtilisateur = extraireDernierMessageUtilisateur(options);
    const memoire = this.memoirePour(options);
    const composition =
      (await this.pilotage?.(messageUtilisateur, options)) ??
      this.composer(messageUtilisateur, decode, memoire);

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
      }
      const reponse = this.cortex.repondre(prompt, contexte);
      if (reponse) {
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
        };
      }
    }

    // Repli : composition conversationnelle du décodeur (intention + réelles).
    return { texte: decode.texte, source: "decoder_intention" };
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

  /** Construit la réponse conforme AIResponse à partir du décodage réel. */
  private construireReponse(
    prompt: string,
    composition: CompositionReponse,
    decode: NeuralDecodedResponse,
    latencyMs: number,
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
        },
      },
    };
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

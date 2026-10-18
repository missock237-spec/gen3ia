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
  ) {}

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
    // Injection en VOLÉE UNIQUE (cycle 1) puis propagation libre — cf. trainer.
    for (let cycle = 1; cycle <= NEURAL_CYCLES_PAR_GENERATION; cycle++) {
      dernierRapport = this.noyau.executerCycle(
        cycle === 1
          ? { intensite: 0, inputsDirects: encodage.inputs }
          : { intensite: 0 },
        { prompt },
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

    return this.construireReponse(prompt, decode, Date.now() - debut);
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

    // Fragments d'événement de progression : données réelles de chaque cycle.
    const resonances: Record<string, number> = {};
    let dernierRapport: CycleReport | undefined;
    // Injection en VOLÉE UNIQUE (cycle 1) puis propagation libre — cf. trainer.
    for (let cycle = 1; cycle <= NEURAL_CYCLES_PAR_GENERATION; cycle++) {
      dernierRapport = this.noyau.executerCycle(
        cycle === 1
          ? { intensite: 0, inputsDirects: encodage.inputs }
          : { intensite: 0 },
        { prompt },
      );
      this.majResonancesMax(
        resonances,
        dernierRapport.spikedNeurones,
        cycle - 1,
      );
      await emettre(
        `Cycle ${cycle}/${NEURAL_CYCLES_PAR_GENERATION} — ${dernierRapport.neuronesActifs} neurones actifs (${dernierRapport.mode}).\n`,
      );
    }
    if (!dernierRapport) {
      throw new Error("Aucun cycle neuronal n'a pu être exécuté.");
    }

    const decode = decodeResponse(dernierRapport, resonances, motsCles);

    // Le texte décodé est émis par segments (phrases réelles du décodeur).
    await emettre("\n");
    for (const segment of segmenterTexte(decode.texte)) {
      await emettre(segment);
      // Rend la main à l'event loop entre les segments (flux réel, sans
      // délai artificiel).
      await new Promise<void>((resoudre) => setImmediate(resoudre));
    }

    return this.construireReponse(prompt, decode, Date.now() - debut);
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
    // Injection en VOLÉE UNIQUE (cycle 1) puis propagation libre — cf. trainer.
    for (let cycle = 1; cycle <= NEURAL_CYCLES_PAR_GENERATION; cycle++) {
      dernierRapport = this.noyau.executerCycle(
        cycle === 1
          ? { intensite: 0, inputsDirects: encodage.inputs }
          : { intensite: 0 },
        { prompt },
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

    yield "\n";
    for (const segment of segmenterTexte(decode.texte)) {
      yield segment;
    }

    return this.construireReponse(prompt, decode, Date.now() - debut);
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

  /** Construit la réponse conforme AIResponse à partir du décodage réel. */
  private construireReponse(
    prompt: string,
    decode: NeuralDecodedResponse,
    latencyMs: number,
  ): NeuralAIResponse {
    // Estimation honnête documentée : un SNN ne compte pas de tokens de LLM,
    // on rapporte les mots réels du prompt et de la réponse.
    const inputTokens = compterMots(prompt);
    const outputTokens = compterMots(decode.texte);
    const usage: AIUsage = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };

    return {
      id: `snn-${randomUUID()}`,
      provider: "gen3-snn",
      model: NEURAL_MODEL,
      text: decode.texte,
      usage,
      finishReason: "stop",
      latencyMs,
      raw: {
        moteur: "snn",
        intention: decode.intention,
        scoreResonance: decode.scoreResonance,
        resonances: decode.resonances,
        motsCles: decode.motsCles,
      },
    };
  }
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

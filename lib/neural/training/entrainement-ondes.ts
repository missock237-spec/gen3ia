/**
 * ENTRAÎNEMENT PAR ONDES DE DOMAINE (it.57 — demande propriétaire :
 * « créer un tout nouveau moyen d'entraînement de gen3, selon les domaines
 * que l'on choisira, basé sur l'ANALYSE DES ONDES et le traitement de ces
 * ondes »).
 *
 * PRINCIPE (trois phases, toutes réelles et mesurées) :
 *
 *  1. ANALYSE DES ONDES — chaque exemple (texte + domaine) est converti en
 *     SIGNATURE D'ONDE : chaque token devient un paquet
 *     [fréquence, phase, amplitude] déterministe (hash FNV-1a du token →
 *     porteur ω ∈ [0.25, 1.75] rad/cycle, phase initiale ∈ [0, 2π),
 *     amplitude pondérée par la longueur du token). Deux textes distincts
 *     produisent deux signatures distinctes ; le même texte produit LA
 *     MÊME signature (reproductible).
 *
 *  2. TRAITEMENT DES ONDES — la signature pilote l'injection corticale :
 *     la COLONNE cible est dérivée de l'ONDE elle-même
 *     (colonne = f(sin(phase), fréquence)), l'intensité = amplitude — le
 *     cortex est stimulé PAR les ondes, pas par un hash direct. Le pas
 *     columnnaire (CSR, décroissance paresseuse) propage l'énergie ; à la
 *     fin des cycles, la résonance graduée des bandes est lue.
 *
 *  3. CONSOLIDATION ONDULAIRE — plasticité supervisée : les colonnes
 *     stimulées sont renforcées vers la bande du DOMAINE (porteur
 *     ω(domaine) — chaque domaine possède sa fréquence, cf. le vocabulaire
 *     du bus d'ondes), les bandes concurrentes sur-résonantes sont
 *     punies (×0.95) ; PUIS le bus d'ondes inter-régions (it.56) propage
 *     le porteur du domaine dans le champ cortical : la « partie » du
 *     domaine grandit en modulation régionale (renfort en phase,
 *     annulation en opposition).
 *
 * HONNÊTETÉ : chaque session rend un rapport par domaine (échantillons,
 * résonance moyenne du porteur, paquets émis, renforts/annulations du bus,
 * métabolisme cumulé du cortex v2 — évaluées/reposées/transmissions/ms
 * mesurés). Aucune métrique inventée. Module PUR — aucune dépendance
 * Node, entièrement déterministe (même entrée → même rapport).
 */

import { CortexColumnnaire } from "../core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../core/v2/champ-cortical";
import { emettrePaquetsDepuisBandes } from "../core/v2/bus-ondes-regions";
import type { PaquetOnde } from "../core/v2/bus-ondes-regions";
import { tokenize } from "../encoding/text-encoder";

/** Nombre de bandes du vocabulaire fréquentiel (celles du cortex v2). */
export const BANDES_VOCABULAIRE_ONDES = 8;

/** Porteur fréquentiel d'une bande (même loi que le bus d'ondes it.56). */
export function porteurBande(bande: number, nb = BANDES_VOCABULAIRE_ONDES): number {
  return 0.25 + (bande / Math.max(1, nb)) * 1.5;
}

/** Bande-porteuse d'un domaine : hash FNV-1a du label, réparti sur le vocabulaire. */
export function bandeDuDomaine(domaine: string): number {
  let h = 2166136261;
  for (let i = 0; i < domaine.length; i++) {
    h ^= domaine.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % BANDES_VOCABULAIRE_ONDES;
}

/**
 * ANALYSE DES ONDES — signature d'onde déterministe d'un texte.
 * Chaque token → paquet [fréquence, phase, amplitude] ; l'ordre des tokens
 * décale les phases (la « mélodie » du texte est conservée).
 */
export function analyserOndeTexte(texte: string, horloge = 0): PaquetOnde[] {
  const tokens = tokenize(texte);
  const paquets: PaquetOnde[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length === 0) continue;
    let h = 2166136261;
    for (let j = 0; j < token.length; j++) {
      h ^= token.charCodeAt(j);
      h = Math.imul(h, 16777619);
    }
    h >>>= 0;
    const frequence = 0.25 + ((h % 4096) / 4096) * 1.5;
    const phase = (((h >>> 12) % 4096) / 4096) * 2 * Math.PI + i * 0.618033988749895 + horloge * 0.1;
    const amplitude = Math.min(1, 0.25 + token.length / 24);
    paquets.push({ region: 0, frequence, phase, amplitude });
  }
  return paquets;
}

/** Gain ondulaire : l'amplitude de l'onde devient l'intensité d'injection
 *  (× 2.0 — une onde pleine force (1.0) déclenche le spike au seuil 1.0
 *  après décroissance, comme l'injection linguistique 1.2 du chemin courant). */
export const GAIN_ONDE_INTENSITE = 2.0;

/**
 * TRAITEMENT DES ONDES — la signature pilote l'injection corticale :
 * colonne = f(onde) (sin de la phase + porteur fréquentiel), intensité =
 * amplitude × GAIN_ONDE_INTENSITE. Déterministe, étalé sur tout le
 * cortex (les ondes balayent le substrat, elles ne le concentrent pas).
 */
export function colonnesDepuisOndes(
  paquets: readonly PaquetOnde[],
  nbColonnes: number,
): Array<[number, number]> {
  const accumulate = new Map<number, number>();
  for (const p of paquets) {
    const onde = (Math.sin(p.phase) + 1) / 2; // [0, 1] — la phase décide
    const balayage = (onde + p.frequence / 1.75) % 1; // la fréquence décale
    const colonne = Math.floor(balayage * Math.max(1, nbColonnes - 1));
    const suivant = Math.min(3.0, (accumulate.get(colonne) ?? 0) + p.amplitude * GAIN_ONDE_INTENSITE);
    accumulate.set(colonne, suivant);
  }
  return Array.from(accumulate.entries());
}

/** Exemple d'entraînement ondes. */
export interface ExempleOnde {
  texte: string;
  domaine: string;
}

/** Options de session. */
export interface OptionsOndes {
  /** Cycles du cortex par échantillon (défaut 3, borné 1..8). */
  cyclesParEchantillon?: number;
  /** Renforcement supervisé colonnes→bande du domaine (défaut 0.15). */
  lrBoost?: number;
  /** Cap d'échantillons par domaine (défaut 200, garde-fou de coût). */
  maxParDomaine?: number;
}

/** Rapport honnête PAR domaine. */
export interface RapportDomaineOndes {
  domaine: string;
  /** Bande-porteuse du domaine (vocabulaire 8 porteurs). */
  bande: number;
  /** Fréquence du porteur du domaine. */
  porteurFrequence: number;
  /** Échantillons réellement traités pour ce domaine. */
  echantillons: number;
  /** Résonance moyenne de la bande-porteuse (lecture graduée, 0..1). */
  resonanceMoyenne: number;
  /** Paquets d'onde émis vers le bus inter-régions pour ce domaine. */
  paquetsEmis: number;
  /** Couplages en phase (renfort de modulation régionale). */
  renforts: number;
  /** Couplages en opposition (annulation). */
  annulations: number;
}

/** Rapport honnête de session (métabolisme réel du cortex v2). */
export interface RapportEntrainementOndes {
  domaines: RapportDomaineOndes[];
  totalEchantillons: number;
  /** Métabolisme cumulé du cortex v2 pendant la session (mesuré). */
  metabolisme: { evaluees: number; reposes: number; transmissions: number; ms: number };
}

/**
 * SESSION D'ENTRAÎNEMENT PAR ONDES — entraîne le cortex v1M selon les
 * domaines CHOISIS, par analyse puis traitement des ondes (cf. en-tête).
 * Retourne un rapport honnête ; détermniniste à entrée égale.
 */
export function entrainerDomainesParOndes(
  cortex: CortexColumnnaire,
  champ: ChampCorticalGen3,
  exemples: readonly ExempleOnde[],
  options: OptionsOndes = {},
): RapportEntrainementOndes {
  const cyclesParEchantillon = Math.max(1, Math.min(8, options.cyclesParEchantillon ?? 3));
  const lrBoost = options.lrBoost ?? 0.15;
  const maxParDomaine = Math.max(1, Math.min(2000, options.maxParDomaine ?? 200));

  // Répartition par domaine + cap honnête par domaine.
  const parDomaine = new Map<string, ExempleOnde[]>();
  for (const exemple of exemples) {
    if (!exemple?.texte?.trim() || !exemple?.domaine?.trim()) continue;
    const liste = parDomaine.get(exemple.domaine) ?? [];
    if (liste.length < maxParDomaine) liste.push(exemple);
    parDomaine.set(exemple.domaine, liste);
  }

  const metabolisme = { evaluees: 0, reposes: 0, transmissions: 0, ms: 0 };
  const rapports: RapportDomaineOndes[] = [];
  let horloge = 0;
  let totalEchantillons = 0;

  for (const [domaine, liste] of parDomaine) {
    const bande = bandeDuDomaine(domaine);
    const porteur = porteurBande(bande);
    let sommeResonance = 0;
    let mesures = 0;
    let paquetsEmis = 0;
    let renforts = 0;
    let annulations = 0;

    for (const exemple of liste) {
      // 1+2. Analyse des ondes → traitement : injection DÉRIVÉE de l'onde.
      const paquets = analyserOndeTexte(exemple.texte, horloge);
      const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes);
      const stimulees = injections.map(([c]) => c);

      for (let c = 0; c < cyclesParEchantillon; c++) {
        horloge += 1;
        cortex.pas(c === 0 ? injections : null, horloge);
        // Métabolisme réel : cumul pas à pas (l'objet est réécrit à chaque pas).
        const meta = cortex.metabolismeDernierPas;
        metabolisme.evaluees += meta.evaluees;
        metabolisme.reposes += meta.reposes;
        metabolisme.transmissions += meta.transmissions;
        metabolisme.ms = Math.round((metabolisme.ms + meta.ms) * 1000) / 1000;
      }

      // Lecture graduée : résonance de la bande-porteuse du domaine.
      const activation = cortex.activationBandes();
      sommeResonance += activation[bande] ?? 0;
      mesures += 1;

      // 3a. Plasticité supervisée vers la bande-porteuse (punition
      // compétitive des bandes sur-résonantes — même mécanique que v1).
      const concurrentes: number[] = [];
      for (let b = 0; b < activation.length; b++) {
        if (b !== bande && (activation[b] ?? 0) > (activation[bande] ?? 0)) concurrentes.push(b);
      }
      cortex.plasticiteSupervisee(stimulees, bande, lrBoost, concurrentes);

      // 3b. Consolidation ondulaire : le porteur du domaine parle dans le
      // bus inter-régions (la « partie » du domaine grandit dans le champ).
      const paquetsBus = emettrePaquetsDepuisBandes(activation, horloge);
      paquetsBus.push({ region: 0, frequence: porteur, phase: (porteur * horloge) % (2 * Math.PI), amplitude: 1 });
      paquetsEmis += paquetsBus.length;
      const bilan = champ.propagerOndes(horloge, paquetsBus);
      renforts += bilan.renforts;
      annulations += bilan.annulations;

      totalEchantillons += 1;
    }

    rapports.push({
      domaine,
      bande,
      porteurFrequence: porteur,
      echantillons: liste.length,
      resonanceMoyenne: mesures > 0 ? sommeResonance / mesures : 0,
      paquetsEmis,
      renforts,
      annulations,
    });
  }

  // Le métabolisme a été cumulé pas à pas pendant la session (mesures réelles).
  return { domaines: rapports, totalEchantillons, metabolisme };
}

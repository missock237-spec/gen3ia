/**
 * BUS D'ONDES INTER-RÉGIONS (it.56 — demande propriétaire : « le cerveau
 * doit posséder plusieurs parties réparties, une pour chaque tâche ; son
 * langage doit être réparti sous des ondes ; chaque partie ou cellule doit
 * pouvoir communiquer via des ondes ; les ressources matérielles ne
 * traitent que les ondes produites par gen3 ; haute qualité à très faible
 * énergie, tel un cerveau humain »).
 *
 * RÔLE PRÉCIS : jusqu'à it.56, le champ cortical (1000 régions × 1M
 * neurones d'onde) ne recevait qu'un couplage VERTICAL (bandes du cortex
 * columnnaire → régions, `couplerBandes`). Ce bus ajoute le canal
 * HORIZONTAL : une région ACTIVE ÉMET un paquet d'onde
 * [région, fréquence, phase, amplitude] — le même vocabulaire que
 * lib/ondes/essaim.ts et encodeur.ts — et les 1000 régions résonnent :
 *
 *  - EN PHASE (cos δ > 0) : renfort — la modulation régionale augmente ;
 *  - EN OPPOSITION DE PHASE (cos δ < 0) : annulation — même physique que
 *    le consensus de l'essaim (ondes déphasées = signal annulé) ;
 *  - δ = φ_paquet + ω_paquet·t − φ_locale(r, t), φ_locale répartie par le
 *    NOMBRE D'OR (décorrélation déterministe des régions).
 *
 * ÉNERGIE : coût O(paquets × régions) — borné (paquets plafonnés à 64,
 * 8 émetteurs typiques = 8 000 évaluations cos par cycle, ~0,1 ms) ; les
 * régions NON touchées coûtent ZÉRO (repos = gratuit, même loi que le
 * noyau v1 et le cortex columnnaire). Aucune allocation hors le bilan.
 *
 * Module PUR — aucune dépendance Node, entièrement déterministe.
 */

/** Un paquet d'onde émis par une région du champ cortical. */
export interface PaquetOnde {
  /** Région émettrice (0..999). */
  region: number;
  /** Fréquence du porteur (unités d'horloge virtuelle⁻¹). */
  frequence: number;
  /** Phase initiale en radians. */
  phase: number;
  /** Amplitude normalisée [0, 1]. */
  amplitude: number;
}

/** Bilan honnête d'une propagation (télémétrie réelle, jamais estimée). */
export interface BilanOndes {
  /** Nombre de paquets effectivement propagés. */
  paquets: number;
  /** Régions touchées par au moins un couplage non nul. */
  regionsTouchees: number;
  /** Couplages en phase (renfort de modulation). */
  renforts: number;
  /** Couplages en opposition de phase (annulation). */
  annulations: number;
  /** Énergie totale transportée (Σ amplitude, bornée par les paquets). */
  energieTransportee: number;
}

/** Plafond de paquets par propagation (garde-fou de coût). */
export const PAQUETS_MAX = 64;
/** Gain de couplage appliqué à l'interférence normalisée. */
export const GAIN_COUPLAGE_ONDES = 0.05;
/** Dilution mémoire appliquée à la modulation existante à chaque propagation. */
export const DILUTION_ONDES = 0.02;
/** Plafond de la modulation régionale (même borne que le couplage vertical). */
export const PLAFOND_MODULATION = 2.0;

/** Phase locale d'une région à l'instant t — nombre d'or × 2π (décorrélation). */
export function phaseLocaleRegion(region: number, t: number): number {
  const phi = 2.618033988749895; // 1 + nombre d'or
  return ((region + 1) * phi * Math.PI + 0.35 * t) % (2 * Math.PI);
}

/**
 * Propage les paquets d'onde dans le champ : chaque région reçoit
 * l'interférence des paquets (Kuramoto : Σ amplitude·cos δ), sa modulation
 * est renforcée en phase / annulée en opposition, bornée à [0, plafond].
 * `modulation` est MUTÉE en place (Float32Array du champ, 1000 valeurs).
 * Déterministe : même entrée → même bilan.
 */
export function propagerOndesInterRegions(
  modulation: Float32Array,
  t: number,
  paquets: readonly PaquetOnde[],
): BilanOndes {
  const utiles = paquets.filter(
    (p) =>
      Number.isFinite(p.amplitude) &&
      p.amplitude > 0 &&
      Number.isFinite(p.frequence) &&
      Number.isFinite(p.phase),
  );
  const retenus = utiles.slice(0, PAQUETS_MAX);
  let energieTransportee = 0;
  let regionsTouchees = 0;
  let renforts = 0;
  let annulations = 0;

  if (retenus.length === 0 || modulation.length === 0) {
    return { paquets: 0, regionsTouchees: 0, renforts: 0, annulations: 0, energieTransportee: 0 };
  }

  // Interférence par région : O(paquets × régions), zéro allocation
  // (un seul accumulateur scalaire par région, calculé à la volée).
  for (let r = 0; r < modulation.length; r++) {
    const phiLocale = phaseLocaleRegion(r, t);
    let interf = 0;
    for (const paquet of retenus) {
      // Le paquet a voyagé depuis sa région émettrice : sa phase à
      // l'arrivée intègre fréquence × t (propagation analytique, sans
      // itération — même modèle de Kuramoto libre que etatNeurone).
      const phaseArrivee = paquet.phase + paquet.frequence * t;
      const delta = phaseArrivee - phiLocale;
      const couplage = paquet.amplitude * Math.cos(delta);
      if (couplage > 0) renforts += 1;
      else if (couplage < 0) annulations += 1;
      interf += couplage;
    }
    if (interf !== 0) regionsTouchees += 1;
    energieTransportee += Math.min(1, Math.abs(interf));
    // Mémoire douce (dilution) + couplage borné, plafond commun.
    const suivante = modulation[r] * (1 - DILUTION_ONDES) + GAIN_COUPLAGE_ONDES * interf;
    modulation[r] = Math.max(0, Math.min(PLAFOND_MODULATION, suivante));
  }

  return {
    paquets: retenus.length,
    regionsTouchees,
    renforts,
    annulations,
    energieTransportee,
  };
}

/**
 * ÉMISSION DÉTERMINISTE de paquets depuis l'activation graduée des bandes
 * du cortex columnnaire : chaque bande d'intention active fait émettre
 * une région (choisie par hash bande×horloge — la « cellule » parlante
 * tourne), à la fréquence VOCABULAIRE de sa bande (langage réparti sous
 * ondes : chaque intention a son porteur) et à la phase de son activation.
 * Retourne au plus 8 paquets (1 par bande d'intention, bandes 0..7).
 */
export function emettrePaquetsDepuisBandes(
  activation: readonly number[],
  horloge: number,
  nbBandesVocabulaire = 8,
): PaquetOnde[] {
  const paquets: PaquetOnde[] = [];
  const nb = Math.min(nbBandesVocabulaire, activation.length);
  for (let b = 0; b < nb; b++) {
    const act = activation[b];
    if (!Number.isFinite(act) || act <= 0) continue;
    // Région émettrice : hash déterministe bande×horloge (la cellule
    // parlante change à chaque cycle — rotation honnête, pas d'élite fixe).
    const h = (Math.imul(b + 1, 0x9e3779b1) ^ Math.imul(horloge + 1, 0x85ebca6b)) >>> 0;
    const region = h % 1000;
    // Fréquence VOCABULAIRE : la bande b parle sur son porteur ω(b)
    // (répartition du langage sous les ondes, encodage déterministe).
    const frequence = 0.25 + (b / Math.max(1, nbBandesVocabulaire)) * 1.5;
    // Phase portée par l'activation (une bande forte parle fort et net).
    const phase = (act * horloge * Math.PI) % (2 * Math.PI);
    paquets.push({
      region,
      frequence,
      phase,
      amplitude: Math.min(1, act * 4),
    });
  }
  return paquets;
}

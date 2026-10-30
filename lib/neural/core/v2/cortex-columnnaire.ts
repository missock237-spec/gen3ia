/**
 * CORTEX COLUMNNAIRE GEN3 (v2) — étage 2 de l'architecture hiérarchique.
 *
 * Le réseau v1 (`ReseauNeuronalGen3`, 100 neurones) est conservé tel quel :
 * il devient le NOYAU PROFOND du système (zones de tokens 0..37, pools de
 * sortie 38..99 — compatibilité totale avec le trainer, le décodeur, les
 * effecteurs et la persistance). Le cortex columnnaire lui ajoute une
 * surface de calcul massive : `colonnes` unités accumulate-and-fire
 * (défaut 262 144 = 2^18) implémentées en TYPED ARRAYS purs.
 *
 * POURQUOI C'EST RAPIDE (le même modèle mathématique que v1, sans ses
 * coûts cachés) :
 *  1. Typed arrays contigus (Float32Array / Float64Array / Uint32Array)
 *     au lieu d'objets `Neurone` avec historique `number[]` — cache-friendly,
 *     ~100× moins de mémoire par unité, zéro GC dans le chemin chaud ;
 *  2. PUSH CSR : la connectivité est stockée au format CSR (Compressed
 *     Sparse Row). Un cycle n'itère que les arêtes sortantes des unités qui
 *     SPIKE (O(spikes × voisins)) — v1 scannait TOUTES les synapses à chaque
 *     cycle (O(S) même sans spike) ;
 *  3. DÉCROISSANCE PARESSEUSE EXACTE : v1 applique `e *= 1-d` à CHAQUE
 *     unité à CHAQUE cycle. Ici, l'énergie est avancée en forme fermée
 *     `e(t2) = e(t1) × (1-d)^(t2-t1)` uniquement quand l'unité est touchée —
 *     strictement équivalent (prouvé dans les tests unitaires contre une
 *     boucle « naïve » pas à pas), coût constant par unité TOUCHÉE ;
 *  4. ÉVÉNEMENTIEL : une unité ne franchit son seuil que lorsqu'elle REÇOIT
 *     de l'énergie (injection externe ou transmission en attente) — seules
 *     les unités stimulées sont évaluées.
 *
 * SÉMANTIQUE EXACTE CONSERVÉE (fidèle à v1, ordre d'un cycle) :
 *  (1) injections externes — décroissies UNE fois au même cycle (v1 :
 *      receiveInput PUIS updateState qui décroît avant le test de seuil) ;
 *  (2) évaluation → spikes (reset à zéro, horodatage) ;
 *  (3) transmission CSR le long des unités qui ont spiké : la cible reçoit
 *      le poids APRÈS l'update (décroissé au cycle suivant, comme v1) avec
 *      plasticité (renforcement si la cible a spiké dans la fenêtre).
 *
 * Module PUR — aucune dépendance Node, entièrement déterministe (seed).
 */

/**
 * Métabolisme du DERNIER pas (it.56 — extension au cortex v2 du modèle
 * v1 : le coût est ∝ ACTIVITÉ, le repos est gratuit — « très faible
 * quantité d'énergie tel un cerveau humain »). Mesuré, jamais estimé.
 */
export interface MetabolismePasV2 {
  /** Colonnes réellement évaluées (recevant énergie ou transmission). */
  evaluees: number;
  /** Colonnes au repos ce cycle (coût ZÉRO — total − évaluées). */
  reposes: number;
  /** Transmissions CSR poussées le long des colonnes qui ont spiké. */
  transmissions: number;
  /** Coût réel du pas en millisecondes (performance.now). */
  ms: number;
}

/** Configuration du cortex columnnaire. */
export interface CortexColumnnaireConfig {
  /** Nombre de colonnes (unités neurales réelles). Défaut 1 048 576 = 2^20
   *  (it.56 — demande propriétaire : « un million de neurones »). */
  colonnes: number;
  /** Arêtes sortantes par colonne. Défaut 12 : 8 vers les bandes de
   *  lecture (1 garantie par bande) + 4 intra-cortex aléatoires. */
  voisins: number;
  /**
   * BANDES DE LECTURE GARANTIES : les `bandesLecture` premières bandes
   * reçoivent EXACTEMENT une arête de chaque colonne (convergence many→one
   * assurée — même mécanisme que les pools v1 : beaucoup de sources, peu
   * de cibles). Les bandes au-delà ne reçoivent que des cascades.
   */
  bandesLecture: number;
  /** Seuil de spike. */
  seuil: number;
  /** Décroissance fractionnaire par cycle (0.1 comme v1). */
  decroissance: number;
  /** Fenêtre de plasticité (unités d'horloge virtuelle, 2.0 comme v1). */
  plasticiteFenetre: number;
  /** Renforcement synaptique supervisé. */
  lrBoost: number;
  /** Graine déterministe (structure CSR + poids initiaux). */
  seed: number;
  /** Nombre de bandes de sortie (groupes de colonnes pour la résonance). */
  bandes: number;
}

/** Valeurs par défaut — it.56 (demande propriétaire : « un million de
 *  neurones ») : 1 048 576 colonnes = 2^20 (×4 l'ancien 2^18). Budget
 *  mémoire ~117 Mo (CSR 12 arêtes/colonne) — compatible VPS 2 Go ; la
 *  persistance gère la migration honnête (artefact de taille ≠ → cortex
 *  neuf seedé, message [NEURAL-V2] explicite). */
export const CORTEX_CONFIG_DEFAUTS: CortexColumnnaireConfig = {
  colonnes: 1048576,
  voisins: 12,
  bandesLecture: 8,
  seuil: 1.0,
  decroissance: 0.1,
  plasticiteFenetre: 2.0,
  lrBoost: 0.15,
  seed: 42,
  bandes: 32,
};

/** Intensité par occurrence d'un token projeté (aligné sur l'encodeur v1). */
export const INTENSITE_TOKEN_CORTEX = 1.2;

/** Intensité maximale cumulée par colonne depuis la projection d'un texte. */
export const INTENSITE_MAX_CORTEX = 3.0;

/** Statistiques descriptives du cortex (API, télémétrie honnête). */
export interface CortexColumnnaireStats {
  colonnes: number;
  aretes: number;
  bandes: number;
  /** Mémoire résidente estimée du moteur (Mo). */
  memoireMo: number;
  /** Somme des résonances de bandes du dernier cycle. */
  activiteDernierCycle: number;
  /** Résonance par bande du dernier cycle (fraction de la bande ayant spiké). */
  resonanceBandes: number[];
  /** Moyenne mobile exponentielle du coût d'un cycle (ms). */
  msCycleEma: number;
  /** Débit mesuré : cycles par seconde (inverse de msCycleEma). */
  cyclesParSeconde: number;
}

/**
 * CORTEX COLUMNNAIRE — réservoir neuronal massif à plasticité locale.
 * (Technique établie de « reservoir computing » : structure générée
 * déterministe, poids entraînables.)
 */
export class CortexColumnnaire {
  readonly config: CortexColumnnaireConfig;

  /** Énergie courante de chaque colonne (transitoire, décroissance paresseuse). */
  readonly energies: Float32Array;
  /** Horloge virtuelle du dernier spike de chaque colonne (plasticité). */
  readonly dernierSpike: Float64Array;
  /** Cycle dont la décroissance a déjà été appliquée à chaque colonne. */
  readonly dernierTouche: Float64Array;
  /** Drapeau « a spiké ce cycle » (réutilisé, libéré en fin de pas). */
  private flagSpike: Uint8Array;

  /** CSR : offsets (colonnes+1), cibles et poids (colonnes × voisins). */
  readonly csrOffset: Uint32Array;
  readonly csrCible: Uint32Array;
  readonly csrPoids: Float32Array;

  /** Colonnes recevant une transmission (évaluées au cycle suivant). */
  private enAttente: number[] = [];

  /** Résonance SPIKE par bande du dernier pas (mécanique pulsaire). */
  private dernierResonance: Float32Array;

  /** Métabolisme du dernier pas (it.56 — coût ∝ activité, repos gratuit). */
  readonly metabolismeDernierPas: MetabolismePasV2 = {
    evaluees: 0,
    reposes: 0,
    transmissions: 0,
    ms: 0,
  };

  /**
   * LECTURE GRADUÉE : énergie totale reçue par bande via les transmissions
   * du dernier pas (readout standard du reservoir computing — la structure
   * CSR fixe ne converge pas many→one sur une cible unique, la lecture
   * spike seule noierait le signal appris dans le bruit de Poisson).
   */
  private energieBandes: Float32Array;

  /** Coût EMA d'un pas (ms). */
  private msCycle = 0;

  constructor(config: Partial<CortexColumnnaireConfig> = {}) {
    this.config = { ...CORTEX_CONFIG_DEFAUTS, ...config };
    const n = this.config.colonnes;

    this.energies = new Float32Array(n);
    this.dernierSpike = new Float64Array(n);
    this.dernierTouche = new Float64Array(n);
    this.flagSpike = new Uint8Array(n);
    this.dernierResonance = new Float32Array(this.config.bandes);
    this.energieBandes = new Float32Array(this.config.bandes);

    const aretes = n * this.config.voisins;
    this.csrOffset = new Uint32Array(n + 1);
    this.csrCible = new Uint32Array(aretes);
    this.csrPoids = new Float32Array(aretes);

    this.genererStructure();
  }

  /**
   * Hash 32 bits déterministe (xorshift-multiply) — la « signature »
   * structurante du câblage (colonne, voie, graine).
   */
  private hash32(a: number, b: number): number {
    let h =
      Math.imul(a + 1, 0x9e3779b1) ^
      Math.imul(b + 1, 0x85ebca6b) ^
      this.config.seed;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /**
   * Génère la structure CSR déterministe :
   *  - arêtes [0, bandesLecture) : UNE cible garantie par bande de lecture
   *    (hash déterministe dans l'intervalle de la bande) — convergence
   *    many→one sur les zones de lecture, comme les pools v1 ;
   *  - arêtes [bandesLecture, voisins) : cibles intra-cortex aléatoires
   *    (dynamique de réservoir, cascades, activité de fond).
   * Poids initiaux uniformes dans [0.1, 0.5] — même distribution que v1.
   */
  private genererStructure(): void {
    const { colonnes, voisins, seed, bandes } = this.config;
    const parBande = Math.floor(colonnes / bandes);
    const lecture = Math.min(this.config.bandesLecture, voisins, bandes);
    let etat = seed >>> 0;
    const alea = (): number => {
      // mulberry32 inline (même générateur que core/rng.ts) — éviter
      // les allocations de closure par arête sur 3M d'arêtes.
      etat = (etat + 0x6d2b79f5) | 0;
      let t = Math.imul(etat ^ (etat >>> 15), 1 | etat);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let c = 0; c < colonnes; c++) {
      this.csrOffset[c] = c * voisins;
      for (let k = 0; k < voisins; k++) {
        let cible: number;
        if (k < lecture) {
          // Cible garantie dans la bande de lecture k.
          cible = k * parBande + (this.hash32(c, k) % parBande);
        } else {
          // Cible intra-cortex aléatoire (réservoir).
          cible = this.hash32(c, k + 1000) % colonnes;
        }
        if (cible === c) cible = (cible + 1) % colonnes; // pas d'auto-boucle
        this.csrCible[c * voisins + k] = cible;
        this.csrPoids[c * voisins + k] = 0.1 + alea() * 0.4;
      }
    }
    this.csrOffset[colonnes] = colonnes * voisins;
  }

  /**
   * Avance la décroissance d'une colonne jusqu'au cycle `t` (forme fermée
   * EXACTE — équivaut à `e *= 1-d` appliqué à chaque cycle intermédiaire,
   * comme updateState() de v1 qui tourne sur toutes les unités). Chemin
   * rapide pour dt = 1 (le cas dominant).
   */
  private avancerDecroissance(c: number, t: number): void {
    const dt = t - this.dernierTouche[c];
    if (dt <= 0) return;
    const facteur =
      dt === 1 ? 1 - this.config.decroissance : Math.pow(1 - this.config.decroissance, dt);
    this.energies[c] *= facteur;
    this.dernierTouche[c] = t;
  }

  /**
   * Évalue une colonne au cycle `t` avec une injection externe `injection`
   * (0 pour une évaluation de transmission seule).
   *
   * Fidélité v1 : l'injection est décroissie UNE fois au même cycle
   * (receiveInput PUIS updateState qui décroît avant le test), la décroissance
   * du stock s'applique via avancerDecroissance, un seul test de seuil, un
   * seul spike possible par cycle (drapeau).
   */
  private evaluerColonne(c: number, injection: number, t: number): boolean {
    if (this.flagSpike[c] === 1) return false; // déjà spiké ce cycle
    this.avancerDecroissance(c, t);
    if (injection !== 0) {
      this.energies[c] += injection * (1 - this.config.decroissance);
    }
    if (this.energies[c] >= this.config.seuil) {
      this.energies[c] = 0;
      this.dernierSpike[c] = t;
      this.flagSpike[c] = 1;
      return true;
    }
    return false;
  }

  /**
   * Injecte des énergies externes [[colonne, intensité]] (dédupliquées)
   * puis exécute un pas complet à l'instant `t` : évaluation des colonnes
   * stimulées et des transmissions en attente du cycle précédent, spikes,
   * transmission CSR, plasticité. Retourne les colonnes ayant spiké.
   */
  pas(injections: Array<[number, number]> | null, t: number): number[] {
    const debut = performance.now();
    const spikes: number[] = [];
    const { voisins, plasticiteFenetre, lrBoost, bandes, colonnes } =
      this.config;

    // ---- (1)+(2) Évaluation : transmissions en attente + injections ------
    // (une colonne ne franchit le seuil que lorsqu'elle reçoit de l'énergie)
    let evaluees = 0;
    if (this.enAttente.length > 0) {
      const attente = this.enAttente;
      this.enAttente = [];
      evaluees += attente.length;
      for (const c of attente) {
        if (this.evaluerColonne(c, 0, t)) spikes.push(c);
      }
    }
    if (injections && injections.length > 0) {
      evaluees += injections.length;
      for (const [c, valeur] of injections) {
        if (c < 0 || c >= colonnes) continue;
        if (this.evaluerColonne(c, valeur, t)) spikes.push(c);
      }
    }

    // ---- (3) Transmission CSR le long des colonnes qui ont spiké ---------
    // Fidélité v1 : le poids est ajouté APRÈS l'update du cycle (il sera
    // décroissé au cycle suivant, exactement comme updateState de v1).
    const parBande = Math.floor(colonnes / bandes);
    this.energieBandes.fill(0);
    for (const s of spikes) {
      const base = s * voisins;
      for (let k = 0; k < voisins; k++) {
        const p = base + k;
        const cible = this.csrCible[p];
        this.avancerDecroissance(cible, t);
        this.energies[cible] += this.csrPoids[p];
        this.energieBandes[Math.min(bandes - 1, Math.floor(cible / parBande))] +=
          this.csrPoids[p];
        this.enAttente.push(cible);
        // Plasticité (renforcement si la cible a spiké récemment).
        const dt = t - this.dernierSpike[cible];
        if (dt > 0 && dt < plasticiteFenetre) {
          this.csrPoids[p] = Math.min(1.0, this.csrPoids[p] + lrBoost);
        }
      }
    }

    // Résonance SPIKE par bande (fraction de la bande ayant spiké ce cycle).
    this.dernierResonance.fill(0);
    for (const s of spikes) {
      this.dernierResonance[Math.min(bandes - 1, Math.floor(s / parBande))] += 1;
    }
    for (let b = 0; b < bandes; b++) {
      this.dernierResonance[b] /= parBande;
    }

    // Libère les drapeaux (coût O(spikes), jamais O(colonnes)).
    for (const s of spikes) this.flagSpike[s] = 0;

    // EMA du coût (mesure réelle, télémétrie honnête).
    const cout = performance.now() - debut;
    this.msCycle = this.msCycle === 0 ? cout : this.msCycle * 0.9 + cout * 0.1;

    // Métabolisme v2 (it.56) : coût ∝ activité — les colonnes non
    // stimulées sont au REPOS (coût zéro, jamais itérées).
    this.metabolismeDernierPas.evaluees = evaluees;
    this.metabolismeDernierPas.reposes = colonnes - evaluees;
    this.metabolismeDernierPas.transmissions = spikes.length * voisins;
    this.metabolismeDernierPas.ms = cout;

    return spikes;
  }

  /**
   * Projection texte → colonnes : mêmes règles de hachage que l'encodeur
   * v1 (FNV-1a 32 bits), espace élargi aux colonnes (262 144 vs 38 neurones
   * — la collision entre mots distincts devient rare). Retourne
   * [[colonne, intensité]] avec cap d'intensité par colonne (dédupliqué).
   * `tokens` est supposé déjà tokenisé (cf. encoding/text-encoder.tokenize).
   */
  projetterTokens(tokens: string[]): Array<[number, number]> {
    const accumule = new Map<number, number>();
    for (const token of tokens) {
      if (token.length === 0) continue;
      const colonne = hashTokenVersColonne(token, this.config.colonnes);
      const suivant = Math.min(
        INTENSITE_MAX_CORTEX,
        (accumule.get(colonne) ?? 0) + INTENSITE_TOKEN_CORTEX,
      );
      accumule.set(colonne, suivant);
    }
    return Array.from(accumule.entries());
  }

  /**
   * PLASTICITÉ SUPERVISÉE — renforce les arêtes CSR des colonnes stimulées
   * qui ciblent la bande `bande` (miroir columnnaire du renforcement
   * entrée→pool du trainer v1), puis affaiblit les arêtes ciblant les
   * bandes concurrentes dont la résonance a dépassé celle de la bande cible
   * (punition compétitive, × 0.95 comme v1).
   */
  plasticiteSupervisee(
    colonnesStimulees: Iterable<number>,
    bande: number,
    boost: number,
    bandesConcurrentesSurResonantes: readonly number[],
  ): void {
    const parBande = Math.floor(this.config.colonnes / this.config.bandes);
    const debutBande = bande * parBande;
    const finBande = Math.min(this.config.colonnes, debutBande + parBande);
    const concurrentes = new Set(bandesConcurrentesSurResonantes);

    for (const c of colonnesStimulees) {
      if (c < 0 || c >= this.config.colonnes) continue;
      const base = c * this.config.voisins;
      for (let k = 0; k < this.config.voisins; k++) {
        const p = base + k;
        const cible = this.csrCible[p];
        if (cible >= debutBande && cible < finBande) {
          this.csrPoids[p] = Math.min(1.0, this.csrPoids[p] + boost);
        } else if (concurrentes.has(Math.floor(cible / parBande))) {
          this.csrPoids[p] *= 0.95;
        }
      }
    }
  }

  /** Bande d'appartenance d'une colonne. */
  bandeDe(colonne: number): number {
    const parBande = Math.floor(this.config.colonnes / this.config.bandes);
    return Math.min(this.config.bandes - 1, Math.floor(colonne / parBande));
  }

  /** Résonance par bande du dernier pas (copie défensive). */
  resonanceBandes(): number[] {
    return Array.from(this.dernierResonance);
  }

  /**
   * LECTURE GRADUÉE normalisée par bande : part de l'énergie totale reçue
   * via les transmissions du dernier pas, normalisée (somme = 1). La bande
   * entraînée — ses arêtes renforcées vers elle — se détache nettement du
   * bruit uniforme de fond. Utilisée par l'effecteur (remontée vers les
   * pools v1, consolidation supervisée) et le pré-entraînement.
   */
  activationBandes(): number[] {
    let somme = 0;
    for (let b = 0; b < this.energieBandes.length; b++) somme += this.energieBandes[b];
    const sortie = new Array<number>(this.energieBandes.length);
    if (somme <= 0) {
      sortie.fill(0);
      return sortie;
    }
    for (let b = 0; b < this.energieBandes.length; b++) {
      sortie[b] = this.energieBandes[b] / somme;
    }
    return sortie;
  }

  /** Remet à zéro l'état transitoire (nouvelle inférence propre). */
  reinitialiserEnergies(): void {
    this.energies.fill(0);
    this.dernierTouche.fill(0);
    this.enAttente = [];
    this.dernierResonance.fill(0);
    this.energieBandes.fill(0);
    // flagSpike est déjà toujours libéré en fin de pas.
  }

  /** Stats descriptives + télémétrie de vitesse réelle. */
  stats(): CortexColumnnaireStats {
    const aretes = this.config.colonnes * this.config.voisins;
    // énergies f32 + dernierSpike f64 + dernierTouche f64 + flags u8
    // + offsets u32 + cibles u32 + poids f32
    const octets =
      this.config.colonnes * (4 + 8 + 8 + 1 + 4) + aretes * (4 + 4);
    return {
      colonnes: this.config.colonnes,
      aretes,
      bandes: this.config.bandes,
      memoireMo: Math.round((octets / 1048576) * 10) / 10,
      activiteDernierCycle: this.dernierResonance.reduce((a, b) => a + b, 0),
      resonanceBandes: this.resonanceBandes(),
      msCycleEma: Math.round(this.msCycle * 1000) / 1000,
      cyclesParSeconde: this.msCycle > 0 ? Math.round(1000 / this.msCycle) : 0,
    };
  }

  /**
   * Exporte l'état STRUCTURAL appris (poids CSR) — les énergies sont
   * transitoires et ne sont jamais persistées (comme v1).
   */
  exporterPoids(): Float32Array {
    return this.csrPoids.slice();
  }

  /** Importe des poids CSR (longueur exacte requise). */
  importerPoids(poids: Float32Array): boolean {
    if (poids.length !== this.csrPoids.length) return false;
    this.csrPoids.set(poids);
    return true;
  }
}

/**
 * Hash FNV-1a 32 bits d'un token vers une colonne — même algorithme que
 * l'encodeur v1 (`hashToken`), espace élargi à `colonnes`.
 */
export function hashTokenVersColonne(token: string, colonnes: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % colonnes;
}

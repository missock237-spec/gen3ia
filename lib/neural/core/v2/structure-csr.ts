/**
 * STRUCTURE CSR PARTAGÉE (it.73 — sobriété énergétique).
 *
 * Le câblage déterministe du cortex columnnaire (hash 32 bits + mulberry32)
 * était écrit en privé dans `CortexColumnnaire.genererStructure`. it.73 en
 * extrait une fonction PURE partagée : la classe de production ET le moteur
 * compact embarqué (téléphone, `cortex-telephone.ts`) utilisent EXACTEMENT
 * le même code — l'identité bit à bit des deux structures est donc garantie
 * PAR CONSTRUCTION (et re-verrouillée par la garde 42ᵉ).
 *
 * Module PUR — aucune dépendance Node, déterministe (seed).
 */

/** Configuration minimale du câblage (sous-ensemble de la config cortex). */
export interface StructureCSRConfig {
  colonnes: number;
  voisins: number;
  bandesLecture: number;
  bandes: number;
  seed: number;
}

/**
 * Hash 32 bits déterministe (xorshift-multiply) — la « signature »
 * structurante du câblage (colonne, voie, graine). Code identique au
 * `hash32` historique de CortexColumnnaire (déplacé ici, non copié).
 */
export function hash32Structure(a: number, b: number, seed: number): number {
  let h =
    Math.imul(a + 1, 0x9e3779b1) ^
    Math.imul(b + 1, 0x85ebca6b) ^
    seed;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Génère la structure CSR déterministe DANS les tableaux fournis
 * (zéro allocation cachée — la classe de production passe ses propres
 * tableaux, le moteur compact les siens) :
 *  - arêtes [0, bandesLecture) : UNE cible garantie par bande de lecture
 *    (hash déterministe dans l'intervalle de la bande) — convergence
 *    many→one sur les zones de lecture, comme les pools v1 ;
 *  - arêtes [bandesLecture, voisins) : cibles intra-cortex aléatoires
 *    (dynamique de réservoir, cascades, activité de fond).
 * Poids initiaux uniformes dans [0.1, 0.5] — même distribution que v1.
 */
export function remplirStructureCSR(
  config: StructureCSRConfig,
  csrOffset: Uint32Array,
  csrCible: Uint32Array,
  csrPoids?: Float32Array,
): void {
  const { colonnes, voisins, seed, bandes } = config;
  const parBande = Math.floor(colonnes / bandes);
  const lecture = Math.min(config.bandesLecture, voisins, bandes);
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
    csrOffset[c] = c * voisins;
    for (let k = 0; k < voisins; k++) {
      let cible: number;
      if (k < lecture) {
        // Cible garantie dans la bande de lecture k.
        cible = k * parBande + (hash32Structure(c, k, seed) % parBande);
      } else {
        // Cible intra-cortex aléatoire (réservoir).
        cible = hash32Structure(c, k + 1000, seed) % colonnes;
      }
      if (cible === c) cible = (cible + 1) % colonnes; // pas d'auto-boucle
      csrCible[c * voisins + k] = cible;
      if (csrPoids) {
        // it.73 — poids optionnels : le moteur compact (téléphone) écrase
        // les poids initiaux par le snapshot u8 — générer 6 Mo de f32
        // temporaires pour les jeter serait du gaspillage énergétique.
        // Les cibles ne dépendent PAS du flux alea (hash seul) — sauter
        // les poids ne change pas la structure.
        csrPoids[c * voisins + k] = 0.1 + alea() * 0.4;
      }
    }
  }
  csrOffset[colonnes] = colonnes * voisins;
}

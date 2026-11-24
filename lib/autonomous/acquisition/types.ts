/**
 * CONTRATS DE L'ACQUISITION AUTONOME (Lot 2 du plan « GEN3IA AUTONOMOUS
 * BRAIN » — branche evolution/autonomous-brain-lots2-5).
 *
 * Le collecteur 24/7 par cycles de 5 minutes : Gen3ia recherche et
 * récupère CONTINUELLEMENT des connaissances publiques, via des modules
 * supervisés par l'Autonomous Core (contrat ModuleAgent).
 *
 * Contraintes non négociables du plan et de la mission :
 *  - cycle de collecte = 5 minutes (défaut du core) — les cycles sont
 *    indépendants (le core garantit le non-blocage) ;
 *  - respect des licences, conditions d'accès et limites de débit :
 *    seules des API publiques documentées sont collectées, avec un
 *    intervalle minimum PAR source et un User-Agent honnête ;
 *  - aucune perte silencieuse : chaque collecte produit un LOT tracé dans
 *    la file persistante du pipeline (Lot 3) ;
 *  - zéro dépendance à une IA externe : extraction locale uniquement.
 */

/** Types de sources autorisées (API publiques documentées uniquement). */
export type TypeSource = "wikipedia" | "arxiv" | "web" | "hub";

/** Une source enregistrée dans le registre (traçabilité + respect). */
export interface SourceEnregistree {
  /** Identifiant stable (ex. "wikipedia-fr"). */
  id: string;
  /** URL de base de l'API publique (jamais une page arbitraire). */
  url: string;
  type: TypeSource;
  /** Licence / conditions, citée honnêtement (ex. "CC BY-SA 4.0"). */
  licence: string;
  /** Intervalle minimum entre deux collectes de cette source (ms) —
   *  respect des limites de débit ; jamais inférieur au cycle du core. */
  intervalleMinMs: number;
  /** Dernière collecte réussie (ISO) — pilotage du tour de rôle. */
  derniereCollecteLe?: string;
  /** Dernière erreur honnête (bornée). */
  derniereErreur?: string;
  statut: "actif" | "pause";
  /** Nb de lots produits par cette source (mesure réelle). */
  lotsProduits: number;
}

/** Un LOT de données collectées — unité traçable du pipeline. */
export interface LotCollecte {
  /** Identifiant unique du lot (idempotence pipeline). */
  id: string;
  /** Cycle du core qui a produit le lot. */
  cycle: number;
  /** Source d'origine. */
  sourceId: string;
  /** URL réellement collectée. */
  url: string;
  /** Date de collecte (ISO). */
  collecteLe: string;
  /** Contenu brut BORNÉ (octets plafonnés à la collecte). */
  contenu: string;
  /** Type MIME déclaré par la source. */
  contentType: string;
  tailleOctets: number;
  /** Empreinte du contenu (déduplication, Lot 4). */
  empreinte: string;
}

/** Résultat d'une collecte bornée (jamais inventé). */
export interface ResultatCollecte {
  ok: boolean;
  lot?: LotCollecte;
  message: string;
}

/** Fetcher injectable (tests : fixtures ; production : fetch global). */
export type Fetcher = (
  url: string,
  options: { timeoutMs: number; maxOctets: number; userAgent: string },
) => Promise<{ ok: boolean; statut: number | null; contentType: string; contenu: string; erreur?: string }>;

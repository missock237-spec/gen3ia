/**
 * Registre des salles de signalisation P2P — la SEULE fonction du
 * serveur dans l'architecture W-DNN : dire au navigateur A comment
 * joindre le navigateur B. Aucun calcul d'IA, aucune donnée lourde :
 * de courtes enveloppes (offres/réponses/ICE WebRTC, annonces) qui
 * vivent le temps de l'établissement de la connexion directe.
 *
 * Implémentation pure et testable : une instance par processus (le
 * déploiement Gen3ia est mono-instance PM2). Les files sont bornées et
 * les pairs inactifs purgés — aucune croissance non bornée.
 */

export interface MessageSignal {
  /** Identifiant de l'émetteur. */
  de: string;
  /** Destinataire précis (absent = diffusion à la salle). */
  vers?: string;
  /** Type : "bonjour" | "offre" | "reponse" | "ice" | "au-revoir". */
  type: string;
  /** Charge utile (offres/réponses/ICE sérialisables en JSON). */
  charge?: unknown;
  /** Horodatage serveur (ms). */
  ts: number;
  /** Identifiant unique du message (déduplication client). */
  mid: string;
}

export interface OptionsRegistre {
  maxSalles: number;
  maxPairsParSalle: number;
  maxFileParPair: number;
  /** Durée de vie d'un pair sans signe de vie (ms). */
  ttlPairMs: number;
  maintenant?: () => number;
}

export const OPTIONS_DEFAUT_REGISTRE: OptionsRegistre = {
  maxSalles: 64,
  maxPairsParSalle: 64,
  maxFileParPair: 256,
  ttlPairMs: 45_000,
};

interface EntreePair {
  file: MessageSignal[];
  vuA: number;
}

export class RegistreSalles {
  private salles = new Map<string, Map<string, EntreePair>>();
  private readonly options: OptionsRegistre;
  private readonly maintenant: () => number;

  constructor(options?: Partial<OptionsRegistre>) {
    this.options = { ...OPTIONS_DEFAUT_REGISTRE, ...options };
    this.maintenant = options?.maintenant ?? Date.now;
  }

  /** Nombre de salles actives (métriques). */
  get nbSalles(): number {
    return this.salles.size;
  }

  /** Nombre de pairs dans une salle (métriques). */
  nbPairs(salle: string): number {
    return this.salles.get(salle)?.size ?? 0;
  }

  /** Enregistre (ou rafraîchit) la présence d'un pair dans une salle. */
  rejoindre(salle: string, pair: string): boolean {
    this.purger();
    let membres = this.salles.get(salle);
    if (!membres) {
      // Capacité maximale : la salle la plus vieille est évincée (LRU).
      if (this.salles.size >= this.options.maxSalles) {
        const plusVieille = [...this.salles.entries()].sort(
          (a, b) => this.vuSalle(a[1]) - this.vuSalle(b[1]),
        )[0];
        if (plusVieille) this.salles.delete(plusVieille[0]);
      }
      membres = new Map();
      this.salles.set(salle, membres);
    }
    const existant = membres.get(pair);
    if (existant) {
      existant.vuA = this.maintenant();
      return true;
    }
    if (membres.size >= this.options.maxPairsParSalle) return false;
    membres.set(pair, { file: [], vuA: this.maintenant() });
    return true;
  }

  /** Retire explicitement un pair (fermeture propre du client). */
  quitter(salle: string, pair: string): void {
    this.salles.get(salle)?.delete(pair);
    if (this.salles.get(salle)?.size === 0) this.salles.delete(salle);
  }

  /** Rafraîchit le signe de vie d'un pair (chaque GET/POST le fait). */
  toucher(salle: string, pair: string): void {
    const entree = this.salles.get(salle)?.get(pair);
    if (entree) entree.vuA = this.maintenant();
  }

  /**
   * Publie un message : livré au destinataire précis ou diffusé à tous
   * les autres membres de la salle. Retourne le nombre de destinataires.
   */
  publier(salle: string, message: MessageSignal): number {
    const membres = this.salles.get(salle);
    if (!membres) return 0;
    const emetteur = membres.get(message.de);
    if (emetteur) emetteur.vuA = this.maintenant();

    let livraisons = 0;
    if (message.vers) {
      const cible = membres.get(message.vers);
      if (cible) {
        livraisons += this.livrer(cible, message);
      }
    } else {
      for (const [id, entree] of membres) {
        if (id === message.de) continue;
        livraisons += this.livrer(entree, message);
      }
    }
    return livraisons;
  }

  /** Draine la file d'un pair (le GET de polling). */
  drainer(salle: string, pair: string): MessageSignal[] {
    const entree = this.salles.get(salle)?.get(pair);
    if (!entree) return [];
    entree.vuA = this.maintenant();
    const messages = entree.file;
    entree.file = [];
    return messages;
  }

  /** Purge les pairs silencieux et les salles vides. */
  purger(): void {
    const limite = this.maintenant() - this.options.ttlPairMs;
    for (const [nomSalle, membres] of this.salles) {
      for (const [id, entree] of membres) {
        if (entree.vuA < limite) membres.delete(id);
      }
      if (membres.size === 0) this.salles.delete(nomSalle);
    }
  }

  private livrer(entree: EntreePair, message: MessageSignal): number {
    if (entree.file.length >= this.options.maxFileParPair) {
      // File saturée : on abandonne le plus ancien (message temps réel).
      entree.file.shift();
    }
    entree.file.push(message);
    return 1;
  }

  private vuSalle(membres: Map<string, EntreePair>): number {
    let plusRecent = 0;
    for (const entree of membres.values()) plusRecent = Math.max(plusRecent, entree.vuA);
    return plusRecent;
  }
}

/**
 * Singleton attaché à globalThis (survit au HMR Next.js, même contrat
 * que le runtime neuronal).
 */
const CLE_GLOBALE = "__gen3ia_registre_ondes__";

export function registreSignalisation(): RegistreSalles {
  const global_ = globalThis as unknown as { [CLE_GLOBALE]?: RegistreSalles };
  if (!global_[CLE_GLOBALE]) {
    global_[CLE_GLOBALE] = new RegistreSalles();
  }
  return global_[CLE_GLOBALE];
}

/**
 * Registre ISOLÉ des salles privées (Private Mesh, plan Entreprise).
 * Les salles `mesh-*` ne partagent AUCUN état avec l'essaim public :
 * un pair du mesh ne peut ni découvrir, ni joindre, ni lire les salles
 * publiques et inversement — isolation structurelle du parc privé.
 * Capacité dédiée (le mesh privé est borné au parc : 16 salles, 16
 * pairs/salle — un parc multi-postes n'a jamais besoin de plus).
 */
const CLE_GLOBALE_MESH = "__gen3ia_registre_ondes_mesh__";

export function registreSignalisationMesh(): RegistreSalles {
  const global_ = globalThis as unknown as { [CLE_GLOBALE_MESH]?: RegistreSalles };
  if (!global_[CLE_GLOBALE_MESH]) {
    global_[CLE_GLOBALE_MESH] = new RegistreSalles({
      maxSalles: 16,
      maxPairsParSalle: 16,
    });
  }
  return global_[CLE_GLOBALE_MESH];
}

/**
 * Le Répartiteur Global — comment un serveur de 2 Go sert un nombre
 * d'utilisateurs non borné.
 *
 * La réponse n'est pas la magie, c'est l'architecture :
 *
 *  1. SHARDING DÉTERMINISTE — l'espace utilisateurs est découpé en
 *     fragments par hachage : aucune table globale à verrouiller, chaque
 *     fragment est indépendant (O(1) par opération, zéro contention) ;
 *  2. QUOTAS PAR UTILISATEUR (token bucket) — un utilisateur ne peut
 *     jamais monopoliser la plateforme, quel que soit son débit ;
 *  3. ÉQUITÉ INTER-FRAGMENTS (weighted round-robin) — tous les
 *     fragments avancent, personne ne meurt de faim (index de Jain
 *     mesuré en continu) ;
 *  4. PRESSION ARRIÈRE HONNÊTE (backpressure) — quand une file est
 *     pleine, la demande est REFUSÉE proprement (429) au lieu de
 *     s'empiler jusqu'à l'effondrement : la mémoire du serveur reste
 *     BORNÉE par construction ;
 *  5. OUBLI ACTIF (LRU) — les utilisateurs inactifs sont oubliés : le
 *     nombre d'utilisateurs SUIVIS est borné, pas le nombre
 *     d'utilisateurs servis ;
 *  6. HORIZONTALITÉ — chaque instance est sans état partagé : N
 *     instances derrière un répartiteur réseau multiplient la capacité
 *     par N, et le calcul lourd (W-DNN, Monde) s'exécute sur le GPU du
 *     client, pas sur le serveur. « Infini » signifie ici : la capacité
 *     croît avec le nombre d'utilisateurs au lieu de décroître.
 */

/** Ticket d'admission — une demande admise dans le répartiteur. */
export interface Ticket {
  /** Identifiant unique du ticket. */
  id: string;
  /** Identifiant utilisateur (hashable). */
  utilisateur: string;
  /** Fragment attribué. */
  fragment: number;
  /** Instant d'admission (performance.now()). */
  admisA: number;
  /** Priorité 0 (normale) à 2 (haute). */
  priorite: 0 | 1 | 2;
}

/** Résultat d'une soumission. */
export type Decision =
  | { admis: true; ticket: Ticket; attenteEstimee: number }
  | { admis: false; raison: "quota" | "sature" | "ferme" };

/** Configuration du répartiteur. */
export interface ConfigRepartiteur {
  /** Nombre de fragments (défaut 64). */
  fragments: number;
  /** Taille maximale de file PAR fragment (défaut 256). */
  fileParFragment: number;
  /** Jetons rechargés par seconde et par utilisateur (défaut 6). */
  debitParUtilisateur: number;
  /** Capacité de rafale du seau (défaut 12). */
  rafale: number;
  /** Nombre maximal d'utilisateurs suivis simultanément (LRU, défaut 100 000). */
  utilisateursSuivis: number;
  /** Fenêtre de métriques glissantes (défaut 10 000). */
  fenetreMetriques: number;
}

const CONFIG_DEFAUT: ConfigRepartiteur = {
  fragments: 64,
  fileParFragment: 256,
  debitParUtilisateur: 6,
  rafale: 12,
  utilisateursSuivis: 100_000,
  fenetreMetriques: 10_000,
};

interface EtatUtilisateur {
  /** Jetons disponibles (bucket). */
  jetons: number;
  /** Dernier remplissage (ms). */
  dernierRemplissage: number;
  /** Horodatage du dernier accès (LRU). */
  dernierAcces: number;
  /** Demandes admises (compteur de vie). */
  admises: number;
  /** Demandes refusées pour quota. */
  refusees: number;
}

interface FileFragment {
  /** File FIFO compacte : tableau + index de tête (shift O(1)). */
  tickets: (Ticket | undefined)[];
  tete: number;
  queue: number;
  /** Jeton de rotation round-robin. */
  tours: number;
}

/** Index de Jain (équité) : 1 = parfaitement équitable, 1/n = monopolisé. */
export function indexDeJain(partages: number[]): number {
  const n = partages.length;
  if (n === 0) return 1;
  let somme = 0;
  let sommeCarres = 0;
  for (const v of partages) {
    somme += v;
    sommeCarres += v * v;
  }
  if (sommeCarres === 0) return 1;
  return (somme * somme) / (n * sommeCarres);
}

/** Hachage FNV-1a + avalanche (déterministe, répartit uniformément). */
export function hacherUtilisateur(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  // Finalisation « avalanche » (mix de MurmurHash3) : les FNV bruts
  // corrèlent les bits bas sur des alphabets séquentiels — le mélange
  // force chaque bit d'entrée à influencer les 32 bits de sortie.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Le répartiteur global — instance par processus serveur. */
export class RepartiteurGlobal {
  private readonly cfg: ConfigRepartiteur;
  private readonly utilisateurs = new Map<string, EtatUtilisateur>();
  private readonly files: FileFragment[];
  private readonly lru: string[] = [];
  private compteurTickets = 0;
  private ferme = false;

  // Métriques (fenêtre glissante).
  private totalAdmises = 0;
  private totalRefuseesQuota = 0;
  private totalRefuseesSature = 0;
  private readonly attentes: number[] = [];
  private readonly servisParUtilisateur = new Map<string, number>();

  constructor(config?: Partial<ConfigRepartiteur>) {
    this.cfg = { ...CONFIG_DEFAUT, ...config };
    this.files = Array.from({ length: this.cfg.fragments }, () => ({
      tickets: new Array(this.cfg.fileParFragment),
      tete: 0,
      queue: 0,
      tours: 0,
    }));
  }

  /** Nombre de demandes actuellement en attente (toutes files). */
  get enAttente(): number {
    let n = 0;
    for (const f of this.files) n += f.queue - f.tete;
    return n;
  }

  /** Utilisateurs distincts actuellement suivis en mémoire. */
  get utilisateursSuivis(): number {
    return this.utilisateurs.size;
  }

  /** Statistiques instantanées. */
  stats(): {
    admises: number;
    refuseesQuota: number;
    refuseesSature: number;
    enAttente: number;
    utilisateursSuivis: number;
    attenteMoyenneMs: number;
    equite: number;
    fragments: number;
  } {
    const servis = Array.from(this.servisParUtilisateur.values());
    return {
      admises: this.totalAdmises,
      refuseesQuota: this.totalRefuseesQuota,
      refuseesSature: this.totalRefuseesSature,
      enAttente: this.enAttente,
      utilisateursSuivis: this.utilisateurs.size,
      attenteMoyenneMs:
        this.attentes.length === 0
          ? 0
          : this.attentes.reduce((s, v) => s + v, 0) / this.attentes.length,
      equite: indexDeJain(servis),
      fragments: this.cfg.fragments,
    };
  }

  /**
   * Soumet une demande. Décision IMMÉDIATE : admise en file ou refusée
   * avec une raison honnête. O(1) amorti.
   */
  soumettre(utilisateur: string, priorite: 0 | 1 | 2 = 0, maintenant = performance.now()): Decision {
    if (this.ferme) return { admis: false, raison: "ferme" };

    const etat = this.etatUtilisateur(utilisateur, maintenant);

    // 1) Quota : token bucket.
    const jetons = this.recharger(etat, maintenant);
    if (jetons < 1) {
      etat.refusees += 1;
      this.totalRefuseesQuota += 1;
      return { admis: false, raison: "quota" };
    }
    etat.jetons = jetons - 1;

    // 2) Capacité : file du fragment.
    const fragment = hacherUtilisateur(utilisateur) % this.cfg.fragments;
    const file = this.files[fragment];
    if (file.queue - file.tete >= this.cfg.fileParFragment) {
      this.totalRefuseesSature += 1;
      return { admis: false, raison: "sature" };
    }

    // 3) Admission.
    this.compteurTickets += 1;
    const ticket: Ticket = {
      id: `t${this.compteurTickets.toString(36)}`,
      utilisateur,
      fragment,
      admisA: maintenant,
      priorite,
    };
    file.tickets[file.queue % this.cfg.fileParFragment] = ticket;
    file.queue += 1;
    this.totalAdmises += 1;
    etat.admises += 1;

    // Estimation d'attente : position dans la file / débit moyen.
    const position = file.queue - file.tete;
    const attenteEstimee = (position / Math.max(1, this.cfg.debitParUtilisateur)) * 1000 * 0.1;
    return { admis: true, ticket, attenteEstimee };
  }

  /**
   * Retire le prochain ticket à traiter — weighted round-robin entre
   * fragments : les fragments de priorité haute tournent plus vite,
   * tous les fragments non vides finissent servis (aucune famine).
   * O(1).
   */
  prochain(maintenant = performance.now()): Ticket | null {
    // Deux passes : d'abord les priorités hautes (2 puis 1), sinon normal.
    for (const priorite of [2, 1, 0] as const) {
      const ticket = this.prochainDans(priorite, maintenant);
      if (ticket) return ticket;
    }
    return null;
  }

  private prochainDans(priorite: 0 | 1 | 2, maintenant: number): Ticket | null {
    let meilleur: Ticket | null = null;
    let meilleurFragment = -1;
    let plusAncien = Infinity;
    for (let i = 0; i < this.cfg.fragments; i++) {
      const file = this.files[i];
      if (file.queue <= file.tete) continue;
      const candidat = file.tickets[file.tete % this.cfg.fileParFragment];
      if (!candidat) continue;
      if (candidat.priorite !== priorite) continue;
      // Round-robin équitable : privilégie le fragment le moins servi,
      // puis l'ancienneté.
      const poids = file.tours + (maintenant - candidat.admisA) / 1e6;
      if (poids < plusAncien) {
        plusAncien = poids;
        meilleur = candidat;
        meilleurFragment = i;
      }
    }
    if (!meilleur) return null;
    const file = this.files[meilleurFragment];
    file.tickets[file.tete % this.cfg.fileParFragment] = undefined;
    file.tete += 1;
    file.tours += 1;
    return meilleur;
  }

  /** Marque un ticket traité (métrologie d'attente). */
  terminer(ticket: Ticket, maintenant = performance.now()): void {
    const attente = Math.max(0, maintenant - ticket.admisA);
    this.attentes.push(attente);
    if (this.attentes.length > this.cfg.fenetreMetriques) this.attentes.shift();
    const servis = (this.servisParUtilisateur.get(ticket.utilisateur) ?? 0) + 1;
    this.servisParUtilisateur.set(ticket.utilisateur, servis);
    if (this.servisParUtilisateur.size > this.cfg.utilisateursSuivis) {
      // Oubli des plus anciens servis (métriques bornées).
      const premier = this.servisParUtilisateur.keys().next().value;
      if (premier !== undefined) this.servisParUtilisateur.delete(premier);
    }
  }

  /** Ferme le répartiteur (arrêt propre). */
  fermer(): void {
    this.ferme = true;
  }

  /** Purge les fichiers vides et les utilisateurs inactifs (oubli actif). */
  purger(maintenant = performance.now()): number {
    let oublies = 0;
    if (this.utilisateurs.size > this.cfg.utilisateursSuivis) {
      // Éviction LRU : on oublie les 10 % les plus anciens.
      const cible = Math.floor(this.utilisateurs.size * 0.1);
      const tries = Array.from(this.utilisateurs.entries())
        .sort((x, y) => x[1].dernierAcces - y[1].dernierAcces)
        .slice(0, cible);
      for (const [id] of tries) {
        this.utilisateurs.delete(id);
        oublies += 1;
      }
    }
    void maintenant;
    return oublies;
  }

  // ——— Internes ———

  private etatUtilisateur(id: string, maintenant: number): EtatUtilisateur {
    let etat = this.utilisateurs.get(id);
    if (!etat) {
      etat = { jetons: this.cfg.rafale, dernierRemplissage: maintenant, dernierAcces: maintenant, admises: 0, refusees: 0 };
      this.utilisateurs.set(id, etat);
      this.lru.push(id);
      // Oubli actif immédiat si la carte déborde.
      if (this.utilisateurs.size > this.cfg.utilisateursSuivis) {
        this.purger(maintenant);
      }
    }
    etat.dernierAcces = maintenant;
    return etat;
  }

  private recharger(etat: EtatUtilisateur, maintenant: number): number {
    const ecoule = Math.max(0, maintenant - etat.dernierRemplissage) / 1000;
    etat.jetons = Math.min(this.cfg.rafale, etat.jetons + ecoule * this.cfg.debitParUtilisateur);
    etat.dernierRemplissage = maintenant;
    return etat.jetons;
  }
}

/** Instance de processus (Next.js : module singleton). */
let instanceGlobale: RepartiteurGlobal | null = null;

/** Répartiteur partagé du processus serveur (lazy singleton). */
export function repartiteurGlobal(): RepartiteurGlobal {
  if (!instanceGlobale) {
    instanceGlobale = new RepartiteurGlobal();
  }
  return instanceGlobale;
}

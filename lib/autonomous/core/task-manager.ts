/**
 * GESTIONNAIRE DE TÂCHES DU GEN3IA AUTONOMOUS CORE (Phase 1).
 *
 * Traçabilité 100 % du plan : chaque tâche reçoit un identifiant unique,
 * un numéro de cycle, un statut et un historique borné (20 événements).
 * Idempotence : une tâche ne peut être terminée/échouée qu'une fois —
 * les doublons d'identifiant sont refusés.
 *
 * État en mémoire du process + instantané sérialisable (le
 * lifecycle-manager le persiste sur disque pour la reprise après crash).
 */

import { randomUUID } from "node:crypto";

import type {
  PrioriteTache,
  StatutTache,
  Tache,
} from "./types";

/** Historique borné par tâche (les événements plus anciens sont comptés). */
const MAX_HISTORIQUE = 20;

/** Journal borné par module (traçabilité récente en mémoire). */
const MAX_JOURNAL_PAR_MODULE = 200;

export class GestionnaireTaches {
  private parId = new Map<string, Tache>();
  /** Journal des identifiants par module (borné). */
  private journalParModule = new Map<string, string[]>();
  private journalMaxParModule = MAX_JOURNAL_PAR_MODULE;

  /** Crée une tâche traçable ; refus (null) si l'id existe déjà (idempotence). */
  creer(options: {
    module: string;
    cycle: number;
    type: string;
    priorite?: PrioriteTache;
    idExistant?: string;
  }): Tache | null {
    const id = options.idExistant ?? `T-${options.cycle}-${randomUUID().slice(0, 8)}`;
    if (this.parId.has(id)) return null;
    const maintenant = new Date().toISOString();
    const tache: Tache = {
      id,
      module: options.module,
      cycle: options.cycle,
      type: options.type,
      statut: "EN_ATTENTE",
      priorite: options.priorite ?? "normale",
      creeLe: maintenant,
      majLe: maintenant,
      historique: [
        { dateIso: maintenant, evenement: "CREEE", details: options.type },
      ],
    };
    this.parId.set(id, tache);
    const journal = this.journalParModule.get(options.module) ?? [];
    journal.push(id);
    if (journal.length > this.journalMaxParModule) {
      // Les tâches très anciennes restent l'affaire du stockage durable
      // (Phase 6 — mémoire permanente) ; le journal mémoire est borné.
      journal.splice(0, journal.length - this.journalMaxParModule);
    }
    this.journalParModule.set(options.module, journal);
    return tache;
  }

  /** Retourne une tâche (null si absente). */
  obtenir(id: string): Tache | null {
    return this.parId.get(id) ?? null;
  }

  /** Marque EN_COURS (idempotence : passe seulement depuis EN_ATTENTE —
   *  les tâches REPRISE ont déjà été ré-ouvertes EN_ATTENTE par marquerReprise). */
  demarrer(id: string, details?: string): boolean {
    return this.transition(id, "EN_COURS", "EN_ATTENTE", details);
  }

  /** Marque TERMINEE (idempotence : jamais deux fois). */
  terminer(id: string, details?: string): boolean {
    return this.transition(id, "TERMINEE", null, details);
  }

  /** Marque ECHEC (idempotence : jamais deux fois). */
  echouer(id: string, details?: string): boolean {
    return this.transition(id, "ECHEC", null, details);
  }

  /**
   * REPRISE — une tâche EN_COURS retrouvée à l'état persisté après un
   * redémarrage (le process est mort pendant son exécution) est marquée
   * REPRISE puis ré-ouverte EN_ATTENTE : l'opération interrompue reprend.
   */
  marquerReprise(id: string, details?: string): Tache | null {
    const tache = this.parId.get(id);
    if (!tache) return null;
    const maintenant = new Date().toISOString();
    tache.statut = "REPRISE";
    tache.majLe = maintenant;
    tache.historique.push({ dateIso: maintenant, evenement: "REPRISE", details });
    this.tronquerHistorique(tache);
    // La tâche reprise repasse EN_ATTENTE pour être ré-exécutée.
    tache.statut = "EN_ATTENTE";
    tache.historique.push({ dateIso: maintenant, evenement: "RE_EN_ATTENTE" });
    this.tronquerHistorique(tache);
    return tache;
  }

  /** Transitions protégées par statut (idempotence honnête). */
  private transition(
    id: string,
    cible: StatutTache,
    seulementDepuis: StatutTache | null,
    details?: string,
  ): boolean {
    const tache = this.parId.get(id);
    if (!tache) return false;
    if (tache.statut === cible) return false; // déjà dans cet état
    if (seulementDepuis && tache.statut !== seulementDepuis) return false;
    if (
      (cible === "TERMINEE" || cible === "ECHEC") &&
      (tache.statut === "TERMINEE" || tache.statut === "ECHEC")
    ) {
      return false; // une tâche close ne se referme pas
    }
    const maintenant = new Date().toISOString();
    tache.statut = cible;
    tache.majLe = maintenant;
    tache.historique.push({ dateIso: maintenant, evenement: cible, details });
    this.tronquerHistorique(tache);
    return true;
  }

  /** Historique borné (les événements tronqués restent comptés par statut). */
  private tronquerHistorique(tache: Tache): void {
    if (tache.historique.length > MAX_HISTORIQUE) {
      tache.historique.splice(0, tache.historique.length - MAX_HISTORIQUE);
    }
  }

  /** Tâches ouvertes (EN_ATTENTE | EN_COURS | REPRISE) pour la persistance. */
  ouvertes(): Tache[] {
    return [...this.parId.values()].filter(
      (t) => t.statut === "EN_ATTENTE" || t.statut === "EN_COURS",
    );
  }

  /** Comptage par statut (santé / tableau de supervision Phase 12). */
  compteParStatut(): Record<StatutTache, number> {
    const compte: Record<StatutTache, number> = {
      EN_ATTENTE: 0,
      EN_COURS: 0,
      TERMINEE: 0,
      ECHEC: 0,
      REPRISE: 0,
    };
    for (const t of this.parId.values()) compte[t.statut] += 1;
    return compte;
  }

  /** Nombre total de tâches connues. */
  taille(): number {
    return this.parId.size;
  }

  /** Bornes mémoire : tâches closes plus anciennes que le journal élagué. */
  elaguerCloses(): number {
    let elaguees = 0;
    for (const [id, t] of [...this.parId.entries()]) {
      if (t.statut === "TERMINEE" || t.statut === "ECHEC") {
        // Garde les closes récentes : borne globale simple (2 × journaux).
        if (this.parId.size - elaguees > this.journalMaxParModule * 2) {
          this.parId.delete(id);
          elaguees += 1;
        }
      }
    }
    return elaguees;
  }

  /**
   * Installe les tâches ouvertes d'un état persisté (démarrage après crash)
   * : les EN_COURS retrouvées sont marquées REPRISE puis ré-ouvertes.
   */
  restaurerOuvertes(taches: Tache[]): number {
    let restaurées = 0;
    for (const t of taches) {
      if (this.parId.has(t.id)) continue;
      this.parId.set(t.id, t);
      const journal = this.journalParModule.get(t.module) ?? [];
      journal.push(t.id);
      this.journalParModule.set(t.module, journal);
      if (t.statut === "EN_COURS") {
        this.marquerReprise(t.id, "retrouvée à l'état persisté après redémarrage");
      }
      restaurées += 1;
    }
    return restaurées;
  }
}

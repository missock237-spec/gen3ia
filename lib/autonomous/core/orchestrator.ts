/**
 * GEN3IA AUTONOMOUS CORE — ORCHESTRATEUR CENTRAL (Phase 1 du plan directeur
 * « GEN3IA AUTONOMOUS BRAIN », Lot 1).
 *
 * Le centre de coordination que l'audit Phase 0 a identifié comme le trou
 * n°1 : démarre les processus, supervise les modules-agents, gère les tâches
 * traçables, détecte les erreurs, relance les opérations interrompues,
 * maintient l'activité — sans JAMAIS faire le travail des modules à leur
 * place (chaque phase du plan s'ajoute ici comme un ModuleAgent).
 *
 * Garanties de validation du plan :
 *  - démarrage automatique (armé par instrumentation.ts, AUTO_CORE=0) ;
 *  - les modules communiquent (bus d'événements sans blocage) ;
 *  - une panne d'un module ne bloque pas les autres (isolation par tick) ;
 *  - les opérations interrompues reprennent (état persisté + REPRISE) ;
 *  - les tâches restent traçables (id unique + historique).
 *
 * Reprise après redémarrage : le compteur de cycles et les métriques par
 * module reprennent depuis var/autonomous/etat.json ; les tâches EN_COURS
 * retrouvées sont marquées REPRISE puis ré-ouvertes (lifecycle-manager).
 */

import { chargerConfigCoeurAutonome, type ConfigCoeurAutonome } from "./config/autonomous-config";
import { chargerEtat, dossierEtatParDefaut, persisterEtat } from "./lifecycle-manager";
import { GestionnaireTaches } from "./task-manager";
import { PlanificateurCycles } from "./scheduler";
import { executerTickModule } from "./process-manager";
import { instantaneSante } from "../monitoring/health-check";
import type {
  ContexteTick,
  EtatModule,
  EtatPersisteCore,
  EvenementModule,
  ModuleAgent,
} from "./types";

/** Entrée du journal de cycles (borné — mesures réelles). */
export interface EntreeJournalCycle {
  cycle: number;
  dateIso: string;
  resultats: Array<{ module: string; statut: string; ms: number; message: string }>;
}

/** Le cœur autonome — un seul par process (singleton globalThis). */
export class Gen3iaCoeurAutonome {
  readonly config: ConfigCoeurAutonome;
  readonly taches = new GestionnaireTaches();

  private readonly modules = new Map<string, ModuleAgent>();
  private readonly etats = new Map<string, EtatModule>();
  private readonly ticksEnCours = new Map<string, boolean>();
  /** File d'événements par module (bus inter-modules, drainé à chaque tick). */
  private readonly evenements = new Map<string, EvenementModule[]>();
  private readonly journalCycles: EntreeJournalCycle[] = [];
  private readonly planificateur: PlanificateurCycles;
  private readonly dossier: string;
  private cycle = 0;
  private demarreLe?: string;
  private persisteLe?: string;

  constructor(options: { dossier?: string; config?: ConfigCoeurAutonome } = {}) {
    this.config = options.config ?? chargerConfigCoeurAutonome();
    this.dossier = options.dossier ?? dossierEtatParDefaut();
    this.planificateur = new PlanificateurCycles(this.config.intervalleCycleMs, (c) => {
      void this.executerCycle(c);
    });
  }

  /** Enregistre un module-agent (idempotent : même id → remplacé honnêtement). */
  enregistrerModule(module: ModuleAgent): void {
    this.modules.set(module.id, module);
    if (!this.etats.has(module.id)) {
      this.etats.set(module.id, {
        id: module.id,
        nom: module.nom,
        role: module.role,
        statut: "actif",
        ticks: 0,
        succes: 0,
        echecs: 0,
        echecsConsecutifs: 0,
        dernieresErreurs: [],
      });
    }
  }

  /**
   * Démarre le cœur : reprise de l'état persisté (cycles, métriques, tâches
   * interrompues → REPRISE), puis heartbeat 5 min. Idempotent.
   */
  demarrer(): { dejaDemarre: boolean; tachesReprises: number } {
    if (this.planificateur.actif()) {
      return { dejaDemarre: true, tachesReprises: 0 };
    }
    const etatPersiste = chargerEtat(this.dossier);
    let tachesReprises = 0;
    if (etatPersiste) {
      this.cycle = Math.max(0, Math.floor(etatPersiste.cycle));
      this.demarreLe = etatPersiste.demarreLe;
      for (const [id, etat] of Object.entries(etatPersiste.modules ?? {})) {
        if (this.modules.has(id)) this.etats.set(id, etat);
      }
      tachesReprises = this.taches.restaurerOuvertes(etatPersiste.tachesOuvertes);
    }
    if (!this.demarreLe) this.demarreLe = new Date().toISOString();
    this.planificateur.demarrer(this.cycle); // le compteur restauré continue sa suite
    this.persiste();
    return { dejaDemarre: false, tachesReprises };
  }

  /** Arrêt propre : heartbeat stoppé, état persisté (ticks en cours finissent). */
  arreter(): void {
    this.planificateur.arreter();
    this.persiste();
  }

  /** Le heartbeat est-il armé ? */
  actif(): boolean {
    return this.planificateur.actif();
  }

  /** Cycle courant. */
  cycleCourant(): number {
    return this.cycle;
  }

  /**
   * Exécute UN cycle : chaque module DÛ est dispatché SANS être attendu
   * (les cycles ne dépendent pas des cycles précédents), avec plafond de
   * concurrence (RAM 2 cœurs). Les modules non dus sont sautés honnêtement.
   */
  async executerCycle(cycleDemande?: number): Promise<EntreeJournalCycle> {
    const cycle = cycleDemande ?? this.cycle + 1;
    if (cycleDemande === undefined || cycleDemande > this.cycle) this.cycle = cycle;
    const dateIso = new Date().toISOString();
    const resultats: EntreeJournalCycle["resultats"] = [];
    let enVol = this.compterEnVol();

    // Files d'événements créées pour TOUS les modules AVANT le dispatch :
    // une émission du cycle courant doit atteindre les modules pas encore
    // dispatchés (sinon l'événement du premier cycle est perdu).
    for (const id of this.modules.keys()) {
      if (!this.evenements.has(id)) this.evenements.set(id, []);
    }

    for (const agent of this.modules.values()) {
      const etat = this.etats.get(agent.id);
      if (!etat) continue;
      if (!this.moduleEstDû(agent, etat, Date.now())) {
        resultats.push({ module: agent.id, statut: "pas_dû", ms: 0, message: "Intervalle non écoulé" });
        continue;
      }
      if (enVol >= this.config.maxTicksConcurrents) {
        resultats.push({
          module: agent.id,
          statut: "reporte",
          ms: 0,
          message: `Limite de concurrence (${this.config.maxTicksConcurrents}) atteinte — reporté au prochain cycle`,
        });
        continue;
      }
      enVol += 1;
      const ctx = this.construireContexte(agent.id, cycle, dateIso);
      void executerTickModule(agent, ctx, etat, {
        timeoutMs: this.config.timeoutTickMs,
        echecsAvantSuspension: this.config.echecsAvantSuspension,
        suspensionMs: this.config.suspensionMs,
        ticksEnCours: this.ticksEnCours,
      }).then((r) => {
        resultats.push({ module: r.module, statut: r.statut, ms: r.ms, message: r.message });
        this.persiste();
      });
      // Le tick est dispatché, PAS attendu : le cycle se termine immédiatement.
    }

    const entree: EntreeJournalCycle = { cycle, dateIso, resultats };
    this.journalCycles.push(entree);
    if (this.journalCycles.length > this.config.journalCycles) {
      this.journalCycles.splice(0, this.journalCycles.length - this.config.journalCycles);
    }
    this.taches.elaguerCloses();
    return entree;
  }

  /** Journal des cycles récents (traçabilité de l'activité). */
  journal(): readonly EntreeJournalCycle[] {
    return this.journalCycles;
  }

  /** Instantané de santé du core (health-check réel). */
  etat() {
    return instantaneSante({
      cycle: this.cycle,
      etats: [...this.etats.values()],
      tachesParStatut: this.taches.compteParStatut(),
      demarreLe: this.demarreLe,
      persisteLe: this.persisteLe,
    });
  }

  /** Persiste l'état (atomique, fail-soft — le chemin ou null). */
  private persiste(): void {
    const etat: EtatPersisteCore = {
      version: 1,
      demarreLe: this.demarreLe ?? new Date().toISOString(),
      cycle: this.cycle,
      persisteLe: new Date().toISOString(),
      modules: Object.fromEntries([...this.etats.entries()].map(([k, v]) => [k, { ...v, dernieresErreurs: [...v.dernieresErreurs] }])),
      tachesOuvertes: this.taches.ouvertes(),
    };
    const chemin = persisterEtat(this.dossier, etat);
    if (chemin) this.persisteLe = etat.persisteLe;
  }

  /** Un module est dû si son intervalle propre est écoulé (jamais plus rapide que le cycle de base). */
  private moduleEstDû(module: ModuleAgent, etat: EtatModule, maintenantMs: number): boolean {
    const intervalle = Math.max(
      this.config.intervalleCycleMs,
      module.intervalleMs ?? this.config.intervalleCycleMs,
    );
    if (!etat.dernierTickLe) return true; // jamais tické → dû au premier cycle
    return maintenantMs - Date.parse(etat.dernierTickLe) >= intervalle;
  }

  /** Contexte de tick : bus d'événements drainé + traçabilité des tâches. */
  private construireContexte(moduleId: string, cycle: number, dateIso: string): ContexteTick {
    const evenementsRecus = this.evenements.get(moduleId) ?? [];
    this.evenements.set(moduleId, []);
    const moi = moduleId;
    const bus = this.evenements;
    return {
      cycle,
      dateIso,
      taches: this.taches,
      evenementsRecus,
      emettreEvenement(evenement: Omit<EvenementModule, "dateIso"> & { dateIso?: string }) {
        const complet: EvenementModule = { ...evenement, dateIso: evenement.dateIso ?? new Date().toISOString() };
        for (const [destinataire, file] of bus.entries()) {
          if (destinataire === moi) continue; // on ne se parle pas à soi-même
          file.push(complet);
        }
      },
    };
  }

  /** Nombre de ticks en vol (bornes de concurrence honnêtes). */
  private compterEnVol(): number {
    let n = 0;
    for (const v of this.ticksEnCours.values()) if (v) n += 1;
    return n;
  }
}

/** Slot mémoire (résiste au HMR, comme le runtime neuronal). */
const globalAvecCoeur = globalThis as typeof globalThis & {
  __gen3iaCoeurAutonome?: Gen3iaCoeurAutonome;
};

/** Singleton du cœur autonome (un seul par process). */
export function getCoeurAutonome(options: { dossier?: string; config?: ConfigCoeurAutonome } = {}): Gen3iaCoeurAutonome {
  if (!globalAvecCoeur.__gen3iaCoeurAutonome) {
    globalAvecCoeur.__gen3iaCoeurAutonome = new Gen3iaCoeurAutonome(options);
  }
  return globalAvecCoeur.__gen3iaCoeurAutonome;
}

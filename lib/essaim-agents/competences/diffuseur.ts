/**
 * Le Diffuseur de Compétences — Swarm Skill Injection, volet réseau.
 *
 * Un module validé est découpé en fragments base64 et DIFFUSÉ en ondes
 * (« competence ») à travers l'essaim : les autres nœuds rassemblent
 * les fragments, vérifient l'empreinte SHA-256 complète, installent le
 * module dans leur registre et l'exécutent à la volée dans leur bac à
 * sable — les capacités GLOBALES de l'IA augmentent instantanément,
 * sans aucune mise à jour serveur.
 *
 * Sécurité d'assemblage : un module n'est installé que COMPLET et
 * INTÈGRE (empreinte vérifiée contre les métadonnées transportées) ;
 * une réception incomplète expire proprement (30 s).
 */

import type { NoeudAgents } from "../noeud-agents";
import type { ChargeCompetence, MessageAgent, MetaCompetence } from "../types";
import { BORNES_AGENTS } from "../types";
import { executerCompetence } from "./bac-a-sable";
import {
  ErreurModule,
  fragmenterModule,
  metaDeModule,
  reassemblerModule,
  verifierIntegrite,
  type ModuleCompetence,
} from "./module-competence";

/** Compétence installée : module + mémoire persistable entre exécutions. */
export interface CompetenceInstallee {
  module: ModuleCompetence;
  memoire: Record<string, unknown>;
  installeeA: number;
  executions: number;
  derniereExecution?: number;
}

/** Registre local des compétences (par nœud). */
export class RegistreCompetences {
  private competences = new Map<string, CompetenceInstallee>();

  installer(module: ModuleCompetence): void {
    const existante = this.competences.get(module.id);
    this.competences.set(module.id, {
      module,
      memoire: existante?.memoire ?? {},
      installeeA: Date.now(),
      executions: existante?.executions ?? 0,
      derniereExecution: existante?.derniereExecution,
    });
  }

  get(id: string): CompetenceInstallee | undefined {
    return this.competences.get(id);
  }

  lister(): CompetenceInstallee[] {
    return [...this.competences.values()].sort((a, b) => b.installeeA - a.installeeA);
  }

  supprimer(id: string): boolean {
    return this.competences.delete(id);
  }

  /** Exécute une compétence dans le bac à sable (mémoire persistée). */
  executer(id: string, entree: unknown): ReturnType<typeof executerCompetence> {
    const competence = this.competences.get(id);
    if (!competence) {
      return {
        ok: false,
        erreur: `Compétence « ${id} » non installée sur ce nœud.`,
        journal: [],
        dureeMs: 0,
        memoire: {},
      };
    }
    const resultat = executerCompetence(competence.module, entree, { memoire: competence.memoire });
    competence.memoire = resultat.memoire;
    competence.executions++;
    competence.derniereExecution = Date.now();
    return resultat;
  }

  get taille(): number {
    return this.competences.size;
  }
}

/** Réception d'un module en cours (fragments collectés). */
interface ReceptionEnCours {
  morceaux: Map<number, string>;
  meta?: MetaCompetence;
  debut: number;
}

export interface OptionsDiffuseur {
  noeud: NoeudAgents;
  registre: RegistreCompetences;
  surEvenement?: (evenement: { type: string; detail: string }) => void;
}

const EXPIRATION_RECEPTION_MS = 30_000;

export class DiffuseurCompetences {
  private readonly noeud: NoeudAgents;
  private readonly registre: RegistreCompetences;
  private readonly surEvenement: ((e: { type: string; detail: string }) => void) | undefined;
  private receptions = new Map<string, ReceptionEnCours>();

  constructor(options: OptionsDiffuseur) {
    this.noeud = options.noeud;
    this.registre = options.registre;
    this.surEvenement = options.surEvenement;
  }

  /**
   * Diffuse un module validé en ondes exécutables.
   * Renvoie le nombre de fragments émis (0 si aucun pair).
   */
  diffuser(module: ModuleCompetence): number {
    const { morceaux, total } = fragmenterModule(module.code);
    const meta = metaDeModule(module, total);
    for (let i = 0; i < total; i++) {
      const charge: ChargeCompetence = {
        moduleId: module.id,
        version: module.version,
        fragment: i,
        total,
        morceau: morceaux[i],
        meta: i === 0 ? meta : undefined,
      };
      this.noeud.emettre({ type: "competence", charge });
    }
    this.surEvenement?.({
      type: "competence-diffusee",
      detail: `Compétence « ${module.nom} » diffusée en ${total} fragment(s) d'onde — empreinte ${module.empreinte.slice(0, 12)}…`,
    });
    return total;
  }

  /** Traite un message « competence » reçu (assemblage + installation). */
  traiterMessage(message: MessageAgent): void {
    if (message.type !== "competence" || message.de === this.noeud.id) return;
    const charge = message.charge as ChargeCompetence | undefined;
    if (!charge?.moduleId || typeof charge.fragment !== "number" || typeof charge.total !== "number") {
      return;
    }

    let reception = this.receptions.get(charge.moduleId);
    if (!reception) {
      reception = { morceaux: new Map(), debut: Date.now() };
      this.receptions.set(charge.moduleId, reception);
    }
    if (charge.meta) reception.meta = charge.meta;
    reception.morceaux.set(charge.fragment, charge.morceau);

    const attendu = reception.meta?.total ?? charge.total;
    if (reception.morceaux.size < attendu) return;
    if (!reception.meta) {
      this.receptions.delete(charge.moduleId);
      return;
    }

    // Module complet : assemblage + intégrité + installation.
    this.receptions.delete(charge.moduleId);
    try {
      const code = reassemblerModule(reception.morceaux, attendu);
      void this.installerVerifie(code, reception.meta);
    } catch (e) {
      this.surEvenement?.({
        type: "competence-rejetee",
        detail: `Compétence « ${charge.moduleId} » rejetée : ${e instanceof ErreurModule ? e.message : "assemblage impossible"}.`,
      });
    }
  }

  private async installerVerifie(code: string, meta: MetaCompetence): Promise<void> {
    try {
      await verifierIntegrite(code, meta);
      const mod: ModuleCompetence = {
        id: meta.id,
        nom: meta.nom,
        description: meta.description,
        version: 1,
        code,
        empreinte: meta.empreinte,
        emetteur: meta.emetteur,
        ts: meta.ts,
      };
      this.registre.installer(mod);
      this.surEvenement?.({
        type: "competence-installee",
        detail: `Compétence « ${meta.nom} » installée (empreinte vérifiée) — le nœud sait désormais en faire plus, sans mise à jour serveur.`,
      });
    } catch (e) {
      this.surEvenement?.({
        type: "competence-rejetee",
        detail: `Compétence « ${meta.id} » rejetée : ${e instanceof ErreurModule ? e.message : "vérification impossible"}.`,
      });
    }
  }

  /** Purge les réceptions incomplètes expirées. */
  purger(maintenant: number = Date.now()): number {
    let purges = 0;
    for (const [id, reception] of this.receptions) {
      if (maintenant - reception.debut > EXPIRATION_RECEPTION_MS) {
        this.receptions.delete(id);
        purges++;
      }
    }
    return purges;
  }

  /** Modules en cours de réception (diagnostic console). */
  get enReception(): Array<{ id: string; fragments: number; attendu: number }> {
    return [...this.receptions.entries()].map(([id, r]) => ({
      id,
      fragments: r.morceaux.size,
      attendu: r.meta?.total ?? 0,
    }));
  }

  /** Taille maximale légale d'un module (rappel honnête). */
  static get tailleMax(): number {
    return BORNES_AGENTS.tailleCompetence;
  }
}

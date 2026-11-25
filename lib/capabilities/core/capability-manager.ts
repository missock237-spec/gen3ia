/**
 * CAPABILITY MANAGER — registre central unique de référence (mission §3).
 *
 * Fusionne en une seule vue :
 *  - les outils NATIFS du dépôt (GEN3IA_TOOLS + présence réelle au registre
 *    d'exécution `createDefaultToolRegistry()`) avec un champ honnête
 *    `enregistre` (catalogue ≠ registre d'exécution selon l'environnement) ;
 *  - les capacités UCE (découvertes, construites) persistées par le
 *    repository (Firestore + repli local).
 *
 * Toute transition de statut passe par la machine à états
 * (`capability-state.ts`) ; les transitions sensibles (« autorisee »,
 * « integree ») exigent une autorisation explicite — jamais automatiques.
 */

import "server-only";

import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import {
  capabilityIdSchema,
  construireCapabilityId,
  maintenantIso,
  type Capability,
  type CapabilityCard,
  type CapabilityKind,
  type CapabilityOrigin,
  type CapabilityStatus,
} from "./capability-contract";
import { verifierTransition } from "./capability-state";
import { lister, sauvegarder, recuperer } from "../storage/capability-repository";

const COLLECTION = "capabilities" as const;

export interface GestionnaireOptions {
  dossier?: string;
  forcerLocal?: boolean;
}

export interface ResultatTransition {
  ok: boolean;
  capability?: Capability;
  raison: string;
}

export interface StatistiquesCapacites {
  total: number;
  parStatut: Record<string, number>;
  parKind: Record<string, number>;
  nativesEnregistrees: number;
  nativesAnnoncees: number;
}

/** Vue native : catalogue (annonce au planner) × registre d'exécution réel. */
export interface CapaciteNative extends Capability {
  /** Présente dans le catalogue annoncé au planificateur (toujours vrai ici). */
  annoncee: true;
  /** Vraiment présente dans le registre d'exécution de cet environnement. */
  enregistre: boolean;
}

export class GestionnaireCapacites {
  private readonly options: GestionnaireOptions;
  private cache: Map<string, Capability> | null = null;

  constructor(options: GestionnaireOptions = {}) {
    this.options = options;
  }

  /** Squelette d'entrée native (complété par l'appelant). */
  private carteNative(): Omit<Capability, "id" | "schemaVersion" | "creeLe" | "majLe"> {
    return {
      kind: "tool",
      origin: "natif",
      status: "integree",
      card: {
        nom: "", // remplacé par l'appelant
        description: "",
        fonctionnalites: [],
        source: "gen3ia",
        dependances: [],
        risques: [],
        verifieLe: maintenantIso(),
      },
      versionActive: "gen3ia-courant",
    };
  }

  private async cacheCapacites(): Promise<Map<string, Capability>> {
    if (this.cache) return this.cache;
    const uce = await lister<Capability>(COLLECTION, undefined, 500, this.options);
    this.cache = new Map(uce.map((c) => [c.id, c]));
    return this.cache;
  }

  private invalider(): void {
    this.cache = null;
  }

  /**
   * Liste les capacités NATIVES avec le drapeau `enregistre` réel
   * (registre d'exécution de l'environnement courant, chargé paresseusement).
   */
  async capacitesNatives(): Promise<CapaciteNative[]> {
    let nomsEnregistres: Set<string>;
    try {
      const { createDefaultToolRegistry } = await import("@/lib/tools/default-registry");
      const registre = createDefaultToolRegistry();
      nomsEnregistres = new Set(registre.list().map((t) => t.id ?? t.name));
    } catch {
      // Registre non chargeable dans cet environnement : honnêteté d'abord.
      nomsEnregistres = new Set();
    }
    return GEN3IA_TOOLS.map((outil) => {
      const base = this.carteNative();
      const maintenant = maintenantIso();
      return {
        ...base,
        id: construireCapabilityId("natif", "gen3ia", outil.name),
        schemaVersion: 1,
        creeLe: maintenant,
        majLe: maintenant,
        card: {
          ...base.card,
          nom: outil.name,
          description: outil.description,
          fonctionnalites: [outil.permission],
          risques: [outil.risk],
        },
        annoncee: true,
        enregistre: nomsEnregistres.has(outil.name),
      };
    });
  }

  /** Enregistre (upsert) une capacité UCE — statut initial borné. */
  async enregistrerCapacite(params: {
    id?: string;
    kind: CapabilityKind;
    origin: CapabilityOrigin;
    card: CapabilityCard;
    version?: string;
    statutInitial?: Extract<CapabilityStatus, "decouverte" | "proposee" | "integree">;
  }): Promise<Capability> {
    const id = params.id ?? construireCapabilityId(params.origin, params.card.source, params.card.nom);
    capabilityIdSchema.parse(id);
    const existante = await this.obtenir(id);
    const maintenant = maintenantIso();
    const capacite: Capability = {
      id,
      kind: params.kind,
      origin: params.origin,
      status: existante?.status ?? params.statutInitial ?? "decouverte",
      card: { ...params.card, verifieLe: params.card.verifieLe || maintenant },
      version: params.version ?? existante?.version,
      score: existante?.score,
      fiabiliteMesuree: existante?.fiabiliteMesuree,
      versionActive: existante?.versionActive,
      schemaVersion: 1,
      creeLe: existante?.creeLe ?? maintenant,
      majLe: maintenant,
    };
    await sauvegarder(COLLECTION, capacite, this.options);
    this.invalider();
    return capacite;
  }

  /** Applique une transition de statut (machine à états + gates sensibles). */
  async transitionner(capabilityId: string, vers: CapabilityStatus, options: { autorisePar?: string } = {}): Promise<ResultatTransition> {
    const capacite = await this.obtenir(capabilityId);
    if (!capacite) return { ok: false, raison: `capacité inconnue : ${capabilityId}` };
    const decision = verifierTransition(capacite.status, vers);
    if (!decision.ok) return { ok: false, raison: decision.raison };

    // GATE 1 : autorisation humaine explicite pour toute intégration.
    if (vers === "autorisee" && !options.autorisePar) {
      return { ok: false, raison: "transition « autorisee » refusée : aucun autorisant humain fourni" };
    }
    if (vers === "autorisee" && options.autorisePar && options.autorisePar.length < 4) {
      return { ok: false, raison: "transition « autorisee » refusée : identifiant d'autorisant invalide" };
    }
    // GATE 2 : une capacité découverte/construite ne devient « integree »
    // que si elle a explicitement été autorisée juste avant.
    if (vers === "integree" && capacite.status !== "autorisee") {
      return { ok: false, raison: "intégration refusée : la capacité n'est pas au statut « autorisee »" };
    }

    capacite.status = vers;
    capacite.majLe = maintenantIso();
    await sauvegarder(COLLECTION, capacite, this.options);
    this.invalider();
    return { ok: true, capability: capacite, raison: decision.raison };
  }

  /** Met à jour les métriques mesurées (score/fiabilité) d'une capacité. */
  async mettreAJourMesures(capabilityId: string, mesures: { score?: number; fiabiliteMesuree?: number; version?: string }): Promise<Capability | null> {
    const capacite = await this.obtenir(capabilityId);
    if (!capacite) return null;
    if (mesures.score !== undefined) capacite.score = mesures.score;
    if (mesures.fiabiliteMesuree !== undefined) capacite.fiabiliteMesuree = mesures.fiabiliteMesuree;
    if (mesures.version !== undefined) capacite.version = mesures.version;
    capacite.majLe = maintenantIso();
    await sauvegarder(COLLECTION, capacite, this.options);
    this.invalider();
    return capacite;
  }

  /** Retourne une capacité UCE ou native (identifiant préfixé). */
  async obtenir(capabilityId: string): Promise<Capability | null> {
    if (capabilityId.startsWith("natif:")) {
      const natives = await this.capacitesNatives();
      return natives.find((n) => n.id === capabilityId) ?? null;
    }
    const cache = await this.cacheCapacites();
    return cache.get(capabilityId) ?? (await recuperer<Capability>(COLLECTION, capabilityId, this.options)) ?? null;
  }

  /** Liste toutes les capacités UCE persistées. */
  async listerUce(filtre?: { status?: CapabilityStatus; kind?: CapabilityKind }): Promise<Capability[]> {
    const cache = await this.cacheCapacites();
    let valeurs = [...cache.values()];
    if (filtre?.status) valeurs = valeurs.filter((c) => c.status === filtre.status);
    if (filtre?.kind) valeurs = valeurs.filter((c) => c.kind === filtre.kind);
    return valeurs;
  }

  /** Statistiques honnêtes pour l'admin (aucun indicateur inventé). */
  async statistiques(): Promise<StatistiquesCapacites> {
    const [natives, uce] = await Promise.all([this.capacitesNatives(), this.listerUce()]);
    const toutes: Capability[] = [...natives, ...uce];
    const parStatut: Record<string, number> = {};
    const parKind: Record<string, number> = {};
    for (const c of toutes) {
      parStatut[c.status] = (parStatut[c.status] ?? 0) + 1;
      parKind[c.kind] = (parKind[c.kind] ?? 0) + 1;
    }
    return {
      total: toutes.length,
      parStatut,
      parKind,
      nativesEnregistrees: natives.filter((n) => n.enregistre).length,
      nativesAnnoncees: natives.length,
    };
  }

  /** Réinitialise le cache mémoire (tests). */
  reinitialiser(): void {
    this.cache = null;
  }
}

let singleton: GestionnaireCapacites | null = null;

/** Singleton process-local du gestionnaire (idempotent). */
export function obtenirGestionnaireCapacites(options: GestionnaireOptions = {}): GestionnaireCapacites {
  if (!singleton || options.dossier) singleton = new GestionnaireCapacites(options);
  return singleton;
}

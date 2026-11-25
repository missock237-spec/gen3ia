/**
 * CAPABILITY REGISTRY (UCE V1.1 Phase 2) — LE registre central unique de
 * référence (mission V1.1 §Phase 2).
 *
 * Responsabilités (exclusives — aucun autre module ne maintient de catalogue
 * concurrent) :
 *  - enregistrer toutes les capacités (natives + UCE persistées) sous un
 *    identifiant unique et stable ;
 *  - exposer le CONTRAT obligatoire mission : id, name, version, category,
 *    description, inputSchema, outputSchema, permissions, dependencies,
 *    environmentRequirements, availability, executionAdapter, healthStatus,
 *    createdAt, updatedAt ;
 *  - gérer les versions (versionActive), les dépendances, les permissions ;
 *  - gérer la DISPONIBILITÉ honnête (annoncé ≠ réellement enregistré) ;
 *  - gérer les adaptateurs d'exécution (outil-natif / capacite-uce / refus) ;
 *  - contrôler les ACTIVATIONS et DÉSACTIVATIONS (une capacité désactivée
 *    n'est plus exécutable — contrôle branché dans le Universal Gateway).
 *
 * Sources : `GEN3IA_TOOLS` (annoncé) × `createDefaultToolRegistry()` (réel)
 * — la même source unique que l'UCE V1 — complétée du registre UCE persisté.
 * Le catalogue déclaratif par principal (catalog.ts) est GÉNÉRÉ depuis ici.
 */

import "server-only";

import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { createDefaultToolRegistry } from "@/lib/tools/default-registry";
import {
  maintenantIso,
  type Capability,
  type CapabilityKind,
  type CapabilityRequirements,
} from "./capability-contract";
import { obtenirGestionnaireCapacites, type CapaciteNative, type GestionnaireOptions } from "./capability-manager";
import { sauvegarder, recuperer, lister } from "../storage/capability-repository";

const COLLECTION_REGISTRE = "registry" as const;

/** Disponibilité honnête d'une entrée du registre (mission Phase 2, règle 5). */
export type DisponibiliteCapacite = "disponible" | "non-enregistre" | "indisponible";

/** Santé d'une capacité (relevée par le monitoring UCE ; inconnu = jamais exécutée). */
export type SanteCapacite = "sain" | "degrade" | "en_echec" | "inconnu";

/** Entrée du registre central — le contrat obligatoire mission (15 champs). */
export interface EntreeRegistreCapacite {
  id: string;
  name: string;
  version: string;
  category: CapabilityKind;
  description: string;
  /** Schéma d'entrée réel (zod) de l'outil natif, si réellement enregistré. */
  inputSchema?: unknown;
  /** Champs de premier niveau du schéma d'entrée (résumé lisible, honnête). */
  entreeSchemaChamps: string[];
  /** Schéma de sortie déclaré (rare — null honnête si absent). */
  outputSchema: unknown | null;
  permissions: string[];
  dependencies: string[];
  environmentRequirements: CapabilityRequirements;
  availability: DisponibiliteCapacite;
  /** Adaptateur du Universal Gateway qui exécute cette capacité. */
  executionAdapter: "outil-natif" | "capacite-uce" | "refus-non-integree";
  healthStatus: SanteCapacite;
  createdAt: string;
  updatedAt: string;
  // ---- champs de gestion UCE (au-delà du contrat mission) ----
  origin: Capability["origin"];
  status: Capability["status"];
  /** Risque déclaré (natif) — réutilisé par le catalogue. */
  risque?: string;
  /** Effet de bord déclaré (natif) — réutilisé par le catalogue. */
  sideEffect?: boolean;
  /** Activation contrôlée (défaut true ; désactivation persistée, tracée). */
  active: boolean;
  desactivationRaison?: string;
}

/** Enregistrement de contrôle d'activation persisté (collection cap_registry). */
interface EnregistrementActivation {
  id: string;
  active: boolean;
  raison: string;
  /** Identifiant humain ayant posé le contrôle (traçabilité obligatoire). */
  par: string;
  majLe: string;
  schemaVersion: number;
}

export type OptionsRegistre = GestionnaireOptions;

/**
 * Registre d'exécution réel chargé UNE fois (même usine que executeTool —
 * source unique). En cas d'échec de chargement (environnement limité), null :
 * les entrées restent annoncées avec availability honnête « non-enregistre ».
 */
let cacheRegistreReel: ReturnType<typeof createDefaultToolRegistry> | null | undefined;
function registreReel(): ReturnType<typeof createDefaultToolRegistry> | null {
  if (cacheRegistreReel !== undefined) return cacheRegistreReel;
  try {
    cacheRegistreReel = createDefaultToolRegistry();
  } catch {
    cacheRegistreReel = null;
  }
  return cacheRegistreReel;
}

/** Champs de premier niveau d'un schéma zod (résumé honnête, jamais inventé). */
function extraireChampsSchema(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const forme = (schema as { shape?: unknown }).shape;
  if (forme && typeof forme === "object") return Object.keys(forme as Record<string, unknown>).slice(0, 20);
  return [];
}

/**
 * Vue SYNCHRONE des entrées natives — la source unique partagée par le
 * registre (async, complet) et par le catalogue déclaratif (sync).
 */
export function entreesNativesSynchrones(): Array<Omit<EntreeRegistreCapacite, "active" | "desactivationRaison">> {
  const reel = registreReel();
  const maintenant = maintenantIso();
  return GEN3IA_TOOLS.map((outil) => {
    const definition = reel?.get(outil.name);
    const schema = definition?.inputSchema;
    return {
      id: `natif:gen3ia:${outil.name}`,
      name: outil.name,
      version: "gen3ia-courant",
      category: "tool" as const,
      description: outil.description,
      inputSchema: definition ? (schema as unknown) : undefined,
      entreeSchemaChamps: extraireChampsSchema(schema),
      outputSchema: null,
      permissions: [outil.permission],
      dependencies: [],
      environmentRequirements: {},
      availability: (definition ? "disponible" : "non-enregistre") as DisponibiliteCapacite,
      executionAdapter: "outil-natif" as const,
      healthStatus: "inconnu" as const,
      createdAt: maintenant,
      updatedAt: maintenant,
      origin: "natif" as const,
      status: "integree" as const,
      risque: outil.risk,
      sideEffect: outil.sideEffect,
    };
  });
}

export class RegistreCentralCapacites {
  private readonly options: OptionsRegistre;
  private cacheActivations: Map<string, EnregistrementActivation> | null = null;

  constructor(options: OptionsRegistre = {}) {
    this.options = options;
  }

  /**
   * Liste COMPLÈTE du registre (natives + capacités UCE persistées), avec
   * activations persistées et, sur demande, santé réelle relevée par le
   * monitoring (jamais inventée : non mesuré = « inconnu »).
   */
  async lister(options: { avecSante?: boolean } = {}): Promise<EntreeRegistreCapacite[]> {
    const [nativesSync, uce] = await Promise.all([
      Promise.resolve(entreesNativesSynchrones()),
      this.capacitesUce(),
    ]);
    const activations = await this.activations();

    const natives: EntreeRegistreCapacite[] = nativesSync.map((e) => {
      const activation = activations.get(e.id);
      return {
        ...e,
        active: activation?.active ?? true,
        desactivationRaison: activation && !activation.active ? activation.raison : undefined,
      };
    });

    const uceEntrees: EntreeRegistreCapacite[] = uce.map((c) => {
      const activation = activations.get(c.id);
      const integree = c.status === "integree" || c.status === "validee";
      return {
        id: c.id,
        name: c.card.nom,
        version: c.version ?? c.versionActive ?? "0",
        category: c.kind,
        description: c.card.description,
        inputSchema: undefined,
        entreeSchemaChamps: [],
        outputSchema: null,
        permissions: c.card.fonctionnalites.slice(0, 5),
        dependencies: c.card.dependances,
        environmentRequirements: c.card.exigences ?? {},
        availability: (integree && (activation?.active ?? true) ? "disponible" : c.status === "rejetee" ? "indisponible" : "non-enregistre") as DisponibiliteCapacite,
        executionAdapter: integree ? ("capacite-uce" as const) : ("refus-non-integree" as const),
        healthStatus: "inconnu" as const,
        createdAt: c.creeLe,
        updatedAt: c.majLe,
        origin: c.origin,
        status: c.status,
        active: activation?.active ?? true,
        desactivationRaison: activation && !activation.active ? activation.raison : undefined,
      };
    });

    const toutes = [...natives, ...uceEntrees];
    if (!options.avecSante) return toutes;
    return this.enrichirSante(toutes);
  }

  /** Une entrée par identifiant (natives puis UCE). */
  async obtenir(id: string): Promise<EntreeRegistreCapacite | null> {
    const toutes = await this.lister();
    return toutes.find((e) => e.id === id) ?? null;
  }

  /**
   * La capacité est-elle EXÉCUTABLE dans l'état courant ? Contrôle strict
   * (admin/tests) : inconnue du registre → refus.
   */
  async estExecutable(id: string): Promise<{ ok: boolean; raison: string }> {
    const entree = await this.obtenir(id);
    if (!entree) return { ok: false, raison: `capacité inconnue du registre central : ${id}` };
    if (!entree.active) {
      return { ok: false, raison: `capacité désactivée${entree.desactivationRaison ? ` : ${entree.desactivationRaison}` : ""}` };
    }
    if (entree.availability === "indisponible") {
      return { ok: false, raison: `capacité indisponible (statut ${entree.status})` };
    }
    return { ok: true, raison: "active et disponible" };
  }

  /**
   * Contrôle d'ACTIVATION du Universal Gateway (mission Phase 3, cycle
   * d'exécution étape 4 « vérifier sa disponibilité ») : une capacité
   * DÉSACTIVÉE ou INDISPONIBLE est refusée ; une capacité hors registre
   * déclaratif laisse la résolution standard continuer (repli registre
   * d'exécution réel côté gateway) — jamais de blocage faux-positif.
   */
  async verifierActivation(id: string): Promise<{ ok: boolean; raison: string }> {
    const activation = (await this.activations()).get(id);
    if (activation && !activation.active) {
      return { ok: false, raison: `capacité désactivée par ${activation.par} : ${activation.raison}` };
    }
    const entree = await this.obtenir(id);
    if (entree && entree.availability === "indisponible") {
      return { ok: false, raison: `capacité indisponible (statut ${entree.status}) — non présentée comme opérationnelle` };
    }
    return { ok: true, raison: activation ? "activation vérifiée" : "hors registre déclaratif : résolution standard" };
  }

  /**
   * DÉSACTIVE une capacité (contrôle d'activation mission Phase 2). Ne peut
   * PAS casser les règles de sécurité : la désactivation est persistée et
   * tracée, l'identifiant humain est OBLIGATOIRE (aucun auto-retrait).
   */
  async desactiver(id: string, params: { raison: string; par: string }): Promise<{ ok: boolean; raison: string }> {
    if (!params.raison?.trim()) return { ok: false, raison: "désactivation refusée : raison obligatoire" };
    if (!params.par?.trim() || params.par.trim().length < 4) {
      return { ok: false, raison: "désactivation refusée : identifiant humain requis (traçabilité)" };
    }
    return this.poserActivation(id, { active: false, raison: params.raison, par: params.par });
  }

  /** RÉACTIVE une capacité désactivée (même traçabilité). */
  async reactiver(id: string, params: { raison: string; par: string }): Promise<{ ok: boolean; raison: string }> {
    if (!params.raison?.trim()) return { ok: false, raison: "réactivation refusée : raison obligatoire" };
    if (!params.par?.trim() || params.par.trim().length < 4) {
      return { ok: false, raison: "réactivation refusée : identifiant humain requis (traçabilité)" };
    }
    return this.poserActivation(id, { active: true, raison: params.raison, par: params.par });
  }

  private async poserActivation(id: string, params: { active: boolean; raison: string; par: string }): Promise<{ ok: boolean; raison: string }> {
    const existante = await this.obtenir(id);
    if (!existante) return { ok: false, raison: `capacité inconnue : ${id}` };
    const enregistrement: EnregistrementActivation = {
      id,
      active: params.active,
      raison: params.raison.slice(0, 300),
      par: params.par.slice(0, 120),
      majLe: maintenantIso(),
      schemaVersion: 1,
    };
    await sauvegarder(COLLECTION_REGISTRE, enregistrement, this.options);
    this.cacheActivations = null;
    return { ok: true, raison: `${id} ${params.active ? "réactivé" : "désactivé"} — ${params.raison}` };
  }

  private async activations(): Promise<Map<string, EnregistrementActivation>> {
    if (this.cacheActivations) return this.cacheActivations;
    const tous = await lister<EnregistrementActivation>(COLLECTION_REGISTRE, undefined, 500, this.options);
    this.cacheActivations = new Map(tous.map((a) => [a.id, a]));
    return this.cacheActivations;
  }

  /** Capacités UCE persistées (via le gestionnaire — machine à états unique). */
  private async capacitesUce(): Promise<Capability[]> {
    return obtenirGestionnaireCapacites(this.options).listerUce();
  }

  /** Enrichit les entrées avec la santé réelle du monitoring (relevée, pas inventée). */
  private async enrichirSante(entrees: EntreeRegistreCapacite[]): Promise<EntreeRegistreCapacite[]> {
    try {
      const { santeGlobale } = await import("../monitoring/capability-health");
      const sante = await santeGlobale(this.options);
      const carte = new Map(sante.capacites.map((c) => [c.capabilityId, c.etat]));
      return entrees.map((e) => {
        const etat = carte.get(e.id);
        if (!etat) return e;
        const santeMappee: SanteCapacite = etat === "saine" ? "sain" : etat === "degradee" ? "degrade" : etat === "en_echec" ? "en_echec" : "inconnu";
        return { ...e, healthStatus: santeMappee };
      });
    } catch {
      return entrees; // monitoring indisponible : santé honnêtement « inconnu »
    }
  }

  /** Statistiques déléguées au gestionnaire (source unique). */
  async statistiques() {
    return obtenirGestionnaireCapacites(this.options).statistiques();
  }

  /** Vue natives du gestionnaire (drapeau honnête enregistre) — réexport. */
  async natives(): Promise<CapaciteNative[]> {
    return obtenirGestionnaireCapacites(this.options).capacitesNatives();
  }

  /** Enregistrement d'activation brut (admin/audit). */
  async activationDe(id: string): Promise<EnregistrementActivation | null> {
    return (await recuperer<EnregistrementActivation>(COLLECTION_REGISTRE, id, this.options)) ?? null;
  }

  reinitialiser(): void {
    this.cacheActivations = null;
  }
}

// ---------------------------------------------------------------------------
// Singleton (process-local, comme le gestionnaire)
// ---------------------------------------------------------------------------

const globalAvecRegistre = globalThis as typeof globalThis & {
  __gen3iaRegistreCapacites?: RegistreCentralCapacites;
};

/** Singleton du registre central (idempotent). */
export function obtenirRegistreCentral(options: OptionsRegistre = {}): RegistreCentralCapacites {
  if (!globalAvecRegistre.__gen3iaRegistreCapacites || options.dossier) {
    globalAvecRegistre.__gen3iaRegistreCapacites = new RegistreCentralCapacites(options);
  }
  return globalAvecRegistre.__gen3iaRegistreCapacites;
}

/** Réinitialise le singleton (tests). */
export function reinitialiserRegistreCentral(): void {
  globalAvecRegistre.__gen3iaRegistreCapacites = undefined;
  obtenirGestionnaireCapacites().reinitialiser();
}

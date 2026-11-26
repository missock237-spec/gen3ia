/**
 * GENAPI SERVICES — catalogue des services exposés aux développeurs externes
 * et PERMISSIONS PAR SERVICE (mission PHASE 3-5 : « Définir des permissions
 * par service » : Chat, Vision, Audio, Vidéo, Agents, Recherche,
 * Automatisation, Embeddings — + Reasoning et Training du PHASE 4).
 *
 * HONNÊTETÉ (règle plateforme) : le statut de chaque service reflète ce qui
 * existe RÉELLEMENT dans le dépôt — jamais de service simulé annoncé comme
 * opérationnel. Les services non connectés au Core restent « indisponible »
 * avec leur raison explicite dans les réponses d'adaptateur.
 */

export const SERVICES_GENAPI = [
  "chat",
  "reasoning",
  "vision",
  "audio",
  "video",
  "agents",
  "research",
  "automation",
  "embeddings",
  "training",
] as const;

export type ServiceGenapi = (typeof SERVICES_GENAPI)[number];

export function estServiceGenapi(valeur: string): valeur is ServiceGenapi {
  return (SERVICES_GENAPI as readonly string[]).includes(valeur);
}

/* ─────────────────────────────── APPLICATIONS ─────────────────────────────── */

export type EnvironnementGenapi = "test" | "production";

/** Une application développeur (mission PHASE 3-7 : associée à un propriétaire). */
export interface ApplicationGenapi {
  id: string;
  nom: string;
  /** Propriétaire Firebase UID — chaque application a UN propriétaire. */
  proprietaireId: string;
  environnement: EnvironnementGenapi;
  /** Services autorisés — tout autre service est refusé (PHASE 3-5). */
  servicesAutorises: ServiceGenapi[];
  /** Restrictions de consommation par application (PHASE 3-8). */
  restriction: {
    /** Appels max par minute (au-delà : 429). */
    appelsParMinute: number;
    /** Coût cumulé max par jour en micro-euros (au-delà : 402 refus budgétaire). */
    budgetJournalierMicroEur: number;
  };
  /** Révocation immédiate (PHASE 3-3) : plus aucun appel n'est accepté. */
  revoquee: boolean;
  creee: number;
}

/* ─────────────────────────────── STORE ─────────────────────────────── */

const globalApps = globalThis as typeof globalThis & {
  __gen3iaGenapiApps?: Map<string, ApplicationGenapi>;
};

function applications(): Map<string, ApplicationGenapi> {
  if (!globalApps.__gen3iaGenapiApps) globalApps.__gen3iaGenapiApps = new Map();
  return globalApps.__gen3iaGenapiApps;
}

/** Crée une application ; les permissions par service sont la liste exacte. */
export function creerApplicationGenapi(entree: {
  nom: string;
  proprietaireId: string;
  environnement?: EnvironnementGenapi;
  servicesAutorises?: ServiceGenapi[];
  appelsParMinute?: number;
  budgetJournalierMicroEur?: number;
}): ApplicationGenapi {
  const app: ApplicationGenapi = {
    id: `app_${crypto.randomUUID().slice(0, 12)}`,
    nom: entree.nom,
    proprietaireId: entree.proprietaireId,
    environnement: entree.environnement ?? "test",
    servicesAutorises: entree.servicesAutorises ?? ["chat"],
    restriction: {
      appelsParMinute: entree.appelsParMinute ?? 30,
      budgetJournalierMicroEur: entree.budgetJournalierMicroEur ?? 200_000, // 0,20 €/j par défaut
    },
    revoquee: false,
    creee: Date.now(),
  };
  applications().set(app.id, app);
  return app;
}

export function lireApplicationGenapi(id: string): ApplicationGenapi | null {
  return applications().get(id) ?? null;
}

export function applicationsDeProprietaire(propietaireId: string): ApplicationGenapi[] {
  return [...applications().values()].filter((a) => a.proprietaireId === propietaireId);
}

/** Révocation IMMÉDIATE (PHASE 3-3) : l'application est marquée revoquee. */
export function revoquerApplicationGenapi(id: string): boolean {
  const app = applications().get(id);
  if (!app) return false;
  app.revoquee = true;
  return true;
}

/** Rotation des secrets (PHASE 3-4) : délègue à developer-keys (génère une nouvelle clé). */
export interface VerdictPermission {
  autorise: boolean;
  raison?: string;
  /** Code de refus normalisé (gateway). */
  code?: "service-non-autorise" | "application-revoquee" | "environnement-refuse" | "service-indisponible";
}

/** Contrôle de permission : service ∈ permissions ET environnement cohérent. */
export function verifierPermissionService(app: ApplicationGenapi, service: ServiceGenapi, environnementRequis: EnvironnementGenapi = "production"): VerdictPermission {
  if (app.revoquee) {
    return { autorise: false, raison: `application « ${app.nom} » révoquée — révocation immédiate (mission PHASE 3-3)`, code: "application-revoquee" };
  }
  if (!app.servicesAutorises.includes(service)) {
    return { autorise: false, raison: `service « ${service} » non autorisé pour cette application (autorisés : ${app.servicesAutorises.join(", ") || "aucun"})`, code: "service-non-autorise" };
  }
  // Les clés de TEST ne peuvent pas produire de consommation réelle de
  // production (mission PHASE 3-6 : environnements séparés).
  if (environnementRequis === "production" && app.environnement === "test") {
    return { autorise: false, raison: "clé de test : service disponible en environnement test uniquement", code: "environnement-refuse" };
  }
  return { autorise: true };
}

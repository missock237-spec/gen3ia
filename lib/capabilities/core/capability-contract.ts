/**
 * CONTRAT CENTRAL DE L'UCE (Universal Capability Engine) — source de vérité
 * unique des types et des schémas de l'infrastructure de capacités.
 *
 * Principes (mission UCE) :
 *  - un SEUL contrat d'exécution : toute capacité (outil natif, skill,
 *    connecteur, modèle, bibliothèque, API) passe par ce contrat ;
 *  - un résultat NON VÉRIFIÉ n'est jamais une réussite confirmée
 *    (champ `verification` obligatoire sur chaque exécution) ;
 *  - une découverte = des DONNÉES : jamais des instructions pour le cerveau ;
 *  - l'intégration en production est TOUJOURS gated (autorisation explicite).
 *
 * Les entités reprennent la mission §9 (Capability, CapabilityVersion,
 * CapabilityBenchmark, CapabilityExecution, CapabilityEvaluation,
 * CapabilityDiscovery, CapabilityPermission, CapabilityLearning,
 * CapabilityIncident, CapabilityRollback, CapabilityResourceUsage) —
 * stockées en Firestore (stack réel du dépôt) ou en repli local versionné.
 */

import { z } from "zod";

/** Version du schéma des enregistrements persistés (migrations réversibles). */
export const CAPABILITY_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Capacité (entité centrale)
// ---------------------------------------------------------------------------

export const CAPABILITY_KINDS = [
  "tool",
  "skill",
  "connecteur",
  "modele",
  "bibliotheque",
  "api",
] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const CAPABILITY_ORIGINS = ["natif", "decouverte", "construite"] as const;
export type CapabilityOrigin = (typeof CAPABILITY_ORIGINS)[number];

/**
 * Machine à états d'une capacité (voir capability-state.ts pour les
 * transitions autorisées) : découverte → évaluée → benchmarquée → proposée →
 * autorisée → intégrée → validée ; ou rejetée / suspendue / rollback.
 */
export const CAPABILITY_STATUSES = [
  "decouverte",
  "evaluee",
  "benchmarquee",
  "proposee",
  "autorisee",
  "integree",
  "validee",
  "rejetee",
  "suspendue",
  "rollback",
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface CapabilityRequirements {
  node?: string;
  python?: string;
  memoireMo?: number;
  disqueMo?: number;
  gpu?: boolean;
  reseau?: boolean;
  systeme?: string;
}

export interface CapabilityCost {
  gratuit: boolean;
  note?: string;
}

/** Fiche normalisée d'une capacité (mission §2.B — champ par champ). */
export interface CapabilityCard {
  nom: string;
  description: string;
  fonctionnalites: string[];
  source: string;
  url?: string;
  licence?: string;
  dependances: string[];
  compatibilite?: string;
  cout?: CapabilityCost;
  exigences?: CapabilityRequirements;
  risques: string[];
  verifieLe: string;
}

export interface Capability {
  /** Identifiant stable et unique : `<origine>:<source>:<nom>` (dédupe). */
  id: string;
  kind: CapabilityKind;
  origin: CapabilityOrigin;
  status: CapabilityStatus;
  card: CapabilityCard;
  version?: string;
  /** Score agrégé de l'évaluation (0-100), présent après évaluation. */
  score?: number;
  /** Taux de succès mesuré au benchmark (0-1), présent après benchmark. */
  fiabiliteMesuree?: number;
  /** ID de la version active (voir CapabilityVersion). */
  versionActive?: string;
  schemaVersion: number;
  creeLe: string;
  majLe: string;
}

// ---------------------------------------------------------------------------
// CapabilityDiscovery — fiche de découverte brute d'une source
// ---------------------------------------------------------------------------

export const DISCOVERY_SOURCES = [
  "npm",
  "pypi",
  "github",
  "huggingface",
  "mcp",
  "api",
  "interne",
] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export interface CapabilityDiscovery {
  id: string;
  source: DiscoverySource;
  kind: CapabilityKind;
  nom: string;
  description: string;
  fonctionnalites: string[];
  url?: string;
  licence?: string;
  version?: string;
  dependances: string[];
  cout?: CapabilityCost;
  exigences?: CapabilityRequirements;
  risques: string[];
  /** Statut honnête de la collecte : ok | indisponible (cause réelle). */
  statut: "ok" | "indisponible";
  causeIndisponibilite?: string;
  verifieLe: string;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// CapabilityEvaluation — critères mesurables (mission §2.C)
// ---------------------------------------------------------------------------

export interface EvaluationCriteria {
  /** 0-100 — le critère « fonctionnement réel » EXIGE une mesure : sans
   * benchmark réel il vaut 0 et le verdict ne peut pas être « recommandé ». */
  fonctionnementReel: number;
  compatibiliteGen3ia: number;
  performance: number;
  precision: number;
  fiabilite: number;
  securite: number;
  memoire: number;
  cpu: number;
  cout: number;
  maintenabilite: number;
  documentation: number;
}

export interface CapabilityEvaluation {
  id: string;
  capabilityId: string;
  criteria: EvaluationCriteria;
  /** Somme pondérée 0-100 (poids par défaut dans evaluation/poids.ts). */
  score: number;
  verdict: "recommande" | "revue_requise" | "rejete";
  raisons: string[];
  /** Vrai uniquement si au moins un benchmark réel a été mesuré. */
  mesureReelle: boolean;
  evalueLe: string;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// CapabilityBenchmark — mesures réelles et reproductibles
// ---------------------------------------------------------------------------

export interface BenchmarkStats {
  runs: number;
  succes: number;
  tauxSucces: number;
  latenceMoyenneMs: number;
  latenceP95Ms: number;
  latenceMinMs: number;
  latenceMaxMs: number;
  memoirePicMo?: number;
  /** Graine de reproductibilité (exécutions déterministes attendues). */
  graine?: number;
}

export interface CapabilityBenchmark {
  id: string;
  capabilityId: string;
  scenario: string;
  environment: { node: string; plateforme: string; mode: string };
  stats: BenchmarkStats;
  /** Journaux tronqués et masqués (aucun secret — voir secrets-protection). */
  journaux: string[];
  mesureLe: string;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// CapabilityExecution — le contrat d'exécution UNIFIÉ (mission §2.G)
// ---------------------------------------------------------------------------

export const EXECUTION_STATUSES = [
  "planifiee",
  "autorisee",
  "en_cours",
  "succes",
  "echec",
  "refusee",
  "timeout",
  "annulee",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export interface CapabilityExecutionRequest {
  executionId: string;
  userId: string;
  projectId?: string;
  capabilityId: string;
  input: unknown;
  /** Surface appelante (chat, api, agent, admin, cycle-uce). */
  origine: string;
  deadlineMs?: number;
}

export interface PermissionDecisionRecord {
  couche: "arret-urgence" | "politique" | "consentement" | "permission-uce";
  autorise: boolean;
  raison: string;
}

/** Preuve de validation : un résultat non vérifié ≠ réussite confirmée. */
export interface ExecutionVerification {
  verifie: boolean;
  methode: string;
  details?: string;
}

export interface CapabilityExecution {
  id: string;
  capabilityId: string;
  toolName: string;
  demande: string;
  permissions: PermissionDecisionRecord[];
  status: ExecutionStatus;
  demarreLe: string;
  dureeMs: number;
  /** Sortie tronquée et masquée (jamais de secret ni de payload géant). */
  resultat?: string;
  erreur?: string;
  journaux: string[];
  verification: ExecutionVerification;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// CapabilityVersion / Rollback / Incident / Permission / Learning / Ressource
// ---------------------------------------------------------------------------

export interface CapabilityVersion {
  id: string;
  capabilityId: string;
  version: string;
  statut: "active" | "staged" | "retraitee" | "rollback";
  changements: string;
  parentVersion?: string;
  tests: Array<{ nom: string; ok: boolean; dureeMs: number }>;
  creeLe: string;
  schemaVersion: number;
}

export interface CapabilityDependency {
  id: string;
  capabilityId: string;
  /** Identifiant de la capacité dont dépend `capabilityId`. */
  dependDeCapabilityId: string;
  critique: boolean;
  schemaVersion: number;
}

export interface CapabilityPermission {
  id: string;
  capabilityId: string;
  risque: "lecture" | "ecriture" | "externe" | "destructif";
  permissionsRequises: string[];
  gated: boolean;
  accordePar?: string;
  accordeLe?: string;
  schemaVersion: number;
}

export interface CapabilityLearning {
  id: string;
  /** Connaissances ≠ compétences ≠ paramètres neuronaux (mission §4/RÈGLE 4). */
  kind: "connaissance" | "competence" | "neural";
  capabilityId?: string;
  lecon: string;
  avant?: number;
  apres?: number;
  /** Jeu de test indépendant utilisé pour la mesure avant/après. */
  jeuTest?: string;
  regressionDetectee: boolean;
  valide: boolean;
  apprentiLe: string;
  schemaVersion: number;
}

export interface CapabilityIncident {
  id: string;
  capabilityId: string;
  kind: "echec-execution" | "echec-benchmark" | "incompatibilite" | "securite" | "ressource";
  message: string;
  statut: "ouvert" | "resolu";
  ouvertLe: string;
  resoluLe?: string;
  schemaVersion: number;
}

export interface CapabilityRollback {
  id: string;
  capabilityId: string;
  depuisVersion: string;
  versVersion: string;
  raison: string;
  resultat: "succes" | "echec";
  effectueLe: string;
  schemaVersion: number;
}

export interface CapabilityResourceUsage {
  id: string;
  capabilityId: string;
  cpuMs?: number;
  memoirePicMo?: number;
  dureeMs: number;
  mesureLe: string;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Schémas zod des entrées d'exécution (validation à la frontière)
// ---------------------------------------------------------------------------

export const executionRequestSchema = z.object({
  executionId: z.string().min(6).max(200),
  userId: z.string().min(1).max(200),
  projectId: z.string().max(200).optional(),
  capabilityId: z.string().min(1).max(300),
  input: z.unknown(),
  origine: z.string().min(1).max(60),
  deadlineMs: z.number().int().min(1_000).max(120_000).optional(),
});

/** Identifiants de capability : origine:source:nom (borné, sans espace). */
export const capabilityIdSchema = z
  .string()
  .regex(/^[a-z0-9_-]+(:[a-z0-9_.-]+)*$/i, "id de capacité invalide")
  .max(300);

// ---------------------------------------------------------------------------
// Utilitaires d'identification
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/** Construit l'identifiant stable d'une capacité depuis sa carte. */
export function construireCapabilityId(origin: CapabilityOrigin, source: string, nom: string): string {
  const nomNettoye = nom.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 120);
  const sourceNettoye = source.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 60);
  return `${origin}:${sourceNettoye}:${nomNettoye}`;
}

/** Identifiant de déduplication d'une découverte (source + nom + version). */
export function cleDeduplication(source: DiscoverySource, nom: string, version?: string): string {
  return createHash("sha256").update(`${source}::${nom}::${version ?? ""}`).digest("hex").slice(0, 24);
}

/** Identifiant court d'enregistrement (préfixe lisible + hash). */
export function idEnregistrement(prefixe: string, contenu: string): string {
  return `${prefixe}_${createHash("sha256").update(contenu + Date.now() + Math.random()).digest("hex").slice(0, 16)}`;
}

/** Estampille ISO maintenant (une seule définition, partout dans l'UCE). */
export function maintenantIso(): string {
  return new Date().toISOString();
}

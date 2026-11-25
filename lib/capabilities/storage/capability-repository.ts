/**
 * REPOSITORY UCE — persistance des entités de capacités.
 *
 * Backend principal : Firestore (stack réel du dépôt) via les helpers
 * résilients de `lib/db/firestore-resilient.ts`. Repli honnête : fichiers
 * JSONL locaux sous `var/capabilities/` (append + « dernier record gagne »,
 * même motif éprouvé que la mémoire de connaissances du cerveau autonome).
 *
 * L'écart mission §9 (PostgreSQL) → Firestore est documenté dans le rapport
 * Phase 0 : aucune entité de la mission n'est perdue, seule la technologie
 * de stockage s'adapte au dépôt réel.
 */

import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  firestoreUsable,
  resilientSet,
  resilientQuery,
  type ResilientQueryOptions,
} from "@/lib/db/firestore-resilient";
import { idEnregistrement, maintenantIso } from "../core/capability-contract";
import { migrerEnregistrement } from "./capability-migrations";

/** Collections UCE (préfixe commun — zéro collision avec le reste du dépôt). */
export const COLLECTIONS_UCE = {
  capabilities: "cap_capabilities",
  discoveries: "cap_discoveries",
  evaluations: "cap_evaluations",
  benchmarks: "cap_benchmarks",
  executions: "cap_executions",
  versions: "cap_versions",
  permissions: "cap_permissions",
  learning: "cap_learning",
  incidents: "cap_incidents",
  rollbacks: "cap_rollbacks",
  resources: "cap_resources",
  dependencies: "cap_dependencies",
} as const;

export type CollectionUce = keyof typeof COLLECTIONS_UCE;

export interface RepositoryUceOptions {
  /** Répertoire du repli local (défaut : var/capabilities). */
  dossier?: string;
  /** Forcer le backend local (tests) — sinon auto-détection Firestore. */
  forcerLocal?: boolean;
}

interface Backend {
  mode: "firestore" | "local";
  dossier: string;
  /** Cache mémoire des index par collection (fichiers chargés une fois). */
  memoire: Map<string, Map<string, Record<string, unknown>>>;
  chargee: Set<string>;
}

let singleton: Backend | null = null;

async function obtenirBackend(options: RepositoryUceOptions = {}): Promise<Backend> {
  if (singleton && !options.dossier) return singleton;
  const dossier = options.dossier ?? path.join(process.cwd(), "var", "capabilities");
  const backend: Backend = {
    // Firestore = backend principal si l'environnement l'autorise
    // (firestoreUsable : clés + réseau) ; le journal local reste TOUJOURS
    // écrit (vérité complète, fonctionne hors ligne, rélecture instantanée).
    mode: options.forcerLocal ? "local" : (firestoreUsable() ? "firestore" : "local"),
    dossier,
    memoire: new Map(),
    chargee: new Set(),
  };
  if (singleton && !options.dossier) return singleton;
  singleton = backend;
  return backend;
}

// ---------------------------------------------------------------------------
// Repli local : JSONL append (dernier record gagne)
// ---------------------------------------------------------------------------

async function chargerCollection(backend: Backend, collection: CollectionUce): Promise<Map<string, Record<string, unknown>>> {
  if (backend.chargee.has(collection)) return backend.memoire.get(collection)!;
  const carte = new Map<string, Record<string, unknown>>();
  const chemin = path.join(backend.dossier, `${collection}.jsonl`);
  try {
    const contenu = await fs.readFile(chemin, "utf8");
    for (const ligne of contenu.split("\n")) {
      if (!ligne.trim()) continue;
      try {
        const rec = JSON.parse(ligne) as Record<string, unknown> & { id?: string };
        if (typeof rec.id === "string") carte.set(rec.id, rec);
      } catch {
        // Ligne corrompue : ignorée honnêtement (append-only journal).
      }
    }
  } catch {
    // Fichier absent : collection vide — cas normal au premier démarrage.
  }
  backend.memoire.set(collection, carte);
  backend.chargee.add(collection);
  return carte;
}

async function persisterLocal(backend: Backend, collection: CollectionUce, rec: Record<string, unknown>): Promise<void> {
  await fs.mkdir(backend.dossier, { recursive: true });
  await fs.appendFile(path.join(backend.dossier, `${collection}.jsonl`), JSON.stringify(rec) + "\n", "utf8");
  const carte = await chargerCollection(backend, collection);
  carte.set(String(rec.id), rec);
}

// ---------------------------------------------------------------------------
// API publique du repository
// ---------------------------------------------------------------------------

export interface SauvegardeResultat {
  id: string;
  backend: "firestore" | "local";
  migrationsAppliquees: string[];
}

/** Enregistre (upsert) un enregistrement dans une collection UCE. */
export async function sauvegarder<T extends { id: string }>(
  collection: CollectionUce,
  enregistrement: T,
  options: RepositoryUceOptions = {},
): Promise<SauvegardeResultat> {
  const migration = migrerEnregistrement(enregistrement as unknown as Record<string, unknown>);
  const rec = migration.enregistrement as unknown as T & { majLe?: string };
  if (!rec.id) throw new Error("sauvegarder : id obligatoire");

  const backend = await obtenirBackend(options);
  let mode: "firestore" | "local" = "local";

  // 1) Firestore (backend principal) — l'échec ne bloque pas le travail.
  if (backend.mode === "firestore" && !options.forcerLocal) {
    try {
      const { adminDb } = await import("@/lib/firebase/admin");
      if (adminDb) {
        const { nestDottedKeys } = await import("@/lib/db/firestore-resilient");
        await resilientSet(
          COLLECTIONS_UCE[collection],
          rec.id,
          nestDottedKeys({ ...rec, majLe: maintenantIso() } as unknown as Record<string, unknown>),
          { merge: true },
        );
        mode = "firestore";
      }
    } catch {
      mode = "local";
    }
  }

  // 2) Journal local systématique (vérité complète, rélecture instantanée).
  await persisterLocal(backend, collection, { ...rec, majLe: maintenantIso() });

  return { id: rec.id, backend: mode, migrationsAppliquees: migration.migrationsAppliquees };
}

/** Récupère un enregistrement par identifiant (null si absent). */
export async function recuperer<T>(
  collection: CollectionUce,
  id: string,
  options: RepositoryUceOptions = {},
): Promise<T | null> {
  const backend = await obtenirBackend(options);
  const carte = await chargerCollection(backend, collection);
  const local = carte.get(id);
  if (local) return migrerEnregistrement(local).enregistrement as unknown as T;
  return null;
}

/** Liste les enregistrements d'une collection (tri par majLe décroissant). */
export async function lister<T extends { id: string; majLe?: string }>(
  collection: CollectionUce,
  filtre?: Partial<Record<string, string>>,
  limite = 200,
  options: RepositoryUceOptions = {},
): Promise<T[]> {
  const backend = await obtenirBackend(options);
  const carte = await chargerCollection(backend, collection);
  let valeurs = [...carte.values()] as unknown as T[];
  if (filtre) {
    for (const [cle, valeur] of Object.entries(filtre)) {
      valeurs = valeurs.filter((v) => String((v as Record<string, unknown>)[cle]) === valeur);
    }
  }
  valeurs.sort((a, b) => String(b.majLe ?? "").localeCompare(String(a.majLe ?? "")));
  return valeurs.slice(0, limite);
}

/** Interroge Firestore directement (usage ponctuel multi-tenant — admin). */
export async function interrogerFirestore<T>(
  collection: CollectionUce,
  filtres: Array<{ field: string; value: unknown }> = [],
  options: ResilientQueryOptions = {},
): Promise<T[] | null> {
  try {
    const backend = await obtenirBackend();
    if (backend.mode !== "firestore") return null;
    return await resilientQuery<T>(COLLECTIONS_UCE[collection], filtres, options);
  } catch {
    return null;
  }
}

/** Compte les enregistrements d'une collection (cache local). */
export async function compter(collection: CollectionUce, options: RepositoryUceOptions = {}): Promise<number> {
  const backend = await obtenirBackend(options);
  const carte = await chargerCollection(backend, collection);
  return carte.size;
}

/** Génère un identifiant d'enregistrement UCE (préfixe lisible). */
export function nouvelId(prefixe: string, contenuDeterministe: string): string {
  return idEnregistrement(prefixe, contenuDeterministe);
}

/** Réinitialise le singleton (tests uniquement). */
export function reinitialiserRepositoryUce(): void {
  singleton = null;
}

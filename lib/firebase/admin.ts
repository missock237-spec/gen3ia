import {
  cert,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";

import { getR2Fs, type Firestore } from "@/lib/r2fs";

/**
 * MIGRATION R2 TOTALE (Task 111) — ce module conserve son chemin d'import
 * (@/lib/firebase/admin) et ses exports consommés par ~55 modules et 45
 * fichiers de tests (adminDb, getAdminDb, getAdminApp) :
 *
 *  - adminDb est désormais le MOTEUR r2fs (lib/r2fs) : documents JSON dans
 *    R2 sous fs/{collection}/{docId}.json, écritures conditionnelles S3
 *    (If-Match ETag) pour les transactions — Firestore n'est PLUS utilisé
 *    comme base de données (cause racine des pannes de quota du 4 oct. :
 *    écritures qui pendent sans lever).
 *  - getAdminApp conserve UNIQUEMENT le rôle de fournisseur d'identité
 *    (Firebase Auth : vérification de tokens côté émulateur, suppression
 *    de compte, recherche par email Chariow). Firebase Storage n'est plus
 *    utilisé (adminStorage supprimé).
 */

function readServerEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value !== "undefined" && value !== "null" ? value : undefined;
}

function getFirebaseAdminConfig() {
  const projectId = readServerEnv("FIREBASE_PROJECT_ID");
  const clientEmail = readServerEnv("FIREBASE_CLIENT_EMAIL");
  const rawPrivateKey = readServerEnv("FIREBASE_PRIVATE_KEY");
  const privateKey = rawPrivateKey
    ?.replace(/^['"]|['"]$/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .trim();

  if (!projectId || !clientEmail || !privateKey?.includes("BEGIN PRIVATE KEY")) {
    throw new Error("Firebase Admin configuration is missing or invalid. Configure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in the production environment.");
  }

  return { projectId, clientEmail, privateKey };
}

function getFirebaseAdmin() {
  const existingApp = getApps()[0];
  if (existingApp) return existingApp;

  const projectId = readServerEnv("FIREBASE_PROJECT_ID");

  // Firebase Admin automatically routes Auth calls to the local
  // emulators when these environment variables are present. No service
  // account credential is needed in that isolated test environment.
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST?.trim()) {
    return initializeApp({ projectId: projectId || "demo-gen3ia" });
  }

  return initializeApp({
    credential: cert(getFirebaseAdminConfig()),
  });
}

/** Lazily initialized Firebase Admin app (AUTH uniquement — pas de base de données). */
let cachedApp: App | undefined;

export function getAdminApp(): App {
  if (!cachedApp) {
    cachedApp = getFirebaseAdmin();
  }
  return cachedApp;
}

/**
 * Le moteur de données r2fs partagé du process. Proxy paresseux : aucune
 * connexion R2 n'est touchée tant qu'aucune méthode n'est appelée (le
 * comportement lazy de l'ancien getFirestore est préservé, notamment pour
 * les imports de modules en contexte build/test).
 */
let cachedDb: Firestore | undefined;

function buildR2Fs(): Firestore {
  if (!cachedDb) {
    cachedDb = getR2Fs();
  }
  return cachedDb;
}

export const adminDb: Firestore = new Proxy({} as Firestore, {
  get(_target, property) {
    const instance = buildR2Fs();
    const value = Reflect.get(instance as object, property);
    return typeof value === "function" ? value.bind(instance) : value;
  },
  has(_target, property) {
    return Reflect.has(buildR2Fs() as object, property);
  },
});

/** Le moteur r2fs (anciennement Firestore) — même surface consommée. */
export function getAdminDb(): Firestore {
  return buildR2Fs();
}

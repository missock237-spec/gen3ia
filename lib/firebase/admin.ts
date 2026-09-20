import {
  cert,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";

import {
  getFirestore,
  type Firestore,
} from "firebase-admin/firestore";

import {
  getStorage,
  type Storage,
} from "firebase-admin/storage";

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

  // Firebase Admin automatically routes Auth/Firestore calls to the local
  // emulators when these environment variables are present. No service
  // account credential is needed in that isolated test environment.
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST?.trim() || process.env.FIRESTORE_EMULATOR_HOST?.trim()) {
    return initializeApp({ projectId: projectId || "demo-gen3ia" });
  }

  return initializeApp({
    credential: cert(getFirebaseAdminConfig()),
    storageBucket:
      readServerEnv("FIREBASE_STORAGE_BUCKET") ??
      readServerEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET"),
  });
}

/** Lazily initialized Firebase Admin app. */
let cachedApp: App | undefined;

export function getAdminApp(): App {
  if (!cachedApp) {
    cachedApp = getFirebaseAdmin();
  }
  return cachedApp;
}

function lazyService<T extends object>(create: () => T): T {
  let instance: T | undefined;

  return new Proxy({} as T, {
    get(_target, property) {
      if (!instance) instance = create();
      const value = Reflect.get(instance as object, property);
      return typeof value === "function" ? value.bind(instance) : value;
    },
    has(_target, property) {
      if (!instance) instance = create();
      return Reflect.has(instance as object, property);
    },
  });
}

export const adminDb: Firestore = lazyService(() => getAdminDb());

export const adminStorage: Storage = lazyService(() =>
  getStorage(getAdminApp()),
);

/**
 * Le projet peut utiliser une base Firestore nommée via
 * FIREBASE_FIRESTORE_DATABASE_ID.
 */
export function getAdminDb(): Firestore {
  const app = getAdminApp();
  const databaseId = process.env.FIREBASE_FIRESTORE_DATABASE_ID?.trim();
  const db = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
  // Les sorties d'outils/agents (resultats de recherche, observations, plans)
  // contiennent parfois des champs undefined (ex. publishedAt absent d'un
  // resultat). Firestore les refuse par defaut et fait echouer checkpoints,
  // conversations et sauvegardes : on les ignore silencieusement.
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

export function getAdminStorage(): Storage {
  return getStorage(getAdminApp());
}

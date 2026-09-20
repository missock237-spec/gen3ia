import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GithubAuthProvider,
  GoogleAuthProvider,
  onAuthStateChanged,
  type Auth,
  type User
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

/**
 * Assainit une variable NEXT_PUBLIC_* lue STATIQUEMENT.
 *
 * IMPORTANT : l'acces `process.env.NEXT_PUBLIC_*` doit rester statique.
 * Next.js (webpack/Turbopack) n'inline dans le bundle client que les
 * references statiques : un acces dynamique `process.env[name]` vaut
 * toujours `undefined` dans le navigateur, ce qui produisait une
 * configuration Firebase vide (auth/invalid-api-key) et faisait planter
 * les pages qui initialisent le SDK client.
 */
function normaliserConfigPublique(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null"
    ? trimmed
    : undefined;
}

const firebaseConfig = {
  apiKey: normaliserConfigPublique(process.env.NEXT_PUBLIC_FIREBASE_API_KEY),
  authDomain: normaliserConfigPublique(
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  ),
  projectId: normaliserConfigPublique(
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  ),
  storageBucket: normaliserConfigPublique(
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  ),
  messagingSenderId: normaliserConfigPublique(
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  ),
  appId: normaliserConfigPublique(process.env.NEXT_PUBLIC_FIREBASE_APP_ID),
};

export function hasFirebaseClientConfig(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId,
  );
}

/**
 * Lazily initialized Firebase web app.
 *
 * The client SDK is only initialized on first use so that pages importing
 * this module can still be prerendered at build time even when the
 * NEXT_PUBLIC_FIREBASE_* variables are not available yet.
 */
let cachedApp: FirebaseApp | undefined;

function getFirebaseApp(): FirebaseApp {
  if (!cachedApp) {
    cachedApp =
      getApps().length > 0
        ? getApps()[0]!
        : initializeApp(firebaseConfig);
  }
  return cachedApp;
}

function lazyService<T extends object>(create: () => T): T {
  let instance: T | undefined;

  return new Proxy({} as T, {
    get(_target, property) {
      if (!instance) {
        instance = create();
      }
      const value = Reflect.get(instance as object, property);
      return typeof value === "function" ? value.bind(instance) : value;
    },
    has(_target, property) {
      if (!instance) {
        instance = create();
      }
      return Reflect.has(instance as object, property);
    },
  });
}

export const auth: Auth = lazyService(() => getAuth(getFirebaseApp()));
export const db: Firestore = lazyService(() => getFirestore(getFirebaseApp()));
export const storage: FirebaseStorage = lazyService(() =>
  getStorage(getFirebaseApp())
);

/**
 * Abonnement a l'etat d'authentification qui ne leve JAMAIS d'exception.
 *
 * Si la configuration Firebase cliente est absente (build sans
 * NEXT_PUBLIC_FIREBASE_*) ou que l'initialisation du SDK echoue,
 * on retourne un unsubscribe factice au lieu de faire planter la page
 * entiere : les pages restent utilisables via la session serveur
 * (cookie gen3ia_session) et les appels API authentifies.
 */
export function watchAuth(
  callback: (user: User | null) => void,
): () => void {
  try {
    return onAuthStateChanged(auth, callback);
  } catch {
    callback(null);
    return () => {};
  }
}

export const googleProvider = new GoogleAuthProvider();

googleProvider.setCustomParameters({
  prompt: "select_account"
});

export const githubProvider = new GithubAuthProvider();

githubProvider.addScope("read:user");
githubProvider.addScope("user:email");

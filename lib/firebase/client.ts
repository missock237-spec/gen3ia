import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GithubAuthProvider,
  GoogleAuthProvider,
  type Auth
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

function readPublicConfig(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value !== "undefined" && value !== "null" ? value : undefined;
}

const firebaseConfig = {
  apiKey: readPublicConfig("NEXT_PUBLIC_FIREBASE_API_KEY"),
  authDomain: readPublicConfig("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
  projectId: readPublicConfig("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
  storageBucket: readPublicConfig("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: readPublicConfig(
    "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  ),
  appId: readPublicConfig("NEXT_PUBLIC_FIREBASE_APP_ID"),
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

export const googleProvider = new GoogleAuthProvider();

googleProvider.setCustomParameters({
  prompt: "select_account"
});

export const githubProvider = new GithubAuthProvider();

githubProvider.addScope("read:user");
githubProvider.addScope("user:email");

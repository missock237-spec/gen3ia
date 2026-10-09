import "server-only";

/**
 * MIGRATION R2 TOTALE — r2fs : remplaçant DROP-IN de firebase-admin/firestore.
 *
 * Re-exports la surface utilisée par le projet (inventaire exact, cf. worklog) :
 *   - FieldValue (increment/delete/serverTimestamp/arrayUnion/arrayRemove) ;
 *   - Timestamp (now/fromMillis/fromDate/toMillis/toDate) ;
 *   - types DocumentData, DocumentReference, CollectionReference, Query,
 *     QuerySnapshot, DocumentSnapshot, Firestore, SetOptions, Transaction,
 *     WriteBatch, AggregateField (sum/count/avg).
 *
 * Le client unique s'obtient via getR2Fs() (singleton process, proxy paresseux
 * comme l'ancien adminDb). Ce module est importé par lib/firebase/admin.ts —
 * le chemin d'import des consommateurs NE CHANGE PAS.
 */

import { R2Fs, FsDocRef, FsCollection, type FsDocumentData, type FsQueryDocSnapshot } from "./db";
import { FsTimestamp } from "./serialization";

export { R2Fs, FsDocRef, FsCollection, FsQuery, FsQuerySnapshot, FsDocSnapshot, FsAggregation, FsTransaction, FsWriteBatch, type AggSpecIn } from "./db";
export type { FsDocumentData, WhereOp } from "./db";
export { FieldValue } from "./field-value";
/** Alias VALEUR : les consommateurs appellent Timestamp.now() / Timestamp.fromMillis(). */
export { FsTimestamp as Timestamp };
export { FsError, isConflictError, FS_DOC_WRITE_CAP_BYTES, FS_DOC_READ_CAP_BYTES } from "./store";
export { FsTimestamp, compareValeurs } from "./serialization";
export { docKey, collectionPrefix, parseKey, FS_ROOT, encodeSeg, decodeSeg } from "./keys";

/* ------------------------------------------------------------------ */
/* Types de compatibilité (imports « type » des consommateurs)         */
/* ------------------------------------------------------------------ */

/** Compatibilité de surface : les données sont indexables par champ (any = contrat firebase-admin). */
export type DocumentData = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parité firebase-admin
  [field: string]: any;
};
export type SetOptions = { merge?: boolean };
export type Precondition = { exists: boolean };

/** Alias de compatibilité avec les types firebase-admin consommés. */
export type DocumentReference = FsDocRef;
export type CollectionReference = FsCollection;
export type Transaction = import("./db").FsTransaction;
export type WriteBatch = import("./db").FsWriteBatch;
export type DocumentSnapshot = import("./db").FsDocSnapshot;
export type QueryDocumentSnapshot<_T = FsDocumentData> = FsQueryDocSnapshot;
export type QuerySnapshot = import("./db").FsQuerySnapshot;
export type Query<T = FsDocumentData, _Db = T> = import("./db").FsQuery<T>;

/** Interface « Firestore » telle que consommée (adminDb). */
export interface Firestore {
  collection(chemin: string): import("./db").FsCollection;
  doc(chemin: string): import("./db").FsDocRef;
  collectionGroup(nom: string): import("./db").FsQuery;
  runTransaction<T>(fn: (tx: import("./db").FsTransaction) => Promise<T>, opts?: { maxAttempts?: number }): Promise<T>;
  batch(): import("./db").FsWriteBatch;
  recursiveDelete(ref: FsDocRef | FsCollection): Promise<number>;
}

/** Alias de compatibilité : AggregateField.sum / count / avg (sentinelles). */
export const AggregateField = {
  sum(field: string) {
    return { __fs_agg__: "sum" as const, field };
  },
  count() {
    return { __fs_agg__: "count" as const };
  },
  avg(field: string) {
    return { __fs_agg__: "avg" as const, field };
  },
} as const;

/**
 * Namespace de compatibilité — les modules du projet référencent
 * `FirebaseFirestore.DocumentData`, etc. (héritage des types firebase-admin).
 * Le namespace GLOBAL est déclaré dans firebase-compat.d.ts ; celui-ci
 * sert aux imports explicites éventuels.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace FirebaseFirestore {
  export type Timestamp = FsTimestamp;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parité firebase-admin
  export type DocumentData = { [field: string]: any };
  export type DocumentReference = FsDocRef;
  export type CollectionReference = FsCollection;
  export type Query<T = DocumentData, _Db = T> = import("./db").FsQuery<T>;
  export type QuerySnapshot = import("./db").FsQuerySnapshot;
  export type DocumentSnapshot = import("./db").FsDocSnapshot;
  export type QueryDocumentSnapshot<_T = DocumentData> = import("./db").FsQueryDocSnapshot;
  /** Instance-type de la sentinelle FieldValue (jamais persistée). */
  export type FieldValue = unknown;
}

/* ------------------------------------------------------------------ */
/* Singleton process (proxy paresseux, comme l'ancien adminDb)          */
/* ------------------------------------------------------------------ */

let instance: R2Fs | undefined;

/**
 * Le client r2fs partagé du process. Proxy paresseux : aucune dépendance R2
 * n'est touchée tant qu'aucune méthode n'est appelée (imports sans effet de
 * bord, comme getFirestore était lazy).
 */
export function getR2Fs(): Firestore {
  if (!instance) instance = new R2Fs();
  return instance;
}

import type { FsCollection, FsDocRef, FsDocSnapshot, FsQuery, FsQueryDocSnapshot, FsQuerySnapshot, FsTimestamp } from "./index";

/**
 * MIGRATION R2 TOTALE — compatibilité de NOMS GLOBAUX.
 *
 * firebase-admin/firestore exposait un namespace GLOBAL `FirebaseFirestore`
 * (déclaré dans ses types). Des modules du projet référencent encore ces
 * formes (`FirebaseFirestore.DocumentData`, `FirebaseFirestore.Query`…)
 * sans import explicite. Ce d.ts recrée le namespace global en le branchant
 * sur les types r2fs — à la manière d'un header de compatibilité.
 */

declare global {
  namespace FirebaseFirestore {
    type Timestamp = FsTimestamp;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parité firebase-admin
    type DocumentData = { [field: string]: any };
    type DocumentReference = FsDocRef;
    type CollectionReference = FsCollection;
    type Query<T = DocumentData, _Db = T> = FsQuery<T>;
    type QuerySnapshot = FsQuerySnapshot;
    type DocumentSnapshot = FsDocSnapshot;
    type QueryDocumentSnapshot<_T = DocumentData> = FsQueryDocSnapshot;
    /** Instance-type de la sentinelle FieldValue (jamais persistée). */
    type FieldValue = unknown;
    type Transaction = import("./index").Transaction;
    type WriteBatch = import("./index").WriteBatch;
  }
}

export {};

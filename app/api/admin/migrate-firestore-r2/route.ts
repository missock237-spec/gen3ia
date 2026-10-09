import { NextRequest, NextResponse } from "next/server";
import type { DocumentReference, Timestamp } from "firebase-admin/firestore";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { getAdminApp } from "@/lib/firebase/admin";
import { rawPut } from "@/lib/r2fs/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * MIGRATION R2 TOTALE (Task 111-b) — copie 1:1 Firestore → R2.
 *
 * PARCOURS : collections racine → documents → sous-collections (récursif,
 * profondeur ≤ 6). Chaque document est écrit à sa clé canonique r2fs
 * `fs/{chemin collection}/{docId}.json` en forme CANONIQUE de sérialisation
 * ({__fs_ts__} pour les Timestamps — même contrat que le moteur r2fs).
 *
 * CONVERSIONS :
 *   Timestamp / Date        → { __fs_ts__: ms }
 *   DocumentReference       → { __fs_ref__: "coll/doc/…" }
 *   GeoPoint                → { __fs_geo__: { latitude, longitude } }
 *   Bytes                   → { __fs_b64__: base64 }
 *
 * PROPRIÉTÉS : relançable et idempotent (overwrite last-write-wins — un
 * second passage ne peut que rafraîchir). BUDGET TEMPS : la copie s'arrête
 * proprement à ~240 s et rend le compte des collections restées incomplètes
 * → re-appeler la route (relance complète, simple et sûre à cette échelle).
 *
 * IMPORTANT : ce module est le SEUL endroit du projet qui lit encore
 * Firestore (import dynamique firebase-admin/firestore) — usage ponctuel de
 * migration, jamais dans le chemin de données applicatif.
 */

interface MigrationReport {
  collection: string;
  docs: number;
  subcollections: string[];
  error?: string;
}

const PROFONDEUR_MAX = 6;
const LOTS = 200;
const BUDGET_MS = 240_000;

/** Conversion des types Firestore → forme stockée r2fs. */
function convertir(valeur: unknown): unknown {
  if (valeur === null || valeur === undefined) return null;
  if (typeof valeur === "object") {
    const objet = valeur as Record<string, unknown>;
    // Timestamp Firestore (toMillis) et Date.
    if (typeof (objet as { toMillis?: unknown }).toMillis === "function") {
      return { __fs_ts__: (valeur as Timestamp).toMillis() };
    }
    if (valeur instanceof Date) return { __fs_ts__: valeur.getTime() };
    // DocumentReference (objet avec path + parent).
    if (typeof (objet as { path?: unknown }).path === "string" && typeof (objet as { parent?: unknown }).parent === "object") {
      return { __fs_ref__: (valeur as DocumentReference).path };
    }
    if (
      typeof objet.latitude === "number" &&
      typeof objet.longitude === "number" &&
      Object.keys(objet).length === 2
    ) {
      return { __fs_geo__: { latitude: objet.latitude, longitude: objet.longitude } };
    }
    if (valeur instanceof Uint8Array) {
      return { __fs_b64__: Buffer.from(valeur).toString("base64") };
    }
    if (Array.isArray(valeur)) return valeur.map((item) => convertir(item) ?? null);
    const sortie: Record<string, unknown> = {};
    for (const [cle, v] of Object.entries(objet)) {
      const converti = convertir(v);
      if (converti !== undefined) sortie[cle] = converti; // ignoreUndefined
    }
    return sortie;
  }
  return valeur;
}

async function migrerCollection(
  db: FirebaseFirestore.Firestore,
  refCollection: FirebaseFirestore.CollectionReference,
  chemin: string[],
  rapport: MigrationReport,
  echeance: number,
): Promise<boolean> {
  // Pagination Firestore par __name__ (stable, complète).
  let curseur: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let requete = refCollection.limit(LOTS);
    if (curseur) requete = requete.startAfter(curseur);
    const lot = await requete.get();

    for (const doc of lot.docs) {
      const donnees = convertir(doc.data()) as Record<string, unknown>;
      await rawPut(chemin, doc.id, donnees);
      rapport.docs += 1;
      curseur = doc;

      // Sous-collections de ce document (profondeur bornée).
      if (chemin.length / 2 + 1 <= PROFONDEUR_MAX) {
        const sousCollections = await doc.ref.listCollections();
        for (const sousRef of sousCollections) {
          rapport.subcollections.push([...chemin, doc.id, sousRef.id].join("/"));
          const sousRapport: MigrationReport = {
            collection: sousRef.path,
            docs: 0,
            subcollections: [],
          };
          await migrerCollection(db, sousRef, [...chemin, doc.id, sousRef.id], sousRapport, echeance);
          rapport.docs += sousRapport.docs;
        }
      }
    }

    if (lot.empty || lot.size < LOTS) return true;
    if (Date.now() > echeance) return false; // budget épuisé → relançable
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);

    // Import dynamique : Firestore n'est PLUS une dépendance du chemin de
    // données — ce module de migration seul l'utilise encore.
    const { getFirestore } = await import("firebase-admin/firestore");
    const db = getFirestore(getAdminApp());

    const body = (await request.json().catch(() => ({}))) as { collections?: string[] };
    const echeance = Date.now() + BUDGET_MS;

    const cibles = body.collections?.length
      ? body.collections.map((chemin) => db.collection(chemin))
      : await db.listCollections();

    const rapports: MigrationReport[] = [];
    for (const refCollection of cibles) {
      const rapport: MigrationReport = {
        collection: refCollection.path,
        docs: 0,
        subcollections: [],
      };
      try {
        await migrerCollection(db, refCollection, refCollection.path.split("/"), rapport, echeance);
      } catch (error) {
        rapport.error = error instanceof Error ? error.message : String(error);
      }
      rapports.push(rapport);
      if (Date.now() > echeance) break;
    }

    const totalDocs = rapports.reduce((somme, r) => somme + r.docs, 0);
    const incompletes = rapports.filter((r) => r.error).map((r) => r.collection);
    return NextResponse.json({
      ok: incompletes.length === 0,
      totalDocs,
      collections: rapports,
      ...(incompletes.length > 0
        ? { relancerAvec: incompletes, note: "Budget de temps atteint — re-appeler la route (idempotent)." }
        : {}),
    });
  } catch (error) {
    // Pattern canonique des routes : réponse JSON complète avec le statut
    // classifié (401/403/…) — `return errorStatus(error)` seul retournerait
    // un NOMBRE et ferait planter Next (500 vide sans corps).
    return NextResponse.json(errorBody(error, "Migration Firestore → R2 indisponible."), { status: errorStatus(error) });
  }
}

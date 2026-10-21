import "server-only";

import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer } from "hyparquet";
import { compressors } from "hyparquet-compressors";

import { HubError } from "./common";

/* ------------------------------------------------------------------ */
/* PARQUET — parsing Node PUR JS (hyparquet) des fichiers .parquet      */
/*                                                                      */
/* La majorité des datasets Hugging Face ne distribuent que du parquet  */
/* (ex. `data/train-00000-of-00001-<hash>.parquet`). Ce module les lit   */
/* SANS dépendance native ni compilée : hyparquet (+ hyparquet-          */
/* compressors : snappy/gzip/brotli/zstd/lz4) est du JavaScript pur.     */
/*                                                                      */
/* HONNÊTETÉ & PLAFONDS :                                               */
/*  - le footer est lu d'abord : le nombre de lignes TOTALES du fichier  */
/*    est connu et signalé quand le plafond le coupe ;                  */
/*  - la lecture est bornée par maxLignes (rowEnd) — jamais toutes les   */
/*    lignes d'un grand fichier ne sont chargées en RAM ;                */
/*  - un fichier tronqué par le plafond de téléchargement (footer        */
/*    coupé) échoue avec une erreur lisible — jamais de donnée à         */
/*    moitié convertie ; le repli /rows du hub reste disponible.         */
/* ------------------------------------------------------------------ */

/** Reconnaît un fichier parquet (y compris .parquet.gz — décompressé
 *  en amont par le connecteur de téléchargement). */
export function estFichierParquet(nomFichier: string): boolean {
  return /\.parquet(\.gz)?$/i.test(nomFichier.trim().toLowerCase());
}

/** AsyncBuffer hyparquet au-dessus d'un Buffer déjà téléchargé (plafonné).
 *  Chaque slice renvoie un ArrayBuffer PROPRE (copie bornée) — contrat
 *  exigé par hyparquet (DataView sur ArrayBuffer réel). */
function asyncBufferDepuisBuffer(buffer: Buffer): AsyncBuffer {
  return {
    byteLength: buffer.byteLength,
    slice: (start, end) => {
      // Buffer n'est jamais adossé à un SharedArrayBuffer → cast sûr.
      const sous = buffer.subarray(start, Math.min(end ?? buffer.byteLength, buffer.byteLength));
      return Promise.resolve(
        sous.buffer.slice(sous.byteOffset, sous.byteOffset + sous.byteLength) as ArrayBuffer,
      );
    },
  };
}

/**
 * NORMALISATION CONSERVATRICE d'une valeur parquet vers une valeur JSON
 * sûre (les colonnes parquet ne sont pas toujours des chaînes) :
 *  - string/boolean → inchangés ;
 *  - number fini → inchangé (non fini → null) ;
 *  - BigInt (INT64) → Number si sûr, sinon chaîne de chiffres exacte ;
 *  - Uint8Array (BINARY) → décodage UTF-8 STRICT, sinon null (binaire
 *    réel ignoré — aucune donnée corrompue n'est convertie) ;
 *  - Date → ISO ; tableaux/structs → normalisés récursivement (formes
 *    de chat « messages » des hubs) ; autres → null.
 */
export function normaliserValeurParquet(valeur: unknown): unknown {
  if (valeur === null || valeur === undefined) return null;
  const type = typeof valeur;
  if (type === "string" || type === "boolean") return valeur;
  if (type === "number") return Number.isFinite(valeur) ? valeur : null;
  if (type === "bigint") {
    const nombre = Number(valeur);
    return Number.isSafeInteger(nombre) ? nombre : valeur.toString();
  }
  if (valeur instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(valeur);
    } catch {
      return null; // binaire réel (image, embedding…) : ignoré honnêtement
    }
  }
  if (valeur instanceof Date) return valeur.toISOString();
  if (Array.isArray(valeur)) return valeur.map((element) => normaliserValeurParquet(element));
  if (type === "object") {
    const aplati: Record<string, unknown> = {};
    for (const [cle, contenu] of Object.entries(valeur as Record<string, unknown>)) {
      aplati[cle] = normaliserValeurParquet(contenu);
    }
    return aplati;
  }
  return null;
}

export interface ResultatParquet {
  lignes: Array<Record<string, unknown>>;
  avertissements: string[];
}

/**
 * Lit jusqu'à `maxLignes` lignes d'un fichier parquet TÉLÉCHARGÉ (buffer
 * plafonné par le connecteur) et les rend en lignes-records compatibles
 * avec le même contrat que JSON/CSV (clés = noms de colonnes).
 * Lève une HubError lisible si le fichier est illisible (corrompu ou
 * tronqué par le plafond de téléchargement).
 */
export async function lignesDepuisParquet(buffer: Buffer, nomFichier: string, maxLignes: number): Promise<ResultatParquet> {
  const plafond = Math.max(1, Math.floor(maxLignes));
  try {
    // 1. FOOTER d'abord : nombre total de lignes déclaré par le fichier —
    //    et détection immédiate d'une troncature (footer coupé).
    const asyncBuffer = asyncBufferDepuisBuffer(buffer);
    const metadata = await parquetMetadataAsync(asyncBuffer);
    const total = Number(metadata.num_rows ?? 0);

    // 2. Lecture BORNÉE : seules les maxLignes premières lignes sont
    //    décodées (le plafond AUTO_APPRENTISSAGE_MAX_LIGNES s'applique
    //    réellement — pas de chargement massif en RAM).
    const rows =
      total > 0
        ? await parquetReadObjects({
            file: asyncBuffer,
            compressors,
            rowStart: 0,
            rowEnd: Math.min(plafond, total),
          })
        : [];

    const avertissements: string[] = [];
    if (total === 0) {
      avertissements.push(`${nomFichier} : fichier parquet vide (0 ligne).`);
    } else if (total > plafond) {
      avertissements.push(
        `${nomFichier} : ${total} lignes dans le fichier parquet — ${plafond} premières analysées (plafond du cycle).`,
      );
    }

    const lignes = rows.slice(0, plafond).map((row) => {
      const ligne: Record<string, unknown> = {};
      for (const [cle, valeur] of Object.entries(row)) {
        ligne[cle.slice(0, 80)] = normaliserValeurParquet(valeur);
      }
      return ligne;
    });
    return { lignes, avertissements };
  } catch (erreur: unknown) {
    const message = erreur instanceof Error ? erreur.message : String(erreur ?? "erreur inconnue");
    const tronque = /footer|parquet file invalid|magic/i.test(message);
    throw new HubError(
      "upstream",
      tronque
        ? `Fichier parquet illisible (tronqué par le plafond de téléchargement ou corrompu). Seul l'API de paging du hub peut lire ce fichier.`
        : `Fichier parquet illisible : ${message.slice(0, 150)}`,
    );
  }
}

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";

/**
 * OUTIL « database.query » — requête SQLite en LECTURE SEULE (vague
 * post-audit v2.1, audit outils §3 : « database.query — interroger
 * différentes bases SQL et NoSQL »).
 *
 * RÉEL : ouvre une base SQLite locale (node:sqlite, sans dépendance
 * externe), exécute UNE requête SELECT/WITH et renvoie les lignes réelles.
 *
 * Garde-fous :
 *  - lecture seule : la requête doit commencer par SELECT ou WITH — tout
 *    INSERT/UPDATE/DELETE/DDL est rejeté AVANT ouverture ;
 *  - un seul statement (pas de « ; » interne) ;
 *  - LIMIT plafonné (200 lignes) — un LIMIT absent ou trop grand est
 *    réécrit honnêtement (signalé dans la réponse) ;
 *  - chemin : fichier existant .db/.sqlite/.sqlite3, taille ≤ 64 Mo ;
 *  - disponibilité : node:sqlite exige Node ≥ 22.13 (CI/production OK) —
 *    en cas d'indisponibilité, échec HONNÊTE nommant la exigence (aucune
 *    capacité fantôme).
 *
 * Modules PUR côté logique ; l'ouverture SQLite est dynamique (import paresseux)
 * pour ne jamais casser le registre sur un runtime sans node:sqlite.
 */

export const DatabaseQueryInput = z
  .object({
    chemin: z
      .string()
      .min(1)
      .describe("Chemin du fichier SQLite (.db/.sqlite/.sqlite3) relatif au projet"),
    requete: z
      .string()
      .min(1)
      .describe("Requête SELECT ou WITH unique (lecture seule)"),
    parametres: z
      .array(z.union([z.string(), z.number(), z.null()]))
      .max(64)
      .optional()
      .describe("Paramètres liés (?) de la requête"),
  })
  .strict();

export type DatabaseQueryInputType = z.infer<typeof DatabaseQueryInput>;

export interface DatabaseQueryRow {
  [colonne: string]: string | number | bigint | null | Uint8Array;
}

export interface DatabaseQueryOutput {
  /** true si des lignes ont été renvoyées. */
  succes: boolean;
  /** Lignes réelles (plafonnées). */
  lignes: DatabaseQueryRow[];
  /** Nombre total de lignes retournées par la requête (avant plafond d'affichage). */
  nbLignes: number;
  /** Colonnes (ordre SQLite réel). */
  colonnes: string[];
  /** Message FR actionnable (succès, réécriture LIMIT, ou cause d'échec). */
  message: string;
  /** true si le LIMIT a été plafonné ou ajouté. */
  limitPlafonne?: boolean;
}

const EXTENSIONS_DB = new Set([".db", ".sqlite", ".sqlite3"]);
const TAILLE_MAX_OCTETS = 64 * 1024 * 1024;
const LIMITE_LIGNES = 200;

/** Vérifie la forme de la requête AVANT tout accès disque (lecture seule). */
export function validerRequeteLecture(requeteBrute: string): { ok: true } | { ok: false; cause: string } {
  const requete = requeteBrute.trim().replace(/^[\s(]+/, "");
  if (requete.length === 0) return { ok: false, cause: "Requête vide." };
  // Un seul statement : un « ; » terminal est toléré, un « ; » interne non.
  const sansTerminal = requete.replace(/;\s*$/, "");
  if (sansTerminal.includes(";")) {
    return { ok: false, cause: "Une seule requête est permise (point-virgule interne interdit)." };
  }
  const premierMot = sansTerminal.split(/\s+/)[0]?.toUpperCase() ?? "";
  if (premierMot !== "SELECT" && premierMot !== "WITH") {
    return {
      ok: false,
      cause: `Lecture seule : seules les requêtes SELECT/WITH sont permises (reçu « ${premierMot} »).`,
    };
  }
  // Garde anti-mutation cachée : pas de mot-clé d'écriture même en CTE.
  const interdits = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA\s+writable_schema)\b/i;
  if (interdits.test(sansTerminal)) {
    return { ok: false, cause: "Lecture seule : les mots-clés d'écriture/schéma sont interdits." };
  }
  return { ok: true };
}

/** Plafonne le LIMIT de la requête (honnêteté : la réécriture est signalée). */
export function plafonnerLimit(requeteBrute: string): { requete: string; plafonne: boolean } {
  const requete = requeteBrute.trim().replace(/;\s*$/, "");
  const match = /\blimit\s+(\d+)\s*$/i.exec(requete);
  if (match) {
    const valeur = Number(match[1]);
    if (valeur <= LIMITE_LIGNES) return { requete, plafonne: false };
    return {
      requete: requete.replace(/\blimit\s+\d+\s*$/i, `LIMIT ${LIMITE_LIGNES}`),
      plafonne: true,
    };
  }
  return { requete: `${requete} LIMIT ${LIMITE_LIGNES}`, plafonne: true };
}

export const databaseQueryTool: ToolDefinition<
  DatabaseQueryInputType,
  DatabaseQueryOutput
> = {
  id: "database.query",
  name: "Requête base de données (lecture seule)",
  description:
    "Exécute une requête SELECT/WITH réelle sur une base SQLite locale (node:sqlite), avec garde-fous lecture seule, LIMIT plafonné et paramètres liés.",
  category: "system",
  risk: "low",
  inputSchema: DatabaseQueryInput,
  async execute(input): Promise<DatabaseQueryOutput> {
    const garde = validerRequeteLecture(input.requete);
    if (!garde.ok) {
      throw new Error(garde.cause);
    }

    // Validation du chemin (fichier SQLite existant, extension contrôlée).
    const cheminAbsolu = resolve(process.cwd(), input.chemin);
    const extension = cheminAbsolu.slice(cheminAbsolu.lastIndexOf(".")).toLowerCase();
    if (!EXTENSIONS_DB.has(extension)) {
      throw new Error(
        `Fichier non SQLite : extension « ${extension} » attendue parmi ${[...EXTENSIONS_DB].join(", ")}.`,
      );
    }
    const infos = await stat(cheminAbsolu).catch(() => null);
    if (!infos || !infos.isFile()) {
      throw new Error(`Base introuvable : ${input.chemin} (fichier existant requis).`);
    }
    if (infos.size > TAILLE_MAX_OCTETS) {
      throw new Error(
        `Base trop volumineuse : ${infos.size} octets (plafond ${TAILLE_MAX_OCTETS}).`,
      );
    }

    // Import paresseux : node:sqlite exige Node ≥ 22.13 — échec honnête
    // nommant l'exigence si le runtime est plus ancien.
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      throw new Error(
        "node:sqlite indisponible sur ce runtime (Node ≥ 22.13 requis) — capacité database.query honnêtement hors service ici.",
      );
    }

    const { requete, plafonne } = plafonnerLimit(input.requete);

    const db = new DatabaseSync(cheminAbsolu, { readOnly: true });
    try {
      const curseur = db.prepare(requete);
      const lignesBrutes = (input.parametres?.length
        ? curseur.all(...input.parametres)
        : curseur.all()) as DatabaseQueryRow[];
      const colonnes =
        lignesBrutes.length > 0
          ? Object.keys(lignesBrutes[0])
          : [];
      return {
        succes: true,
        lignes: lignesBrutes,
        nbLignes: lignesBrutes.length,
        colonnes,
        message: plafonne
          ? `${lignesBrutes.length} ligne(s) lue(s) — LIMIT plafonné à ${LIMITE_LIGNES} (lecture seule).`
          : `${lignesBrutes.length} ligne(s) lue(s) (lecture seule).`,
        limitPlafonne: plafonne,
      };
    } finally {
      db.close();
    }
  },
};

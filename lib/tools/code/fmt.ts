import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import type { ToolDefinition } from "../types";

/**
 * OUTIL `dev.fmt` — boîte d'outils de formatage/normalisation pour le dev :
 *  - `json`   : formatage (indent réglable) + validation avec position
 *               honnête (ligne/colonne quand V8 la fournit, calculée sinon) ;
 *  - `base64` : encodage/décodage UTF-8 avec validation stricte (le décodage
 *               Buffer.from est tolérant par défaut — ici un texte invalide
 *               est refusé, pas transformé silencieusement) ;
 *  - `hash`   : SHA-256 hexadécimal (+ taille en octets) ;
 *  - `url`    : parse/sérialisation via l'URL API (composants + params) ;
 *  - `html`   : échappement HTML (&, <, >, ", ').
 *
 * Aucune dépendance externe, aucun réseau, 100 % déterministe.
 */

const CONTENU_MAX_CARACTERES = 200_000;

const EntreeDevFmt = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("json"),
    contenu: z.string().min(1).max(CONTENU_MAX_CARACTERES),
    indent: z.number().int().min(0).max(8).default(2),
  }),
  z.object({
    operation: z.literal("base64"),
    sens: z.enum(["encoder", "decoder"]),
    contenu: z.string().min(1).max(CONTENU_MAX_CARACTERES),
  }),
  z.object({
    operation: z.literal("hash"),
    contenu: z.string().max(CONTENU_MAX_CARACTERES),
  }),
  z.object({
    operation: z.literal("url"),
    contenu: z.string().min(1).max(2000),
  }),
  z.object({
    operation: z.literal("html"),
    contenu: z.string().max(CONTENU_MAX_CARACTERES),
  }),
]);

export type EntreeDevFmt = z.infer<typeof EntreeDevFmt>;

export interface SortieDevFmt {
  operation: "json" | "base64" | "hash" | "url" | "html";
  succes: boolean;
  /** Résultat selon l'opération (voir ci-dessous). */
  jsonFormate?: string;
  jsonCompacte?: string;
  base64?: string;
  texteDecode?: string;
  sha256?: string;
  tailleOctets?: number;
  composantsUrl?: {
    protocole: string;
    hote: string;
    port?: string;
    chemin: string;
    recherche: string;
    parametres: Array<{ nom: string; valeur: string }>;
    ancre: string;
    serialise: string;
  };
  htmlEchappe?: string;
  /** Erreur honnête (JSON invalide, base64 invalide, URL invalide). */
  erreur?: {
    message: string;
    ligne?: number;
    colonne?: number;
  };
}

/** Convertit une position (index de caractère) en ligne/colonne 1-based. */
function ligneColonneDepuisPosition(contenu: string, position: number): { ligne: number; colonne: number } {
  const avant = contenu.slice(0, Math.max(0, position));
  const morceaux = avant.split("\n");
  return { ligne: morceaux.length, colonne: (morceaux[morceaux.length - 1]?.length ?? 0) + 1 };
}

/** Extrait la position d'une erreur V8 JSON (formats « at position N » ou « line X column Y »). */
function extraireErreurJson(contenu: string, erreur: unknown): SortieDevFmt["erreur"] {
  const message = erreur instanceof Error ? erreur.message : "JSON invalide";
  const resultat: NonNullable<SortieDevFmt["erreur"]> = { message };
  const ligneColonne = /line\s+(\d+)\s+column\s+(\d+)/.exec(message);
  if (ligneColonne) {
    resultat.ligne = Number(ligneColonne[1]);
    resultat.colonne = Number(ligneColonne[2]);
    return resultat;
  }
  const position = /position\s+(\d+)/.exec(message);
  if (position) {
    const { ligne, colonne } = ligneColonneDepuisPosition(contenu, Number(position[1]));
    resultat.ligne = ligne;
    resultat.colonne = colonne;
  }
  return resultat;
}

/** Échappement HTML canonique (l'échappement de contexte attribut inclut les guillemets). */
function echapperHtml(contenu: string): string {
  return contenu
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const outilDevFmt: ToolDefinition<EntreeDevFmt, SortieDevFmt> = {
  id: "dev.fmt",
  name: "dev.fmt",
  description:
    "Formatage/normalisation de données pour le dev : json (format + validation d'erreurs avec ligne/colonne), base64 (encoder/decoder UTF-8 avec validation stricte), hash SHA-256 (hex), url (parse/sérialisation via l'URL API : protocole, hôte, chemin, paramètres, ancre), html (échappement & < > \" '). " +
    "Input : { operation: \"json\"|\"base64\"|\"hash\"|\"url\"|\"html\", contenu: \"…\", sens?: \"encoder\"|\"decoder\" (base64), indent?: 0–8 (json, défaut 2) }. " +
    "100 % déterministe, aucun réseau, aucune exécution de code ; un échec (JSON/base64/URL invalide) est restitué honnêtement avec position quand disponible.",
  category: "code",
  risk: "low",
  inputSchema: EntreeDevFmt,
  async execute(input) {
    if (input.operation === "json") {
      try {
        const objet = JSON.parse(input.contenu);
        const format = input.indent;
        const jsonFormate = JSON.stringify(objet, null, format);
        const jsonCompacte = JSON.stringify(objet);
        return {
          operation: "json",
          succes: true,
          ...(jsonFormate !== undefined ? { jsonFormate } : {}),
          ...(jsonCompacte !== undefined ? { jsonCompacte } : {}),
        };
      } catch (erreur) {
        return {
          operation: "json",
          succes: false,
          erreur: extraireErreurJson(input.contenu, erreur),
        };
      }
    }

    if (input.operation === "base64") {
      if (input.sens === "encoder") {
        const encode = Buffer.from(input.contenu, "utf-8").toString("base64");
        return { operation: "base64", succes: true, base64: encode };
      }
      const nettoye = input.contenu.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(nettoye)) {
        return {
          operation: "base64",
          succes: false,
          erreur: { message: "base64 invalide : caractères hors alphabet A–Z a–z 0–9 + / =" },
        };
      }
      const tampon = Buffer.from(nettoye, "base64");
      if (tampon.toString("base64").replace(/=+$/, "") !== nettoye.replace(/=+$/, "")) {
        return {
          operation: "base64",
          succes: false,
          erreur: { message: "base64 invalide : longueur ou bourrage incorrect (décodage non fidèle)" },
        };
      }
      const texteDecode = tampon.toString("utf-8");
      return { operation: "base64", succes: true, texteDecode };
    }

    if (input.operation === "hash") {
      const tampon = Buffer.from(input.contenu, "utf-8");
      const empreinte = createHash("sha256").update(tampon).digest("hex");
      return { operation: "hash", succes: true, sha256: empreinte, tailleOctets: tampon.byteLength };
    }

    if (input.operation === "url") {
      try {
        const url = new URL(input.contenu);
        const parametres = [...url.searchParams.entries()].map(([nom, valeur]) => ({ nom, valeur }));
        return {
          operation: "url",
          succes: true,
          composantsUrl: {
            protocole: url.protocol.replace(/:$/, ""),
            hote: url.hostname,
            ...(url.port ? { port: url.port } : {}),
            chemin: url.pathname,
            recherche: url.search,
            parametres,
            ancre: url.hash,
            serialise: url.toString(),
          },
        };
      } catch (erreur) {
        return {
          operation: "url",
          succes: false,
          erreur: {
            message: `URL invalide : ${erreur instanceof Error ? erreur.message : "erreur"}`,
          },
        };
      }
    }

    // operation === "html"
    return { operation: "html", succes: true, htmlEchappe: echapperHtml(input.contenu) };
  },
};

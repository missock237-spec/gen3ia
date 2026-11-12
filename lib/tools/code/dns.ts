import "server-only";

import { lookup, resolveCname, resolveMx, resolveNs, resolveSoa, resolveTxt } from "node:dns/promises";
import type { LookupOptions } from "node:dns";

import { z } from "zod";

import type { ToolDefinition } from "../types";

/**
 * OUTIL `web.dns` — résolution DNS réelle via node:dns/promises.
 *
 * Interroge indépendamment chaque type demandé (lookup A/AAAA, MX, TXT, NS,
 * CNAME, SOA) avec un délai borné par type. HONNÊTETÉ : une erreur DNS
 * (ENOTFOUND, ENODATA, ESERVFAIL…) n'interrompt PAS l'ensemble — elle est
 * restituée dans `erreurs` avec son code exact ; un type sans enregistrement
 * (ENODATA) est rapporté comme tel, jamais masqué par un autre type.
 *
 * TTL : node ne fournit le TTL que pour le lookup (A/AAAA). Les types
 * MX/TXT/NS/CNAME/SOA de node:dns n'exposent pas de TTL — l'outil le
 * déclare honnêtement (absence = non fourni par le résolveur système), pas
 * de TTL inventé.
 */

const DELAI_PAR_DEFAUT_MS = 5_000;
const DELAI_MAX_MS = 15_000;

const TYPES = ["lookup", "mx", "txt", "ns", "cname", "soa"] as const;
type TypeEnregistrement = (typeof TYPES)[number];

/** Nom d'hôte : lettres/chiffres/tirets/sous-tirets + points (et point final racine). */
const REGEX_HOTE =
  /^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?(?:\.[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?)*\.?$/;

const EntreeWebDns = z.object({
  hote: z.string().trim().min(1).max(253).regex(REGEX_HOTE, "nom d'hôte invalide (ex. « exemple.com » ou « _dmarc.exemple.com »)"),
  types: z.array(z.enum(TYPES)).max(TYPES.length).optional(),
  timeoutMs: z.number().int().min(500).max(DELAI_MAX_MS).default(DELAI_PAR_DEFAUT_MS),
});

export interface AdresseResolvee {
  adresse: string;
  famille: "IPv4" | "IPv6";
  /** TTL en secondes — fourni uniquement par le lookup système (absent sinon). */
  ttl?: number;
}

export interface EchangeMail {
  echange: string;
  priorite: number;
}

export interface EnregistrementSoa {
  nsPrimaire: string;
  courrielAdmin: string;
  serie: number;
  rafraichissement: number;
  nouvelEssai: number;
  expiration: number;
  ttlMin: number;
}

export interface ResultatsWebDns {
  lookup?: AdresseResolvee[];
  mx?: EchangeMail[];
  txt?: string[];
  ns?: string[];
  cname?: string[];
  soa?: EnregistrementSoa;
}

export interface ErreurWebDns {
  type: TypeEnregistrement;
  /** Code du résolveur (ENOTFOUND, ENODATA, ESERVFAIL… ou ETIMEOUT). */
  code?: string;
  message: string;
}

export interface SortieWebDns {
  hote: string;
  timeoutMs: number;
  /** Vrai si AU MOINS un type demandé a été résolu. */
  succes: boolean;
  resultats: ResultatsWebDns;
  erreurs: ErreurWebDns[];
  remarques: string[];
}

/** Erreur interne de délai (convertie en code ETIMEOUT honnête). */
class DelaiResolveurDepasse extends Error {
  constructor(type: TypeEnregistrement, delaiMs: number) {
    super(`délai dépassé (${delaiMs} ms) pour « ${type} »`);
    this.name = "DelaiResolveurDepasse";
  }
}

async function avecDelai<T>(promesse: Promise<T>, type: TypeEnregistrement, delaiMs: number): Promise<T> {
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const expiration = new Promise<never>((_, rejeter) => {
    minuteur = setTimeout(() => rejeter(new DelaiResolveurDepasse(type, delaiMs)), delaiMs);
  });
  try {
    return await Promise.race([promesse, expiration]);
  } finally {
    clearTimeout(minuteur);
  }
}

function codeErreur(erreur: unknown): string | undefined {
  if (erreur instanceof DelaiResolveurDepasse) return "ETIMEOUT";
  if (typeof erreur === "object" && erreur !== null && "code" in erreur) {
    const code = (erreur as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export const outilWebDns: ToolDefinition<z.infer<typeof EntreeWebDns>, SortieWebDns> = {
  id: "web.dns",
  name: "web.dns",
  description:
    "Résolution DNS RÉELLE d'un nom d'hôte (lookup A/AAAA avec TTL, MX, TXT, NS, CNAME, SOA) via le résolveur système, sortie structurée par type. " +
    "Input : { hote: \"exemple.com\" | \"_dmarc.exemple.com\", types?: [\"lookup\",\"mx\",\"txt\",\"ns\",\"cname\",\"soa\"], timeoutMs?: 500–15000 (défaut 5000) }. " +
    "Honnête : chaque type est interrogé indépendamment — une erreur (ENOTFOUND, ENODATA, ESERVFAIL…) est restituée avec son code exact dans `erreurs`, jamais transformée en donnée inventée ; le TTL n'existe que pour lookup (le résolveur Node ne l'expose pas pour MX/TXT/NS/CNAME/SOA). " +
    "À utiliser pour diagnostiquer un domaine, vérifier la configuration mail (MX/SPF/DKIM), contrôler des NS/SOA.",
  category: "web",
  risk: "low",
  inputSchema: EntreeWebDns,
  async execute(input) {
    const types = input.types ?? [...TYPES];
    const resultats: ResultatsWebDns = {};
    const erreurs: ErreurWebDns[] = [];

    for (const type of types) {
      try {
        if (type === "lookup") {
          const brutes = await avecDelai(
            lookup(input.hote, { all: true, verbatim: true, ttl: true } as LookupOptions),
            type,
            input.timeoutMs,
          ) as unknown as { address: string; family: number; ttl?: number }[];
          resultats.lookup = brutes.map((a) => ({
            adresse: a.address,
            famille: a.family === 4 ? "IPv4" as const : "IPv6" as const,
            ...(typeof a.ttl === "number" ? { ttl: a.ttl } : {}),
          }));
        } else if (type === "mx") {
          const mx = await avecDelai(resolveMx(input.hote), type, input.timeoutMs);
          resultats.mx = mx
            .map((e) => ({ echange: e.exchange, priorite: e.priority }))
            .sort((a, b) => a.priorite - b.priorite);
        } else if (type === "txt") {
          const txt = await avecDelai(resolveTxt(input.hote), type, input.timeoutMs);
          resultats.txt = txt.map((morceaux) => morceaux.join(""));
        } else if (type === "ns") {
          resultats.ns = await avecDelai(resolveNs(input.hote), type, input.timeoutMs);
        } else if (type === "cname") {
          resultats.cname = await avecDelai(resolveCname(input.hote), type, input.timeoutMs);
        } else {
          const soa = await avecDelai(resolveSoa(input.hote), type, input.timeoutMs);
          resultats.soa = {
            nsPrimaire: soa.nsname,
            courrielAdmin: soa.hostmaster,
            serie: soa.serial,
            rafraichissement: soa.refresh,
            nouvelEssai: soa.retry,
            expiration: soa.expire,
            ttlMin: soa.minttl,
          };
        }
      } catch (erreur) {
        erreurs.push({
          type,
          ...(codeErreur(erreur) ? { code: codeErreur(erreur) } : {}),
          message: erreur instanceof Error ? erreur.message.slice(0, 300) : "erreur de résolution",
        });
      }
    }

    const remarques: string[] = [];
    if (types.includes("mx") || types.includes("txt") || types.includes("ns") || types.includes("cname") || types.includes("soa")) {
      remarques.push("le résolveur Node n'expose pas de TTL pour MX/TXT/NS/CNAME/SOA — l'absence de ttl est honnête, pas une donnée masquée");
    }
    if (erreurs.length > 0 && Object.keys(resultats).length > 0) {
      remarques.push("certaines requêtes ont échoué : les résultats présents sont néanmoins réels");
    }

    return {
      hote: input.hote,
      timeoutMs: input.timeoutMs,
      succes: Object.keys(resultats).length > 0,
      resultats,
      erreurs,
      remarques,
    };
  },
};

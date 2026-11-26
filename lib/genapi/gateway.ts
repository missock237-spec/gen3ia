/**
 * GENAPI GATEWAY — passerelle centrale (mission PHASE 2) : TOUTES les
 * requêtes externes passent ici avant d'atteindre un service Gen3ia.
 *
 * Chaîne : AUTH (porte v1 existante réutilisée — jamais réécrite) →
 * PERMISSIONS par service (PHASE 3) → VALIDATION zod → QUOTA/rate par
 * application → JOURNALISATION → EXÉCUTION avec TIMEOUT → réponse
 * NORMALISÉE {data} ou {error:{code,message,requestId}}.
 *
 * VERSIONNAGE (PHASE 2-8) : les routes /v1/* et /v2/* partagent la même
 * passerelle — la version est un champ de la requête, les handlers changent
 * sans toucher au contrat de sécurité.
 */

import "server-only";

import { z } from "zod";

import { ErrorAccesV1 } from "@/lib/api/v1/porte-v1";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import {
  estServiceGenapi,
  verifierPermissionService,
  type ApplicationGenapi,
  type EnvironnementGenapi,
  type ServiceGenapi,
} from "./services";

export const VERSIONS_GENAPI = ["v1", "v2"] as const;
export type VersionGenapi = (typeof VERSIONS_GENAPI)[number];

/** Erreur normalisée genAPI — la SEULE forme renvoyée aux développeurs. */
export class ErreurGateway extends Error {
  readonly code: string;
  readonly statut: number;
  readonly requestId: string;
  readonly enTetes: Record<string, string>;

  constructor(code: string, message: string, statut: number, requestId: string, enTetes: Record<string, string> = {}) {
    super(message);
    this.name = "ErreurGateway";
    this.code = code;
    this.statut = statut;
    this.requestId = requestId;
    this.enTetes = enTetes;
  }

  corps(): { error: { code: string; message: string; requestId: string } } {
    return { error: { code: this.code, message: this.message, requestId: this.requestId } };
  }
}

export interface JournalGenapi {
  requestId: string;
  version: VersionGenapi;
  service: ServiceGenapi;
  applicationId: string;
  proprietaireId: string;
  statut: number;
  dureeMs: number;
  horodatage: number;
  erreur?: string;
}

const globalJournal = globalThis as typeof globalThis & { __gen3iaGenapiJournal?: JournalGenapi[] };

/** Journal des requêtes (PHASE 2-6) — borné, lisible par le portail (PHASE 7). */
export function journalGenapi(): readonly JournalGenapi[] {
  if (!globalJournal.__gen3iaGenapiJournal) globalJournal.__gen3iaGenapiJournal = [];
  return globalJournal.__gen3iaGenapiJournal;
}

export function reinitialiserJournalGenapi(): void {
  globalJournal.__gen3iaGenapiJournal = [];
}

export interface RequeteGateway {
  version: VersionGenapi;
  service: ServiceGenapi;
  /** Application déjà résolue (le portail l'a sélectionnée) — requis. */
  application: ApplicationGenapi;
  /** Charge utile validée par le schéma du service. */
  charge?: unknown;
  /** Délai maximal d'exécution (PHASE 2-7 : délais d'expiration). */
  timeoutMs?: number;
  /** Environnement requis (PHASE 3-6) — défaut production. */
  environnement?: EnvironnementGenapi;
}

export interface ResultatGateway<T = unknown> {
  requestId: string;
  version: VersionGenapi;
  service: ServiceGenapi;
  data: T;
  dureeMs: number;
}

/**
 * Traverse la passerelle : chaque étape est ordonnée et lève une
 * ErreurGateway avec un code stable. Le handler reçoit la charge VALIDÉE.
 */
export async function traverserGateway<TCharge, TSortie>(
  requete: RequeteGateway & { schema: z.ZodType<TCharge> },
  handler: (charge: TCharge, ctx: { requestId: string }) => Promise<TSortie>,
): Promise<ResultatGateway<TSortie>> {
  const debut = Date.now();
  const requestId = `req_${crypto.randomUUID().slice(0, 16)}`;
  const journal: JournalGenapi = {
    requestId,
    version: requete.version,
    service: requete.service,
    applicationId: requete.application.id,
    proprietaireId: requete.application.proprietaireId,
    statut: 200,
    dureeMs: 0,
    horodatage: debut,
  };

  try {
    // 1. PERMISSIONS (PHASE 3) — avant toute exécution.
    const permission = verifierPermissionService(requete.application, requete.service, requete.environnement ?? "production");
    if (!permission.autorise) {
      throw new ErreurGateway(permission.code ?? "service-non-autorise", permission.raison ?? "service refusé", permission.code === "application-revoquee" ? 403 : 403, requestId);
    }

    // 2. VALIDATION (PHASE 2-3) — la charge est rejetée avant le handler.
    const parse = requete.schema.safeParse(requete.charge);
    if (!parse.success) {
      throw new ErreurGateway("requete-invalide", `charge invalide : ${parse.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, 400, requestId);
    }

    // 3. QUOTA PAR APPLICATION (PHASE 2-4) — au-delà du plan : 429.
    const verdict = await enforceRateLimit(`genapi:${requete.application.id}:${requete.service}`, {
      limit: requete.application.restriction.appelsParMinute,
      windowMs: 60_000,
    });
    if (!verdict.allowed) {
      const retryS = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
      throw new ErreurGateway("quota-atteint", `quota de l'application atteint (${requete.application.restriction.appelsParMinute} appels/min sur ce service). Réessayez dans ${retryS} s.`, 429, requestId, { "retry-after": String(retryS) });
    }

    // 4. EXÉCUTION avec TIMEOUT (PHASE 2-7) — jamais de pendaison infinie.
    const timeoutMs = requete.timeoutMs ?? 60_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const data = await Promise.race([
      handler(parse.data, { requestId }),
      new Promise<never>((_, rejeter) => {
        timeoutSignal.addEventListener("abort", () => rejeter(new ErreurGateway("delai-depasse", `le service « ${requete.service} » n'a pas répondu en ${timeoutMs} ms`, 504, requestId)));
      }),
    ]);

    return { requestId, version: requete.version, service: requete.service, data, dureeMs: Date.now() - debut };
  } catch (erreur) {
    if (erreur instanceof ErreurGateway) {
      journal.statut = erreur.statut;
      journal.erreur = erreur.code;
      throw erreur;
    }
    if (erreur instanceof ErrorAccesV1) {
      // Erreur de la porte v1 (auth 401 / rate 429) — propagée telle quelle
      // (le contrat existant est conservé, règle « ne pas remplacer »).
      throw erreur;
    }
    journal.statut = 500;
    journal.erreur = "erreur-interne";
    throw new ErreurGateway("erreur-interne", erreur instanceof Error ? erreur.message : "erreur inconnue", 500, requestId);
  } finally {
    journal.dureeMs = Date.now() - debut;
    const log = globalJournal.__gen3iaGenapiJournal ?? (globalJournal.__gen3iaGenapiJournal = []);
    log.push(journal);
    if (log.length > 1000) log.splice(0, log.length - 1000);
  }
}

/** Parse la version depuis le chemin (/api/v1/... ou /api/v2/...). */
export function versionDepuisChemin(chemin: string): VersionGenapi {
  const m = chemin.match(/^\/api\/(v1|v2)\//);
  if (!m) {
    throw new ErreurGateway("version-non-supportee", `version d'API non supportée : ${chemin} — versions : ${VERSIONS_GENAPI.join(", ")}`, 404, `req_${crypto.randomUUID().slice(0, 16)}`);
  }
  return m[1] as VersionGenapi;
}

export { estServiceGenapi };

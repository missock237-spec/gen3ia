import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { franchirPorteV1, ErrorAccesV1 } from "@/lib/api/v1/porte-v1";
import { errorStatus } from "@/lib/security/http-errors";
import { executerTacheInterne, estTacheInterne } from "@/lib/agents-os/dispatch/registre-taches";
import { ExecuteurSandbox } from "@/lib/agents-os/dispatch/executeur-sandbox";

/**
 * POST /api/v1/dispatch — HUB ZERO-CLOUD (Module 2 : webhook-to-sandbox).
 *
 * Réception d'un payload JSON { taskType, data, script?, timeoutMs? } :
 *   · taskType NATIF (registre interne : text-extract, http-scrape,
 *     json-transform, sha256) → exécution déterministe in-process ;
 *   · script (JavaScript) fourni → exécution dans la SANDBOX
 *     (processus enfant isolé, heap plafonné, timeout dur, répertoire
 *     temporaire détruit en finally — Docker si DOCKER_SANDBOX=1).
 *
 * SÛRETÉ : authentification développeur obligatoire (franchirPorteV1 — clé
 * `g3a_` en Bearer ou x-api-key, rate limit par clé), payload plafonné
 * (256 Ko), timeout par défaut 30 s (plafond 120 s). Aucun SaaS tiers,
 * aucune API LLM : tout tourne localement, de façon déterministe.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TAILLE_PAYLOAD_MAX = 256_000;
const SANDBOX = new ExecuteurSandbox();

interface ContratDispatch {
  taskType?: unknown;
  data?: unknown;
  script?: unknown;
  donneesScript?: unknown;
  timeoutMs?: unknown;
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    // 1. Porte : auth développeur + rate limit (2 couches, par clé/route).
    const porte = await franchirPorteV1(request, "dispatch", { limit: 20, windowMs: 60_000 });

    // 2. Payload plafonné.
    const brut = await request.text();
    if (brut.length > TAILLE_PAYLOAD_MAX) {
      return NextResponse.json(
        { error: `payload dépasse ${TAILLE_PAYLOAD_MAX} octets`, requestId },
        { status: 413, headers: enTetes(requestId, porte.enTetesLimite) },
      );
    }

    let contrat: ContratDispatch;
    try {
      contrat = JSON.parse(brut) as ContratDispatch;
    } catch {
      return NextResponse.json(
        { error: "payload n'est pas un JSON valide", requestId },
        { status: 400, headers: enTetes(requestId, porte.enTetesLimite) },
      );
    }

    const taskType = typeof contrat.taskType === "string" ? contrat.taskType : "";
    const data = (contrat.data !== null && typeof contrat.data === "object" && !Array.isArray(contrat.data))
      ? (contrat.data as Record<string, unknown>)
      : {};

    // 3a. Voie native : registre interne.
    if (taskType) {
      if (!estTacheInterne(taskType)) {
        return NextResponse.json(
          {
            error: `taskType « ${taskType.slice(0, 64)} » inconnu — natives : text-extract, http-scrape, json-transform, sha256`,
            requestId,
          },
          { status: 400, headers: enTetes(requestId, porte.enTetesLimite) },
        );
      }
      const resultat = await executerTacheInterne({ taskType, data });
      return NextResponse.json(
        { ...resultat, identite: porte.identite.userId, requestId },
        { status: resultat.ok ? 200 : 422, headers: enTetes(requestId, porte.enTetesLimite) },
      );
    }

    // 3b. Voie sandbox : script JavaScript isolé.
    if (typeof contrat.script === "string" && contrat.script.trim()) {
      const execution = await SANDBOX.executer(contrat.script, contrat.donneesScript);
      return NextResponse.json(
        {
          ok: execution.ok,
          voie: "sandbox",
          mode: execution.mode,
          resultat: execution.resultat,
          logs: execution.logs,
          stderr: execution.stderr,
          dureeMs: execution.dureeMs,
          timeoutAtteint: execution.timeoutAtteint,
          nettoye: execution.nettoye,
          erreur: execution.erreur,
          identite: porte.identite.userId,
          requestId,
        },
        { status: execution.ok ? 200 : 422, headers: enTetes(requestId, porte.enTetesLimite) },
      );
    }

    return NextResponse.json(
      { error: "payload invalide — fournir taskType (tâche native) ou script (sandbox)", requestId },
      { status: 400, headers: enTetes(requestId, porte.enTetesLimite) },
    );
  } catch (error) {
    if (error instanceof ErrorAccesV1) {
      return NextResponse.json(
        { error: error.message, requestId },
        { status: error.statut, headers: { "x-request-id": requestId, ...error.enTetes } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "erreur interne", requestId },
      { status: errorStatus(error), headers: { "x-request-id": requestId } },
    );
  }
}

/** GET : capacités du hub (tâches natives + contrat sandbox) — découverte. */
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const porte = await franchirPorteV1(request, "dispatch", { limit: 60, windowMs: 60_000 });
    return NextResponse.json(
      {
        service: "agents-os/dispatch",
        version: 1,
        tachesNatives: ["text-extract", "http-scrape", "json-transform", "sha256"],
        sandbox: {
          contrat: "script: string (JavaScript, emettre(valeur) pour renvoyer le résultat)",
          timeoutDefautMs: 30_000,
          timeoutMaxMs: 120_000,
          isolement: "processus enfant (heap plafonné) ou conteneur Docker si DOCKER_SANDBOX=1",
          nettoyage: "répertoire temporaire détruit en finally — aucun fichier résiduel",
        },
        limites: { payloadMaxOctets: 256_000, rateLimit: "20/min par clé (POST)" },
        requestId,
      },
      { status: 200, headers: enTetes(requestId, porte.enTetesLimite) },
    );
  } catch (error) {
    if (error instanceof ErrorAccesV1) {
      return NextResponse.json(
        { error: error.message, requestId },
        { status: error.statut, headers: { "x-request-id": requestId, ...error.enTetes } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "erreur interne", requestId },
      { status: errorStatus(error), headers: { "x-request-id": requestId } },
    );
  }
}

function enTetes(requestId: string, limite: Record<string, string>): Record<string, string> {
  return { "x-request-id": requestId, ...limite };
}

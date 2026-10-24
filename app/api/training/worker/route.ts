import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { resolveProviders } from "@/lib/training/providers";

/**
 * GET /api/training/worker — état RÉEL du worker GPU d'entraînement
 * (plan d'amélioration B-P0 : le studio doit voir l'état du worker).
 *
 * HONNÊTETÉ : aucun état simulé. Si TRAINING_WORKER_URL n'est pas configuré,
 * la réponse le dit (le worker n'est PAS déployé par défaut — doctrine du
 * projet). Si configuré, la sonde /nz du worker (sans auth, prévue pour le
 * monitoring) est interrogée avec un délai borné ; la latence mesurée est
 * retournée. Authentification : convention du namespace /api/training
 * (requireUser).
 */
export const runtime = "nodejs";

function fournisseursHonnêtes() {
  return resolveProviders().map((p) => ({
    id: p.id,
    label: p.label,
    ...(p.engines ? { engines: p.engines } : {}),
  }));
}

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  try {
    await requireUser(request);
  } catch (error) {
    return NextResponse.json(errorBody(error), {
      status: errorStatus(error, 401),
      headers: { "x-request-id": requestId },
    });
  }

  const url = (process.env.TRAINING_WORKER_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.TRAINING_WORKER_TOKEN ?? "").trim();

  if (!url) {
    return NextResponse.json(
      {
        worker: {
          configure: false,
          atteignable: false,
          note: "Aucun worker GPU configuré (TRAINING_WORKER_URL absent) : l'entraînement distant est indisponible — aucune simulation n'est exposée. L'entraînement local du cerveau (studio) reste opérationnel.",
        },
        fournisseurs: fournisseursHonnêtes(),
        requestId,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  const debut = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_500);
  try {
    const reponse = await fetch(`${url}/nz`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
      cache: "no-store",
    });
    const latenceMs = Date.now() - debut;
    const corps = (await reponse.json().catch(() => ({}))) as { ok?: boolean };
    const joignable = reponse.ok && corps.ok === true;
    return NextResponse.json(
      {
        worker: {
          configure: true,
          atteignable: joignable,
          latenceMs,
          httpStatus: reponse.status,
          note: joignable
            ? "Worker GPU joignable : soumission de tâches possible."
            : "Worker configuré mais sonde /nz en échec : vérifier le service (docker compose) et TRAINING_WORKER_TOKEN.",
        },
        fournisseurs: fournisseursHonnêtes(),
        requestId,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        worker: {
          configure: true,
          atteignable: false,
          note: "Worker configuré mais injoignable (délai 2,5 s dépassé ou réseau coupé) : les soumissions échoueront tant que le service est absent.",
        },
        fournisseurs: fournisseursHonnêtes(),
        requestId,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } finally {
    clearTimeout(timer);
  }
}

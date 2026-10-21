import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

import { buildCatalog } from "@/lib/training/catalog";
import { trainingQuotas } from "@/lib/training/quotas";

/**
 * GET /api/training/catalog — catalogue « CONFIG ONLY » (demande n° 6).
 *
 * L'utilisateur ne reçoit que ce qui sert à CONFIGURER son projet :
 *  - moteurs (méthodes, paramètres exposés, limites connues) ;
 *  - modèles de base référençables ;
 *  - quotas applicables (inchangés : 200 Mo/fichier, 50 datasets/projet,
 *    2 048 Mo de stockage, 60 min d'entraînement/mois…) ;
 *  - un résumé d'exécution SANS mécanique interne : la sonde fournisseurs
 *    brute (`providers` : worker GPU, inventaire matériel, flags de
 *    simulation par fournisseur) n'est plus exposée — elle est agrégée en
 *    trois booléens honnêtes (`nativeAvailable`, `gpuAvailable`,
 *    `simulationDetected`).
 */
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    await requireUser(request);
    const catalog = await buildCatalog();
    const quotas = trainingQuotas();

    /* Agrégation config-only de l'état d'exécution (aucun détail d'infra). */
    const nativeAvailable = catalog.providers.some(
      (provider) => provider.id === "gen3-local" && provider.configured && !provider.simulated,
    );
    const gpuAvailable = catalog.providers.some(
      (provider) => provider.id !== "gen3-local" && provider.configured && !provider.simulated,
    );
    const simulationDetected = catalog.providers.some(
      (provider) => provider.configured && provider.simulated,
    );

    return NextResponse.json(
      {
        catalog: {
          engines: catalog.engines,
          baseModels: catalog.baseModels,
          execution: { nativeAvailable, gpuAvailable, simulationDetected },
          quotas: {
            ...catalog.quotas,
            maxStorageMb: Math.round(quotas.maxStorageBytes / (1024 * 1024)),
            maxTrainingMinutesPerMonth: quotas.maxTrainingMinutesPerMonth,
          },
        },
        requestId,
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Catalogue indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { lireVueCalcul } from "@/lib/neural/compute/brain-bridge";
import { etatSecurite } from "@/lib/neural/compute/compute-security";
import { etatDeviceActuel, erreursGpuRecentes } from "@/lib/neural/compute/webgpu/webgpu-device";
import { etatMemoireGpu } from "@/lib/neural/compute/webgpu/webgpu-memory-manager";
import { statsPool } from "@/lib/neural/compute/webgpu/webgpu-buffer-pool";
import { statsPipelines } from "@/lib/neural/compute/webgpu/webgpu-pipeline";
import type { ProfilEnergie } from "@/lib/neural/compute/compute-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/compute — supervision du moteur de calcul central
 * (mission Phase 11, admin uniquement) : capacités réelles, métriques,
 * profil actif, historique des exécutions, diagnostics GPU et sécurité.
 * Le dashboard OBSERVE : il ne devient jamais un second moteur de décision.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const vue = await lireVueCalcul();
  const sec = etatSecurite();
  const device = etatDeviceActuel();

  return NextResponse.json({
    ok: true,
    etat: {
      profil: vue.profil,
      capacites: vue.capacites,
      capacitesCpu: vue.capacitesCpu,
      metrics: vue.metrics,
      gpu: {
        device: device.statut,
        raison: device.raison,
        adaptateur: device.adaptateur,
        pertes: device.pertes,
        memoireGen3ia: etatMemoireGpu(),
        buffersEnPool: statsPool(),
        pipelinesEnCache: statsPipelines(),
      },
      securite: {
        breaker: sec.etat,
        echecsGpuConsecutifs: sec.echecsGpuConsecutifs,
        seuilOuverture: sec.seuilOuverture,
        tachesEnCours: [...sec.enCours.keys()],
        erreursRecentes: sec.erreursRecentes.slice(-10),
      },
      erreursDevice: erreursGpuRecentes().slice(-10),
    },
  });
}

/**
 * POST /api/admin/compute — configuration autorisée : changement de profil
 * énergétique (ECO/BALANCED/PERFORMANCE/MOBILE/SERVER), réinitialisation du
 * circuit breaker. Aucune manipulation matérielle directe (jamais un second
 * moteur de décision).
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  let corps: { profil?: ProfilEnergie; action?: string };
  try {
    corps = (await request.json()) as { profil?: ProfilEnergie; action?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "corps JSON invalide" }, { status: 400 });
  }

  const { definirProfilCerveau } = await import("@/lib/neural/compute/brain-bridge");
  if (corps.profil) {
    const profils: ProfilEnergie[] = ["ECO", "BALANCED", "PERFORMANCE", "MOBILE", "SERVER"];
    if (!profils.includes(corps.profil)) {
      return NextResponse.json({ ok: false, error: `profil inconnu (${corps.profil})` }, { status: 400 });
    }
    definirProfilCerveau(corps.profil);
  }
  if (corps.action === "reinitialiser-breaker") {
    const sec = etatSecurite();
    sec.etat = "ferme";
    sec.echecsGpuConsecutifs = 0;
    sec.ouvertJusquA = 0;
  }

  return NextResponse.json({ ok: true, profil: (await lireVueCalcul()).profil });
}

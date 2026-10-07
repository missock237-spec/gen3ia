import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  CHARIOW_LEASE_MS,
  claimChariowDelivery,
  processChariowSale,
  receivedAtToMillis,
  storedChariowPayload,
} from "@/lib/billing/chariow-delivery";
import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Rapprochement synchrone : scan (2 requêtes) + jusqu'à 10 retraitements
// (claim + crédit idempotent chacun) — la fenêtre par défaut de la
// plateforme est trop juste.
export const maxDuration = 60;

/** Taille des scans Firestore (requêtes champ simple — politique quota Task 102). */
const SCAN_LIMIT = 50;
/** Nombre maximal de retraitements par appel (l'appelant relance si besoin). */
const RETRY_LIMIT = 10;

interface ProblemDoc {
  id: string;
  receivedAtMs: number;
  data: Record<string, unknown>;
}

/**
 * POST /api/admin/billing/reconcile — rapprochement périodique des livraisons
 * Chariow (Task 104-b) : détecte les documents coincés (échecs et baux de
 * processing expirés) et, sur { retry: true }, re-traite les réparables via
 * le MÊME chemin idempotent que le webhook (claim transactionnel + crédit
 * protégé par le journal wallet chariow_${saleId}).
 *
 * Rapport sans corps : { failed, staleProcessing, oldest } (oldest = plus
 * ancien receivedAt des documents problématiques, en ms epoch, ou null).
 * Avec { retry: true } : + { retried, recovered, stillFailed }.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const body = (await request.json().catch(() => null)) as { retry?: unknown } | null;
  const retryRequested = body?.retry === true;

  const { adminDb } = await import("@/lib/firebase/admin");
  const deliveries = adminDb.collection("chariowPulseDeliveries");
  const now = Date.now();

  // Requêtes champ simple auto-indexées (aucun index composite) : égalité sur
  // "status", puis filtrage MÉMOIRE du bail pour les processing — un range
  // receivedAt + égalité status exigerait un index composite.
  const [failedSnap, processingSnap] = await Promise.all([
    deliveries.where("status", "==", "failed").limit(SCAN_LIMIT).get(),
    deliveries.where("status", "==", "processing").limit(SCAN_LIMIT).get(),
  ]);

  const failed: ProblemDoc[] = [];
  for (const doc of failedSnap.docs) {
    const data = (doc.data() ?? {}) as Record<string, unknown>;
    failed.push({ id: doc.id, receivedAtMs: receivedAtToMillis(data.receivedAt), data });
  }
  const staleProcessing: ProblemDoc[] = [];
  for (const doc of processingSnap.docs) {
    const data = (doc.data() ?? {}) as Record<string, unknown>;
    const receivedAtMs = receivedAtToMillis(data.receivedAt);
    if (now - receivedAtMs > CHARIOW_LEASE_MS) {
      staleProcessing.push({ id: doc.id, receivedAtMs, data });
    }
  }

  // Du plus ancien au plus récent : les reprises traitent d'abord les plus urgents.
  const problems = [...failed, ...staleProcessing].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  const oldest = problems.length > 0 ? problems[0].receivedAtMs : null;

  const report: Record<string, unknown> = {
    failed: failed.length,
    staleProcessing: staleProcessing.length,
    oldest,
  };

  if (!retryRequested) {
    return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
  }

  // Réparables = payload sérialisable stocké au claim (les documents
  // antérieurs à Task 104-b n'en ont pas : signalés, mais non rejouables).
  const repairable: Array<{ id: string; payload: Record<string, unknown> }> = [];
  for (const problem of problems) {
    if (repairable.length >= RETRY_LIMIT) break;
    const payload = storedChariowPayload(problem.data);
    if (payload) repairable.push({ id: problem.id, payload });
  }

  let retried = 0;
  let recovered = 0;
  let stillFailed = 0;
  for (const problem of repairable) {
    retried += 1;
    try {
      // Même porte d'entrée que le webhook : le claim reprend le document
      // (échec ou bail expiré) et protège d'une course avec une re-délivrance.
      const claim = await claimChariowDelivery(problem.id, problem.payload);
      if (claim.action !== "process") {
        // Réglé entre-temps ou pris en charge par un autre worker.
        retried -= 1;
        continue;
      }
      const result = await processChariowSale(problem.payload, problem.id);
      if (result.kind === "failed") stillFailed += 1;
      else recovered += 1;
    } catch {
      // Isolation : l'échec d'une livraison n'empêche jamais les autres.
      stillFailed += 1;
    }
  }

  return NextResponse.json({ ...report, retried, recovered, stillFailed }, { headers: { "cache-control": "no-store" } });
}

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

/**
 * SONDE DE DIAGNOSTIC TEMPORAIRE (Task 114 — À RETIRER après diagnostic).
 * Protégée par le header x-diag-token == process.env.GEN3IA_DIAG_TOKEN.
 * Ne révèle JAMAIS de secret : booléens de présence + identifiants non sensibles.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const expected = process.env.GEN3IA_DIAG_TOKEN;
  const provided = request.headers.get("x-diag-token");
  if (!expected || !provided || provided !== expected) {
    return NextResponse.json({ error: "Interdit." }, { status: 403 });
  }
  const runId = request.nextUrl.searchParams.get("runId") ?? "";
  const report: Record<string, unknown> = { at: new Date().toISOString() };

  // 1) Origine canonique (allowlist)
  try {
    const { resolveJobOrigin } = await import("@/lib/queue/origin");
    const res = resolveJobOrigin();
    report.origin = res.ok ? { ok: true, host: new URL(res.origin).host } : { ok: false, reason: res.reason, detail: res.detail };
  } catch (e) {
    report.origin = { error: e instanceof Error ? e.message : String(e) };
  }

  // 2) Config QStash (présence uniquement — jamais les valeurs)
  try {
    const { qstashConfig, missionQueueConfigured } = await import("@/lib/queue/qstash");
    const cfg = qstashConfig();
    report.qstash = {
      token: Boolean(cfg?.token),
      currentSigningKey: Boolean(cfg?.currentSigningKey),
      nextSigningKey: Boolean(cfg?.nextSigningKey),
      queueConfigured: missionQueueConfigured(),
    };
  } catch (e) {
    report.qstash = { error: e instanceof Error ? e.message : String(e) };
  }

  // 3) État du doc mission (si runId fourni) — lecture brute diagnostic
  if (runId) {
    try {
      const { getR2Fs } = await import("@/lib/r2fs");
      const db = getR2Fs();
      const snap = await db.collection("missionQueue").doc(runId).get();
      const data = snap.exists ? snap.data() : null;
      report.mission = data
        ? {
            status: data.status,
            attempts: data.attempts,
            pendingCount: data.pendingCount,
            leaseUntilMs: data.leaseUntilMs ?? null,
            lastError: typeof data.lastError === "string" ? data.lastError.slice(0, 300) : null,
            updatedAtMs: data.updatedAtMs,
            createdAtMs: data.createdAtMs,
          }
        : { missing: true };
    } catch (e) {
      report.mission = { error: e instanceof Error ? e.message : String(e) };
    }
    // 4) Publication d'un tick réel pour cette mission
    try {
      const { publishMissionTick } = await import("@/lib/queue/qstash");
      const pub = await publishMissionTick(runId);
      report.publish = pub ? { published: true, messageId: pub.messageId } : { published: false, reason: "non configuré" };
    } catch (e) {
      report.publish = { published: false, error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    report.publish = { skipped: "runId absent — probe config only" };
  }

  report.probeId = randomUUID();
  return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}

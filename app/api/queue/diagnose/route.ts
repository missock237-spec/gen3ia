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
    // SONDE CLÉS ACTIVES (temporaire) : l'API QStash expose-t-elle les clés
    // de signature actives ? Si oui, on peut réaligner les env Vercel.
    if (cfg && request.nextUrl.searchParams.get("keys") === "1") {
      try {
        const r = await fetch("https://qstash.upstash.io/v2/keys", { headers: { Authorization: `Bearer ${cfg.token}` } });
        const body = r.ok ? await r.json() : await r.text();
        report.qstashKeysApi = { status: r.status, body: r.ok ? body : String(body).slice(0, 200) };
      } catch (e) {
        report.qstashKeysApi = { error: e instanceof Error ? e.message : String(e) };
      }
    }
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
            executionId: typeof data.executionId === "string" ? data.executionId : null,
            conversationId: typeof data.conversationId === "string" ? data.conversationId : null,
            timeline: Array.isArray(data.timeline) ? data.timeline.slice(-4) : [],
            planSteps: data.plan?.steps ? (data.plan.steps as Array<Record<string, unknown>>).map((s) => ({ id: s.id, type: s.type, status: s.status })) : null,
          }
        : { missing: true };
      // Checkpoint runtime correspondant (exécution réelle)
      if (typeof data?.executionId === "string") {
        try {
          const ck = await db.collection("executions").doc(data.executionId).get();
          report.checkpoint = ck.exists
            ? {
                status: ck.data()?.status ?? null,
                outputsKeys: Object.keys((ck.data()?.outputs ?? {}) as Record<string, unknown>).slice(0, 8),
                billing: ck.data()?.billing ?? null,
                steps: Array.isArray(ck.data()?.plan?.steps)
                  ? (ck.data()?.plan?.steps as Array<Record<string, unknown>>).map((s) => ({ id: s.id, status: s.status }))
                  : null,
              }
            : { missing: true };
        } catch (e) {
          report.checkpoint = { error: e instanceof Error ? e.message : String(e) };
        }
      }
    } catch (e) {
      report.mission = { error: e instanceof Error ? e.message : String(e) };
    }
    // 4) Publication d'un tick réel pour cette mission
    try {
      const { publishMissionTick, qstashConfig } = await import("@/lib/queue/qstash");
      const pub = await publishMissionTick(runId);
      report.publish = pub ? { published: true, messageId: pub.messageId } : { published: false, reason: "non configuré" };
      // 5) LIVRAISON réelle selon QStash : état du message + événements récents
      // (lecture API QStash côté serveur — aucun secret retourné, états seulement)
      const cfg = qstashConfig();
      if (cfg) {
        const headers = { Authorization: `Bearer ${cfg.token}` };
        const events = await fetch("https://qstash.upstash.io/v2/events?count=10", { headers });
      const eventsBody = events.ok ? await events.json() : null;
      const rawList = Array.isArray(eventsBody?.events) ? eventsBody.events.slice(0, 6) : [];
      // Résumé compact + UN événement BRUT (échec de préférence) pour diagnostic
      const simplified = rawList.map((ev: Record<string, unknown>) => {
        const req = (ev.request ?? {}) as Record<string, unknown>;
        const resp = (ev.response ?? {}) as Record<string, unknown>;
        return {
          messageId: ev.messageId ?? null,
          state: ev.state ?? null,
          url: typeof ev.url === "string" ? new URL(ev.url).host + new URL(ev.url).pathname : ev.url,
          responseStatus: resp.status ?? ev.responseStatus ?? null,
          check: ev.check ?? null,
          nextAttemptMs: ev.nextAttempt ?? null,
        };
      });
      report.qstashEvents = simplified;
      const failed = rawList.find((ev: Record<string, unknown>) => ev.state === "FAILED" || ev.state === "ERROR");
      report.qstashRawSample = failed ?? rawList[0] ?? null;
      }
    } catch (e) {
      report.publish = { published: false, error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    report.publish = { skipped: "runId absent — probe config only" };
  }

  // 6) CLAIM DIRECT (test décisif) : exécuter claimMissionTick ici-même et
  // retourner l'issue exacte ou l'erreur brute — sans passer par QStash.
  if (runId) {
    try {
      const { claimMissionTick } = await import("@/lib/queue/mission-queue");
      const t0 = Date.now();
      const claim = await claimMissionTick(runId);
      report.claim = { ms: Date.now() - t0, kind: claim.kind, ...(claim.kind === "terminal" ? { status: claim.status } : {}), ...(claim.kind === "missing" ? { note: "doc absent" } : {}) };
    } catch (e) {
      report.claim = { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? (e.stack ?? "").split("\n").slice(0, 4).join(" | ") : undefined };
    }
  }
  return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}

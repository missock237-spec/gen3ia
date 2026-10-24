import { describe, expect, it } from "vitest";

import {
  FRAME_INTERVAL_BUCKETS_MS,
  HEARTBEAT_INTERVAL_BUCKETS_MS,
  describeStopReason,
  nextIntervalBucket,
} from "./limits";

describe("nextIntervalBucket (intervalles distants boulonnés sur barillets constants)", () => {
  it("renvoie le plus petit barillet >= à la demande (cadence jamais plus lente)", () => {
    expect(nextIntervalBucket(6_000, HEARTBEAT_INTERVAL_BUCKETS_MS, 15_000)).toBe(10_000);
    expect(nextIntervalBucket(1_000, FRAME_INTERVAL_BUCKETS_MS, 900)).toBe(1_500);
    expect(nextIntervalBucket(5_000, HEARTBEAT_INTERVAL_BUCKETS_MS, 15_000)).toBe(5_000);
  });

  it("repli sur la valeur par défaut si absente ou non numérique", () => {
    expect(nextIntervalBucket(undefined, HEARTBEAT_INTERVAL_BUCKETS_MS, 15_000)).toBe(15_000);
    expect(nextIntervalBucket("abc", FRAME_INTERVAL_BUCKETS_MS, 900)).toBe(900);
    expect(nextIntervalBucket(Number.NaN, FRAME_INTERVAL_BUCKETS_MS, 900)).toBe(900);
    expect(nextIntervalBucket(Number.POSITIVE_INFINITY, FRAME_INTERVAL_BUCKETS_MS, 900)).toBe(900);
  });

  it("plafonne au dernier barillet (aucune valeur réseau au-delà du max)", () => {
    expect(nextIntervalBucket(120_000, HEARTBEAT_INTERVAL_BUCKETS_MS, 15_000)).toBe(60_000);
    expect(nextIntervalBucket(9_999_999, FRAME_INTERVAL_BUCKETS_MS, 900)).toBe(60_000);
  });

  it("plancher garanti : une demande trop rapide remonte au barillet minimal", () => {
    expect(nextIntervalBucket(1, HEARTBEAT_INTERVAL_BUCKETS_MS, 15_000)).toBe(5_000);
    expect(nextIntervalBucket(0, FRAME_INTERVAL_BUCKETS_MS, 900)).toBe(900);
    expect(nextIntervalBucket(-50, FRAME_INTERVAL_BUCKETS_MS, 900)).toBe(900);
  });

  it("la valeur renvoyée appartient TOUJOURS au barillet (aucune valeur distante directe)", () => {
    for (const requested of [0, 1, 733, 1_250, 4_444, 9_001, 77_777, 1e9]) {
      const heartbeat = nextIntervalBucket(requested, HEARTBEAT_INTERVAL_BUCKETS_MS, 15_000);
      expect(HEARTBEAT_INTERVAL_BUCKETS_MS).toContain(heartbeat);
      const frame = nextIntervalBucket(requested, FRAME_INTERVAL_BUCKETS_MS, 900);
      expect(FRAME_INTERVAL_BUCKETS_MS).toContain(frame);
    }
  });
});

describe("describeStopReason (libellés constants — aucune donnée distante journalisée)", () => {
  it("classe les signaux système", () => {
    expect(describeStopReason("SIGINT")).toBe("signal SIGINT");
    expect(describeStopReason("SIGTERM")).toBe("signal SIGTERM");
  });

  it("classe le fichier d'arrêt local et les demandes gateway", () => {
    expect(describeStopReason("Local stop file is present.")).toBe("fichier d'arrêt local présent");
    expect(describeStopReason("gateway requested stop")).toBe("demande du gateway");
    expect(describeStopReason("n'importe quel motif libre distant")).toBe(
      "demande du gateway (motif non classé)",
    );
  });

  it("le libellé renvoyé appartient TOUJOURS à l'ensemble constant (injection impossible)", () => {
    const ATTACKS = [
      "ligne1\n2026 ERROR faux journal\nat attacker",
      "\u001b[31mansi\u001b[0m",
      "SIGINT\nforged",
      "",
      "x".repeat(10_000),
    ];
    const ALLOWED = new Set([
      "signal SIGINT",
      "signal SIGTERM",
      "fichier d'arrêt local présent",
      "demande du gateway",
      "demande du gateway (motif non classé)",
    ]);
    for (const attack of ATTACKS) {
      expect(ALLOWED.has(describeStopReason(attack))).toBe(true);
    }
  });
});

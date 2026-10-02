import { describe, expect, it } from "vitest";

import {
  FRAME_INTERVAL_BUCKETS_MS,
  HEARTBEAT_INTERVAL_BUCKETS_MS,
  nextIntervalBucket,
  sanitizeLogText,
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

describe("sanitizeLogText (hygiène des journaux contre les données distantes)", () => {
  it("purge les caractères de contrôle C0 (sauts de ligne, retours, tabulations, nul)", () => {
    expect(sanitizeLogText("ligne1\nligne2")).toBe("ligne1 ligne2");
    expect(sanitizeLogText("a\rb\nc\td")).toBe("a b c d");
    expect(sanitizeLogText("avant\u0000après")).toBe("avant après");
    expect(sanitizeLogText("\u001b[31mrouge\u001b[0m")).toBe(" [31mrouge [0m");
  });

  it("purge les caractères de contrôle C1 (0x7F–0x9F)", () => {
    expect(sanitizeLogText("ok\u007f\u009ffin")).toBe("ok  fin");
  });

  it("conserve les textes sains et les accents", () => {
    expect(sanitizeLogText("Arrêt demandé par l'opérateur")).toBe("Arrêt demandé par l'opérateur");
  });

  it("plafonne la longueur (défaut 200 caractères)", () => {
    const long = "x".repeat(500);
    expect(sanitizeLogText(long).length).toBe(200);
    expect(sanitizeLogText("abcdefghij", 5)).toBe("abcde");
  });

  it("neutralise une tentative de forge de ligne de journal", () => {
    const forged = 'stop\n2026-01-01 ERROR: faux journal\nat generated/by/attacker';
    const cleaned = sanitizeLogText(forged);
    expect(cleaned).not.toContain("\n");
    expect(cleaned.split("\n").length).toBe(1);
  });
});

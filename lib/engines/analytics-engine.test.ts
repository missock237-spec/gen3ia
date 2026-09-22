import { describe, expect, it } from "vitest";
import {
  summarizeNumbers,
  timeseriesByDay,
  linearForecast,
  forecastDaily,
  getAtPath,
  formatMoney,
} from "./analytics-engine";

describe("Analytics Engine — fonctions pures", () => {
  describe("summarizeNumbers", () => {
    it("résume une série classique", () => {
      const summary = summarizeNumbers([10, 20, 30, 40, 100]);
      expect(summary.count).toBe(5);
      expect(summary.sum).toBe(200);
      expect(summary.avg).toBe(40);
      expect(summary.min).toBe(10);
      expect(summary.max).toBe(100);
      expect(summary.median).toBe(30);
    });

    it("gère une série vide et un élément unique", () => {
      expect(summarizeNumbers([]).count).toBe(0);
      const single = summarizeNumbers([42]);
      expect(single.median).toBe(42);
      expect(single.p90).toBe(42);
    });

    it("calcule le p90 correctement", () => {
      const values = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10
      expect(summarizeNumbers(values).p90).toBe(9);
    });
  });

  describe("getAtPath", () => {
    it("lit un chemin profond et renvoie undefined sinon", () => {
      const source = { payload: { client: { name: "ACME" } }, total: 5 };
      expect(getAtPath(source, "payload.client.name")).toBe("ACME");
      expect(getAtPath(source, "total")).toBe(5);
      expect(getAtPath(source, "payload.missing")).toBeUndefined();
      expect(getAtPath(source as unknown as Record<string, unknown>, "")).toBe(source);
    });
  });

  describe("timeseriesByDay", () => {
    it("compte les enregistrements par jour sans champ de valeur", () => {
      const records = [
        { data: { issuedAt: "2026-03-01T10:00:00Z" } },
        { data: { issuedAt: "2026-03-01T15:00:00Z" } },
        { data: { issuedAt: "2026-03-02T08:00:00Z" } },
        { data: { issuedAt: "pas-une-date" } },
      ];
      const series = timeseriesByDay(records, "data.issuedAt");
      expect(series).toEqual([
        { date: "2026-03-01", value: 2 },
        { date: "2026-03-02", value: 1 },
      ]);
    });

    it("somme un champ de montant avec signe", () => {
      const records = [
        { data: { dueDate: "2026-03-01T00:00:00Z", amount: 100 } },
        { data: { dueDate: "2026-03-01T00:00:00Z", amount: 50.5 } },
      ];
      const series = timeseriesByDay(records, "data.dueDate", "data.amount", -1);
      expect(series).toEqual([{ date: "2026-03-01", value: -150.5 }]);
    });
  });

  describe("linearForecast", () => {
    it("retrouve une pente parfaite (r2 = 1)", () => {
      const points = [1, 2, 3, 4].map((x) => ({ x, y: 10 * x + 5 }));
      const forecast = linearForecast(points, 2);
      expect(forecast.r2).toBeCloseTo(1, 6);
      expect(forecast.slope).toBeCloseTo(10, 6);
      // Suite des x (5 puis 6) : y = 10x + 5 → 55 puis 65.
      expect(forecast.predictions).toEqual([55, 65]);
    });

    it("dégrade proprement avec moins de 2 points", () => {
      expect(linearForecast([], 3).predictions).toEqual([0, 0, 0]);
      expect(linearForecast([{ x: 0, y: 7 }], 2).predictions).toEqual([7, 7]);
    });
  });

  describe("forecastDaily", () => {
    it("comble les jours manquants par zéro avant de projeter", () => {
      const series = [
        { date: "2026-03-01", value: 4 },
        { date: "2026-03-03", value: 4 },
      ];
      const result = forecastDaily(series, 1);
      expect(result.history).toHaveLength(3);
      expect(result.history[1]).toEqual({ date: "2026-03-02", value: 0 });
      expect(result.forecast).toHaveLength(1);
      expect(result.forecast[0].date).toBe("2026-03-04");
    });

    it("renvoie des séries vides sans entrée", () => {
      expect(forecastDaily([], 5)).toEqual({ history: [], forecast: [], r2: 0 });
    });
  });

  it("formate la monnaie en EUR", () => {
    expect(formatMoney(1234.5)).toContain("1");
  });
});

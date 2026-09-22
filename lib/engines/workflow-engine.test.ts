import { describe, expect, it } from "vitest";
import { interpolate, interpolateConfig, evaluateConditions, resolveFlexibleDate } from "./workflow-engine";

describe("Workflow Engine — fonctions pures", () => {
  describe("interpolate", () => {
    it("résout les placeholders simples et imbriqués", () => {
      const context = { payload: { client: "ACME", amount: 1500 }, workflow: { name: "Relances" }, results: { s1: "OK" } };
      expect(interpolate("Facture {{payload.client}} de {{payload.amount}} €", context)).toBe("Facture ACME de 1500 €");
      expect(interpolate("Workflow: {{workflow.name}} / résultat: {{results.s1}}", context)).toBe("Workflow: Relances / résultat: OK");
    });

    it("renvoie une chaîne vide pour un chemin manquant et sérialise les objets", () => {
      const context = { payload: { extra: { a: 1 } } };
      expect(interpolate("Valeur: {{payload.missing}} !", context)).toBe("Valeur:  !");
      expect(interpolate("Extra: {{payload.extra}}", context)).toBe('Extra: {"a":1}');
    });

    it("tolère les espaces dans les délimiteurs", () => {
      expect(interpolate("{{ payload.x }}", { payload: { x: 3 } })).toBe("3");
    });
  });

  describe("interpolateConfig", () => {
    it("interpole récursivement objets, tableaux et chaînes", () => {
      const config = { title: "RDV {{payload.client}}", tags: ["{{payload.statut}}"], nested: { when: "+3 d", keep: 12 }, untouched: null };
      const context = { payload: { client: "ACME", statut: "retard" } };
      const result = interpolateConfig(config, context);
      expect(result).toEqual({ title: "RDV ACME", tags: ["retard"], nested: { when: "+3 d", keep: 12 }, untouched: null });
    });
  });

  describe("evaluateConditions", () => {
    const context = { payload: { status: "overdue", amount: 500, label: "Facture Electricité" } };

    it("égalité, différence et contains (insensible à la casse)", () => {
      expect(evaluateConditions([{ field: "payload.status", op: "eq", value: "overdue" }], context)).toBe(true);
      expect(evaluateConditions([{ field: "payload.status", op: "neq", value: "paid" }], context)).toBe(true);
      expect(evaluateConditions([{ field: "payload.label", op: "contains", value: "electri" }], context)).toBe(true);
    });

    it("comparaisons numériques", () => {
      expect(evaluateConditions([{ field: "payload.amount", op: "gte", value: 500 }], context)).toBe(true);
      expect(evaluateConditions([{ field: "payload.amount", op: "lt", value: 100 }], context)).toBe(false);
    });

    it("ET logique : une seule condition fausse suffit à rejeter", () => {
      expect(
        evaluateConditions(
          [
            { field: "payload.status", op: "eq", value: "overdue" },
            { field: "payload.amount", op: "gt", value: 999 },
          ],
          context,
        ),
      ).toBe(false);
    });
  });

  describe("resolveFlexibleDate", () => {
    it("résout +Nd / +Nj en ISO futur", () => {
      const date = new Date(resolveFlexibleDate("+7 d"));
      expect(date.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000 - 60_000);
      expect(new Date(resolveFlexibleDate("+3 j")).getTime()).toBeGreaterThan(Date.now());
    });

    it("complète une date de jour en 09:00 UTC", () => {
      expect(resolveFlexibleDate("2026-10-05")).toBe("2026-10-05T09:00:00.000Z");
    });

    it("passe un ISO complet et rejette une date invalide", () => {
      expect(new Date(resolveFlexibleDate("2026-10-05T14:30:00Z")).getUTCHours()).toBe(14);
      expect(() => resolveFlexibleDate("demain matin")).toThrow(/Date invalide/);
    });
  });
});

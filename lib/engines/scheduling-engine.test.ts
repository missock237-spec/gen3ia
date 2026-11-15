import { describe, expect, it } from "vitest";
import { leaveBusinessDays, nextMaintenanceDue, maintenanceStatus } from "./scheduling-engine";

describe("Scheduling Engine — fonctions pures", () => {
  describe("leaveBusinessDays", () => {
    it("compte les jours ouvrés d'une semaine complète (5 jours)", () => {
      // Lundi 2026-09-07 → vendredi 2026-09-11
      expect(leaveBusinessDays("2026-09-07", "2026-09-11")).toBe(5);
    });

    it("exclut les week-ends d'une période de 7 jours calendaires", () => {
      // Lundi 2026-09-07 → dimanche 2026-09-13
      expect(leaveBusinessDays("2026-09-07", "2026-09-13")).toBe(5);
    });

    it("compte un jour unique en semaine", () => {
      expect(leaveBusinessDays("2026-09-09", "2026-09-09")).toBe(1);
    });

    it("renvoie 0 pour une plage inversée ou invalide", () => {
      expect(leaveBusinessDays("2026-09-11", "2026-09-07")).toBe(0);
      expect(leaveBusinessDays("invalide", "2026-09-07")).toBe(0);
      expect(leaveBusinessDays("2026-09-07", "samedi?")).toBe(0);
    });

    it("ne compte que le samedi sur un week-end", () => {
      // Samedi 2026-09-12 → dimanche 2026-09-13
      expect(leaveBusinessDays("2026-09-12", "2026-09-13")).toBe(0);
    });
  });

  describe("nextMaintenanceDue", () => {
    it("ajoute l'intervalle en jours à la dernière intervention", () => {
      expect(nextMaintenanceDue("2026-06-01T08:00:00.000Z", 30)).toBe("2026-07-01T08:00:00.000Z");
    });

    it("borne l'intervalle à 1 jour minimum", () => {
      expect(nextMaintenanceDue("2026-06-01T08:00:00.000Z", 0)).toBe("2026-06-02T08:00:00.000Z");
    });

    it("rejette une date invalide", () => {
      expect(() => nextMaintenanceDue("jamais", 30)).toThrow(/invalide/i);
    });
  });

  describe("maintenanceStatus", () => {
    const now = new Date("2026-09-23T12:00:00Z");

    it("classe ok / due_soon / overdue", () => {
      expect(maintenanceStatus("2026-10-15T00:00:00Z", now)).toBe("ok");
      expect(maintenanceStatus("2026-09-28T00:00:00Z", now)).toBe("due_soon"); // dans 5 jours
      expect(maintenanceStatus("2026-09-20T00:00:00Z", now)).toBe("overdue"); // passé
      expect(maintenanceStatus("2026-09-23T11:00:00Z", now)).toBe("overdue"); // dans l'heure passée
    });

    it("traite une date invalide comme en retard (sécurité)", () => {
      expect(maintenanceStatus("?", now)).toBe("overdue");
    });
  });
});

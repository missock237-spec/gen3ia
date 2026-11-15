import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  absorptionExpiree,
  bilanAutonomie,
  cloturerAbsorption,
  phaseDe,
} from "./phases";
import { etatParDefaut } from "./etat";
import type { EtatAutoApprentissage } from "./types";

/* ------------------------------------------------------------------ */
/* LE CYCLE DE VIE — machine à états PURE : absorption bornée →        */
/* autonomie définitive. Chaque règle est testée sur des états réels.  */
/* (Régime fenêtre forcé : le régime maîtrise a ses propres tests.)    */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.stubEnv("AUTO_APPRENTISSAGE_MAITRISE", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const LANCE_A = "2026-01-01T00:00:00.000Z";
const LANCE_A_DATE = Date.parse(LANCE_A);
const DEUX_HEURES_MS = 2 * 60 * 60 * 1000;

function etatAbsorption(partiels: Partial<EtatAutoApprentissage> = {}): EtatAutoApprentissage {
  return { ...etatParDefaut(LANCE_A), ...partiels };
}

describe("phaseDe", () => {
  it("fenêtre ouverte : phase absorption, temps restant dérivé de lanceA", () => {
    const vue = phaseDe(etatAbsorption(), LANCE_A_DATE + 30 * 60_000);
    expect(vue.phase).toBe("absorption");
    expect(vue.absorptionCloturee).toBe(false);
    expect(vue.restantMs).toBe(DEUX_HEURES_MS - 30 * 60_000);
  });

  it("la fenêtre ne se repousse PAS au reboot : le restant est absolument borné", () => {
    // 1 h 50 écoulées : il reste 10 min, quel que soit le nombre de reboots.
    const vue = phaseDe(etatAbsorption(), LANCE_A_DATE + 110 * 60_000);
    expect(vue.restantMs).toBe(10 * 60_000);
  });

  it("lanceA invalide → fenêtre ancrée sur l'instant courant (jamais NaN)", () => {
    const etat = etatAbsorption({ lanceA: "pas-une-date" });
    const vue = phaseDe(etat, 5_000_000);
    expect(vue.phase).toBe("absorption");
    expect(Number.isFinite(vue.restantMs)).toBe(true);
    expect(vue.restantMs).toBeGreaterThan(0);
  });

  it("clôture persistée → phase autonomie, restant null", () => {
    const etat = etatAbsorption({
      absorptionCloturee: true,
      absorptionClotureeA: "2026-01-01T02:00:00.000Z",
    });
    const vue = phaseDe(etat, LANCE_A_DATE + 30 * 60_000);
    expect(vue.phase).toBe("autonomie");
    expect(vue.absorptionCloturee).toBe(true);
    expect(vue.clotureeA).toBe("2026-01-01T02:00:00.000Z");
    expect(vue.restantMs).toBeNull();
  });
});

describe("absorptionExpiree", () => {
  it("faux pendant la fenêtre", () => {
    expect(absorptionExpiree(etatAbsorption(), LANCE_A_DATE + DEUX_HEURES_MS - 1)).toBe(false);
  });

  it("vrai à l'échéance exacte", () => {
    expect(absorptionExpiree(etatAbsorption(), LANCE_A_DATE + DEUX_HEURES_MS)).toBe(true);
  });

  it("faux en autonomie (déjà clôturée — rien à faire)", () => {
    const etat = etatAbsorption({ absorptionCloturee: true, absorptionClotureeA: LANCE_A });
    expect(absorptionExpiree(etat, LANCE_A_DATE + 3 * DEUX_HEURES_MS)).toBe(false);
  });
});

describe("bilanAutonomie", () => {
  it("socle complet : un seul axe (évolution par les utilisateurs)", () => {
    const etat = etatAbsorption({
      pairesCumulees: 120,
      echantillonsCumules: 60,
      datasetsIngestes: ["org/a", "org/b"],
      dernierRapport: {
        v: 1,
        id: "c1",
        demarreA: LANCE_A,
        dureeMs: 1000,
        statut: "termine",
        message: "ok",
        hubs: [],
        datasetsIngestes: ["org/a"],
        intention: { echantillons: 60, epoques: 2, accuracyTrain: 0.9, accuracyTest: 0.85, dureeMs: 500 },
      },
    });
    const bilan = bilanAutonomie(etat, LANCE_A_DATE + DEUX_HEURES_MS);
    expect(bilan.axes).toHaveLength(1);
    expect(bilan.axes[0]).toContain("utilisateurs");
    expect(bilan.pairesAbsorbees).toBe(120);
    expect(bilan.echantillonsAbsorbes).toBe(60);
    expect(bilan.datasetsAbsorbes).toBe(2);
    expect(bilan.dureeUtiliseeMs).toBe(DEUX_HEURES_MS);
    expect(bilan.message).toContain("n'apprend plus de ses datasets");
  });

  it("socle vide : les axes nomment honnêtement les manques", () => {
    const bilan = bilanAutonomie(etatAbsorption(), LANCE_A_DATE + DEUX_HEURES_MS);
    expect(bilan.axes).toHaveLength(3);
    expect(bilan.axes.some((a) => a.startsWith("Langage :"))).toBe(true);
    expect(bilan.axes.some((a) => a.startsWith("Intentions :"))).toBe(true);
    expect(bilan.axes.some((a) => a.startsWith("Socle :"))).toBe(true);
  });

  it("accuracy faible → axe de consolidation (jamais de maquillage)", () => {
    const etat = etatAbsorption({
      pairesCumulees: 10,
      echantillonsCumules: 5,
      datasetsIngestes: ["org/a"],
      dernierRapport: {
        v: 1,
        id: "c1",
        demarreA: LANCE_A,
        dureeMs: 1000,
        statut: "termine",
        message: "ok",
        hubs: [],
        datasetsIngestes: ["org/a"],
        intention: { echantillons: 5, epoques: 2, accuracyTrain: 0.5, accuracyTest: 0.4, dureeMs: 500 },
      },
    });
    const bilan = bilanAutonomie(etat, LANCE_A_DATE + DEUX_HEURES_MS);
    expect(bilan.axes.some((a) => a.includes("40 %"))).toBe(true);
  });
});

describe("cloturerAbsorption", () => {
  it("clôture : état marqué, bilan écrit UNE fois, horizon 2 h respecté", () => {
    const etat = etatAbsorption({ pairesCumulees: 10, echantillonsCumules: 5 });
    const cloture = cloturerAbsorption(etat, LANCE_A_DATE + DEUX_HEURES_MS);
    expect(cloture.absorptionCloturee).toBe(true);
    expect(cloture.absorptionClotureeA).toBe("2026-01-01T02:00:00.000Z");
    expect(cloture.bilanAutonomie?.datasetsAbsorbes).toBe(0);
    expect(cloture.bilanAutonomie?.message).toContain("utilisateurs");
  });

  it("idempotent : une clôture déjà faite n'écrase jamais le bilan", () => {
    const premier = cloturerAbsorption(etatAbsorption(), LANCE_A_DATE + DEUX_HEURES_MS);
    const second = cloturerAbsorption(premier, LANCE_A_DATE + 5 * DEUX_HEURES_MS);
    expect(second).toBe(premier); // même objet — aucune réécriture
  });
});

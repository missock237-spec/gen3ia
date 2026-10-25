import { describe, expect, it } from "vitest";

import { RegistreEssaim } from "../registre";
import { BORNES_ESSAIM, scoreNoeud, type CapacitésNoeud } from "../types";

/** Horloge mutable : le temps ne s'écoule que quand les tests le décident. */
function horlogeMutable(): { t: number; avancer: (ms: number) => void; lire: () => number } {
  const état = { t: 1_700_000_000_000 };
  return {
    t: état.t,
    avancer: (ms) => (état.t += ms),
    lire: () => état.t,
  };
}

const CAP_FORT: CapacitésNoeud = {
  webgpu: true,
  memoireGo: 4,
  adaptateur: "nvidia ada",
  features: ["shader-f16"],
};
const CAP_FAIBLE: CapacitésNoeud = { webgpu: true, memoireGo: 0.5, adaptateur: "intel" };
const CAP_SANS_GPU: CapacitésNoeud = { webgpu: false };

describe("scoreNoeud", () => {
  it("vaut 0 sans WebGPU — jamais de fragment pour un nœud inapte", () => {
    expect(scoreNoeud(CAP_SANS_GPU, 0, 0, 0)).toBe(0);
  });

  it("classe la mémoire GPU d'abord (4 Go + f16 > 0,5 Go)", () => {
    const t = Date.now();
    const fort = scoreNoeud(CAP_FORT, 0, t, t);
    const faible = scoreNoeud(CAP_FAIBLE, 0, t, t);
    expect(fort).toBeGreaterThan(0.7);
    expect(faible).toBeLessThan(0.25);
    expect(fort).toBeGreaterThan(faible);
  });

  it("la fraîcheur du battement pèse : un nœud silencieux décroît", () => {
    const t = Date.now();
    const frais = scoreNoeud(CAP_FORT, 0, t, t);
    const vieux = scoreNoeud(CAP_FORT, 0, t - BORNES_ESSAIM.ttlNoeudMs - 1, t);
    expect(frais).toBeGreaterThan(vieux);
  });
});

describe("RegistreEssaim", () => {
  it("crée un nœud, recalcule le score à chaque battement, garde la réputation", () => {
    const h = horlogeMutable();
    const registre = new RegistreEssaim(h.lire);
    const n = registre.battre("essaim-aaaa1111-x", "user-1", CAP_FORT);
    expect(n.noeudId).toBe("essaim-aaaa1111-x");
    expect(n.succès).toBe(0);

    n.succès = 0; // le crédit passe par créditerSuccès
    registre.créditerSuccès("essaim-aaaa1111-x");
    h.avancer(1_000);
    const n2 = registre.battre("essaim-aaaa1111-x", "user-1", CAP_FORT);
    expect(n2.succès).toBe(1);
    expect(n2.ratés).toBe(0);
    expect(n2.score).toBeGreaterThan(0);
  });

  it("refuse le détournement d'identité : un autre compte écrase le nœud", () => {
    const h = horlogeMutable();
    const registre = new RegistreEssaim(h.lire);
    registre.battre("essaim-volé0000-x", "user-1", CAP_FORT);
    registre.battre("essaim-volé0000-x", "user-2", CAP_FORT);
    expect(registre.appartient("essaim-volé0000-x", "user-2")).toBe(true);
    expect(registre.appartient("essaim-volé0000-x", "user-1")).toBe(false);
  });

  it("charge plafonnée : UN fragment par GPU (chargeMaxParNoeud)", () => {
    const h = horlogeMutable();
    const registre = new RegistreEssaim(h.lire);
    registre.battre("essaim-charge01-x", "user-1", CAP_FORT);
    expect(registre.charger("essaim-charge01-x")).toBe(true);
    expect(registre.charger("essaim-charge01-x")).toBe(false);
    registre.décharger("essaim-charge01-x");
    expect(registre.charger("essaim-charge01-x")).toBe(true);
  });

  it("SÉLECTION DES 5 MEILLEURS : vivants, WebGPU, triés par score, plafond équipeMax", () => {
    const h = horlogeMutable();
    const registre = new RegistreEssaim(h.lire);
    // 6 nœuds vivants de mémoires différentes + 1 mort + 1 sans GPU.
    const mémoires = [1, 2, 3, 4, 0.5, 8];
    mémoires.forEach((m, i) => {
      registre.battre(`essaim-noeud00${i}-x`, `user-${i}`, { webgpu: true, memoireGo: m });
    });
    registre.battre("essaim-mort0000-x", "user-m", CAP_FORT);
    registre.battre("essaim-sansgpu0-x", "user-s", CAP_SANS_GPU);
    h.avancer(BORNES_ESSAIM.ttlNoeudMs + 1_000);
    // Deux nœuds survivent (leurs ondes continuent) ; les autres se taisent.
    registre.battre("essaim-noeud005-x", "user-5", { webgpu: true, memoireGo: 8 });
    registre.battre("essaim-noeud000-x", "user-0", { webgpu: true, memoireGo: 1 });

    const équipe = registre.sélectionnerÉquipe();
    expect(équipe.length).toBeLessThanOrEqual(BORNES_ESSAIM.équipeMax);
    // Le nœud mort (user-m) et le sans-GPU ne sont JAMAIS sélectionnés.
    expect(équipe.some((n) => n.noeudId === "essaim-mort0000-x")).toBe(false);
    expect(équipe.some((n) => n.noeudId === "essaim-sansgpu0-x")).toBe(false);
    expect(équipe.some((n) => n.noeudId === "essaim-noeud003-x")).toBe(false); // silencieux
    // Tri décroissant par score.
    for (let i = 1; i < équipe.length; i++) {
      expect(équipe[i - 1].score).toBeGreaterThanOrEqual(équipe[i].score);
    }
    // 8 Go domine.
    expect(équipe[0].noeudId).toBe("essaim-noeud005-x");
  });

  it("exclut les nœuds à charge pleine de la sélection", () => {
    const h = horlogeMutable();
    const registre = new RegistreEssaim(h.lire);
    registre.battre("essaim-saturé00-x", "user-1", CAP_FORT);
    registre.charger("essaim-saturé00-x");
    expect(registre.sélectionnerÉquipe()).toHaveLength(0);
  });

  it("SENTINELLE : un nœud muet au-delà du TTL est déclaré rompu et retiré", () => {
    const h = horlogeMutable();
    const registre = new RegistreEssaim(h.lire);
    registre.battre("essaim-brusque0-x", "user-1", CAP_FORT);
    registre.charger("essaim-brusque0-x");
    h.avancer(BORNES_ESSAIM.ttlNoeudMs + 1);

    const perdues: string[] = [];
    const perdus = registre.balayageRuptures((n) => perdues.push(n.noeudId));
    expect(perdus).toHaveLength(1);
    expect(perdues).toEqual(["essaim-brusque0-x"]);
    expect(registre.connu("essaim-brusque0-x")).toBe(false);
    // Le nœud mort n'est plus vivant ni sélectionnable.
    expect(registre.vivant("essaim-brusque0-x")).toBeNull();
  });

  it("un nœud à la limite du TTL reste vivant (pas de rupture prématurée)", () => {
    const h = horlogeMutable();
    const registre = new RegistreEssaim(h.lire);
    registre.battre("essaim-limite00-x", "user-1", CAP_FORT);
    h.avancer(BORNES_ESSAIM.ttlNoeudMs - 1_000);
    expect(registre.vivant("essaim-limite00-x")).not.toBeNull();
  });

  it("partir() retire proprement (déconnexion annoncée)", () => {
    const h = horlogeMutable();
    const registre = new RegistreEssaim(h.lire);
    registre.battre("essaim-adieu000-x", "user-1", CAP_FORT);
    registre.partir("essaim-adieu000-x");
    expect(registre.connu("essaim-adieu000-x")).toBe(false);
  });

  it("état() agrège sans fuir de données privées", () => {
    const h = horlogeMutable();
    const registre = new RegistreEssaim(h.lire);
    registre.battre("essaim-état001-x", "user-1", CAP_FORT);
    const e = registre.état();
    expect(e.noeudsEnLigne).toBe(1);
    expect(e.top[0]?.adaptateur).toBe("nvidia ada");
    expect(JSON.stringify(e)).not.toContain("user-1");
  });
});

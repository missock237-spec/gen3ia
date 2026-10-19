import { describe, expect, it } from "vitest";

import { extraireMesures, interpreter } from "../intention";
import { simuler, type SpecSimulation } from "../univers";

describe("intention — extraction de mesures", () => {
  it("extrait nombres et unités", () => {
    const m = extraireMesures("lance à 50 m/s avec un angle de 45 degrés");
    expect(m[0]).toEqual({ valeur: 50, unite: "m/s" });
    expect(m.some((x) => x.valeur === 45 && x.unite === "deg")).toBe(true);
  });

  it("gère la virgule française", () => {
    const m = extraireMesures("masse de 2,5 kg");
    expect(m.some((x) => x.valeur === 2.5)).toBe(true);
  });
});

describe("intention — détection de domaine", () => {
  it("projectile avec vitesse et angle", () => {
    const i = interpreter("lance un projectile à 50 m/s avec un angle de 30 degrés");
    expect(i).not.toBeNull();
    expect(i!.spec.type).toBe("projectile");
    expect(i!.confiance).toBeGreaterThan(0.5);
    const spec = i!.spec as Extract<SpecSimulation, { type: "projectile" }>;
    expect(spec.v0).toBe(50);
    expect(spec.angleDeg).toBe(30);
  });

  it("pendule", () => {
    const i = interpreter("simule un pendule de longueur 2 m lâché à 60 degrés");
    expect(i!.spec.type).toBe("pendule");
  });

  it("fentes de Young", () => {
    const i = interpreter("montre les franges d'interférence des fentes de Young avec une longueur d'onde de 500 nm");
    expect(i!.spec.type).toBe("fentesYoung");
  });

  it("chaleur", () => {
    const i = interpreter("diffusion de la chaleur dans une plaque de cuivre chauffée à 200 °C");
    expect(i!.spec.type).toBe("diffusionChaleur");
  });

  it("relativité", () => {
    const i = interpreter("dilatation du temps à 99 % de la vitesse de la lumière");
    expect(i!.spec.type).toBe("dilatationTemps");
  });

  it("gaz parfait adiabatique", () => {
    const i = interpreter("détente adiabatique d'un gaz parfait, le volume double");
    expect(i!.spec.type).toBe("gazParfait");
    const spec = i!.spec as Extract<SpecSimulation, { type: "gazParfait" }>;
    expect(spec.processus).toBe("adiabatique");
    expect(spec.facteurVariation).toBe(2);
  });

  it("circuit RLC", () => {
    const i = interpreter("décharge d'un circuit RLC avec une résistance de 10 ohms");
    expect(i!.spec.type).toBe("circuitRLC");
  });

  it("ODE fournie explicitement", () => {
    const i = interpreter("résous y' = -2*t*y avec y(0) = 1 jusqu'à t = 5 s");
    expect(i!.spec.type).toBe("ode");
    const spec = i!.spec as Extract<SpecSimulation, { type: "ode" }>;
    expect(spec.expression).toBe("-2*t*y");
    expect(spec.tFin).toBe(5);
  });

  it("racines d'une équation", () => {
    const i = interpreter("trouve les racines de x^2 - 9 = 0 entre -10 et 10");
    expect(i!.spec.type).toBe("racines");
  });

  it("intégrale", () => {
    const i = interpreter("calcule l'intégrale de sin(x) entre 0 et pi");
    expect(i!.spec.type).toBe("integrale");
  });

  it("chute avec parachute", () => {
    const i = interpreter("un parachutiste de 80 kg tombe depuis 4000 m");
    expect(i!.spec.type).toBe("chuteLibre");
  });

  it("orbites", () => {
    const i = interpreter("simule l'orbite de la lune autour de la terre");
    expect(i!.spec.type).toBe("nCorps");
  });

  it("quantique : boîte", () => {
    const i = interpreter("niveaux d'énergie d'un électron dans une boîte de 1 nm");
    expect(i!.spec.type).toBe("particuleBoite");
  });

  it("vidange (Torricelli)", () => {
    const i = interpreter("temps de vidange d'un réservoir de 2 m de haut avec un trou au fond");
    expect(i!.spec.type).toBe("torricelli");
  });

  it("renvoie null sans intention physique", () => {
    expect(interpreter("bonjour, comment vas-tu ?")).toBeNull();
    expect(interpreter("écris-moi un poème sur les chats")).toBeNull();
  });
});

describe("intention → univers — la chaîne complète fonctionne", () => {
  it("« lance un projectile » produit un résultat physique complet", () => {
    const i = interpreter("lance un projectile à 40 m/s avec un angle de 45 degrés");
    const resultat = simuler(i!.spec);
    expect(resultat.domaine).toBe("mecanique");
    expect(resultat.series.length).toBeGreaterThan(0);
    expect(resultat.scalaires.some((s) => s.nom === "Portée")).toBe(true);
    expect(resultat.dureeMs).toBeGreaterThanOrEqual(0);
  });

  it("« fentes de Young » produit un interfrange exact", () => {
    const i = interpreter("franges des fentes de Young avec longueur d'onde de 600 nm et fentes espacées de 0.1 mm");
    const resultat = simuler(i!.spec);
    expect(resultat.domaine).toBe("ondulaire");
    const interfrange = resultat.scalaires.find((s) => s.nom === "Interfrange")!.valeur;
    expect(interfrange).toBeCloseTo((600e-9 * 2) / 0.0001, 9);
  });

  it("« résous y' = -y » converge", () => {
    const i = interpreter("résous y' = -y avec y(0) = 2 jusqu'à t = 3 s");
    const resultat = simuler(i!.spec);
    expect(resultat.domaine).toBe("equations");
    const yFinal = resultat.scalaires.find((s) => s.nom === "y final")!.valeur;
    expect(yFinal).toBeCloseTo(2 * Math.exp(-3), 2);
  });
});

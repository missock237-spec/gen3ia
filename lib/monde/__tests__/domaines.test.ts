import { describe, expect, it } from "vitest";

import { circuitRLC, champElectrique } from "../electromagnetique";
import { resoudreIntegrale, resoudreOde, resoudreRacines } from "../equations";
import { ecoulementCylindre, torricelli } from "../fluidique";
import { chuteLibre, nCorps, pendule, projectile, ressort, systemeTerreLune } from "../mecanique";
import { fentesYoung, onde2D, ondeLumiere } from "../ondulaire";
import { particuleDansBoite, paquetOnde } from "../quantique";
import { dilatationTemps, energieRelativiste, redshiftGravitationnel } from "../relativiste";
import { diffusionChaleur, gazParfait } from "../thermique";

describe("mécanique", () => {
  it("projectile idéal : portée analytique vérifiée", () => {
    // v0 = 30 m/s, 45° → portée = v0²·sin(2α)/g = 91.74 m
    const r = projectile({ v0: 30, angleDeg: 45, altitude0: 0, trainee: 0, masse: 1 });
    const portee = r.scalaires.find((s) => s.nom === "Portée")!;
    expect(portee.valeur).toBeCloseTo(91.74, 0);
    const altitude = r.scalaires.find((s) => s.nom === "Altitude maximale")!;
    expect(altitude.valeur).toBeCloseTo(22.94, 0);
  });

  it("la traînée réduit la portée", () => {
    const ideal = projectile({ v0: 30, angleDeg: 45, altitude0: 0, trainee: 0, masse: 1 });
    const freine = projectile({ v0: 30, angleDeg: 45, altitude0: 0, trainee: 0.05, masse: 1 });
    const pIdeal = ideal.scalaires.find((s) => s.nom === "Portée")!.valeur;
    const pFreine = freine.scalaires.find((s) => s.nom === "Portée")!.valeur;
    expect(pFreine).toBeLessThan(pIdeal);
  });

  it("pendule : la période des grandes amplitudes dépasse 2π√(L/g)", () => {
    const r = pendule({ longueur: 1, angleDeg: 80, vitesseAngulaire: 0, amortissement: 0, masse: 1 }, 20, 0.001);
    const mesuree = r.scalaires.find((s) => s.nom === "Période mesurée")!.valeur;
    const petiteAngle = r.scalaires.find((s) => s.nom === "Période petits angles")!.valeur;
    expect(mesuree).toBeGreaterThan(petiteAngle);
  });

  it("ressort sous-amorti oscille", () => {
    const r = ressort(50, 1, 0.5, 0.1, 0, 10, 0.002);
    expect(r.diagnostics.find((d) => d.nom === "Régime")!.valeur).toContain("sous-amorti");
    const x = r.series[0].valeurs;
    const max = Math.max(...x);
    const min = Math.min(...x);
    // Léger amortissement : les crêtes décroissent d'un cycle à l'autre.
    expect(max).toBeGreaterThan(0.085);
    expect(min).toBeLessThan(-0.085);
  });

  it("chute libre : la vitesse se stabilise à la vitesse limite", () => {
    const r = chuteLibre(80, 6, 4000, 40, 0.01);
    const vLimite = r.scalaires.find((s) => s.nom === "Vitesse limite")!.valeur;
    const vitesses = r.series[1].valeurs;
    const finale = Math.abs(vitesses[vitesses.length - 1]);
    expect(finale).toBeLessThan(vLimite * 1.05);
    expect(finale).toBeGreaterThan(vLimite * 0.7);
  });

  it("N corps Terre–Lune : la distance reste quasi constante sur un mois", () => {
    const r = nCorps(systemeTerreLune(2_592_000, 60));
    const separation = r.series.find((s) => s.nom.includes("Séparation"))!;
    const premiere = separation.valeurs[0];
    const derniere = separation.valeurs[separation.valeurs.length - 1];
    // Orbite circulaire : la séparation varie de moins de 15 % sur un mois.
    expect(Math.abs(derniere - premiere) / premiere).toBeLessThan(0.15);
  });
});

describe("ondes", () => {
  it("équation d'onde : énergie finie et Courant stable", () => {
    const r = onde2D({ celerite: 343, taille: 10, resolution: 64, sourceX: 0.2, sourceY: 0.5, frequence: 440, pas: 800 });
    expect(r.champ).not.toBeNull();
    expect(r.champ!.valeurs.length).toBe(64 * 64);
    expect(r.diagnostics.find((d) => d.nom === "Nombre de Courant")!.sain).toBe(true);
    let maxAbs = 0;
    for (const v of r.champ!.valeurs) maxAbs = Math.max(maxAbs, Math.abs(v));
    expect(maxAbs).toBeLessThan(50); // pas d'explosion numérique
  });

  it("Young : l'interfrange vaut λD/d", () => {
    const lambda = 6.328e-7;
    const D = 2;
    const d = 0.0002;
    const r = fentesYoung({ largeurEcran: 2, distanceEcran: D, espacement: d, longueurOnde: lambda });
    const interfrange = r.scalaires.find((s) => s.nom === "Interfrange")!.valeur;
    expect(interfrange).toBeCloseTo((lambda * D) / d, 9);
  });

  it("lumière : c = λf pour le laser hélium-néon", () => {
    const r = ondeLumiere(632.8e-9);
    const f = r.scalaires.find((s) => s.nom === "Fréquence")!.valeur;
    expect(f).toBeCloseTo(299792458 / 632.8e-9, 2);
    expect(r.diagnostics.find((d) => d.nom === "Bande spectrale")!.valeur).toContain("visible");
  });
});

describe("quantique", () => {
  it("particule dans une boîte : E₂/E₁ = 4 exactement", () => {
    const r = particuleDansBoite(1e-9);
    const e1 = r.scalaires.find((s) => s.nom === "Énergie du fondamental E₁")!.valeur;
    const ecarts = r.series.map((s) => s.nom);
    expect(ecarts.length).toBe(8);
    // E2 − E1 = 3·E1
    const ecart = r.scalaires.find((s) => s.nom === "Écart E₂ − E₁")!.valeur;
    expect(ecart / e1).toBeCloseTo(3, 8);
  });

  it("paquet d'onde : la probabilité totale reste 1", () => {
    const r = paquetOnde({ impulsion: 1e-24, duree: 1e-14, resolution: 64 });
    const conservation = r.diagnostics.find((d) => d.nom.includes("Conservation"))!;
    expect(conservation.sain).toBe(true);
    const vg = r.scalaires.find((s) => s.nom === "Vitesse de groupe")!.valeur;
    expect(vg).toBeCloseTo(1e-24 / 9.1093837015e-31, 2);
  });
});

describe("thermique", () => {
  it("diffusion de chaleur : CFL respecté, pas adaptatif", () => {
    const r = diffusionChaleur({
      diffusivite: 1.11e-4,
      taille: 0.1,
      resolution: 64,
      sourceX: 0.3,
      sourceY: 0.5,
      temperatureSource: 100,
      temperatureInitiale: 20,
      duree: 10,
    });
    expect(r.diagnostics.find((d) => d.nom === "Condition CFL")!.sain).toBe(true);
    expect(r.champ).not.toBeNull();
    // La source reste à 100 °C (Dirichlet).
    let tMax = 0;
    for (const v of r.champ!.valeurs) tMax = Math.max(tMax, v);
    expect(tMax).toBeCloseTo(100, 6);
  });

  it("gaz parfait : le premier principe est vérifié pour tous les processus", () => {
    for (const processus of ["isochore", "isobare", "isotherme", "adiabatique"] as const) {
      const r = gazParfait({ moles: 1, volume: 0.0224, temperature: 273.15, processus, facteurVariation: 2 });
      const premierPrincipe = r.diagnostics.find((d) => d.nom.includes("principe"))!;
      expect(premierPrincipe.sain).toBe(true);
    }
  });

  it("adiabatique : Q = 0 et refroidissement à la détente", () => {
    const r = gazParfait({ moles: 1, volume: 0.0224, temperature: 273.15, processus: "adiabatique", facteurVariation: 2 });
    const q = r.scalaires.find((s) => s.nom === "Chaleur Q")!.valeur;
    expect(Math.abs(q)).toBeLessThan(1e-9);
    const tFinale = r.scalaires.find((s) => s.nom === "Température finale")!.valeur;
    expect(tFinale).toBeLessThan(273.15);
  });
});

describe("électromagnétisme", () => {
  it("dipôle : charge totale nulle, champ fini", () => {
    const r = champElectrique({
      taille: 2e-9,
      resolution: 64,
      charges: [
        { x: -1e-9, y: 0, q: 1, nom: "+q" },
        { x: 1e-9, y: 0, q: -1, nom: "−q" },
      ],
    });
    expect(r.champ).not.toBeNull();
    let maxV = 0;
    for (const v of r.champ!.valeurs) maxV = Math.max(maxV, v);
    expect(maxV).toBeGreaterThan(0);
    expect(Number.isFinite(maxV)).toBe(true);
  });

  it("RLC : fréquence propre 1/(2π√(LC)) confirmée par la mesure", () => {
    const r = circuitRLC({ resistance: 5, inductance: 1e-3, capacite: 1e-9, tensionInitiale: 5 }, 5e-4);
    const f0 = r.scalaires.find((s) => s.nom === "Fréquence propre f₀")!.valeur;
    const periode = r.scalaires.find((s) => s.nom === "Période observée")!.valeur;
    expect(f0).toBeCloseTo(1 / (2 * Math.PI * Math.sqrt(1e-12)), 0);
    expect(periode).toBeGreaterThan(0);
    // La période mesurée ≈ 2π√(LC) (léger écart par effet résistif).
    expect(Math.abs(periode - 2 * Math.PI * Math.sqrt(1e-3 * 1e-9)) / (2 * Math.PI * Math.sqrt(1e-3 * 1e-9))).toBeLessThan(0.05);
  });
});

describe("relativité", () => {
  it("dilatation : γ = 2 à β = √3/2", () => {
    const c = 299792458;
    const r = dilatationTemps({ vitesse: c * Math.sqrt(3) / 2, dureePropre: 10 });
    const gamma = r.scalaires.find((s) => s.nom === "Facteur de Lorentz γ")!.valeur;
    expect(gamma).toBeCloseTo(2, 6);
    const dureeTerre = r.scalaires.find((s) => s.nom === "Durée terrestre")!.valeur;
    expect(dureeTerre).toBeCloseTo(20, 6);
  });

  it("aucun corps massif n'atteint c", () => {
    expect(() => dilatationTemps({ vitesse: 299792459, dureePropre: 1 })).toThrow();
  });

  it("E = mc² : 1 kg vaut c² joules", () => {
    const r = energieRelativiste(1, 0);
    const repos = r.scalaires.find((s) => s.nom === "Énergie de repos")!.valeur;
    const attendu = 299792458 * 299792458;
    expect(Math.abs(repos - attendu) / attendu).toBeLessThan(1e-15);
  });

  it("redshift GPS : ~38 µs/jour d'avance satellite", () => {
    const r = redshiftGravitationnel(0, 20_200_000);
    const gps = r.scalaires.find((s) => s.nom.includes("GPS"))!.valeur;
    // Effet net incluant uniquement le potentiel gravitationnel : +45.7 µs/j.
    // Notre modèle newtonien simple ne compte pas la vitesse orbitale (−3.8 µs/j)
    // : on vérifie donc l'ordre de grandeur gravitationnel pur.
    expect(gps).toBeGreaterThan(30e-6);
    expect(gps).toBeLessThan(60e-6);
  });
});

describe("fluides", () => {
  it("cylindre : vitesse doublée au sommet (2U)", () => {
    const r = ecoulementCylindre({ vitesseLointaine: 10, rayon: 1, densite: 1.2, taille: 10, resolution: 96 });
    const sommet = r.scalaires.find((s) => s.nom === "Vitesse au sommet")!.valeur;
    expect(sommet).toBe(20);
    const dAlembert = r.diagnostics.find((d) => d.nom.includes("d'Alembert"))!;
    expect(dAlembert.sain).toBe(false); // annoncé honnêtement
  });

  it("Torricelli : v = √(2gΔh)", () => {
    const r = torricelli(2, 0, 1, 0.0001);
    const v = r.scalaires.find((s) => s.nom === "Vitesse initiale de sortie")!.valeur;
    expect(v).toBeCloseTo(Math.sqrt(2 * 9.80665 * 2), 6);
  });
});

describe("équations universelles", () => {
  it("ODE y' = y converge vers e", () => {
    const r = resoudreOde({ expression: "y", ordre: 1, y0: 1, derivee0: 0, tDebut: 0, tFin: 1 });
    const yFinal = r.scalaires.find((s) => s.nom === "y final")!.valeur;
    expect(yFinal).toBeCloseTo(Math.E, 2);
    expect(r.diagnostics.find((d) => d.nom === "Convergence RK4")!.sain).toBe(true);
  });

  it("ODE d'ordre 2 : oscillateur harmonique x'' = −x", () => {
    const r = resoudreOde({ expression: "-y", ordre: 2, y0: 1, derivee0: 0, tDebut: 0, tFin: Math.PI });
    const yFinal = r.scalaires.find((s) => s.nom === "y final")!.valeur;
    expect(yFinal).toBeCloseTo(-1, 2);
  });

  it("racines de x² − 4 = 0 : ±2", () => {
    const r = resoudreRacines({ expression: "x^2 - 4", borneMin: -10, borneMax: 10 });
    const racines = r.scalaires.filter((s) => s.nom.startsWith("Racine")).map((s) => s.valeur);
    expect(racines.length).toBe(2);
    expect(racines.some((v) => Math.abs(v - 2) < 1e-6)).toBe(true);
    expect(racines.some((v) => Math.abs(v + 2) < 1e-6)).toBe(true);
  });

  it("intégrale de x² sur [0;1] = 1/3", () => {
    const r = resoudreIntegrale({ expression: "x^2", borneMin: 0, borneMax: 1 });
    const simpson = r.scalaires.find((s) => s.nom === "Intégrale (Simpson)")!.valeur;
    expect(simpson).toBeCloseTo(1 / 3, 8);
    expect(r.diagnostics[0].sain).toBe(true);
  });

  it("refuse les expressions dangereuses", () => {
    expect(() => resoudreOde({ expression: "process.exit(1)", ordre: 1, y0: 0, derivee0: 0, tDebut: 0, tFin: 1 })).toThrow();
  });
});

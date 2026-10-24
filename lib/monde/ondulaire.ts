/**
 * Domaine ondulatoire — c'est le cœur battant du Monde : ici la
 * physique côtoie directement le moteur W-DNN de Gen3ia. La même
 * équation d'onde discrète qui propage la pensée dans le champ
 * d'oscillateurs propage aussi la lumière, le son, l'eau — le Monde
 * n'est qu'une extension naturelle du cerveau de l'IA.
 */

import { C_LUMIERE } from "./constantes";
import { laplacien2D } from "./solveurs";
import { borner, CAPS_MONDE, type Champ2D, type Diagnostic, type ResultatSimulation, type Serie } from "./types";

/** Paramètres de l'équation d'onde 2D. */
export interface ParamsOnde2D {
  /** Célérité de l'onde (m/s) — 343 = son dans l'air, 3e8 = lumière. */
  celerite: number;
  /** Taille du domaine (m). */
  taille: number;
  /** Nombre de cellules de la grille (≤ 128 côté serveur). */
  resolution: number;
  /** Position de la source (0..1, fractions du domaine). */
  sourceX: number;
  sourceY: number;
  /** Fréquence de la source (Hz). */
  frequence: number;
  /** Nombre de pas de simulation. */
  pas: number;
  /** Sources secondaires (interférences) — optionnelles. */
  sourceSecondaire?: { x: number; y: number };
  /** Amortissement (0.9–1.0, 1 = sans pertes). */
  amortissement?: number;
}

/**
 * Équation d'onde 2D par différences finies explicites :
 *   u(t+1) = 2u(t) − u(t−1) + (c·Δt/Δx)²·∇²u(t)
 * Schéma stable tant que le nombre de Courant c·Δt/Δx ≤ 1/√2 en 2D.
 * C'est EXACTEMENT le schéma du shader WGSL du moteur W-DNN.
 */
export function onde2D(p: ParamsOnde2D): ResultatSimulation {
  const debut = performance.now();
  const n = borner(Math.round(p.resolution), 16, CAPS_MONDE.grilleMax);
  const dx = p.taille / n;
  // Nombre de Courant cible : 0.5 (marge de stabilité).
  const dt = (0.5 * dx) / Math.max(1e-9, p.celerite);
  const c2 = Math.pow((p.celerite * dt) / dx, 2);
  const amortissement = borner(p.amortissement ?? 0.998, 0.9, 1);

  let courant = new Float64Array(n * n);
  let passe = new Float64Array(n * n);
  let suivant = new Float64Array(n * n);

  const sx = Math.floor(borner(p.sourceX, 0, 1) * (n - 1));
  const sy = Math.floor(borner(p.sourceY, 0, 1) * (n - 1));
  const omega = 2 * Math.PI * p.frequence;
  const s2 = p.sourceSecondaire
    ? {
        x: Math.floor(borner(p.sourceSecondaire.x, 0, 1) * (n - 1)),
        y: Math.floor(borner(p.sourceSecondaire.y, 0, 1) * (n - 1)),
      }
    : null;

  const total = borner(Math.round(p.pas), 10, CAPS_MONDE.pasMax);
  const laplacien = new Float64Array(n * n);
  const energieSeries: number[] = [];
  const tempsSeries: number[] = [];

  for (let k = 0; k < total; k++) {
    // Source sinusoïdale injectée au point choisi.
    courant[sy * n + sx] = 4 * Math.sin(omega * k * dt);
    if (s2) courant[s2.y * n + s2.x] = 4 * Math.sin(omega * k * dt);

    laplacien2D(courant, n, n, laplacien);
    for (let i = 0; i < courant.length; i++) {
      suivant[i] = (2 * courant[i] - passe[i] + c2 * laplacien[i]) * amortissement;
    }
    // Bords absorbants (condition de Dirichlet douce).
    for (let i = 0; i < n; i++) {
      suivant[i] = 0;
      suivant[(n - 1) * n + i] = 0;
      suivant[i * n] = 0;
      suivant[i * n + n - 1] = 0;
    }
    const echange = passe;
    passe = courant;
    courant = suivant;
    suivant = echange;

    if (k % Math.max(1, Math.floor(total / 256)) === 0) {
      let energie = 0;
      for (let i = 0; i < courant.length; i++) energie += courant[i] * courant[i];
      energieSeries.push(Math.sqrt(energie / courant.length));
      tempsSeries.push(k * dt);
    }
  }

  const champ: Champ2D = {
    largeur: n,
    hauteur: n,
    valeurs: courant.slice(),
    unite: "m",
    nom: "Amplitude de l'onde",
  };

  const nombreCourant = (p.celerite * dt) / dx;
  const diagnostics: Diagnostic[] = [
    {
      nom: "Nombre de Courant",
      valeur: `${nombreCourant.toFixed(3)} (stabilité ≤ 0,707 en 2D)`,
      sain: nombreCourant <= 0.7071,
    },
    {
      nom: "Schéma",
      valeur: "différences finies explicites — identique au shader WGSL du W-DNN",
      sain: true,
    },
  ];

  const series: Serie[] = [
    {
      nom: "Énergie du champ RMS",
      abscisses: tempsSeries,
      valeurs: energieSeries,
      unite: "m",
      couleur: "#2AD4E8",
    },
  ];

  const lamba = p.celerite / Math.max(1e-9, p.frequence);
  return {
    domaine: "ondulaire",
    modele: "Équation d'onde 2D (différences finies, schéma explicite)",
    titre: s2 ? "Interférence de deux sources" : "Propagation d'une onde",
    explication: s2
      ? "Deux sources cohérentes émettent la même fréquence : là où les crêtes se rencontrent l'onde s'amplifie (franges constructives), là où une crête rencontre un creux elle s'annule (franges destructives). La carte de chaleur montre ce motif d'interférence — la même physique que les fentes de Young."
      : "La source vibre à la fréquence choisie et le perturbation se propage à la célérité c : son, lumière ou vague, l'équation est la même. La carte de chaleur montre l'amplitude instantanée sur tout le domaine ; la courbe suit l'énergie totale du champ.",
    equations: [
      "∂²u/∂t² = c²·∇²u",
      "uⁿ⁺¹ = 2uⁿ − uⁿ⁻¹ + (c·Δt/Δx)²·∇²uⁿ",
      "λ = c / f",
    ],
    series,
    champ,
    scalaires: [
      { nom: "Longueur d'onde", valeur: lamba, unite: "m", note: "λ = c/f" },
      { nom: "Période", valeur: 1 / Math.max(1e-9, p.frequence), unite: "s", note: "T = 1/f" },
      { nom: "Pas de temps", valeur: dt, unite: "s", note: "imposé par la condition CFL" },
    ],
    diagnostics,
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Paramètres des fentes de Young. */
export interface ParamsYoung {
  /** Largeur de l'écran observé (m). */
  largeurEcran: number;
  /** Distance fentes → écran (m). */
  distanceEcran: number;
  /** Espacement des fentes (m). */
  espacement: number;
  /** Longueur d'onde (m). */
  longueurOnde: number;
}

/**
 * Fentes de Young — solution analytique exacte de l'intensité sur
 * l'écran : I ∝ cos²(π·d·sinθ/λ)·sinc²(π·a·sinθ/λ).
 */
export function fentesYoung(p: ParamsYoung): ResultatSimulation {
  const debut = performance.now();
  const points = 512;
  const abscisses: number[] = [];
  const intensite: number[] = [];
  const enveloppe: number[] = [];
  for (let i = 0; i < points; i++) {
    const x = -p.largeurEcran / 2 + (p.largeurEcran * i) / (points - 1);
    const theta = Math.atan2(x, p.distanceEcran);
    const phase = (Math.PI * p.espacement * Math.sin(theta)) / p.longueurOnde;
    const a = 0.05 * p.espacement; // largeur de fente = 5 % de l'espacement
    const phaseA = (Math.PI * a * Math.sin(theta)) / p.longueurOnde;
    const sinc = phaseA === 0 ? 1 : Math.sin(phaseA) / phaseA;
    abscisses.push(x);
    intensite.push(Math.pow(Math.cos(phase), 2) * Math.pow(sinc, 2));
    enveloppe.push(Math.pow(sinc, 2));
  }
  const interfrange = (p.longueurOnde * p.distanceEcran) / p.espacement;
  return {
    domaine: "ondulaire",
    modele: "Fentes de Young (solution analytique)",
    titre: "Interférence lumineuse sur un écran",
    explication:
      "Deux fentes séparées de d éclairent un écran lointain. L'onde qui arrive des deux fentes parcourt des distances différentes : si la différence vaut un nombre entier de longueurs d'onde, les ondes s'ajoutent (frange brillante) ; à une demi-longueur d'onde, elles s'annulent (frange sombre). Le Monde trace l'intensité exacte et mesure l'interfrange.",
    equations: [
      "I(x) ∝ cos²(π·d·sinθ/λ) · sinc²(π·a·sinθ/λ)",
      "Δfranges = λ·D/d",
    ],
    series: [
      { nom: "Intensité lumineuse", abscisses, valeurs: intensite, unite: "u.a.", couleur: "#7C5CFF" },
      { nom: "Enveloppe de diffraction", abscisses, valeurs: enveloppe, unite: "u.a.", couleur: "#9E85FF" },
    ],
    champ: null,
    scalaires: [
      {
        nom: "Interfrange",
        valeur: interfrange,
        unite: "m",
        note: "distance entre deux franges brillantes",
      },
      {
        nom: "Franges visibles",
        valeur: Math.floor(p.largeurEcran / Math.max(1e-9, interfrange)),
        unite: "franges",
        note: "dans la largeur d'écran simulée",
      },
    ],
    diagnostics: [
      { nom: "Solution", valeur: "analytique exacte — aucune erreur numérique", sain: true },
      {
        nom: "Régime",
        valeur: p.distanceEcran > 10 * p.espacement ? "champ lointain (Fraunhofer) ✓" : "champ proche — modèle approché",
        sain: p.distanceEcran > 10 * p.espacement,
      },
    ],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Onde électromagnétique dans le vide (lumière) : aide-mémoire. */
export function ondeLumiere(longueurOndeM: number): ResultatSimulation {
  const debut = performance.now();
  const f = C_LUMIERE / longueurOndeM;
  const bande =
    longueurOndeM < 1e-9
      ? "rayons X"
      : longueurOndeM < 4e-7
        ? "ultraviolet"
        : longueurOndeM < 7e-7
          ? "lumière visible"
          : longueurOndeM < 1e-3
            ? "infrarouge"
            : "ondes radio";
  const abscisses: number[] = [];
  const champ: number[] = [];
  const points = 256;
  const periodes = 3;
  for (let i = 0; i < points; i++) {
    const t = (periodes / Math.max(1e-9, f)) * (i / (points - 1));
    abscisses.push(t * 1e15); // femtosecondes
    champ.push(Math.sin(2 * Math.PI * f * t));
  }
  return {
    domaine: "ondulaire",
    modele: "Onde plane électromagnétique",
    titre: "Lumière — onde électromagnétique",
    explication:
      "Dans le vide, toute onde électromagnétique voyage exactement à c. Sa fréquence f = c/λ décide de sa nature : invisible sous 400 nm (UV), visible entre 400 et 700 nm, infrarouge au-delà. Le Monde trace trois périodes de l'onde et la classe dans le spectre.",
    equations: ["c = λ·f", "E = h·f (photon)"],
    series: [
      { nom: "Champ E (t)", abscisses, valeurs: champ, unite: "fs", couleur: "#7C5CFF" },
    ],
    champ: null,
    scalaires: [
      { nom: "Fréquence", valeur: f, unite: "Hz", note: "f = c/λ" },
      { nom: "Énergie du photon", valeur: (6.62607015e-34 * f) / 1.602176634e-19, unite: "eV", note: "E = h·f" },
    ],
    diagnostics: [{ nom: "Bande spectrale", valeur: bande, sain: true }],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

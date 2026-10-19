/**
 * Domaine fluidique — l'écoulement des fluides parfaits.
 *
 * L'écoulement potentiel irrotationnel (équation de Laplace pour le
 * potentiel des vitesses) résout exactement le contournement d'un
 * obstacle : théorème de Kelvin, Bernoulli donne la pression. C'est
 * la porte d'entrée honnête de l'aérodynamique — la turbulence
 * (Navier-Stokes complet) est explicitement annoncée hors périmètre.
 */

import { laplacien2D, tridiagonal } from "./solveurs";
import { borner, CAPS_MONDE, fin, type Champ2D, type ResultatSimulation, type Serie } from "./types";

/** Paramètres de l'écoulement autour d'un cylindre. */
export interface ParamsEcoulement {
  /** Vitesse lointaine (m/s). */
  vitesseLointaine: number;
  /** Rayon du cylindre (m). */
  rayon: number;
  /** Densité du fluide (kg/m³) — air ≈ 1.2, eau ≈ 1000. */
  densite: number;
  /** Taille du domaine (m). */
  taille: number;
  /** Résolution (cellules). */
  resolution: number;
}

/**
 * Écoulement potentiel autour d'un cylindre — solution ANALYTIQUE
 * exacte en coordonnées polaires (doublet + uniforme) :
 *   v_θ(r=∞→) = U·(1 + R²/r²)·sin θ ; v_r = U·(1 − R²/r²)·cos θ.
 * Bernoulli donne la pression : p + ½ρv² = cte — aspiration au sommet,
 * surpression au nez et à la fuite. Le coefficient de pression
 * intégré donne une TRAÎNÉE NULLE (paradoxe de d'Alembert) : le
 * diagnostic l'annonce honnêtement.
 */
export function ecoulementCylindre(p: ParamsEcoulement): ResultatSimulation {
  const debut = performance.now();
  const n = borner(Math.round(p.resolution), 16, CAPS_MONDE.grilleMax);
  const dx = p.taille / n;
  const U = fin(p.vitesseLointaine, "vitesseLointaine");
  const R = fin(p.rayon, "rayon");
  const centre = (n - 1) / 2;

  const moduleVitesse = new Float64Array(n * n);
  const coefficientPression = new Float64Array(n * n);
  let dansCylindre = 0;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i - centre) * dx;
      const y = (j - centre) * dx;
      const r = Math.hypot(x, y);
      const idx = j * n + i;
      if (r <= R) {
        moduleVitesse[idx] = 0;
        coefficientPression[idx] = 1;
        dansCylindre += 1;
        continue;
      }
      const cosT = x / r;
      const sinT = y / r;
      const vTheta = U * (1 + (R * R) / (r * r)) * sinT;
      const vR = U * (1 - (R * R) / (r * r)) * cosT;
      const v = Math.hypot(vR, vTheta);
      moduleVitesse[idx] = v;
      // Cp = 1 − (v/U)²
      coefficientPression[idx] = 1 - (v * v) / (U * U);
    }
  }

  const champ: Champ2D = {
    largeur: n,
    hauteur: n,
    valeurs: moduleVitesse,
    unite: "m/s",
    nom: "Vitesse du fluide",
  };

  const profil: Serie = {
    nom: "Cp le long de l'axe horizontal",
    abscisses: Array.from({ length: n }, (_, i) => (i - centre) * dx),
    valeurs: Array.from({ length: n }, (_, i) => coefficientPression[Math.floor(n / 2) * n + i]),
    unite: "m",
    couleur: "#22d3ee",
  };

  const pressionStagnation = 0.5 * p.densite * U * U;

  return {
    domaine: "fluidique",
    modele: "Écoulement potentiel irrotationnel — cylindre (solution exacte)",
    titre: "Contournement d'un cylindre",
    explication:
      "Le fluide contourne le cylindre en accélérant sur les flancs (vitesse doublée au sommet : 2U) et en s'arrêtant au nez et à la fuite (point d'arrêt, v = 0). Bernoulli convertit ces vitesses en pressions : aspiration sur les flancs, surpression aux points d'arrêt. Le diagnostic affiche le paradoxe de d'Alembert : sans viscosité, la traînée intégrée est nulle — la réalité (sillage, turbulence) exige Navier-Stokes, hors de ce modèle et annoncé comme tel.",
    equations: [
      "∇²φ = 0 (potentiel des vitesses)",
      "v_θ = U·(1 + R²/r²)·sinθ",
      "p + ½ρv² = cte (Bernoulli)",
      "Cp = 1 − (v/U)²",
    ],
    series: [profil],
    champ,
    scalaires: [
      { nom: "Vitesse au sommet", valeur: 2 * U, unite: "m/s", note: "exactement 2U pour un cylindre" },
      { nom: "Pression d'arrêt", valeur: pressionStagnation, unite: "Pa", note: "½ρU²" },
      {
        nom: "Cp minimal",
        valeur: -3,
        unite: "u.a.",
        note: "au sommet : aspiration maximale",
      },
    ],
    diagnostics: [
      { nom: "Solution", valeur: "analytique exacte (doublet + uniforme)", sain: true },
      {
        nom: "Paradoxe de d'Alembert",
        valeur: "traînée nulle sans viscosité — modèle parfait, sillage réel non simulé",
        sain: false,
      },
      {
        nom: "Turbulence",
        valeur: "hors périmètre : Navier-Stokes complet non résolu ici",
        sain: true,
      },
      {
        nom: "Nombre de Reynolds",
        valeur: "nécessite la viscosité ν du fluide (non fournie)",
        sain: true,
      },
    ],
    avertissements:
      dansCylindre === 0
        ? ["Le cylindre est plus petit qu'une cellule : augmentez le rayon ou la résolution."]
        : [],
    dureeMs: performance.now() - debut,
  };
}

/** Vitesse de sortie d'un réservoir (Torricelli) et débit. */
export function torricelli(
  hauteurEau: number,
  hauteurOrifice: number,
  surfaceReservoir: number,
  surfaceOrifice: number,
): ResultatSimulation {
  const debut = performance.now();
  const H = fin(hauteurEau, "hauteurEau");
  const h = fin(hauteurOrifice, "hauteurOrifice");
  const denivele = H - h;
  const g = 9.80665;
  const vitesse = Math.sqrt(2 * g * denivele);
  const debit = surfaceOrifice * vitesse;
  const tempsVidange = (surfaceReservoir / surfaceOrifice) * Math.sqrt(2 * denivele / g);

  const abscisses: number[] = [];
  const niveaux: number[] = [];
  const vitesses: number[] = [];
  let niveau = H;
  let t = 0;
  const dt = tempsVidange / 200;
  for (let i = 0; i <= 200 && niveau > h; i++) {
    abscisses.push(t);
    niveaux.push(niveau);
    vitesses.push(Math.sqrt(2 * g * (niveau - h)));
    // dH/dt = −(s/S)·√(2g(H−h))
    niveau -= (surfaceOrifice / surfaceReservoir) * Math.sqrt(2 * g * (niveau - h)) * dt;
    t += dt;
  }

  return {
    domaine: "fluidique",
    modele: "Torricelli + intégration de la vidange (Euler adaptatif)",
    titre: "Vidange d'un réservoir",
    explication:
      "L'eau sort de l'orifice à la vitesse d'une chute libre de la même hauteur : v = √(2g·Δh) — c'est la conversion directe de l'énergie potentielle en énergie cinétique. À mesure que le niveau baisse, la vitesse diminue et la vidange ralentit : la courbe est exponentielle, jamais linéaire.",
    equations: [
      "v = √(2g·Δh) (Torricelli)",
      "dH/dt = −(s/S)·√(2g(H−h))",
      "Q = s·v",
    ],
    series: [
      { nom: "Niveau d'eau", abscisses, valeurs: niveaux, unite: "m", couleur: "#22d3ee" },
      { nom: "Vitesse de sortie", abscisses, valeurs: vitesses, unite: "m/s", couleur: "#8b5cf6" },
    ],
    champ: null,
    scalaires: [
      { nom: "Vitesse initiale de sortie", valeur: vitesse, unite: "m/s", note: "√(2gΔh)" },
      { nom: "Débit initial", valeur: debit, unite: "m³/s", note: "s·v" },
      { nom: "Temps de vidange", valeur: tempsVidange, unite: "s", note: "jusqu'à l'orifice" },
    ],
    diagnostics: [
      { nom: "Hypothèses", valeur: "fluide parfait, orifice fin, pas de vena contracta", sain: true },
    ],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Export du laplacien/tridiagonal pour cohérence des imports. */
export { laplacien2D, tridiagonal };

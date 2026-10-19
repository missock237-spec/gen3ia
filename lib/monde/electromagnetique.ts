/**
 * Domaine électromagnétique — les champs et les circuits.
 *
 *  - Champ électrique de charges ponctuelles : superposition exacte de
 *    la loi de Coulomb, cartographiée sur grille (lignes de champ
 *    visibles dans l'interface) ;
 *  - Circuit RLC série : oscillation amortie résolue par RK4, régime
 *    identifié (sous/critique/sur-amorti).
 */

import { E_CHARGE, EPSILON0 } from "./constantes";
import { integrerRk4, type SecondMembre } from "./solveurs";
import { borner, CAPS_MONDE, fin, type Champ2D, type Diagnostic, type ResultatSimulation, type Serie } from "./types";

/** Une charge ponctuelle. */
export interface ChargePonctuelle {
  /** Position (m). */
  x: number;
  y: number;
  /** Charge en multiples de e (négatif = électron). */
  q: number;
  nom: string;
}

/** Paramètres du champ électrostatique. */
export interface ParamsChampE {
  /** Taille du domaine (m) — typiquement 1e-9 (nanomètre). */
  taille: number;
  /** Résolution de la carte (cellules). */
  resolution: number;
  charges: ChargePonctuelle[];
}

/**
 * Champ électrostatique par superposition de Coulomb :
 * E = Σ qᵢ·(r − rᵢ)/(4πε₀·|r − rᵢ|³). Carte de |E| sur la grille,
 * potentiel V calculé en parallèle. Deux charges opposées donnent le
 * dipôle classique — visible immédiatement dans la carte de chaleur.
 */
export function champElectrique(p: ParamsChampE): ResultatSimulation {
  const debut = performance.now();
  const n = borner(Math.round(p.resolution), 16, CAPS_MONDE.grilleMax);
  const dx = p.taille / n;
  const charges = p.charges.slice(0, 12);
  if (charges.length === 0) throw new Error("Au moins une charge est requise.");

  const champNorme = new Float64Array(n * n);
  const potentiel = new Float64Array(n * n);
  const k = 1 / (4 * Math.PI * EPSILON0);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * dx;
      const y = j * dx;
      let ex = 0;
      let ey = 0;
      let v = 0;
      for (const c of charges) {
        const ddx = x - c.x;
        const ddy = y - c.y;
        const r2 = ddx * ddx + ddy * ddy;
        const r = Math.sqrt(r2);
        if (r < dx * 0.5) continue; // évite la singularité sur la charge elle-même
        const q = c.q * E_CHARGE;
        const facteur = (k * q) / (r2 * r);
        ex += facteur * ddx;
        ey += facteur * ddy;
        v += (k * q) / r;
      }
      champNorme[j * n + i] = Math.hypot(ex, ey);
      potentiel[j * n + i] = v;
    }
  }

  const chargeTotale = charges.reduce((s, c) => s + c.q, 0);
  const champ: Champ2D = {
    largeur: n,
    hauteur: n,
    valeurs: champNorme,
    unite: "V/m",
    nom: "Intensité du champ |E|",
  };

  const series: Serie[] = [
    {
      nom: "Profil du champ le long de l'axe médian",
      abscisses: Array.from({ length: n }, (_, i) => i * dx),
      valeurs: Array.from({ length: n }, (_, i) => champNorme[Math.floor(n / 2) * n + i]),
      unite: "V/m",
      couleur: "#8b5cf6",
    },
  ];

  const diagnostics: Diagnostic[] = [
    { nom: "Principe", valeur: "superposition exacte de Coulomb — aucune approximation", sain: true },
    {
      nom: "Système de charges",
      valeur:
        chargeTotale === 0
          ? "neutre (dipôle ou multipôle)"
          : chargeTotale > 0
            ? "charge nette positive"
            : "charge nette négative",
      sain: true,
    },
  ];

  return {
    domaine: "electromagnetique",
    modele: "Électrostatique de Coulomb (superposition exacte)",
    titre: "Champ électrique de charges ponctuelles",
    explication:
      "Chaque charge crée autour d'elle un champ radial dont l'intensité décroît comme le carré de la distance (loi de Coulomb). Le champ total est la SOMME vectorielle des champs individuels — c'est le principe de superposition. La carte de chaleur montre |E| ; pour un dipôle (+q, −q), les lignes de champ ferment des boucles caractéristiques.",
    equations: [
      "E = Σᵢ qᵢ·(r−rᵢ)/(4πε₀·|r−rᵢ|³)",
      "V = Σᵢ qᵢ/(4πε₀·|r−rᵢ|)",
    ],
    series,
    champ,
    scalaires: [
      {
        nom: "Champ maximal",
        valeur: Math.max(...champNorme),
        unite: "V/m",
        note: "au plus près des charges",
      },
      {
        nom: "Charge totale",
        valeur: chargeTotale * E_CHARGE,
        unite: "C",
        note: `${chargeTotale.toFixed(1)} e`,
      },
    ],
    diagnostics,
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Paramètres du circuit RLC série. */
export interface ParamsRLC {
  resistance: number; // ohms
  inductance: number; // henrys
  capacite: number; // farads
  /** Tension initiale du condensateur (V). */
  tensionInitiale: number;
}

/**
 * Circuit RLC série sans source : L·q'' + R·q' + q/C = 0. RK4 sur
 * [q, i]. Le régime dépend du rapport R/(2L) vs ω₀ = 1/√(LC) — le
 * même discriminant que le ressort amorti : la physique est une.
 */
export function circuitRLC(p: ParamsRLC, duree = 1e-3): ResultatSimulation {
  const debut = performance.now();
  fin(p.resistance, "resistance");
  fin(p.inductance, "inductance");
  fin(p.capacite, "capacite");
  const omega0 = 1 / Math.sqrt(p.inductance * p.capacite);
  const facteur = p.resistance / (2 * p.inductance);
  const regime =
    facteur < omega0 * 0.99
      ? "sous-amorti (oscillations)"
      : facteur < omega0 * 1.01
        ? "critique"
        : "sur-amorti";
  // Pas adaptatif : le circuit oscille typiquement à MHz.
  const pas = Math.min(1e-7, (0.1 / omega0));
  const f: SecondMembre = (_t, y) => [
    y[1],
    -(p.resistance / p.inductance) * y[1] - y[0] / (p.inductance * p.capacite),
  ];
  const res = integrerRk4(f, [p.tensionInitiale * p.capacite, 0], 0, duree, pas, 512);
  const tension = res.series.map((s) => s[0] / p.capacite);
  const courant = res.series.map((s) => s[1]);

  // Fréquence oscillante observée (passages à zéro du courant).
  let periodeMesuree = NaN;
  let dernierZero = -1;
  for (let i = 1; i < res.t.length; i++) {
    if (courant[i - 1] < 0 && courant[i] >= 0) {
      if (dernierZero >= 0) periodeMesuree = res.t[i] - dernierZero;
      dernierZero = res.t[i];
    }
  }

  return {
    domaine: "electromagnetique",
    modele: "Circuit RLC série libre (RK4)",
    titre: "Circuit RLC — oscillation électrique amortie",
    explication:
      "L'énergie oscille entre le champ magnétique de la bobine et le champ électrique du condensateur, pendant que la résistance la dissipe en chaleur. C'est l'EXACT analogue mécanique du ressort amorti : L ↔ masse, 1/C ↔ raideur, R ↔ frottement. La fréquence d'oscillation f₀ = 1/(2π√(LC)) est la base de tous les émetteurs radio.",
    equations: [
      "L·q'' + R·q' + q/C = 0",
      "ω₀ = 1/√(L·C)",
      "ρ = R/(2L) décide du régime",
    ],
    series: [
      { nom: "Tension condensateur u(t)", abscisses: res.t, valeurs: tension, unite: "V", couleur: "#8b5cf6" },
      { nom: "Courant i(t)", abscisses: res.t, valeurs: courant, unite: "A", couleur: "#22d3ee" },
    ],
    champ: null,
    scalaires: [
      { nom: "Fréquence propre f₀", valeur: omega0 / (2 * Math.PI), unite: "Hz", note: "1/(2π√(LC))" },
      {
        nom: "Période observée",
        valeur: periodeMesuree,
        unite: "s",
        note: "mesurée sur les passages à zéro",
      },
      { nom: "Facteur de qualité Q", valeur: (1 / p.resistance) * Math.sqrt(p.inductance / p.capacite), unite: "u.a.", note: "Q = (1/R)·√(L/C)" },
    ],
    diagnostics: [
      { nom: "Régime", valeur: regime, sain: true },
      {
        nom: "Intégration",
        valeur: `${res.pas.toLocaleString("fr-FR")} pas de ${(pas * 1e9).toFixed(1)} ns`,
        sain: true,
      },
    ],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

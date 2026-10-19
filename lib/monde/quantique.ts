/**
 * Domaine quantique — quand la physique devient ondulatoire et
 * probabiliste. Le Monde résout l'équation de Schrödinger dépendante
 * du temps (méthode de Crank-Nicolson, inconditionnellement stable) et
 * les états stationnaires exacts (particule confinée).
 */

import { H_BARRE, M_ELECTRON } from "./constantes";
import { borner, CAPS_MONDE, fin, type ResultatSimulation, type Serie } from "./types";

/**
 * Particule dans un puits infini — les énergies d'un confinement 1D
 * sont EXACTES : Eₙ = n²π²ħ²/(2mL²). La numérotation quantique n=1,2,3…
 * émerge toute seule de la condition aux limites ψ(0)=ψ(L)=0.
 */
export function particuleDansBoite(
  longueurBoite: number,
  masse = M_ELECTRON,
  niveaux = 8,
): ResultatSimulation {
  const debut = performance.now();
  const L = fin(longueurBoite, "longueurBoite");
  const m = fin(masse, "masse");
  const nb = borner(Math.round(niveaux), 3, 16);

  const energies: number[] = [];
  const series: Serie[] = [];
  const points = 256;
  const couleurs = ["#8b5cf6", "#22d3ee", "#f59e0b", "#34d399", "#f472b6", "#60a5fa", "#fb7185", "#a3e635"];

  for (let n = 1; n <= nb; n++) {
    const e = (n * n * Math.PI * Math.PI * H_BARRE * H_BARRE) / (2 * m * L * L);
    energies.push(e);
    const psi: number[] = [];
    for (let i = 0; i < points; i++) {
      const x = (L * i) / (points - 1);
      psi.push(Math.sqrt(2 / L) * Math.sin((n * Math.PI * x) / L));
    }
    series.push({
      nom: `ψ${n} (Eₙ = ${e.toExponential(2)} J)`,
      abscisses: Array.from({ length: points }, (_, i) => (L * i) / (points - 1)),
      valeurs: psi,
      unite: "m⁻¹ᐟ²",
      couleur: couleurs[(n - 1) % couleurs.length],
    });
  }

  return {
    domaine: "quantique",
    modele: "Puits de potentiel infini 1D (états propres exacts)",
    titre: "Particule confinée — quantification de l'énergie",
    explication:
      "Confiner une particule la force à des états d'énergie DISCRETS : Eₙ ∝ n². Une particule plus confinée (boîte plus petite) ou plus légère a des niveaux très espacés — c'est pourquoi les effets quantiques dominent à l'échelle atomique. Les fonctions d'onde tracées sont les états stationnaires exacts.",
    equations: [
      "ψₙ(x) = √(2/L)·sin(nπx/L)",
      "Eₙ = n²·π²·ħ²/(2m·L²)",
    ],
    series,
    champ: null,
    scalaires: [
      {
        nom: "Énergie du fondamental E₁",
        valeur: energies[0],
        unite: "J",
        note: `${((energies[0] / 1.602176634e-19).toExponential(3))} eV`,
      },
      {
        nom: "Écart E₂ − E₁",
        valeur: energies[1] - energies[0],
        unite: "J",
        note: "énergie du premier photon absorbable",
      },
    ],
    diagnostics: [
      { nom: "Solution", valeur: "analytique exacte — aucune erreur numérique", sain: true },
      { nom: "Niveaux calculés", valeur: `${nb}`, sain: true },
    ],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Paramètres de l'évolution de Schrödinger 1D. */
export interface ParamsSchrödinger {
  /** Largeur du domaine simulé (m) — typiquement 1e-9 à 1e-8. Défaut : 1e-8. */
  largeur?: number;
  /** Position initiale du paquet d'onde (fraction 0..1). Défaut : 0.3. */
  positionInitiale?: number;
  /** Impulsion initiale (kg·m/s). */
  impulsion: number;
  /** Largeur initiale du paquet gaussien (m). Défaut : 1e-9. */
  largeurPaquet?: number;
  /** Durée de l'évolution (s) — typiquement 1e-15 à 1e-14. */
  duree: number;
  /** Résolution spatiale (cellules). Défaut : 96. */
  resolution?: number;
}

/**
 * Paquet d'onde gaussien libre — équation de Schrödinger dépendante du
 * temps iħ·∂ψ/∂t = −ħ²/2m·∂²ψ/∂x², résolue par Crank-Nicolson
 * (schéma implicite inconditionnellement stable). Diagnostic : la
 * NORME de ψ doit se conserver (probabilité totale = 1).
 */
export function paquetOnde(p: ParamsSchrödinger): ResultatSimulation {
  const debut = performance.now();
  const n = borner(Math.round(p.resolution ?? 96), 32, CAPS_MONDE.grilleMax);
  const largeurDomaine = fin(p.largeur ?? 1e-8, "largeur");
  const dx = largeurDomaine / n;
  const m = M_ELECTRON;
  const x0 = borner(p.positionInitiale ?? 0.3, 0.1, 0.9) * largeurDomaine;
  const sigma = Math.max(p.largeurPaquet ?? 1e-9, 2 * dx);
  const duree = borner(fin(p.duree, "duree"), 1e-18, 1e-12);

  // Paquet gaussien initial ψ(x,0) = exp(-(x-x0)²/2σ²)·e^{ikx}
  const psiRe = new Array<number>(n);
  const psiIm = new Array<number>(n);
  const k0 = p.impulsion / H_BARRE;
  for (let i = 0; i < n; i++) {
    const x = i * dx;
    const gaussien = Math.exp(-Math.pow(x - x0, 2) / (2 * sigma * sigma));
    psiRe[i] = gaussien * Math.cos(k0 * x);
    psiIm[i] = gaussien * Math.sin(k0 * x);
  }
  // Normalisation de la probabilité à 1.
  let norme = 0;
  for (let i = 0; i < n; i++) norme += (psiRe[i] * psiRe[i] + psiIm[i] * psiIm[i]) * dx;
  const facteur = 1 / Math.sqrt(Math.max(1e-300, norme));
  for (let i = 0; i < n; i++) {
    psiRe[i] *= facteur;
    psiIm[i] *= facteur;
  }

  // Crank-Nicolson : (I + i·γ·H)·ψⁿ⁺¹ = (I − i·γ·H)·ψⁿ, γ = Δt/(2ħ),
  // H = α·(différence seconde) avec α = ħ²/(2m·Δx²). Système tridiagonal
  // COMPLEXE résolu par l'algorithme de Thomas généralisé aux complexes.
  const alpha = (H_BARRE * H_BARRE) / (2 * m * dx * dx);
  const dt = duree / 200;
  const gamma = dt / (2 * H_BARRE);
  // Coefficients complexes du système. Hψ_i = α·(2ψ_i − ψ_{i−1} − ψ_{i+1})
  // (diagonale +2α, voisins −α) → (I + iγH) : diagonale 1 + 2iγα, voisins −iγα.
  const diagRe = 1;
  const diagIm = 2 * gamma * alpha;
  const voisinRe = 0;
  const voisinIm = -gamma * alpha;

  // Arithmétique complexe locale (paires [re, im]).
  const cmul = (a: number[], b: number[]): number[] => [
    a[0] * b[0] - a[1] * b[1],
    a[0] * b[1] + a[1] * b[0],
  ];
  const cdiv = (a: number[], b: number[]): number[] => {
    const d = b[0] * b[0] + b[1] * b[1];
    return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
  };
  const csub = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1]];

  /** Thomas complexe : résout (A)·x = d pour un système tridiagonal. */
  const thomasComplexe = (
    sousC: number[][],
    diagC: number[][],
    surC: number[][],
    dC: number[][],
  ): number[][] => {
    const nn = diagC.length;
    const cp: number[][] = new Array(nn);
    const dp: number[][] = new Array(nn);
    cp[0] = cdiv(surC[0], diagC[0]);
    dp[0] = cdiv(dC[0], diagC[0]);
    for (let i = 1; i < nn; i++) {
      const m = csub(diagC[i], cmul(sousC[i], cp[i - 1]));
      cp[i] = i < nn - 1 ? cdiv(surC[i], m) : [0, 0];
      dp[i] = cdiv(csub(dC[i], cmul(sousC[i], dp[i - 1])), m);
    }
    const x: number[][] = new Array(nn);
    x[nn - 1] = dp[nn - 1];
    for (let i = nn - 2; i >= 0; i--) {
      x[i] = csub(dp[i], cmul(cp[i], x[i + 1]));
    }
    return x;
  };

  const densites: Serie = { nom: "Probabilité totale (doit rester 1)", abscisses: [], valeurs: [], unite: "u.a.", couleur: "#34d399" };
  const positionMoyenne: Serie = { nom: "Position moyenne ⟨x⟩", abscisses: [], valeurs: [], unite: "m", couleur: "#22d3ee" };
  const echantillonFinal = new Float64Array(n);

  const pas = 200;
  let psi: number[][] = psiRe.map((r, i) => [r, psiIm[i]]);
  for (let step = 0; step < pas; step++) {
    // Membre de droite : (I − iγH)·ψⁿ
    const b: number[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      const gauche = i > 0 ? psi[i - 1] : [0, 0];
      const droite = i < n - 1 ? psi[i + 1] : [0, 0];
      const hPsi = [
        alpha * (gauche[0] + droite[0] - 2 * psi[i][0]),
        alpha * (gauche[1] + droite[1] - 2 * psi[i][1]),
      ];
      b[i] = csub(psi[i], cmul([0, -gamma], hPsi));
    }
    // Matrice gauche (I + iγH) en tridiagonal complexe.
    const sousC: number[][] = Array.from({ length: n }, (_, i) => (i > 0 ? [voisinRe, voisinIm] : [0, 0]));
    const diagC: number[][] = Array.from({ length: n }, () => [diagRe, diagIm]);
    const surC: number[][] = Array.from({ length: n }, (_, i) => (i < n - 1 ? [voisinRe, voisinIm] : [0, 0]));
    psi = thomasComplexe(sousC, diagC, surC, b);

    if (step === pas - 1) {
      for (let i = 0; i < n; i++) echantillonFinal[i] = psi[i][0] * psi[i][0] + psi[i][1] * psi[i][1];
    }
    if (step % 20 === 0 || step === pas - 1) {
      let dens = 0;
      let xm = 0;
      for (let i = 0; i < n; i++) {
        const d = psi[i][0] * psi[i][0] + psi[i][1] * psi[i][1];
        dens += d * dx;
        xm += d * dx * i * dx;
      }
      densites.valeurs.push(dens);
      densites.abscisses.push((step + 1) * dt);
      positionMoyenne.valeurs.push(xm / Math.max(1e-300, dens));
      positionMoyenne.abscisses.push((step + 1) * dt);
    }
  }
  const normeFinale = densites.valeurs[densites.valeurs.length - 1] ?? 1;
  const densiteFinale: Serie = {
    nom: "|ψ|² finale (après évolution)",
    abscisses: Array.from({ length: n }, (_, i) => i * dx),
    valeurs: Array.from(echantillonFinal),
    unite: "m⁻¹",
    couleur: "#f472b6",
  };
  const densiteInitiale: Serie = {
    nom: "|ψ|² initiale",
    abscisses: Array.from({ length: n }, (_, i) => i * dx),
    valeurs: psiRe.map((r, i) => r * r + psiIm[i] * psiIm[i]),
    unite: "m⁻¹",
    couleur: "#60a5fa",
  };

  const deriveeNorme = Math.abs(normeFinale - 1);
  const vitesseGroupe = p.impulsion / m;

  const avertissements: string[] = [];
  if (deriveeNorme > 0.01) {
    avertissements.push(
      "La norme de la fonction d'onde a dérivé de plus de 1 % : le pas de temps est trop grand pour cette impulsion.",
    );
  }

  return {
    domaine: "quantique",
    modele: "Équation de Schrödinger dépendante du temps (Crank-Nicolson)",
    titre: "Paquet d'onde quantique en évolution libre",
    explication:
      "Un électron n'est pas une bille : c'est un paquet d'onde. Le Monde laisse ce paquet évoluer selon l'équation de Schrödinger et montre les deux signatures quantiques : la position moyenne avance à la vitesse de groupe v = p/m (comme une bille), MAIS le paquet s'élargit (la position devient incertaine) et la probabilité totale reste exactement 1.",
    equations: [
      "iħ·∂ψ/∂t = −(ħ²/2m)·∂²ψ/∂x²",
      "v_groupe = p/m",
      "Δx(t) croît : dispersion quantique",
    ],
    series: [positionMoyenne, densiteFinale, densiteInitiale, densites],
    champ: null,
    scalaires: [
      { nom: "Vitesse de groupe", valeur: vitesseGroupe, unite: "m/s", note: "v = p/m" },
      {
        nom: "Longueur de de Broglie",
        valeur: p.impulsion === 0 ? Infinity : (2 * Math.PI * H_BARRE) / p.impulsion,
        unite: "m",
        note: "λ = h/p",
      },
    ],
    diagnostics: [
      {
        nom: "Conservation de la probabilité",
        valeur: `dérive ${(deriveeNorme * 100).toFixed(4)} %`,
        sain: deriveeNorme < 0.01,
      },
      { nom: "Schéma", valeur: "Crank-Nicolson — inconditionnellement stable", sain: true },
    ],
    avertissements,
    dureeMs: performance.now() - debut,
  };
}

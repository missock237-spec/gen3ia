/**
 * Domaine mécanique — le mouvement sous toutes ses formes.
 *
 * Deux philosophies cohabitent volontairement :
 *  - la solution ANALYTIQUE quand elle existe (projectile idéal) —
 *    instantanée et exacte ;
 *  - l'intégration NUMÉRIQUE RK4 quand il n'y a pas de formule fermée
 *    (N corps, pendule non linéaire) — avec diagnostic de conservation
 *    de l'énergie pour prouver la qualité de l'intégration.
 */

import { G_TERRE, G_NEWTON, M_TERRE, R_TERRE } from "./constantes";
import { integrerRk4, type SecondMembre, type SerieTemporelle } from "./solveurs";
import { borner, CAPS_MONDE, fin, type Diagnostic, type ResultatSimulation, type Serie } from "./types";

const COULEURS = ["#7C5CFF", "#2AD4E8", "#9E85FF", "#7FE9F5", "#C9AEFF"];

/** Paramètres du projectile. */
export interface ParamsProjectile {
  /** Vitesse initiale (m/s). */
  v0: number;
  /** Angle de tir (degrés). */
  angleDeg: number;
  /** Altitude initiale (m). */
  altitude0: number;
  /** Coefficient de traînée quadratique k (kg/m) — 0 = idéal. */
  trainee: number;
  /** Masse du projectile (kg). */
  masse: number;
}

function serieProjectile(t: number[], x: number[], y: number[], vx: number[], vy: number[]): Serie[] {
  return [
    { nom: "Trajectoire x(t)", abscisses: t, valeurs: x, unite: "m", couleur: COULEURS[0] },
    { nom: "Altitude y(t)", abscisses: t, valeurs: y, unite: "m", couleur: COULEURS[1] },
    { nom: "Vitesse vx(t)", abscisses: t, valeurs: vx, unite: "m/s", couleur: COULEURS[2] },
    { nom: "Vitesse vy(t)", abscisses: t, valeurs: vy, unite: "m/s", couleur: COULEURS[3] },
  ];
}

/**
 * Projectile soumis à la gravité et (optionnellement) à une traînée
 * quadratique F = −k·v·|v|. Résolu par RK4 : la traînée rend le
 * problème non intégrable simplement, RK4 le gère nativement.
 */
export function projectile(p: ParamsProjectile, duree = 12, pas = 0.005): ResultatSimulation {
  const debut = performance.now();
  fin(p.v0, "v0");
  fin(p.angleDeg, "angleDeg");
  fin(p.altitude0, "altitude0");
  fin(p.trainee, "trainee");
  fin(p.masse, "masse");

  const angle = (p.angleDeg * Math.PI) / 180;
  const y0 = [
    0,
    p.altitude0,
    p.v0 * Math.cos(angle),
    p.v0 * Math.sin(angle),
  ];
  const k = p.trainee / Math.max(1e-9, p.masse);
  const f: SecondMembre = (_t, y) => [
    y[2],
    y[3],
    -k * y[2] * Math.hypot(y[2], y[3]),
    -G_TERRE - k * y[3] * Math.hypot(y[2], y[3]),
  ];

  const res = integrerRk4(f, y0, 0, duree, pas, 512);
  const temps = res.t;
  const xs = res.series.map((s) => s[0]);
  const ys = res.series.map((s) => s[1]);
  const vxs = res.series.map((s) => s[2]);
  const vys = res.series.map((s) => s[3]);

  // Portée : première altitude négative (interpolation linéaire).
  let portee = xs[xs.length - 1];
  let tempsVol = temps[temps.length - 1];
  const altitudeMax = Math.max(...ys);
  for (let i = 1; i < ys.length; i++) {
    if (ys[i] < 0 && ys[i - 1] >= 0) {
      const r = ys[i - 1] / (ys[i - 1] - ys[i]);
      portee = xs[i - 1] + r * (xs[i] - xs[i - 1]);
      tempsVol = temps[i - 1] + r * (temps[i] - temps[i - 1]);
      break;
    }
  }

  // Solution idéale pour comparaison (traînée nulle).
  const porteeIdeale =
    ((p.v0 * Math.cos(angle)) / G_TERRE) *
    (p.v0 * Math.sin(angle) + Math.sqrt(p.v0 * p.v0 * Math.sin(angle) ** 2 + 2 * G_TERRE * p.altitude0));
  const ecart = p.trainee > 0 ? ((porteeIdeale - portee) / porteeIdeale) * 100 : 0;

  const diagnostics: Diagnostic[] = [
    {
      nom: "Intégrateur",
      valeur: `RK4 — ${res.pas.toLocaleString("fr-FR")} pas de ${pas * 1000} ms`,
      sain: res.pas <= CAPS_MONDE.pasMax,
    },
    {
      nom: "Traînée",
      valeur: p.trainee > 0 ? `quadratique k=${p.trainee} kg/m — portée réduite de ${ecart.toFixed(1)} %` : "aucune (idéal)",
      sain: true,
    },
  ];
  if (p.trainee > 0 && Math.abs(ecart) > 50) {
    diagnostics.push({
      nom: "Effet traînée dominant",
      valeur: "la traînée domine la gravité — vérifiez la cohérence masse/coefficient",
      sain: false,
    });
  }

  return {
    domaine: "mecanique",
    modele: p.trainee > 0 ? "Projectile avec traînée quadratique (RK4)" : "Projectile idéal (RK4)",
    titre: "Trajectoire balistique",
    explication:
      "Le Monde a intégré les équations du mouvement pas à pas (Runge-Kutta d'ordre 4) : la gravité tire chaque pas vers le bas, la traînée soustrait une force proportionnelle au carré de la vitesse. La portée est détectée au moment où l'altitude repasse sous zéro, par interpolation.",
    equations: [
      "x'' = -(k/m)·x'·√(x'² + y'²)",
      "y'' = -g -(k/m)·y'·√(x'² + y'²)",
    ],
    series: serieProjectile(temps, xs, ys, vxs, vys),
    champ: null,
    scalaires: [
      { nom: "Portée", valeur: portee, unite: "m", note: "distance horizontale au retour au sol" },
      { nom: "Temps de vol", valeur: tempsVol, unite: "s", note: "durée jusqu'au retour au sol" },
      { nom: "Altitude maximale", valeur: altitudeMax, unite: "m", note: "sommet de la trajectoire" },
      {
        nom: "Portée idéale (sans traînée)",
        valeur: porteeIdeale,
        unite: "m",
        note: "formule analytique de référence",
      },
    ],
    diagnostics,
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Un corps céleste simplifié : position, vitesse, masse. */
export interface Corps {
  nom: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  masse: number;
}

/** Paramètres du problème à N corps gravitationnel. */
export interface ParamsNCorps {
  corps: Corps[];
  /** Durée simulée (s). */
  duree: number;
  /** Pas d'intégration (s). */
  pas: number;
}

/**
 * Problème à N corps (gravitation newtonienne, softening de Plummer
 * pour éviter les singularités de contact). Intégration RK4, diagnostic
 * de dérive d'énergie — la preuve que le chaos simulé reste physique.
 */
export function nCorps(p: ParamsNCorps): ResultatSimulation {
  const debut = performance.now();
  const corps = p.corps.slice(0, CAPS_MONDE.corpsMax);
  const n = corps.length;
  if (n < 2) throw new Error("Au moins deux corps sont nécessaires.");

  // Aplatissement : [x1, y1, vx1, vy1, x2, ...]
  const y0: number[] = [];
  for (const c of corps) {
    y0.push(fin(c.x, "x"), fin(c.y, "y"), fin(c.vx, "vx"), fin(c.vy, "vy"));
  }
  const masses = corps.map((c) => fin(c.masse, "masse"));

  const softening2 = 1e6; // (m²) amortit les rencontres trop proches.
  const acceleration = (positions: number[]) => {
    const acc = new Array<number>(positions.length).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = positions[j * 4] - positions[i * 4];
        const dy = positions[j * 4 + 1] - positions[i * 4 + 1];
        const r2 = dx * dx + dy * dy + softening2;
        const r = Math.sqrt(r2);
        const facteur = G_NEWTON / (r2 * r);
        acc[i * 4] += facteur * masses[j] * dx;
        acc[i * 4 + 1] += facteur * masses[j] * dy;
        acc[j * 4] -= facteur * masses[i] * dx;
        acc[j * 4 + 1] -= facteur * masses[i] * dy;
      }
    }
    return acc;
  };

  const f: SecondMembre = (_t, y) => {
    const acc = acceleration(y);
    const derivee: number[] = new Array(y.length);
    for (let i = 0; i < n; i++) {
      derivee[i * 4] = y[i * 4 + 2];
      derivee[i * 4 + 1] = y[i * 4 + 3];
      derivee[i * 4 + 2] = acc[i * 4];
      derivee[i * 4 + 3] = acc[i * 4 + 1];
    }
    return derivee;
  };

  const res = integrerRk4(f, y0, 0, p.duree, p.pas, 512);

  // Énergie totale initiale vs finale (cinétique + potentielle).
  const energie = (etat: number[]): number => {
    let ec = 0;
    let ep = 0;
    for (let i = 0; i < n; i++) {
      const vx = etat[i * 4 + 2];
      const vy = etat[i * 4 + 3];
      ec += 0.5 * masses[i] * (vx * vx + vy * vy);
      for (let j = i + 1; j < n; j++) {
        const dx = etat[j * 4] - etat[i * 4];
        const dy = etat[j * 4 + 1] - etat[i * 4 + 1];
        ep -= (G_NEWTON * masses[i] * masses[j]) / Math.sqrt(dx * dx + dy * dy + softening2);
      }
    }
    return ec + ep;
  };
  const e0 = energie(res.series[0]);
  const eF = energie(res.series[res.series.length - 1]);
  const derive = Math.abs((eF - e0) / (Math.abs(e0) || 1));

  const series: Serie[] = corps.map((c, i) => ({
    nom: `${c.nom} — distance à l'origine`,
    abscisses: res.t,
    valeurs: res.series.map((s) => Math.hypot(s[i * 4], s[i * 4 + 1])),
    unite: "m",
    couleur: COULEURS[i % COULEURS.length],
  }));
  series.push({
    nom: "Séparation Terre–corps 2",
    abscisses: res.t,
    valeurs: res.series.map((s) => Math.hypot(s[4] - s[0], s[5] - s[1])),
    unite: "m",
    couleur: COULEURS[4],
  });

  const avertissements: string[] = [];
  if (derive > 0.05) {
    avertissements.push(
      "Dérive d'énergie notable : le pas d'intégration est trop grand pour cette configuration (orbites serrées). Réduisez le pas.",
    );
  }

  return {
    domaine: "mecanique",
    modele: "Gravitation newtonienne à N corps (RK4, softening de Plummer)",
    titre: "Danse gravitationnelle à N corps",
    explication:
      "Chaque corps attire tous les autres selon la loi de Newton, recalculée à chaque pas d'intégration. Le Monde suit les trajectoires et vérifie que l'énergie totale se conserve : c'est le garant que la simulation reste fidèle à la physique réelle et n'a pas dérivé numériquement.",
    equations: [
      "r̈ᵢ = Σⱼ≠ᵢ G·mⱼ·(rⱼ−rᵢ)/|rⱼ−rᵢ|³",
      "E = ½·Σ mᵢ·vᵢ² − Σᵢ<ⱼ G·mᵢ·mⱼ/rᵢⱼ",
    ],
    series,
    champ: null,
    scalaires: [
      { nom: "Énergie totale initiale", valeur: e0, unite: "J", note: "cinétique + potentielle" },
      { nom: "Énergie totale finale", valeur: eF, unite: "J", note: "doit être ≈ initiale" },
    ],
    diagnostics: [
      { nom: "Dérive d'énergie", valeur: `${(derive * 100).toFixed(4)} %`, sain: derive < 0.05 },
      { nom: "Corps simulés", valeur: `${n}`, sain: n <= CAPS_MONDE.corpsMax },
    ],
    avertissements,
    dureeMs: performance.now() - debut,
  };
}

/** Scénario prêt à l'emploi : le système Terre–Lune. */
export function systemeTerreLune(duree = 2_592_000, pas = 60): ParamsNCorps {
  const vitesseLune = 1022;
  return {
    corps: [
      { nom: "Terre", x: 0, y: 0, vx: -(vitesseLune * 7.3477e22) / M_TERRE, vy: 0, masse: M_TERRE },
      { nom: "Lune", x: 384_400_000, y: 0, vx: 0, vy: vitesseLune, masse: 7.3477e22 },
    ],
    duree,
    pas,
  };
}

/** Paramètres du pendule non linéaire. */
export interface ParamsPendule {
  /** Longueur (m). */
  longueur: number;
  /** Angle initial (degrés). */
  angleDeg: number;
  /** Vitesse angulaire initiale (rad/s). */
  vitesseAngulaire: number;
  /** Amortissement (kg/s). */
  amortissement: number;
  /** Masse (kg). */
  masse: number;
}

/** Pendule NON linéaire (sin θ complet, pas d'approximation small-angle). */
export function pendule(p: ParamsPendule, duree = 20, pas = 0.002): ResultatSimulation {
  const debut = performance.now();
  const th0 = (p.angleDeg * Math.PI) / 180;
  const y0 = [th0, p.vitesseAngulaire];
  const f: SecondMembre = (_t, y) => [
    y[1],
    -(G_TERRE / p.longueur) * Math.sin(y[0]) - (p.amortissement / p.masse) * y[1],
  ];
  const res = integrerRk4(f, y0, 0, duree, pas, 512);

  const periode: number[] = [];
  let dernierPassage = -1;
  for (let i = 1; i < res.t.length; i++) {
    if (res.series[i - 1][0] < 0 && res.series[i][0] >= 0 && dernierPassage >= 0) {
      periode.push(res.t[i] - dernierPassage);
    }
    if (res.series[i - 1][0] < 0 && res.series[i][0] >= 0) dernierPassage = res.t[i];
  }
  const periodeMesuree = periode.length > 0 ? periode[periode.length - 1] : NaN;
  const periodePetiteAngle = 2 * Math.PI * Math.sqrt(p.longueur / G_TERRE);

  return {
    domaine: "mecanique",
    modele: "Pendule non linéaire amorti (sin θ complet, RK4)",
    titre: "Oscillation du pendule",
    explication:
      "Contrairement à l'approximation des petits angles (sin θ ≈ θ), le Monde résout le sin θ complet : pour les grandes amplitudes la période s'allonge — c'est visible ici par la comparaison avec la formule simplifiée. L'amortissement retire progressivement de l'énergie.",
    equations: [
      "θ'' = -(g/L)·sin(θ) - (b/m)·θ'",
      "T_petits_angles = 2π·√(L/g)",
    ],
    series: [
      { nom: "Angle θ(t)", abscisses: res.t, valeurs: res.series.map((s) => (s[0] * 180) / Math.PI), unite: "°", couleur: COULEURS[0] },
      { nom: "Vitesse angulaire θ'(t)", abscisses: res.t, valeurs: res.series.map((s) => s[1]), unite: "rad/s", couleur: COULEURS[1] },
    ],
    champ: null,
    scalaires: [
      {
        nom: "Période mesurée",
        valeur: periodeMesuree,
        unite: "s",
        note: "dernière oscillation complète détectée",
      },
      {
        nom: "Période petits angles",
        valeur: periodePetiteAngle,
        unite: "s",
        note: "2π·√(L/g) — référence approximative",
      },
    ],
    diagnostics: [
      {
        nom: "Régime",
        valeur:
          Math.abs(p.angleDeg) > 60
            ? "grandes amplitudes — l'approximation des petits angles serait fausse"
            : "amplitudes modérées",
        sain: true,
      },
    ],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Oscillateur harmonique amorti (ressort) par RK4. */
export function ressort(
  raideur: number,
  masse: number,
  amortissement: number,
  x0: number,
  v0 = 0,
  duree = 10,
  pas = 0.002,
): ResultatSimulation {
  const debut = performance.now();
  const f: SecondMembre = (_t, y) => [
    y[1],
    -(raideur / masse) * y[0] - (amortissement / masse) * y[1],
  ];
  const res = integrerRk4(f, [fin(x0, "x0"), fin(v0, "v0")], 0, duree, pas, 512);
  const omega0 = Math.sqrt(raideur / masse);
  const facteur = amortissement / (2 * masse);
  const regime =
    facteur < omega0 * 0.99
      ? "sous-amorti (oscillations)"
      : facteur < omega0 * 1.01
        ? "critique (retour le plus rapide sans oscillation)"
        : "sur-amorti (retour lent)";

  return {
    domaine: "mecanique",
    modele: "Oscillateur harmonique amorti (RK4)",
    titre: "Ressort — oscillation amortie",
    explication:
      "Le ressort tire proportionnellement à l'élongation (loi de Hooke), l'amortissement s'oppose à la vitesse. Le rapport entre les deux décide du régime : sous-amorti, critique ou sur-amorti — le Monde nomme le régime observé et trace la décroissance.",
    equations: ["m·x'' + b·x' + k·x = 0", "ω₀ = √(k/m)", "ζ = b/(2·√(k·m))"],
    series: [
      { nom: "Position x(t)", abscisses: res.t, valeurs: res.series.map((s) => s[0]), unite: "m", couleur: COULEURS[0] },
      { nom: "Vitesse x'(t)", abscisses: res.t, valeurs: res.series.map((s) => s[1]), unite: "m/s", couleur: COULEURS[1] },
    ],
    champ: null,
    scalaires: [
      { nom: "Pulsation propre ω₀", valeur: omega0, unite: "rad/s", note: "fréquence sans amortissement" },
      { nom: "Période propre", valeur: (2 * Math.PI) / omega0, unite: "s", note: "T₀ = 2π/ω₀" },
    ],
    diagnostics: [{ nom: "Régime", valeur: regime, sain: true }],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Chute libre / vitesse limite avec traînée atmosphérique. */
export function chuteLibre(
  masse: number,
  trainee: number,
  altitude0: number,
  duree = 30,
  pas = 0.005,
): ResultatSimulation {
  const debut = performance.now();
  const vLimite = Math.sqrt((masse * G_TERRE) / Math.max(1e-9, trainee));
  const f: SecondMembre = (_t, y) => [y[1], -G_TERRE + (trainee / masse) * y[1] * y[1]];
  const res = integrerRk4(f, [altitude0, 0], 0, duree, pas, 512);
  const atteintSol = res.series[res.series.length - 1][0] <= 0;
  return {
    domaine: "mecanique",
    modele: "Chute avec traînée quadratique (RK4)",
    titre: "Chute libre et vitesse limite",
    explication:
      "Sans traînée, la vitesse croît indéfiniment comme g·t. Avec l'air, la traînée croît comme le carré de la vitesse jusqu'à l'annuler : la chute atteint sa vitesse limite √(m·g/k) et s'y stabilise — c'est la physique d'un parachutiste.",
    equations: ["y'' = -g + (k/m)·y'²", "v_limite = √(m·g/k)"],
    series: [
      { nom: "Altitude (t)", abscisses: res.t, valeurs: res.series.map((s) => s[0]), unite: "m", couleur: COULEURS[0] },
      { nom: "Vitesse (t)", abscisses: res.t, valeurs: res.series.map((s) => s[1]), unite: "m/s", couleur: COULEURS[1] },
    ],
    champ: null,
    scalaires: [
      { nom: "Vitesse limite", valeur: vLimite, unite: "m/s", note: "√(m·g/k)" },
      {
        nom: "Gravité à l'altitude initiale",
        valeur: G_NEWTON * ((M_TERRE / Math.pow(R_TERRE + borner(altitude0, 0, 2e6), 2)) || G_TERRE),
        unite: "m/s²",
        note: "g diminue légèrement avec l'altitude",
      },
    ],
    diagnostics: [
      { nom: "Sol atteint", valeur: atteintSol ? "oui pendant la durée simulée" : "non (augmentez la durée)", sain: true },
    ],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Export utilitaire pour les tests. */
export { serieProjectile, type SerieTemporelle };

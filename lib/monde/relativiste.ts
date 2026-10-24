/**
 * Domaine relativiste — quand les vitesses approchent c et que les
 * champs gravitationnels courbent le temps. Solutions analytiques
 * exactes de la relativité restreinte (Lorentz) et générale
 * (déviation gravitationnelle, redshift).
 */

import { C_LUMIERE, G_NEWTON, M_TERRE, R_TERRE } from "./constantes";
import { fin, type Diagnostic, type ResultatSimulation, type Serie } from "./types";

/** Paramètres d'un voyage relativiste. */
export interface ParamsLorentz {
  /** Vitesse du voyageur (m/s). */
  vitesse: number;
  /** Durée mesurée par le voyageur (s). */
  dureePropre: number;
}

/**
 * Dilatation du temps de Lorentz : Δt = γ·Δτ avec
 * γ = 1/√(1 − v²/c²). Solution analytique exacte. Le Monde montre la
 * rupture d'intuition : sous 10 % de c, rien ne change ; à 99,999 %,
 * une seconde propre vaut des heures terrestres.
 */
export function dilatationTemps(p: ParamsLorentz): ResultatSimulation {
  const debut = performance.now();
  const v = fin(p.vitesse, "vitesse");
  if (v >= C_LUMIERE) {
    throw new Error("Aucun corps massif n'atteint la vitesse de la lumière.");
  }
  const beta = v / C_LUMIERE;
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  const dureeTerrestre = gamma * p.dureePropre;

  // Courbe γ(β) pour visualiser la « muraille de la lumière ».
  const abscisses: number[] = [];
  const gammas: number[] = [];
  for (let i = 0; i <= 500; i++) {
    const b = 0.99 + (0.999999 * i) / 500;
    abscisses.push(b);
    gammas.push(1 / Math.sqrt(1 - b * b));
  }

  const series: Serie[] = [
    {
      nom: "Facteur de Lorentz γ (proche de c)",
      abscisses,
      valeurs: gammas,
      unite: "β = v/c",
      couleur: "#7C5CFF",
    },
  ];

  return {
    domaine: "relativiste",
    modele: "Relativité restreinte — transformation de Lorentz (exact)",
    titre: "Dilatation du temps",
    explication:
      "Plus un objet va vite, plus son temps propre ralentit vu de l'extérieur : c'est le facteur de Lorentz γ = 1/√(1 − v²/c²). À 87 % de la vitesse de la lumière, γ = 2 : une année du voyageur en vaut deux sur Terre. À 99,999 %, γ ≈ 224. La vitesse c est une asymptote infranchissable : γ diverge quand β → 1.",
    equations: [
      "γ = 1/√(1 − v²/c²)",
      "Δt_terrestre = γ·Δτ_voyageur",
      "Longueur contractée : L = L₀/γ",
    ],
    series,
    champ: null,
    scalaires: [
      { nom: "Facteur de Lorentz γ", valeur: gamma, unite: "u.a.", note: "dilatation multiplicatrice" },
      { nom: "Durée terrestre", valeur: dureeTerrestre, unite: "s", note: "ce que voit un observateur au sol" },
      { nom: "β = v/c", valeur: beta, unite: "u.a.", note: "fraction de la vitesse de la lumière" },
      {
        nom: "Contraction des longueurs",
        valeur: 1 / gamma,
        unite: "facteur",
        note: "la longueur propre perçue par le voyageur",
      },
    ],
    diagnostics: [
      { nom: "Solution", valeur: "analytique exacte — aucune erreur numérique", sain: true },
      {
        nom: "Régime",
        valeur: beta < 0.1 ? "newtonien (γ ≈ 1, relativité négligeable)" : beta < 0.9 ? "relativiste modéré" : "ultra-relativiste",
        sain: true,
      },
    ],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Énergie relativiste totale et cinétique. */
export function energieRelativiste(masseKg: number, vitesse: number): ResultatSimulation {
  const debut = performance.now();
  const m = fin(masseKg, "masseKg");
  const v = Math.min(fin(vitesse, "vitesse"), C_LUMIERE * 0.999999);
  const beta = v / C_LUMIERE;
  const gamma = 1 / Math.sqrt(1 - beta * beta);
  const repos = m * C_LUMIERE * C_LUMIERE;
  const totale = gamma * repos;
  const cinetique = totale - repos;
  const cinetiqueNewton = 0.5 * m * v * v;
  const ecartNewton = ((cinetique - cinetiqueNewton) / cinetique) * 100;

  return {
    domaine: "relativiste",
    modele: "Énergie relativiste E = γmc² (exact)",
    titre: "Équivalence masse-énergie",
    explication:
      "E = mc² dit une chose simple : la masse EST de l'énergie au repos. En mouvement, il faut multiplier par γ. La mécanique newtonienne (½mv²) n'est que l'approximation basse vitesse : le Monde affiche l'écart exact entre les deux — il devient énorme dès que v dépasse 30 % de c.",
    equations: [
      "E² = (m·c²)² + (p·c)²",
      "E = γ·m·c²",
      "Ec = E − m·c²",
    ],
    series: [],
    champ: null,
    scalaires: [
      { nom: "Énergie de repos", valeur: repos, unite: "J", note: "m·c²" },
      { nom: "Énergie cinétique relativiste", valeur: cinetique, unite: "J", note: "exacte" },
      { nom: "Énergie cinétique newtonienne", valeur: cinetiqueNewton, unite: "J", note: "½mv² — approximation" },
      { nom: "Sous-estimation newtonienne", valeur: ecartNewton, unite: "%", note: "erreur si on ignorait la relativité" },
    ],
    diagnostics: [
      {
        nom: "Validité du modèle newtonien",
        valeur: beta < 0.1 ? "acceptable (< 1 % d'erreur)" : "FAUX — la relativité domine",
        sain: beta < 0.1,
      } as Diagnostic,
    ],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/** Redshift gravitationnel près d'un corps massif. */
export function redshiftGravitationnel(
  altitudeEmetteur: number,
  altitudeRecepteur: number,
  masse = M_TERRE,
  rayon = R_TERRE,
): ResultatSimulation {
  const debut = performance.now();
  // Potentiel newtonien Φ = −GM/r ; le temps s'écoule plus lentement
  // dans un potentiel plus profond : Δf/f ≈ ΔΦ/c² (approximation faible).
  const phi1 = (-G_NEWTON * masse) / (rayon + altitudeEmetteur);
  const phi2 = (-G_NEWTON * masse) / (rayon + altitudeRecepteur);
  const deltaFsurF = (phi1 - phi2) / (C_LUMIERE * C_LUMIERE);
  const gLocale = (G_NEWTON * masse) / Math.pow(rayon + altitudeEmetteur, 2);

  // GPS : horloges des satellites vs sol.
  const altitudeGps = 20_200_000;
  const phiGps = (-G_NEWTON * masse) / (rayon + altitudeGps);
  const deriveGps = (phiGps - phi1) / (C_LUMIERE * C_LUMIERE);

  const abscisses: number[] = [];
  const valeurs: number[] = [];
  for (let i = 0; i <= 100; i++) {
    const alt = altitudeEmetteur + ((altitudeRecepteur - altitudeEmetteur) * i) / 100;
    const phi = (-G_NEWTON * masse) / (rayon + alt);
    abscisses.push(alt);
    valeurs.push((phi - phi1) / (C_LUMIERE * C_LUMIERE));
  }

  return {
    domaine: "relativiste",
    modele: "Redshift gravitationnel (approximation de champ faible)",
    titre: "Le temps coule différemment selon l'altitude",
    explication:
      "Plus on est proche d'une masse, plus le temps s'écoule lentement : c'est le redshift gravitationnel, mesuré au laboratoire dès 1959 (expérience de Pound-Rebka). Concrètement : les horloges des satellites GPS avancent de ~38 µs par jour par rapport au sol — sans la correction relativiste, le GPS dériverait de 10 km PAR JOUR.",
    equations: [
      "Δf/f ≈ ΔΦ/c² (champ faible)",
      "Φ = −G·M/r",
    ],
    series: [
      {
        nom: "Δf/f selon l'altitude",
        abscisses,
        valeurs,
        unite: "m",
        couleur: "#2AD4E8",
      },
    ],
    champ: null,
    scalaires: [
      { nom: "Décalage de fréquence", valeur: deltaFsurF, unite: "u.a.", note: "positif = fréquence augmente en montant" },
      { nom: "Gravité à l'émetteur", valeur: gLocale, unite: "m/s²", note: "g locale" },
      {
        nom: "Effet GPS (satellite → sol)",
        valeur: deriveGps * 86400,
        unite: "s/jour",
        note: "avance des horloges GPS par jour",
      },
    ],
    diagnostics: [
      {
        nom: "Régime de champ faible",
        valeur: "GM/(rc²) ≪ 1 — approximation linéaire valide",
        sain: true,
      },
    ],
    avertissements: [],
    dureeMs: performance.now() - debut,
  };
}

/**
 * L'Interprète — du langage naturel à la physique.
 *
 * Le Monde parle français : « lance un projectile à 50 m/s à 45 degrés »
 * devient une spécification exécutable. L'approche est HONNÊTE et
 * déterministe : détection de mots-clés par domaine, extraction des
 * nombres avec leurs unités, valeurs par défaut physiquement
 * raisonnables quand un paramètre manque (et affichées comme telles).
 * L'IA Gen3 s'appuie sur cet interprète puis reformule les résultats.
 */

import type { ChargePonctuelle } from "./electromagnetique";
import type { SpecSimulation } from "./univers";

/** Résultat de l'interprétation. */
export interface Interpretation {
  spec: SpecSimulation;
  /** Confiance de la détection (0..1) — affichée à l'utilisateur. */
  confiance: number;
  /** Ce que l'interprète a compris, en clair. */
  comprehension: string;
  /** Paramètres par défaut employés faute d'information. */
  suppositions: string[];
}

/** Un nombre + son unité extraits du texte. */
interface Mesure {
  valeur: number;
  unite: string;
}

/** Extrait toutes les mesures « nombre + unité optionnelle » d'un texte. */
export function extraireMesures(texte: string): Mesure[] {
  const mesures: Mesure[] = [];
  const regex = /(-?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?)\s*(m\/s|km\/h|deg(?:rés?|s)?|°|rad|kg|g\b|mol|Hz|kHz|MHz|GHz|K\b|°C|C\b|J\b|kJ|eV|Pa|bar|V\b|A\b|Ω|ohms?|H\b|F\b|mF|µF|nF|pF|m\b|cm|mm|km|s\b|ms|µs|ns|min|h\b|%)?/giu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(texte)) !== null) {
    const valeur = Number(match[1].replace(",", "."));
    if (!Number.isFinite(valeur)) continue;
    let unite = (match[2] ?? "").toLowerCase();
    // Normalisation : « degrés », « degré », « degrs » → « deg ».
    if (unite.startsWith("deg")) unite = "deg";
    mesures.push({ valeur, unite });
  }
  return mesures;
}

/** Cherche une valeur numérique associée à un mot-clé (dans la fenêtre suivante). */
function valeurApres(texte: string, motsCles: string[], unites?: string[]): number | null {
  for (const mot of motsCles) {
    const regex = new RegExp(`${mot}[^\\d]{0,24}(-?\\d+(?:[.,]\\d+)?(?:[eE][-+]?\\d+)?)`, "i");
    const match = texte.match(regex);
    if (match) {
      const valeur = Number(match[1].replace(",", "."));
      if (Number.isFinite(valeur)) return valeur;
    }
  }
  // Sinon : première mesure dont l'unité correspond (ex. m/s pour v0).
  if (unites && unites.length > 0) {
    const toutes = extraireMesures(texte);
    const correspond = toutes.find((m) => unites.includes(m.unite));
    if (correspond) return correspond.valeur;
  }
  return null;
}

/** Table de conversion des longueurs vers le mètre. */
const LONGUEURS_SI: Record<string, number> = {
  nm: 1e-9,
  "µm": 1e-6,
  um: 1e-6,
  mm: 1e-3,
  cm: 1e-2,
  m: 1,
  km: 1e3,
};

/** Cherche une mesure associée à un mot-clé (nombre + unité). */
function mesureApres(texte: string, motsCles: string[]): Mesure | null {
  for (const mot of motsCles) {
    const regex = new RegExp(
      `${mot}[^\\d]{0,24}(-?\\d+(?:[.,]\\d+)?(?:[eE][-+]?\\d+)?)\\s*(m/s|km/h|deg[^\\s]*|rad|kg|mol|Hz|kHz|MHz|GHz|°C|K|eV|Pa|V|A|Ω|ohms?|H|F|µF|nF|pF|nm|µm|um|mm|cm|km|m|s|ms|µs|ns|min|h|%)?`,
      "i",
    );
    const match = texte.match(regex);
    if (match) {
      const valeur = Number(match[1].replace(",", "."));
      if (Number.isFinite(valeur)) return { valeur, unite: (match[2] ?? "").toLowerCase() };
    }
  }
  return null;
}

/** Mesure convertie en mètres si son unité est une longueur. */
function longueurApres(texte: string, motsCles: string[], defaut: number): number {
  const mesure = mesureApres(texte, motsCles);
  if (!mesure) return defaut;
  const facteur = LONGUEURS_SI[mesure.unite] ?? 1;
  return mesure.valeur * facteur;
}

const a = (v: number | null, defaut: number) => (v === null || !Number.isFinite(v) ? defaut : v);

/**
 * Interprète une question en français et propose une simulation.
 * Renvoie null si aucun domaine physique n'est détecté — l'appelant
 * (IA ou interface) sait alors répondre autrement.
 */
export function interpreter(question: string): Interpretation | null {
  const q = question.toLowerCase().normalize("NFC");
  const suppositions: string[] = [];
  let confiance = 0;

  // ——— Équations fournies explicitement (priorité maximale) ———
  const matchOde2 = q.match(/y''\s*=\s*([^,;.]+)/);
  const matchOde1 = q.match(/y'\s*=\s*([^,;.]+)/);
  if (matchOde2 || matchOde1) {
    // Coupe le membre de droite au premier mot de liaison : « y' = -y avec
    // y(0) = 1 » → expression « -y » seulement.
    const brut = (matchOde2?.[1] ?? matchOde1?.[1] ?? "").trim();
    const expression = brut.split(/\s+(?:avec|pour|où|ou|jusqu)\b/i)[0].trim();
    const ordre: 1 | 2 = matchOde2 ? 2 : 1;
    const tFin = a(valeurApres(q, ["jusqu'à", "jusqu'a", "sur", "t ≤", "pour t"], ["s"]), 10);
    const y0 = a(valeurApres(q, ["y\\(0\\)", "initiale"], []), 1);
    if (expression.length > 0) {
      confiance = 0.95;
      return {
        spec: {
          type: "ode",
          ordre,
          expression,
          y0,
          derivee0: a(valeurApres(q, ["y'\\(0\\)"], []), 0),
          tDebut: 0,
          tFin,
        },
        confiance,
        comprehension: `Résolution de l'ODE d'ordre ${ordre} : ${ordre === 1 ? "y'" : "y''"} = ${expression}, y(0) = ${y0}, intégrée jusqu'à t = ${tFin} s.`,
        suppositions: [
          `condition initiale y(0) = ${y0} (non fournie ou vérifiez-la)`,
          `intervalle d'intégration [0 ; ${tFin}] s`,
        ],
      };
    }
  }

  const matchRacine = q.match(/(?:racines?|zero[s]?|zéro[s]?|annule)\s+(?:de\s+)?(?:f\(x\)\s*=\s*)?([^,;.]+)=?\s*(?:0)?(?:\s+sur|\s+entre|\s+dans)?/);
  if (matchRacine && (q.includes("=0") || q.includes("= 0") || q.includes("racine") || q.includes("zéro") || q.includes("zero"))) {
    const expression = matchRacine[1].replace(/=\s*0\s*$/, "").trim();
    if (expression.length > 1) {
      const matchBornes = q.match(/entre\s+(-?\d+(?:[.,]\d+)?)\s+(?:et|à|;)\s+(-?\d+(?:[.,]\d+)?)/);
      const borneMin = a(matchBornes ? Number(matchBornes[1].replace(",", ".")) : null, -10);
      const borneMax = a(matchBornes ? Number(matchBornes[2].replace(",", ".")) : null, 10);
      confiance = 0.9;
      return {
        spec: { type: "racines", expression, borneMin, borneMax },
        confiance,
        comprehension: `Recherche des racines de f(x) = ${expression} sur [${borneMin} ; ${borneMax}].`,
        suppositions: [`intervalle de recherche [${borneMin} ; ${borneMax}] (précisez « entre … et … »)`],
      };
    }
  }

  if (/\b(?:int[ée]grale|int[ée]grer|∫)\b/.test(q)) {
    const matchInt = q.match(/(?:int[ée]grale?\s*(?:de)?|∫)\s*([^,;.;]+(?:dx)?)/);
    const expression = (matchInt?.[1] ?? "").replace(/dx\s*$/, "").trim();
    if (expression.length > 1) {
      const matchBornes = q.match(/entre\s+(-?\d+(?:[.,]\d+)?)\s+(?:et|à|;)\s+(-?\d+(?:[.,]\d+)?)/);
      const borneMin = a(matchBornes ? Number(matchBornes[1].replace(",", ".")) : null, 0);
      const borneMax = a(matchBornes ? Number(matchBornes[2].replace(",", ".")) : null, 1);
      confiance = 0.9;
      return {
        spec: { type: "integrale", expression, borneMin, borneMax },
        confiance,
        comprehension: `Intégrale de ${expression} entre ${borneMin} et ${borneMax}, par Monte-Carlo vérifiée par Simpson.`,
        suppositions: [`bornes [${borneMin} ; ${borneMax}] (précisez « entre … et … »)`],
      };
    }
  }

  if (/\b(?:minimum|minimiser|maxim(?:um|iser)|extremum)\b/.test(q)) {
    const expression = q.match(/(?:de|du)\s+([a-z0-9+\-*/^().\s]+?)(?:\s+sur|\s+entre|$)/)?.[1]?.trim() ?? "";
    if (expression.length > 1) {
      const matchBornes = q.match(/(?:sur|entre)\s+\[?(-?\d+(?:[.,]\d+)?)\s*(?:;|,|et|à)\s*(-?\d+(?:[.,]\d+)?)/);
      const borneMin = a(matchBornes ? Number(matchBornes[1].replace(",", ".")) : null, -5);
      const borneMax = a(matchBornes ? Number(matchBornes[2].replace(",", ".")) : null, 5);
      confiance = 0.85;
      return {
        spec: { type: "optimisation", expression, borneMin, borneMax },
        confiance,
        comprehension: `Recherche du minimum de ${expression} sur [${borneMin} ; ${borneMax}].`,
        suppositions: [`intervalle de recherche [${borneMin} ; ${borneMax}]`],
      };
    }
  }

  // ——— Relativité ———
  if (/\b(?:relativit|lorentz|dilatation|temps ralent|vitesse de la lumi|e\s*=\s*mc|mc2|mc²|redshift|gravitationnel)\b/.test(q)) {
    confiance = 0.85;
    if (/\b(?:redshift|altitude|gps|gravitationnel)\b/.test(q)) {
      const altE = a(valeurApres(q, ["depuis", "emetteur", "émetteur", "à"], ["m", "km"]), 0);
      const altR = a(valeurApres(q, ["vers", "recepteur", "récepteur", "jusqu'à", "jusqu'a"], ["m", "km"]), 100000);
      return {
        spec: { type: "redshift", altitudeEmetteur: altE, altitudeRecepteur: altR },
        confiance,
        comprehension: `Redshift gravitationnel entre ${altE} m et ${altR} m d'altitude (Terre).`,
        suppositions: ["corps attracteur = Terre", "approximation de champ faible"],
      };
    }
    const vitesse =
      valeurApres(q, ["vitesse", "à", "de"], ["m/s", "km/h"]) ??
      a(valeurApres(q, ["% de c", "pourcent de c"], []), 0.9 * 299792458) * (q.includes("% de c") ? 0.01 * 299792458 : 1);
    const dureePropre = a(valeurApres(q, ["durée", "duree", "voyage"], ["s", "min", "h", "ans"]), 3600);
    return {
      spec: { type: "dilatationTemps", vitesse: a(vitesse, 0.9 * 299792458), dureePropre },
      confiance,
      comprehension: `Dilatation du temps à v = ${((a(vitesse, 0.9 * 299792458) / 299792458) * 100).toFixed(2)} % de c pendant ${dureePropre} s propres.`,
      suppositions: ["relativité restreinte (pas de gravitation)"],
    };
  }

  // ——— Quantique ———
  if (/\b(?:quantique|schro|paquet d'onde|particule dans|boite|boîte|eigen|quantif|électron confin|electron confin)\b/.test(q)) {
    confiance = 0.85;
    const libre = /\b(?:libre|evol|évolution|evolution|propage|paquet)\b/.test(q);
    const impulsion = a(valeurApres(q, ["impulsion", "momentum"], []), 1e-24);
    if (libre) {
      return {
        spec: { type: "paquetOnde", impulsion, duree: a(valeurApres(q, ["durée", "duree"], ["fs", "s"]), 1e-14) },
        confiance,
        comprehension: `Évolution d'un paquet d'onde d'électron (p = ${impulsion.toExponential(2)} kg·m/s) pendant la durée demandée.`,
        suppositions: ["électron libre (pas de potentiel)", "domaine de 10 nm, paquet gaussien initial"],
      };
    }
    return {
      spec: { type: "particuleBoite", longueurBoite: a(valeurApres(q, ["boite", "boîte", "largeur", "confin"], ["m", "nm"]), 1e-9) },
      confiance,
      comprehension: "Niveaux d'énergie d'une particule confinée (puits infini 1D).",
      suppositions: ["puits de potentiel infini", "particule = électron sauf indication contraire"],
    };
  }

  // ——— Ondes ———
  if (/\b(?:young|fentes?|interf[ée]rence|diffraction|franges?)\b/.test(q)) {
    confiance = 0.9;
    const longueurOnde = longueurApres(q, ["longueur d'onde", "longueur donde", "λ"], 6.328e-7);
    const espacement = longueurApres(q, ["fentes espac", "espacement", "séparées de", "separees de", "fentes"], 0.0002);
    return {
      spec: {
        type: "fentesYoung",
        largeurEcran: a(valeurApres(q, ["écran", "ecran"], ["m", "cm"]), 2),
        distanceEcran: a(valeurApres(q, ["écran à", "ecran a", "distance"], ["m"]), 2),
        espacement,
        longueurOnde,
      },
      confiance,
      comprehension: `Interférences de Young : λ = ${(longueurOnde * 1e9).toFixed(0)} nm, fentes espacées de ${(espacement * 1e3).toFixed(2)} mm, écran à 2 m.`,
      suppositions: ["largeur de fente = 5 % de l'espacement", "régime de champ lointain (Fraunhofer)"],
    };
  }

  if (/\b(?:onde|ondes|propagation|sonore|acoustique|vague)\b/.test(q)) {
    confiance = 0.8;
    const lumiere = /\b(?:lumière|lumiere|optique|photon)\b/.test(q);
    const deuxSources = /\b(?:deux sources|2 sources|interf[ée]renc|deux fentes|2 fentes)\b/.test(q);
    const frequence = a(valeurApres(q, ["fréquence", "frequence", "à", "de"], ["Hz", "kHz", "MHz"]), 440);
    if (lumiere) {
      return {
        spec: { type: "ondeLumiere", longueurOnde: a(valeurApres(q, ["longueur d'onde", "λ"], ["nm", "m"]), 6.328e-7) },
        confiance,
        comprehension: "Onde électromagnétique plane dans le vide (classification spectrale).",
        suppositions: [],
      };
    }
    return {
      spec: {
        type: "onde2D",
        frequence,
        celerite: a(valeurApres(q, ["célérité", "celerite", "vitesse du son", "vitesse"], ["m/s"]), 343),
        sourceSecondaire: deuxSources ? { x: 0.8, y: 0.5 } : undefined,
        resolution: 96,
        pas: 1500,
      },
      confiance,
      comprehension: `Propagation d'une onde de ${frequence} Hz (célérité du son dans l'air${deuxSources ? ", deuxième source pour l'interférence" : ""}).`,
      suppositions: ["domaine de 10 m", "amortissement 0.998", deuxSources ? "sources à 20 % et 80 % du domaine" : "source unique à 20 %"],
    };
  }

  // ——— Thermique ———
  if (/\b(?:chaleur|diffusion thermique|temperature|température|plaque|thermique|refroidi)\b/.test(q) && !/\b(?:gaz|pression|volume)\b/.test(q)) {
    confiance = 0.8;
    const tSource = a(valeurApres(q, ["source", "chauff", "chaud"], ["°C", "K"]), 100);
    const tInitiale = a(valeurApres(q, ["initiale", "ambiante", "départ", "depart"], ["°C", "K"]), 20);
    const diffusivite = /\b(?:cuivre)\b/.test(q)
      ? 1.11e-4
      : /\b(?:aluminium)\b/.test(q)
        ? 9.7e-5
        : /\b(?:verre|bois|isolant)\b/.test(q)
          ? 3.4e-7
          : 1.11e-4;
    if (diffusivite === 1.11e-4 && !/\bcuivre\b/.test(q)) suppositions.push("matériau = cuivre (diffusivité 1.11e-4 m²/s)");
    return {
      spec: {
        type: "diffusionChaleur",
        diffusivite,
        temperatureSource: tSource,
        temperatureInitiale: tInitiale,
        duree: a(valeurApres(q, ["durée", "duree", "pendant", "après", "apres"], ["s", "min", "ms"]), 30),
        resolution: 96,
      },
      confiance,
      comprehension: `Diffusion de la chaleur : source à ${tSource} °C, plaque initialement à ${tInitiale} °C.`,
      suppositions: ["plaque de 10 cm, bords isolés", ...suppositions],
    };
  }

  if (/\b(?:gaz|pression|boyle|mariotte|adiabatique|isotherme|isobare|isochore|thermodynamique)\b/.test(q)) {
    confiance = 0.85;
    const processus = /\badiabatique\b/.test(q)
      ? "adiabatique" as const
      : /\bisotherme\b/.test(q)
        ? "isotherme" as const
        : /\bisobare\b/.test(q)
          ? "isobare" as const
          : /\bisochore\b/.test(q)
            ? "isochore" as const
            : ("isotherme" as const);
    const facteur = a(valeurApres(q, ["détend", "detend", "compresse", "double", "augmente", "varie"], []), 2);
    return {
      spec: {
        type: "gazParfait",
        moles: a(valeurApres(q, ["mol"], ["mol"]), 1),
        volume: a(valeurApres(q, ["volume"], ["m3", "m³", "L"]), 0.0224),
        temperature: a(valeurApres(q, ["température", "temperature", "à", "de"], ["K", "°C"]), 273.15),
        processus,
        facteurVariation: facteur,
      },
      confiance,
      comprehension: `Transformation ${processus} d'un gaz parfait, facteur de variation ${facteur}.`,
      suppositions: ["gaz monoatomique (γ = 5/3)", "1 mol à 273.15 K, 22.4 L par défaut"],
    };
  }

  // ——— Électromagnétisme ———
  if (/\b(?:rlc|circuit|condensateur|bobine|inductance)\b/.test(q)) {
    confiance = 0.85;
    return {
      spec: {
        type: "circuitRLC",
        resistance: a(valeurApres(q, ["résistance", "resistance", "R =", "R="], ["Ω", "ohm"]), 10),
        inductance: a(valeurApres(q, ["inductance", "bobine", "L =", "L="], ["H"]), 1e-3),
        capacite: a(valeurApres(q, ["capacité", "capacite", "condensateur", "C =", "C="], ["F", "µF", "nF", "pF"]), 1e-9),
        tensionInitiale: a(valeurApres(q, ["tension", "chargé", "charge"], ["V"]), 5),
      },
      confiance,
      comprehension: "Circuit RLC série libre (décharge oscillante du condensateur).",
      suppositions: ["R = 10 Ω, L = 1 mH, C = 1 nF, u₀ = 5 V par défaut"],
    };
  }

  // Champ électrostatique — APRÈS le circuit RLC (« décharge » ne doit pas
  // piéger « charge » : frontière de mot Unicode explicite).
  if (/\b(?:champ [ée]lectrique|coulomb|dip[ôo]le|[ée]lectrostatique)\b/.test(q) || /(?<![\p{L}])charges?(?![\p{L}])/u.test(q)) {
    confiance = 0.85;
    const charges: ChargePonctuelle[] = [];
    if (/\b(?:dip[ôo]le|deux charges|2 charges|\+q.*-q|-q.*\+q)\b/u.test(q)) {
      charges.push({ x: -1e-9, y: 0, q: 1, nom: "+q" }, { x: 1e-9, y: 0, q: -1, nom: "−q" });
    } else {
      charges.push({ x: 0, y: 0, q: 1, nom: "q" });
    }
    return {
      spec: { type: "champElectrique", charges, taille: 2e-9, resolution: 96 },
      confiance,
      comprehension: `Cartographie du champ électrique de ${charges.length} charge(s) sur un domaine de 2 nm.`,
      suppositions: ["charges en multiples de e", "domaine carré de 2 nm centré sur l'origine"],
    };
  }

  // ——— Fluides ———
  if (/\b(?:[ée]coulement|cylindre|aile|aérodynamique|aerodynamique|fluide|vent|jet)\b/.test(q)) {
    confiance = 0.8;
    return {
      spec: {
        type: "ecoulementCylindre",
        vitesseLointaine: a(valeurApres(q, ["vitesse", "vent", "à", "de"], ["m/s", "km/h"]), 10),
        rayon: a(valeurApres(q, ["rayon", "diamètre", "diametre", "cylindre"], ["m", "cm"]), 1),
        densite: /\b(?:eau)\b/.test(q) ? 1000 : 1.2,
        resolution: 96,
      },
      confiance,
      comprehension: "Écoulement potentiel autour d'un cylindre (fluide parfait).",
      suppositions: [/\beau\b/.test(q) ? "fluide = eau (1000 kg/m³)" : "fluide = air (1.2 kg/m³)", "viscosité négligée (modèle potentiel)"],
    };
  }

  if (/\b(?:torricelli|vidange|r[ée]servoir|robinet|se vide|fuite)\b/.test(q)) {
    confiance = 0.85;
    return {
      spec: {
        type: "torricelli",
        hauteurEau: a(valeurApres(q, ["hauteur", "niveau", "rempli"], ["m", "cm"]), 2),
        hauteurOrifice: a(valeurApres(q, ["orifice", "fond", "trou"], ["m", "cm"]), 0),
        surfaceReservoir: a(valeurApres(q, ["réservoir", "reservoir", "cuve"], ["m2", "m²"]), 1),
        surfaceOrifice: a(valeurApres(q, ["orifice", "trou"], ["m2", "m²", "cm2"]), 0.0001),
      },
      confiance,
      comprehension: "Vidange d'un réservoir par un orifice (Torricelli).",
      suppositions: ["fluide parfait, orifice fin", "S = 1 m², s = 1 cm² par défaut"],
    };
  }

  // ——— Mécanique ———
  if (/\b(?:pendule|balan[çc]oire|oscillateur simple)\b/.test(q)) {
    confiance = 0.9;
    return {
      spec: {
        type: "pendule",
        longueur: a(valeurApres(q, ["longueur", "corde", "fil"], ["m", "cm"]), 1),
        angleDeg: a(valeurApres(q, ["angle", "lâché", "lache", "écarté", "ecarte", "de"], ["deg", "°", "degés"]), 30),
        amortissement: a(valeurApres(q, ["amortissement", "frottement"], []), 0),
      },
      confiance,
      comprehension: "Pendule non linéaire (sin θ complet), oscillation libre ou amortie.",
      suppositions: ["masse ponctuelle, fil rigide sans masse"],
    };
  }

  if (/\b(?:ressort|raideur|hooke)\b/.test(q)) {
    confiance = 0.9;
    return {
      spec: {
        type: "ressort",
        raideur: a(valeurApres(q, ["raideur", "constante de", "k =", "k="], []), 50),
        masse: a(valeurApres(q, ["masse"], ["kg", "g"]), 1),
        amortissement: a(valeurApres(q, ["amortissement", "frottement"], []), 0.5),
        x0: a(valeurApres(q, ["étiré", "etire", "comprimé", "comp", "écart"], ["m", "cm"]), 0.1),
      },
      confiance,
      comprehension: "Oscillateur masse-ressort amorti (loi de Hooke).",
      suppositions: ["k = 50 N/m, m = 1 kg par défaut"],
    };
  }

  if (/\b(?:orbite|lune|plan[èe]te|[ée]toiles?|n\s?corps|gravitation|satellite)\b/.test(q)) {
    confiance = 0.85;
    const doubleEtoile = /\b(?:deux [ée]toiles|2 [ée]toiles|double)\b/.test(q);
    return {
      spec: {
        type: "nCorps",
        duree: a(valeurApres(q, ["durée", "duree", "pendant"], ["s", "min", "h", "ans"]), 2_592_000),
        pas: 60,
        scenario: doubleEtoile ? "double-etoile" : "terre-lune",
      },
      confiance,
      comprehension: doubleEtoile
        ? "Système binaire : deux étoiles de masse solaire en orbite mutuelle."
        : "Système Terre–Lune (gravitation newtonienne à 2 corps).",
      suppositions: ["orbites coplanaires, softening de Plummer anti-singularité"],
    };
  }

  if (/\b(?:projectile|balistique|parabole|tir|lancé|lance|boulet|obus|jette)\b/.test(q)) {
    confiance = 0.9;
    const v0 = a(valeurApres(q, ["à", "vitesse", "lancé à", "lance a"], ["m/s", "km/h"]), 30);
    const angle = a(valeurApres(q, ["angle", "degrés", "degrés"], ["deg", "°"]), 45);
    const trainee = /\b(?:air|tra[îi]n[ée]e|frottement|atmosph[èe]re|r[ée]sistance)\b/.test(q) ? 0.01 : 0;
    return {
      spec: {
        type: "projectile",
        v0,
        angleDeg: angle,
        altitude0: a(valeurApres(q, ["hauteur", "altitude"], ["m"]), 0),
        trainee,
        masse: a(valeurApres(q, ["masse"], ["kg", "g"]), 1),
      },
      confiance,
      comprehension: `Projectile : v₀ = ${v0} m/s, angle ${angle}°, ${trainee > 0 ? "avec" : "sans"} traînée de l'air.`,
      suppositions: trainee > 0 ? ["k de traînée = 0.01 kg/m"] : ["pas de traînée (projectile idéal) — dites « avec l'air » pour l'inclure"],
    };
  }

  if (/\b(?:chute|parachute|tombe|gravit[ée] seul)\b/.test(q)) {
    confiance = 0.85;
    const parachute = /\bparachute\b/.test(q);
    return {
      spec: {
        type: "chuteLibre",
        masse: a(valeurApres(q, ["masse"], ["kg", "g"]), 80),
        trainee: parachute ? 6 : a(valeurApres(q, ["traînée", "trainee", "frottement"], []), 0.3),
        altitude0: a(valeurApres(q, ["hauteur", "altitude", "depuis"], ["m", "km"]), 4000),
      },
      confiance,
      comprehension: `Chute${parachute ? " avec parachute (forte traînée)" : " avec traînée atmosphérique"} depuis ${a(valeurApres(q, ["hauteur", "altitude", "depuis"], ["m", "km"]), 4000)} m.`,
      suppositions: ["traînée quadratique k = masse·g/v²limite implicite"],
    };
  }

  // ——— Aucune intention physique ———
  return null;
}

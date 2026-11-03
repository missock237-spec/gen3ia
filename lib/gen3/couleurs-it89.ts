/**
 * GÉNÉRATEUR COULEURS (it.89 — demande propriétaire : 10 millions de
 * données « reconnaissance des couleurs, leurs propriétés et leurs
 * mélanges »).
 *
 * Sources de vérité unique : PALETTE (24 couleurs nommées, RGB canonique)
 * + les FONCTIONS PURES (voisin, temperature, luminosite, melangeLumiere,
 * melangePigment, complementaire). Génération, vérification et chat
 * instancié passent par LES MÊMES fonctions — zéro divergence possible
 * (pattern interrogation-milliard it.86).
 *
 * Familles :
 *   R — reconnaissance : « Quelle couleur porte le code hexa #RRGGBB ? »
 *   P — propriétés    : température (chaude/froide/neutre) + luminosité
 *                       (claire/sombre/moyenne) du même code
 *   M — mélanges      : lumière (additif, somme des canaux bornée à 255) et
 *                       pigments (soustractif simplifié), couleurs de la PALETTE
 *   H — décomposition : « Décompose #RRGGBB en rouge, vert et bleu. »
 *   C — complémentaire: inversion des canaux (255 - x)
 *
 * Injectivité : R/H/C parcourent l'espace RGB complet (pas 1 → 16 777 216
 * couleurs exactes chacune, le pas étant contrôlé par env pour le
 * BALAYAGE) ; P dérive du même espace ; M énumère les paires non ordonnées
 * de la palette × 2 formules. Capacité totale mesurée par capaciteTotale().
 */

export type Rgb = readonly [number, number, number];

export interface CouleurPalette {
  readonly nom: string;
  readonly rgb: Rgb;
  readonly temperature: "chaude" | "froide" | "neutre";
}

// 24 couleurs nommées — RGB canonique (usage francophone courant).
export const PALETTE: readonly CouleurPalette[] = [
  { nom: "noir", rgb: [0, 0, 0], temperature: "neutre" },
  { nom: "blanc", rgb: [255, 255, 255], temperature: "neutre" },
  { nom: "gris", rgb: [128, 128, 128], temperature: "neutre" },
  { nom: "argent", rgb: [192, 192, 192], temperature: "neutre" },
  { nom: "rouge", rgb: [255, 0, 0], temperature: "chaude" },
  { nom: "bordeaux", rgb: [128, 0, 0], temperature: "chaude" },
  { nom: "corail", rgb: [255, 127, 80], temperature: "chaude" },
  { nom: "orange", rgb: [255, 128, 0], temperature: "chaude" },
  { nom: "jaune", rgb: [255, 255, 0], temperature: "chaude" },
  { nom: "or", rgb: [255, 215, 0], temperature: "chaude" },
  { nom: "marron", rgb: [139, 69, 19], temperature: "chaude" },
  { nom: "beige", rgb: [245, 245, 220], temperature: "chaude" },
  { nom: "rose", rgb: [255, 128, 192], temperature: "chaude" },
  { nom: "vert", rgb: [0, 255, 0], temperature: "froide" },
  { nom: "vert anis", rgb: [127, 255, 0], temperature: "froide" },
  { nom: "olive", rgb: [128, 128, 0], temperature: "froide" },
  { nom: "kaki", rgb: [107, 142, 35], temperature: "froide" },
  { nom: "turquoise", rgb: [64, 224, 208], temperature: "froide" },
  { nom: "cyan", rgb: [0, 255, 255], temperature: "froide" },
  { nom: "bleu", rgb: [0, 0, 255], temperature: "froide" },
  { nom: "indigo", rgb: [75, 0, 130], temperature: "froide" },
  { nom: "violet", rgb: [128, 0, 255], temperature: "froide" },
  { nom: "magenta", rgb: [255, 0, 255], temperature: "froide" },
  { nom: "lavande", rgb: [230, 230, 250], temperature: "froide" },
];

const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, "0");

export function versHex([r, g, b]: Rgb): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function depuisHex(hx: string): Rgb | null {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hx.trim());
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** Couleur de la PALETTE la plus proche (distance euclidienne RGB, tie → ordre de la palette). */
export function voisine([r, g, b]: Rgb): CouleurPalette {
  let meilleure = PALETTE[0];
  let dMin = Infinity;
  for (const c of PALETTE) {
    const d = (c.rgb[0] - r) ** 2 + (c.rgb[1] - g) ** 2 + (c.rgb[2] - b) ** 2;
    if (d < dMin) {
      dMin = d;
      meilleure = c;
    }
  }
  return meilleure;
}

export function luminosite([r, g, b]: Rgb): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

export function qualifieLuminosite(c: Rgb): "claire" | "sombre" | "moyenne" {
  const L = luminosite(c);
  if (L >= 170) return "claire";
  if (L <= 85) return "sombre";
  return "moyenne";
}

/** Mélange de LUMIÈRE (additif) : somme des canaux bornée à 255 — rouge+vert=jaune. */
export function melangeLumiere(a: Rgb, b: Rgb): Rgb {
  return [
    Math.min(255, a[0] + b[0]),
    Math.min(255, a[1] + b[1]),
    Math.min(255, a[2] + b[2]),
  ];
}

/** Mélange de PIGMENTS (soustractif simplifié) : 255 - moyenne des complémentaires. */
export function melangePigment(a: Rgb, b: Rgb): Rgb {
  return melangeLumiere([255 - a[0], 255 - a[1], 255 - a[2]], [255 - b[0], 255 - b[1], 255 - b[2]]);
}

/** Complémentaire : inversion des canaux. */
export function complementaire([r, g, b]: Rgb): Rgb {
  return [255 - r, 255 - g, 255 - b];
}

export function parNom(nom: string): CouleurPalette | undefined {
  const cible = nom.trim().toLowerCase();
  return PALETTE.find((c) => c.nom === cible);
}

// ─── Espaces de questions (capacité mesurée) ───────────────────────────────

export const R_MAX = 255; // pas 1 : l'espace RGB complet

export interface QuestionCouleur {
  readonly famille: "R" | "P" | "M" | "H" | "C";
  readonly prompt: string;
  readonly reponse: string;
  readonly extraitsVerifiables: readonly string[];
}

const gabaritsReconnaissance = [
  (hx: string) => `Quelle couleur porte le code hexa ${hx} ?`,
  (hx: string) => `À quelle couleur de la palette correspond ${hx} ?`,
];

const gabaritsPropriete = [
  (hx: string) => `La couleur ${hx} est-elle chaude ou froide, et claire, sombre ou moyenne ?`,
  (hx: string) => `Décris la température et la luminosité de ${hx}.`,
];

const gabaritsComplementaire = [
  (hx: string) => `Quelle est la couleur complémentaire de ${hx} ?`,
  (hx: string) => `Si j'inverse les canaux de ${hx}, quel code et quelle couleur obtient-on ?`,
];

/**
 * Question par (famille, index d'espace, variante). Déterministe et injectif
 * par (famille, variante, couleur) : un même prompt n'apparaît que pour une
 * couleur (les gabarits ne contiennent que la couleur).
 */
export function questionCouleur(famille: "R" | "P" | "H" | "C", couleur: Rgb, variante = 0): QuestionCouleur {
  const hx = versHex(couleur);
  const nom = voisine(couleur).nom;
  const L = qualifieLuminosite(couleur);
  const temp = voisine(couleur).temperature;
  if (famille === "R") {
    const g = gabaritsReconnaissance[variante % 2];
    return {
      famille: "R",
      prompt: g(hx),
      reponse: `1) Je lis les canaux de ${hx} : R=${couleur[0]}, V=${couleur[1]}, B=${couleur[2]}. 2) Je cherche la couleur de la palette la plus proche : ${nom}. Donc : ${hx} est le code du ${nom}.`,
      extraitsVerifiables: [nom],
    };
  }
  if (famille === "P") {
    const g = gabaritsPropriete[variante % 2];
    return {
      famille: "P",
      prompt: g(hx),
      reponse: `1) Canaux de ${hx} : R=${couleur[0]}, V=${couleur[1]}, B=${couleur[2]}. 2) Luminosité : 0,299×${couleur[0]} + 0,587×${couleur[1]} + 0,114×${couleur[2]} = ${luminosite(couleur)} → ${L}. 3) Le plus proche de la palette est le ${nom}, classé ${temp}. Donc : ${hx} est une couleur ${temp} et ${L}.`,
      extraitsVerifiables: [temp, L],
    };
  }
  if (famille === "H") {
    return {
      famille: "H",
      prompt: `Décompose le code hexa ${hx} en valeurs de rouge, vert et bleu.`,
      reponse: `1) Je découpe ${hx} en trois octets : ${hex2(couleur[0])}, ${hex2(couleur[1])}, ${hex2(couleur[2])}. 2) Chaque octet vaut son poids en base 16. Donc : rouge = ${couleur[0]}, vert = ${couleur[1]}, bleu = ${couleur[2]}.`,
      extraitsVerifiables: [`rouge = ${couleur[0]}`, `vert = ${couleur[1]}`, `bleu = ${couleur[2]}`],
    };
  }
  const g = gabaritsComplementaire[variante % 2];
  const comp = complementaire(couleur);
  const nomComp = voisine(comp).nom;
  return {
    famille: "C",
    prompt: g(hx),
    reponse: `1) Le complémentaire inverse chaque canal : 255-${couleur[0]} = ${comp[0]}, 255-${couleur[1]} = ${comp[1]}, 255-${couleur[2]} = ${comp[2]}. 2) Le code obtenu est ${versHex(comp)}, le plus proche de la palette est le ${nomComp}. Donc : le complémentaire de ${hx} est ${versHex(comp)} (${nomComp}).`,
    extraitsVerifiables: [versHex(comp), nomComp],
  };
}

export function questionMelange(a: CouleurPalette, b: CouleurPalette, mode: "lumiere" | "pigment"): QuestionCouleur {
  const res = mode === "lumiere" ? melangeLumiere(a.rgb, b.rgb) : melangePigment(a.rgb, b.rgb);
  const nom = voisine(res).nom;
  const hx = versHex(res);
  const formule =
    mode === "lumiere"
      ? `somme des canaux bornée à 255 : R=${a.rgb[0]}+${b.rgb[0]}, V=${a.rgb[1]}+${b.rgb[1]}, B=${a.rgb[2]}+${b.rgb[2]}`
      : `soustractif : on moyenne les complémentaires puis on ré-inverse`;
  return {
    famille: "M",
    prompt:
      mode === "lumiere"
        ? `On mélange de la lumière ${a.nom} (${versHex(a.rgb)}) et de la lumière ${b.nom} (${versHex(b.rgb)}). Quelle couleur obtient-on ?`
        : `On mélange des pigments ${a.nom} (${versHex(a.rgb)}) et ${b.nom} (${versHex(b.rgb)}). Quelle couleur obtient-on ?`,
    reponse: `1) Mélange ${mode === "lumiere" ? "de lumière (additif)" : "de pigments (soustractif)"} : ${formule}. 2) Le code obtenu est ${hx}, le plus proche de la palette est le ${nom}. Donc : ${a.nom} + ${b.nom} en ${mode === "lumiere" ? "lumière" : "pigments"} donnent le ${nom} (${hx}).`,
    extraitsVerifiables: [hx, nom],
  };
}

/** Capacité totale HONNÊTE (mesurée, pas supposée). */
export function capaciteTotale(pas = 1): number {
  const n = Math.floor(R_MAX / pas) + 1;
  const couleurs = n ** 3;
  // R ×2 variantes, P ×2, H ×1, C ×2 — par couleur exacte
  const parEspace = couleurs * 7;
  // M : paires non ordonnées de la palette × 2 formules
  const melanges = (PALETTE.length * (PALETTE.length - 1)) / 2 * 2;
  return parEspace + melanges;
}

/** Petit générateur pseudo-aléatoire déterministe (xorshift32). */
export function alea(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

/** Échantillon stratifié déterministe de questions (sans doublon de prompt). */
export function echantillonCouleurs(n: number, seed = 20261103): QuestionCouleur[] {
  const rnd = alea(seed);
  const vus = new Set<string>();
  const out: QuestionCouleur[] = [];
  const familles: Array<"R" | "P" | "H" | "C"> = ["R", "P", "H", "C"];
  let garde = 0;
  while (out.length < n && garde < n * 40) {
    garde += 1;
    const f = familles[Math.floor(rnd() * familles.length)];
    const couleur: Rgb = [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)];
    const variante = Math.floor(rnd() * 2);
    const q = questionCouleur(f, couleur, variante);
    if (vus.has(q.prompt)) continue;
    vus.add(q.prompt);
    out.push(q);
  }
  // ajoute des mélanges (10 % du total demandé)
  const nbMelanges = Math.max(1, Math.floor(n / 10));
  for (let i = 0; i < nbMelanges && out.length < n + nbMelanges; i++) {
    const a = PALETTE[Math.floor(rnd() * PALETTE.length)];
    const b = PALETTE[Math.floor(rnd() * PALETTE.length)];
    if (a.nom === b.nom) continue;
    const mode = i % 2 === 0 ? "lumiere" : "pigment";
    const q = questionMelange(a, b, mode);
    if (vus.has(q.prompt)) continue;
    vus.add(q.prompt);
    out.push(q);
  }
  return out;
}

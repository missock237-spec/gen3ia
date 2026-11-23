/**
 * MOTEUR DES COULEURS — solveur DÉTERMINISTE du cerveau Gen3 (v5, Job 478451).
 *
 * Demande : « donne-lui tout ce dont il a besoin » pour la RECONNAISSANCE DES
 * COULEURS, LEURS PROPRIÉTÉS ET LEURS MÉLANGES. Ce module répond EXACTEMENT
 * (aucune IA externe, aucun simulacre) :
 *   - identification d'une couleur nommée (FR/EN, palette de 1 310 couleurs
 *     réelles : enquête XKCD + canoniques W3C) ou d'un hex/rgb() ;
 *   - propriétés : RGB ↔ HEX ↔ HSL, luminance relative (Rec. 709 sRGB
 *     linéarisé), température, clarté, saturation ;
 *   - mélanges : moyenne RGB numérique (synthèse additive) + table des
 *     mélanges artistiques soustractifs documentés (rouge+jaune=orange…) ;
 *   - complémentaire (teinte + 180°) ;
 *   - contraste WCAG 2.1 contre blanc/noir + verdict AA ;
 *   - daltonisme : simulation par les matrices de Machado et al. (2009,
 *     sévérité 1.0) — protanopie, deutéranopie, tritanopie ;
 *   - famille canonique la plus proche (distance angulaire de teinte).
 *
 * Module PUR : zéro I/O, zéro dépendance — testable unitairement (cf.
 * moteur-couleurs.test.ts) et branché dans engine.composer avant le cortex.
 */

import { PALETTE_COULEURS } from "./palette-couleurs";

export interface CouleurResolue {
  nom: string;
  nomNormalise: string;
  hex: string;
  rgb: [number, number, number];
  source: "palette" | "hex" | "rgb";
}

// ── Normalisation FR/EN (miroir du normalizeur lexical du moteur) ────────────

export function normaliserCouleur(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Petits noms FR → EN pour atteindre la palette XKCD (anglaise). */
const FR_VERS_EN: Record<string, string> = {
  rouge: "red", bleu: "blue", vert: "green", jaune: "yellow", orange: "orange",
  violet: "purple", rose: "pink", brun: "brown", marron: "brown", noir: "black",
  blanc: "white", gris: "gray", cyan: "cyan", magenta: "magenta",
  or: "gold", corail: "coral", indigo: "indigo", lavande: "lavender",
  bordeaux: "maroon", olive: "olive", saumon: "salmon", sienne: "sienna",
  argent: "silver", tomate: "tomato", turquoise: "turquoise", ble: "wheat",
  kaki: "khaki", ivoire: "ivory", prune: "plum", azur: "azure",
  bege: "beige", beige: "beige", carmin: "crimson", marine: "navy",
  sarcelle: "teal", aigue: "aquamarine", "aigue-marine": "aquamarine",
  citron: "lime", "citron vert": "lime", ciel: "sky blue", mer: "sea green",
  foret: "forest green", feu: "firebrick", soleil: "sunny yellow",
};

/** Index de la palette (nom normalisé → entrée), construit une fois. */
const INDEX_PALETTE = new Map<string, { nom: string; hex: string }>();
for (const [nom, hex] of PALETTE_COULEURS) {
  INDEX_PALETTE.set(normaliserCouleur(nom), { nom, hex });
}

// ── Conversions (formules standards, déterministes) ──────────────────────────

export function hexVersRgb(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function rgbVersHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function rgbVersHsl(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l * 100];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (mx === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s * 100, l * 100];
}

export function luminanceRelative(r: number, g: number, b: number): number {
  const canal = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

export function contrasteWcag(
  c1: [number, number, number],
  c2: [number, number, number],
): number {
  const l1 = luminanceRelative(...c1);
  const l2 = luminanceRelative(...c2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Matrices de Machado, Oliveira & Fernandes (2009), sévérité 1.0. */
const MATRICES_DALTONISME = {
  protanopie: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786289, 0.099208],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopie: [
    [0.367322, 0.860646, -0.227968],
    [0.11978, 0.916302, -0.036082],
    [-0.011634, 0.029407, 0.982227],
  ],
  tritanopie: [
    [1.255528, -0.076749, -0.178779],
    [0.076, 0.930808, -0.006808],
    [-0.004634, 0.138104, 0.86653],
  ],
} as const;

export type TypeDaltonisme = keyof typeof MATRICES_DALTONISME;

export function simulerDaltonisme(
  rgb: [number, number, number],
  type: TypeDaltonisme,
): [number, number, number] {
  const m = MATRICES_DALTONISME[type];
  const [r, g, b] = rgb;
  const proj = m.map(
    (ligne) => ligne[0] * r + ligne[1] * g + ligne[2] * b,
  );
  return proj.map((v) => Math.max(0, Math.min(255, Math.round(v)))) as [
    number,
    number,
    number,
  ];
}

/** Familles canoniques (teinte de référence). */
const FAMILLES: Array<{ nom: string; hex: string }> = [
  { nom: "rouge (red)", hex: "#ff0000" },
  { nom: "orange", hex: "#ff7f00" },
  { nom: "jaune (yellow)", hex: "#ffff00" },
  { nom: "vert (green)", hex: "#00ff00" },
  { nom: "cyan", hex: "#00ffff" },
  { nom: "bleu (blue)", hex: "#0000ff" },
  { nom: "violet (purple)", hex: "#7d3cbf" },
  { nom: "magenta", hex: "#ff00ff" },
];

/** Mélanges artistiques soustractifs documentés (référence pédagogique). */
const MELANGES_ARTISTIQUES: Array<{
  a: string; b: string; resultat: string; hex: string;
}> = [
  { a: "rouge", b: "jaune", resultat: "orange", hex: "#ff7f00" },
  { a: "red", b: "yellow", resultat: "orange", hex: "#ff7f00" },
  { a: "rouge", b: "bleu", resultat: "violet", hex: "#7d3cbf" },
  { a: "red", b: "blue", resultat: "purple/violet", hex: "#7d3cbf" },
  { a: "jaune", b: "bleu", resultat: "vert", hex: "#2e9e4f" },
  { a: "yellow", b: "blue", resultat: "green", hex: "#2e9e4f" },
  { a: "rouge", b: "vert", resultat: "brun terreux (neutralisation)", hex: "#8b5a2b" },
  { a: "red", b: "green", resultat: "earthy brown (neutralization)", hex: "#8b5a2b" },
  { a: "jaune", b: "violet", resultat: "gris neutre (neutralisation)", hex: "#8f8577" },
  { a: "yellow", b: "purple", resultat: "neutral gray (neutralization)", hex: "#8f8577" },
  { a: "bleu", b: "orange", resultat: "gris-brun neutre (neutralisation)", hex: "#8b7b6b" },
  { a: "blue", b: "orange", resultat: "neutral gray-brown (neutralization)", hex: "#8b7b6b" },
  { a: "blanc", b: "rouge", resultat: "rose (teinte pastel)", hex: "#ff8080" },
  { a: "white", b: "red", resultat: "pink (pastel tint)", hex: "#ff8080" },
  { a: "noir", b: "rouge", resultat: "rouge sombre (ombre)", hex: "#7f0000" },
  { a: "black", b: "red", resultat: "dark red (shade)", hex: "#7f0000" },
];

// ── Résolution d'une mention de couleur dans le texte ────────────────────────

function resolverMention(motif: string): CouleurResolue | null {
  const n = normaliserCouleur(motif);
  if (!n) return null;
  // 1) hex direct
  const hexMatch = motif.match(/#([0-9a-fA-F]{6})\b/);
  if (hexMatch) {
    const rgb = hexVersRgb(hexMatch[0]);
    if (rgb) {
      return { nom: `hex ${hexMatch[0].toLowerCase()}`, nomNormalise: hexMatch[0].toLowerCase(), hex: hexMatch[0].toLowerCase(), rgb, source: "hex" };
    }
  }
  // 2) rgb(r, g, b)
  const rgbMatch = motif.match(/rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/i);
  if (rgbMatch) {
    const rgb = [
      Math.min(255, Number(rgbMatch[1])),
      Math.min(255, Number(rgbMatch[2])),
      Math.min(255, Number(rgbMatch[3])),
    ] as [number, number, number];
    const hex = rgbVersHex(...rgb);
    return { nom: `rgb(${rgb.join(", ")})`, nomNormalise: hex, hex, rgb, source: "rgb" };
  }
  // 3) nom FR/EN — la PLUS LONGUE correspondance dans la palette (bilingual)
  const tr = normaliserCouleur(motif);
  let meilleure: { nom: string; hex: string } | null = null;
  if (INDEX_PALETTE.has(tr)) meilleure = INDEX_PALETTE.get(tr)!;
  if (!meilleure) {
    // correspondance par sous-chaîne de mots (jusqu'à 3 mots consécutifs)
    const mots = tr.split(" ");
    for (let taille = 3; taille >= 1; taille--) {
      for (let i = 0; i + taille <= mots.length; i++) {
        const fenetre = mots.slice(i, i + taille).join(" ");
        const traduite = FR_VERS_EN[fenetre] ?? fenetre;
        for (const candidat of [fenetre, traduite]) {
          const entree = INDEX_PALETTE.get(candidat);
          if (entree) {
            if (!meilleure || entree.nom.length > meilleure.nom.length) {
              meilleure = entree;
            }
          }
        }
      }
      if (meilleure) break;
    }
  }
  if (!meilleure) return null;
  const rgb = hexVersRgb(meilleure.hex);
  if (!rgb) return null;
  return {
    nom: meilleure.nom,
    nomNormalise: normaliserCouleur(meilleure.nom),
    hex: meilleure.hex,
    rgb,
    source: "palette",
  };
}

function temperatureFr(h: number): string {
  if (h < 70 || h >= 300) return "chaude";
  if (h < 160) return "neutre-fraîche";
  return "froide";
}

function temperatureEn(h: number): string {
  if (h < 70 || h >= 300) return "warm";
  if (h < 160) return "neutral-cool";
  return "cool";
}

function clarteFr(l: number): string {
  return l >= 60 ? "claire" : l >= 30 ? "moyenne" : "sombre";
}

function verdictContraste(ratio: number): string {
  return ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA grand texte seulement" : "échec WCAG";
}

function familleProche(h: number): { nom: string; distance: number } {
  let meilleure = FAMILLES[0];
  let distance = Infinity;
  for (const f of FAMILLES) {
    const hf = rgbVersHsl(...(hexVersRgb(f.hex) as [number, number, number]))[0];
    const delta = Math.abs(((h - hf + 540) % 360) - 180);
    if (delta < distance) {
      distance = delta;
      meilleure = f;
    }
  }
  return { nom: meilleure.nom, distance };
}

// ── Patterns de questions ────────────────────────────────────────────────────

interface PatternCouleurs {
  type: "proprietes" | "melange" | "complementaire" | "contraste" | "daltonisme" | "temperature" | "famille" | "identification";
  regex: RegExp;
}

const PATTERNS: PatternCouleurs[] = [
  { type: "melange", regex: /\b(melange|meler|mix|mixing|combine|fusion)\b/i },
  { type: "complementaire", regex: /\b(complementaire|complement|opposee|opposite)\b/i },
  { type: "contraste", regex: /\b(contraste|contrast|wcag|lisibilite|readability)\b/i },
  { type: "daltonisme", regex: /\b(daltonien|daltonisme|protanop|deuteranop|tritanop|color[- ]?blind|blind)\b/i },
  { type: "temperature", regex: /\b(chaude|froide|warm|cool temperature|temperature)\b/i },
  { type: "famille", regex: /\b(familles?|family|familie|analog(?:ue|o|ous)?s?|proches?|nuances?|shade famil(?:y|ie))\b/i },
  { type: "proprietes", regex: /\b(proprietes?|propert(?:y|ies)|hsl|rgb|luminance|teinte|hue|saturation|lumiere|lightness|colorimetr\w*)\b/i },
  { type: "identification", regex: /\b(couleur de|color of|identifie\w*|which color|nom de la couleur|name of the color|nearest color|correspond)\b/i },
];

function detecterType(prompt: string): PatternCouleurs["type"] | null {
  for (const p of PATTERNS) {
    if (p.regex.test(normaliserCouleur(prompt))) return p.type;
  }
  return null;
}

function extraireMentions(prompt: string): CouleurResolue[] {
  const mentions: CouleurResolue[] = [];
  const hexes = prompt.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
  for (const h of hexes) {
    const resolue = resolverMention(h);
    if (resolue) mentions.push(resolue);
  }
  if (mentions.length === 0) {
    // Mentions nommées : essaie chaque segment de 1..4 mots du prompt.
    const mots = prompt.split(/[\s,?:;!.'()+]+/).filter(Boolean);
    for (let i = 0; i < mots.length; i++) {
      for (let taille = 4; taille >= 1; taille--) {
        if (i + taille > mots.length) continue;
        const fenetre = mots.slice(i, i + taille).join(" ");
        const resolue = resolverMention(fenetre);
        if (resolue && resolue.source === "palette") {
          mentions.push(resolue);
          i += taille - 1;
          break;
        }
      }
      if (mentions.length >= 2) break;
    }
  }
  // déduplication par hex
  const vus = new Set<string>();
  return mentions.filter((m) => {
    if (vus.has(m.hex)) return false;
    vus.add(m.hex);
    return true;
  });
}

// ── Point d'entrée : résoudre une requête couleurs ───────────────────────────

/**
 * Tente de répondre EXACTEMENT à une question sur les couleurs.
 * Retourne null si le prompt ne parle pas de couleurs (le moteur de
 * composition du cerveau passe alors au cortex langagier).
 */
export function resoudreCouleurs(prompt: string): string | null {
  const type = detecterType(prompt);
  if (!type) return null;
  const mentions = extraireMentions(prompt);
  if (mentions.length === 0) return null;

  const [c1, c2] = mentions;

  if (type === "melange") {
    if (!c2) return null;
    // Mélanges artistiques documentés d'abord
    const nomA = normaliserCouleur(c1.nom);
    const nomB = normaliserCouleur(c2.nom);
    for (const m of MELANGES_ARTISTIQUES) {
      const ma = normaliserCouleur(m.a);
      const mb = normaliserCouleur(m.b);
      const paire1 = `${ma} ${mb}`;
      const paire2 = `${mb} ${ma}`;
      const cible1 = `${nomA} ${nomB}`;
      const cible2 = `${nomB} ${nomA}`;
      if (paire1 === cible1 || paire1 === cible2 || paire2 === cible1 || paire2 === cible2) {
        return `Mélange artistique (synthèse soustractive, pigments) de ${c1.nom} et ${c2.nom} : ${m.resultat} — référence ${m.hex}. En soustractive, les absorptions se combinent : le résultat est plus sombre et plus neutre que les deux parents. À l'inverse, le mélange numérique additif (lumière) de ces mêmes couleurs donnerait ${rgbVersHex(...moyenneRgb(c1.rgb, c2.rgb))}.`;
      }
    }
    const mix = moyenneRgb(c1.rgb, c2.rgb);
    const hexMix = rgbVersHex(...mix);
    const [h, s, l] = rgbVersHsl(...mix);
    return `Mélange numérique additif (moyenne RGB canal par canal) de ${c1.nom} (${c1.hex}) et ${c2.nom} (${c2.hex}) : RGB (${mix.join(", ")}) = ${hexMix} — HSL (${h.toFixed(0)}°, ${s.toFixed(0)}%, ${l.toFixed(0)}%). La mélange de pigments (soustractif) serait plus sombre : les absorptions se combinent.`;
  }

  if (!c1) return null;
  const [r, g, b] = c1.rgb;
  const [h, s, l] = rgbVersHsl(r, g, b);

  if (type === "proprietes") {
    return `Propriétés colorimétriques de ${c1.nom} (${c1.hex}) : RGB (${r}, ${g}, ${b}) ; HSL (${h.toFixed(0)}°, ${s.toFixed(0)}%, ${l.toFixed(0)}%) ; luminance relative ${luminanceRelative(r, g, b).toFixed(3)} (sRGB linéarisé, Rec. 709) ; teinte ${temperatureEn(h) === "warm" ? "chaude" : temperatureEn(h) === "cool" ? "froide" : "neutre"} (${h.toFixed(0)}°) ; ${clarteFr(l)} en clarté, saturation ${s >= 60 ? "élevée" : s >= 25 ? "modérée" : "faible"}.`;
  }

  if (type === "complementaire") {
    const comp: [number, number, number] = [255 - r, 255 - g, 255 - b];
    const hexC = rgbVersHex(...comp);
    const [hc] = rgbVersHsl(...comp);
    return `Complémentaire de ${c1.nom} (${c1.hex}, teinte ${h.toFixed(0)}°) : ${hexC} — RGB (${comp.join(", ")}), teinte ${hc.toFixed(0)}° (+180°). Associées, ces deux couleurs s'annulent en mixing (gris neutre) et créent le contraste maximal de teinte.`;
  }

  if (type === "contraste") {
    const surBlanc = contrasteWcag(c1.rgb, [255, 255, 255]);
    const surNoir = contrasteWcag(c1.rgb, [0, 0, 0]);
    const lum = luminanceRelative(r, g, b);
    const fond = surBlanc >= surNoir ? "blanc" : "noir";
    const meilleur = Math.max(surBlanc, surNoir);
    return `Contraste WCAG 2.1 de ${c1.nom} (${c1.hex}) : sur blanc = ${surBlanc.toFixed(2)}:1 (${verdictContraste(surBlanc)}) ; sur noir = ${surNoir.toFixed(2)}:1 (${verdictContraste(surNoir)}). Luminance relative = ${lum.toFixed(3)}. Meilleur fond : ${fond} (${meilleur.toFixed(2)}:1). Seuils : AA ≥ 4.5:1 (texte normal), AA ≥ 3:1 (grand texte), AAA ≥ 7:1.`;
  }

  if (type === "daltonisme") {
    const dite = prompt.toLowerCase();
    let type2: TypeDaltonisme = "deuteranopie";
    if (dite.includes("protan")) type2 = "protanopie";
    else if (dite.includes("tritan")) type2 = "tritanopie";
    const sim = simulerDaltonisme(c1.rgb, type2);
    const hexSim = rgbVersHex(...sim);
    const autres = (Object.keys(MATRICES_DALTONISME) as TypeDaltonisme[])
      .filter((t) => t !== type2)
      .map((t) => `${t} → ${rgbVersHex(...simulerDaltonisme(c1.rgb, t))}`)
      .join(" ; ");
    return `Perception de ${c1.nom} (${c1.hex}, RGB ${r},${g},${b}) en ${type2} : ${hexSim} (simulation par les matrices de Machado et al. 2009, sévérité 1.0). ${autres}. Protanopie/deutéranopie confondent l'axe rouge-vert, tritanopie l'axe bleu-jaune.`;
  }

  if (type === "temperature") {
    return `${c1.nom} (${c1.hex}) a une teinte de ${h.toFixed(0)}° : couleur ${temperatureFr(h)}. Repères : chaudes ≈ 0-70° (rouges-oranges-jaunes) et 300-360° (magentas) ; froides ≈ 90-270° (verts-bleus) ; neutres entre les deux.`;
  }

  if (type === "famille") {
    const f = familleProche(h);
    const [hf] = rgbVersHsl(...(hexVersRgb(f.nom.match(/\((#[0-9a-f]{6})\)/)?.[1] ?? "#ff0000") as [number, number, number]));
    void hf;
    return `${c1.nom} (${c1.hex}, teinte ${h.toFixed(0)}°) appartient à la famille ${f.nom} (distance angulaire ${f.distance.toFixed(0)}°). Les couleurs analogues sont à ±30° de teinte ; à ±180° se trouve la complémentaire.`;
  }

  // identification : hex/rgb → couleur nommée la plus proche
  let meilleureNom = "—";
  let meilleureDist = Infinity;
  for (const [nom, hex] of PALETTE_COULEURS) {
    const rgb = hexVersRgb(hex);
    if (!rgb) continue;
    const d = (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
    if (d < meilleureDist) {
      meilleureDist = d;
      meilleureNom = nom;
    }
  }
  return `${c1.hex} (RGB ${r}, ${g}, ${b}) correspond le plus à « ${meilleureNom} » dans la palette de ${PALETTE_COULEURS.length} couleurs réelles (distance RGB euclidienne ≈ ${Math.round(Math.sqrt(meilleureDist))}). HSL : (${h.toFixed(0)}°, ${s.toFixed(0)}%, ${l.toFixed(0)}%).`;
}

function moyenneRgb(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [
    Math.round((a[0] + b[0]) / 2),
    Math.round((a[1] + b[1]) / 2),
    Math.round((a[2] + b[2]) / 2),
  ];
}

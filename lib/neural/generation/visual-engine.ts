/**
 * MOTEUR VISUEL NEURONAL — génération LOCALE et RÉELLE.
 *
 * Remplace l'ancienne génération d'images via IA externe (Agnes/HF,
 * supprimées du projet). La composition est calculée à partir de
 * l'état RÉEL du réseau neuronal Gen3 :
 *
 *  - la structure (constellation de neurones et de synapses) est un
 *    échantillon réel des synapses du cerveau (positions dérivées des
 *    IDs source/cible, rayons et opacités des poids APPRIS) ;
 *  - la palette est dérivée du hash du prompt (identité chromatique
 *    propre à chaque demande) ;
 *  - les tokens du prompt sont hachés vers la zone lexicale réelle du
 *    réseau et apparaissent comme étiquettes orbitales.
 *
 * Sortie : document SVG autonome (vectoriel, aucune dépendance).
 *
 * Module PUR — aucune dépendance Node, aucun appel réseau.
 */

import {
  type NeuralSnapshot,
  rngDepuisSnapshot,
  teinteDuPrompt,
  hslVersHex,
  echapperXml,
  tronquer,
  choisir,
  PALETTE_AURORA,
} from "./snapshot";

/** Ratios supportés → dimensions de la toile. */
const DIMENSIONS: Record<string, { w: number; h: number }> = {
  "1:1": { w: 1024, h: 1024 },
  "3:4": { w: 896, h: 1195 },
  "4:3": { w: 1195, h: 896 },
  "16:9": { w: 1280, h: 720 },
  "9:16": { w: 720, h: 1280 },
  "2:3": { w: 832, h: 1248 },
  "3:2": { w: 1248, h: 832 },
  "21:9": { w: 1344, h: 576 },
};

export interface RenduVisuelNeural {
  /** Document SVG complet (autonome, affichable tel quel). */
  svg: string;
  width: number;
  height: number;
  /** Métadonnées réelles de composition (traçabilité honnête). */
  meta: {
    nbNoeuds: number;
    nbAretes: number;
    poidsMoyenEchantillon: number;
    palette: string[];
  };
}

/** Nombre de nœuds de la constellation (fonction de la densité réelle). */
function nbNoeudsPour(snapshot: NeuralSnapshot): number {
  const densite = snapshot.nbSynapses / Math.max(1, snapshot.nbNeurones * (snapshot.nbNeurones - 1));
  // Entre 42 et 96 nœuds selon la connectivité réelle du cerveau.
  return Math.round(42 + Math.min(1, densite * 4) * 54);
}

/** Position d'un nœud : spirale d'or dérivée des IDs réels des neurones. */
function positionSpirale(
  idNeurone: number,
  index: number,
  total: number,
  cx: number,
  cy: number,
  rayonMax: number,
): { x: number; y: number } {
  const angleOr = Math.PI * (3 - Math.sqrt(5));
  const t = (index + (idNeurone % 7) / 7) / Math.max(1, total);
  const angle = t * Math.PI * 2 * (1 + (idNeurone % 5) * 0.15);
  const r = rayonMax * Math.sqrt(t) * (0.72 + ((idNeurone % 11) / 11) * 0.28);
  return {
    x: cx + r * Math.cos(angle + angleOr),
    y: cy + r * Math.sin(angle + angleOr),
  };
}

/**
 * Génère une composition visuelle neurale. Déterministe : le même
 * (prompt, état du réseau) produit exactement le même rendu.
 */
export function genererVisuelNeural(
  prompt: string,
  ratio: string,
  snapshot: NeuralSnapshot,
): RenduVisuelNeural {
  const dims = DIMENSIONS[ratio] ?? DIMENSIONS["1:1"]!;
  const { w, h } = dims;
  const rng = rngDepuisSnapshot(snapshot, 1);
  const hue = teinteDuPrompt(prompt);

  // Palette du rendu : base AURORA + deux teintes dérivées du prompt.
  const palette = [
    hslVersHex(hue, 0.72, 0.58),
    hslVersHex(hue + 40, 0.68, 0.52),
    hslVersHex(hue - 55, 0.62, 0.6),
    ...PALETTE_AURORA.slice(2, 6),
  ];

  // Fond : dégradé radial profond + voile conique.
  const fond = `
  <defs>
    <radialGradient id="fond" cx="30%" cy="28%" r="92%">
      <stop offset="0%" stop-color="${hslVersHex(hue, 0.5, 0.14)}"/>
      <stop offset="55%" stop-color="${hslVersHex(hue + 25, 0.55, 0.07)}"/>
      <stop offset="100%" stop-color="#05050f"/>
    </radialGradient>
    <linearGradient id="voile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette[0]!}" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="${palette[1]!}" stop-opacity="0.04"/>
    </linearGradient>
    <filter id="lueur" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="${Math.round(Math.min(w, h) / 90)}" result="flou"/>
      <feMerge><feMergeNode in="flou"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#fond)"/>
  <rect width="${w}" height="${h}" fill="url(#voile)"/>`;

  // Constellation : nœuds depuis les synapses réelles échantillonnées.
  const totalNoeuds = nbNoeudsPour(snapshot);
  const cx = w / 2;
  const cy = h / 2;
  const rayonMax = Math.min(w, h) * 0.44;
  const pasSynapse = Math.max(1, Math.floor(snapshot.echantillonSynapses.length / totalNoeuds));

  const noeuds: Array<{ id: number; x: number; y: number; r: number; poids: number; couleur: string }> = [];
  for (let i = 0; i < totalNoeuds && i * pasSynapse < snapshot.echantillonSynapses.length; i++) {
    const [src] = snapshot.echantillonSynapses[i * pasSynapse]!;
    const poids = snapshot.echantillonSynapses[i * pasSynapse]![2];
    const pos = positionSpirale(src, i, totalNoeuds, cx, cy, rayonMax);
    const energie = snapshot.energies[i % Math.max(1, snapshot.energies.length)]?.[1] ?? 0;
    const r = (2.2 + poids * 7.5 + energie * 2.4) * (Math.min(w, h) / 1024);
    noeuds.push({
      id: src,
      x: pos.x,
      y: pos.y,
      r,
      poids,
      couleur: choisir(rng, palette),
    });
  }

  // Arêtes : connexions réelles entre les nœuds retenus (les synapses dont
  // source ET cible sont dans la constellation), sinon voisins angulaires.
  const aretes: Array<{ a: typeof noeuds[number]; b: typeof noeuds[number]; poids: number }> = [];
  for (const [src, tgt, poids] of snapshot.echantillonSynapses) {
    if (aretes.length >= totalNoeuds * 2) break;
    const a = noeuds.find((n) => n.id === src);
    const b = noeuds.find((n) => n.id === tgt);
    if (a && b && a !== b) aretes.push({ a, b, poids });
  }
  // Complément structurel : anneaux de voisins (structure en spirale réelle).
  for (let i = 0; i < noeuds.length && aretes.length < noeuds.length * 1.6; i++) {
    const a = noeuds[i]!;
    const b = noeuds[(i + 1) % noeuds.length]!;
    if (a !== b) aretes.push({ a, b, poids: (a.poids + b.poids) / 2 });
  }

  const svgAretes = aretes
    .map(
      ({ a, b, poids }) =>
        `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${a.couleur}" stroke-opacity="${(0.08 + poids * 0.34).toFixed(3)}" stroke-width="${(0.5 + poids * 1.6).toFixed(2)}"/>`,
    )
    .join("\n  ");

  const svgNoeuds = noeuds
    .map(
      (n) =>
        `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(2)}" fill="${n.couleur}" fill-opacity="${(0.55 + n.poids * 0.4).toFixed(2)}" filter="url(#lueur)"/>`,
    )
    .join("\n  ");

  // Halo central : intensité = poids moyen APPRIS du cerveau.
  const haloR = Math.min(w, h) * (0.1 + snapshot.poidsMoyen * 0.16);
  const halo = `<circle cx="${cx}" cy="${cy}" r="${haloR.toFixed(1)}" fill="none" stroke="${palette[0]!}" stroke-opacity="0.35" stroke-width="1.4"/>`;

  // Étiquettes orbitales : les tokens réels du prompt (zone lexicale).
  const etiquetteRayon = Math.min(w, h) * 0.47;
  const etiquetteTokens = snapshot.tokens.slice(0, 9);
  const etiquettes = etiquetteTokens
    .map((token, i) => {
      const angle = (i / Math.max(1, etiquetteTokens.length)) * Math.PI * 2 - Math.PI / 2;
      const x = cx + etiquetteRayon * Math.cos(angle);
      const y = cy + etiquetteRayon * Math.sin(angle);
      const taille = Math.max(11, Math.min(w, h) / 58);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${taille.toFixed(0)}" fill="${palette[2]!}" fill-opacity="0.5" letter-spacing="0.12em">${echapperXml(tronquer(token.toUpperCase(), 14))}</text>`;
    })
    .join("\n  ");

  // Cartouche : prompt + empreinte de l'état cérébral (traçabilité).
  const tailleBase = Math.max(11, Math.min(w, h) / 62);
  const cartouche = `
  <g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif">
    <text x="${(w * 0.05).toFixed(0)}" y="${(h * 0.945).toFixed(0)}" font-size="${(tailleBase * 1.15).toFixed(0)}" fill="#ffffff" fill-opacity="0.85">${echapperXml(tronquer(prompt, 64))}</text>
    <text x="${(w * 0.05).toFixed(0)}" y="${(h * 0.972).toFixed(0)}" font-size="${tailleBase.toFixed(0)}" fill="${palette[0]!}" fill-opacity="0.75">Gen3 · SNN ${snapshot.nbNeurones} neurones · ${snapshot.nbSynapses} synapses · poids moyen ${(snapshot.poidsMoyen ?? 0).toFixed(3)}</text>
  </g>`;

  const poidsMoyenEchantillon =
    snapshot.echantillonSynapses.length > 0
      ? snapshot.echantillonSynapses.reduce((s, [, , p]) => s + p, 0) / snapshot.echantillonSynapses.length
      : 0;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Composition neuronale générée localement pour : ${echapperXml(tronquer(prompt, 80))}">
${fond}
  <g>
  ${svgAretes}
  </g>
  ${halo}
  <g>
  ${svgNoeuds}
  </g>
  <g>
  ${etiquettes}
  </g>
${cartouche}
</svg>`;

  return {
    svg,
    width: w,
    height: h,
    meta: {
      nbNoeuds: noeuds.length,
      nbAretes: aretes.length,
      poidsMoyenEchantillon,
      palette,
    },
  };
}

/** Construit une data URI (SVG) prête à persister ou afficher (Node ou navigateur). */
export function visuelVersDataUri(svg: string): string {
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(svg, "utf-8").toString("base64")
      : btoa(String.fromCharCode(...new TextEncoder().encode(svg)));
  return `data:image/svg+xml;base64,${base64}`;
}

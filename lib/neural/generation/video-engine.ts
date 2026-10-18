/**
 * MOTEUR VIDÉO NEURONAL — animation vectorielle LOCALE et RÉELLE.
 *
 * Remplace l'ancienne génération vidéo via IA externe (Agnes Video,
 * supprimée du projet). L'animation est calculée localement : un
 * document SVG animé (SMIL — animations natives du navigateur, sans
 * dépendance) dont :
 *
 *  - la constellation de nœuds/arêtes est un échantillon RÉEL des
 *    synapses du cerveau (positions, tailles, opacités dérivées des
 *    poids APPRIS) ;
 *  - les pulsations (rythmes, amplitudes, déphasages) sont dérivées
 *    des poids et des IDs des neurones — chaque nœud respire au
 *    rythme de la synapse réelle qu'il représente ;
 *  - la durée demandée règle la période des boucles d'animation.
 *
 * Sortie : document SVG animé (affichable dans tout navigateur,
 * archivable comme artefact .svg). Aucune frame vidéo IA — une
 * animation vectorielle honnête de l'activité neuronale.
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

export interface RenduVideoNeural {
  /** Document SVG animé (SMIL) complet. */
  svg: string;
  width: number;
  height: number;
  dureeSecondes: number;
  meta: {
    nbNoeuds: number;
    nbAretes: number;
    periodeMs: number;
  };
}

/** Dimensions fixes du rendu (16:9 — format d'animation standard). */
const W = 1280;
const H = 720;

/**
 * Génère une animation neuronale. Déterministe : le même (prompt,
 * état du réseau, durée) produit exactement la même animation.
 */
export function genererVideoNeural(
  prompt: string,
  dureeSecondes: number,
  snapshot: NeuralSnapshot,
): RenduVideoNeural {
  const duree = Math.min(60, Math.max(2, Math.round(dureeSecondes)));
  const rng = rngDepuisSnapshot(snapshot, 3);
  const hue = teinteDuPrompt(prompt);

  const palette = [
    hslVersHex(hue, 0.75, 0.62),
    hslVersHex(hue + 45, 0.7, 0.55),
    hslVersHex(hue - 60, 0.65, 0.6),
    ...PALETTE_AURORA.slice(2, 7),
  ];

  // Constellation : 64 nœuds depuis les synapses réelles.
  const nbNoeuds = 64;
  const cx = W / 2;
  const cy = H / 2;
  const rayonMax = Math.min(W, H) * 0.42;
  const pasSynapse = Math.max(1, Math.floor(snapshot.echantillonSynapses.length / nbNoeuds));

  interface Noeud {
    id: number;
    x: number;
    y: number;
    r: number;
    poids: number;
    couleur: string;
    periodeMs: number;
    dephasageMs: number;
  }

  const noeuds: Noeud[] = [];
  for (let i = 0; i < nbNoeuds && i * pasSynapse < snapshot.echantillonSynapses.length; i++) {
    const [src, , poids] = snapshot.echantillonSynapses[i * pasSynapse]!;
    // Spirale d'or + jitter réel depuis l'ID.
    const angleOr = Math.PI * (3 - Math.sqrt(5));
    const t = (i + (src % 5) / 5) / nbNoeuds;
    const angle = t * Math.PI * 2 + angleOr + (src % 9) * 0.07;
    const r = rayonMax * Math.sqrt(t) * (0.7 + (poids ?? 0.3) * 0.3);
    noeuds.push({
      id: src,
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
      r: 2 + (poids ?? 0.3) * 8,
      poids: poids ?? 0.3,
      couleur: choisir(rng, palette),
      // Période de pulsation : les synapses fortes pulsent plus vite.
      periodeMs: Math.round((duree * 1000) / (1 + (poids ?? 0) * 3 + (src % 4) * 0.5)),
      dephasageMs: (src * 137) % 2400,
    });
  }

  // Arêtes : synapses réelles reliant les nœuds retenus.
  interface Arete { a: Noeud; b: Noeud; poids: number }
  const aretes: Arete[] = [];
  for (const [src, tgt, poids] of snapshot.echantillonSynapses) {
    if (aretes.length >= nbNoeuds * 2) break;
    const a = noeuds.find((n) => n.id === src);
    const b = noeuds.find((n) => n.id === tgt);
    if (a && b && a !== b) aretes.push({ a, b, poids });
  }
  for (let i = 0; i < noeuds.length && aretes.length < nbNoeuds * 1.5; i++) {
    const a = noeuds[i]!;
    const b = noeuds[(i + 3) % noeuds.length]!;
    if (a !== b) aretes.push({ a, b, poids: (a.poids + b.poids) / 2 });
  }

  // Dégradés animés (rotation lente du voile chromatique).
  const defs = `
  <defs>
    <radialGradient id="fond" cx="50%" cy="46%" r="88%">
      <stop offset="0%" stop-color="${hslVersHex(hue, 0.5, 0.16)}">
        <animate attributeName="stop-color" values="${hslVersHex(hue, 0.5, 0.16)};${hslVersHex(hue + 60, 0.55, 0.1)};${hslVersHex(hue, 0.5, 0.16)}" dur="${duree}s" repeatCount="indefinite"/>
      </stop>
      <stop offset="100%" stop-color="#05050f"/>
    </radialGradient>
    <filter id="lueur" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="7" result="flou"/>
      <feMerge><feMergeNode in="flou"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

  const svgAretes = aretes
    .map(({ a, b, poids }) => {
      const periode = Math.round((duree * 1000) / (1 + poids * 2));
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${a.couleur}" stroke-width="${(0.5 + poids * 1.5).toFixed(2)}" stroke-opacity="${(0.1 + poids * 0.3).toFixed(3)}">
    <animate attributeName="stroke-opacity" values="${(0.06 + poids * 0.18).toFixed(3)};${(0.16 + poids * 0.42).toFixed(3)};${(0.06 + poids * 0.18).toFixed(3)}" dur="${(periode / 1000).toFixed(2)}s" begin="${(a.dephasageMs / 1000).toFixed(2)}s" repeatCount="indefinite"/>
  </line>`;
    })
    .join("\n  ");

  const svgNoeuds = noeuds
    .map((n) => {
      const rMin = (n.r * 0.55).toFixed(2);
      const rMax = (n.r * (1.35 + n.poids * 0.6)).toFixed(2);
      return `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(2)}" fill="${n.couleur}" fill-opacity="0.8" filter="url(#lueur)">
    <animate attributeName="r" values="${n.r.toFixed(2)};${rMax};${rMin};${n.r.toFixed(2)}" dur="${(n.periodeMs / 1000).toFixed(2)}s" begin="${(n.dephasageMs / 1000).toFixed(2)}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.35;0.7;1" keySplines="0.4 0 0.2 1;0.4 0 0.2 1;0.4 0 0.2 1"/>
    <animate attributeName="fill-opacity" values="0.5;0.95;0.5" dur="${(n.periodeMs / 1000).toFixed(2)}s" begin="${(n.dephasageMs / 1000).toFixed(2)}s" repeatCount="indefinite"/>
  </circle>`;
    })
    .join("\n  ");

  // Onde de choc centrale : halo rythmé par le poids moyen APPRIS.
  const haloBase = Math.min(W, H) * (0.08 + snapshot.poidsMoyen * 0.14);
  const halo = `<circle cx="${cx}" cy="${cy}" r="${haloBase.toFixed(1)}" fill="none" stroke="${palette[0]!}" stroke-width="1.6" stroke-opacity="0.4">
  <animate attributeName="r" values="${haloBase.toFixed(1)};${(haloBase * 2.1).toFixed(1)};${haloBase.toFixed(1)}" dur="${(duree / 2).toFixed(2)}s" repeatCount="indefinite"/>
  <animate attributeName="stroke-opacity" values="0.45;0.05;0.45" dur="${(duree / 2).toFixed(2)}s" repeatCount="indefinite"/>
</circle>`;

  // Cartouche : prompt + empreinte réelle du cerveau.
  const cartouche = `
  <g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif">
    <text x="64" y="${H - 44}" font-size="17" fill="#ffffff" fill-opacity="0.88">${echapperXml(tronquer(prompt, 72))}</text>
    <text x="64" y="${H - 20}" font-size="13" fill="${palette[0]!}" fill-opacity="0.75">Gen3 · SNN ${snapshot.nbNeurones} neurones · ${snapshot.nbSynapses} synapses · animation ${duree}s · poids moyen ${(snapshot.poidsMoyen ?? 0).toFixed(3)}</text>
  </g>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Animation neuronale générée localement pour : ${echapperXml(tronquer(prompt, 80))}">
${defs}
  <rect width="${W}" height="${H}" fill="url(#fond)"/>
  <g>
  ${svgAretes}
  </g>
  ${halo}
  <g>
  ${svgNoeuds}
  </g>
${cartouche}
</svg>`;

  return {
    svg,
    width: W,
    height: H,
    dureeSecondes: duree,
    meta: {
      nbNoeuds: noeuds.length,
      nbAretes: aretes.length,
      periodeMs: duree * 1000,
    },
  };
}

/** Construit une data URI (SVG animé) prête à persister ou afficher. */
export function videoVersDataUri(svg: string): string {
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(svg, "utf-8").toString("base64")
      : btoa(String.fromCharCode(...new TextEncoder().encode(svg)));
  return `data:image/svg+xml;base64,${base64}`;
}

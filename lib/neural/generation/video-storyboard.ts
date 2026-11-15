/**
 * MOTEUR VIDÉO SCÉNIQUE v2 — storyboard animé LOCAL et RÉEL, sans IA
 * externe, sans GPU.
 *
 * Évolution du moteur v1 (constellation pulsante) : le prompt devient
 * un STORYBOARD. L'analyseur sémantique découpe la demande en 1 à 4
 * scènes (segments du prompt), chaque scène est rendue par le moteur
 * visuel v2 (calques : ciel, astre, cadre, SUJET) puis ANIMÉE :
 *
 *  - caméra : travelling latéral ou zoom lent par scène ;
 *  - sujet : flottement doux (translate SMIL) ;
 *  - météo ANIMÉE : pluie qui tombe, neige qui descend, brouillard qui
 *    respire, éclairs d'orage ;
 *  - oiseaux qui traversent le cadre (forêt, océan, sujet oiseau) ;
 *  - transitions : fondus enchaînés entre les scènes.
 *
 * Sortie : document SVG animé SMIL (les navigateurs l'animent
 * nativement, zéro dépendance, zéro GPU).
 * HONNÊTETÉ : animation vectorielle stylisée — pas un rendu photoréaliste
 * type Veo (écart documenté dans docs/multimodal/gen3-multimodal.md).
 * Aucune scène reconnaissable dans le prompt → repli honnête sur le
 * moteur v1 (assuré par l'appelant).
 *
 * Module PUR — aucune dépendance Node, aucun appel réseau.
 */

import {
  type NeuralSnapshot,
  rngDepuisSnapshot,
  echapperXml,
  tronquer,
} from "./snapshot";
import type { SceneSpec } from "./scene-spec";
import { composerCorpsScene } from "./visual-scene";

export interface RenduVideoScene {
  /** Document SVG animé (SMIL) complet. */
  svg: string;
  width: number;
  height: number;
  dureeSecondes: number;
  meta: {
    nbScenes: number;
    dureeSceneS: number;
    /** Résumé honnête de chaque scène du storyboard. */
    scenes: Array<{
      sujet: string | null;
      cadre: string | null;
      moment: string;
      animations: string[];
    }>;
  };
}

const W = 1280;
const H = 720;

/** Durée totale bornée (identique au v1). */
const DUREE_MIN = 2;
const DUREE_MAX = 60;

/** Fenêtre d'opacité d'une scène (fondus enchaînés, boucle infinie). */
function fenetreOpacity(index: number, nb: number, dureeSceneS: number, totalS: number): {
  values: string;
  keyTimes: string;
} {
  const f = Math.min(0.8, dureeSceneS * 0.3);
  const debut = index * dureeSceneS;
  const fin = (index + 1) * dureeSceneS;
  const points: Array<[number, number]> = [[0, 0], [totalS, 0]];
  const fadeIn0 = Math.max(0, debut - f / 2);
  const fadeIn1 = debut + f / 2;
  const fadeOut0 = fin - f / 2;
  const fadeOut1 = Math.min(totalS, fin + f / 2);
  points.push([fadeIn0, 0], [fadeIn1, 1], [fadeOut0, 1], [fadeOut1, 0]);
  points.sort((a, b) => a[0] - b[0]);
  // Dédoublonnage + bornes strictes 0..1 (contrat SMIL keyTimes).
  const nettoyees: Array<[number, number]> = [];
  for (const [t, v] of points) {
    const tc = Math.min(totalS, Math.max(0, t));
    const precedent = nettoyees[nettoyees.length - 1];
    if (precedent && Math.abs(precedent[0] - tc) < totalS * 0.001) {
      precedent[1] = v;
    } else {
      nettoyees.push([tc, v]);
    }
  }
  if (nettoyees[0]?.[0] !== 0) nettoyees.unshift([0, 0]);
  if (nettoyees[nettoyees.length - 1]?.[0] !== totalS) nettoyees.push([totalS, 0]);
  const valeurs = nettoyees.map(([, v]) => v.toFixed(2)).join(";");
  const clefs = nettoyees.map(([t]) => (t / totalS).toFixed(4)).join(";");
  return { values: valeurs, keyTimes: clefs };
}

/** Mouvement de caméra par scène (alternance déterministe). */
function mouvementCamera(index: number, dureeSceneS: number, rng: () => number): { svg: string; nom: string } {
  const dur = `${dureeSceneS.toFixed(2)}s`;
  switch (index % 4) {
    case 0:
      // Travelling latéral droite → gauche.
      return {
        nom: "pan-droite",
        svg: `<animateTransform attributeName="transform" type="translate" values="${(-W * 0.02).toFixed(0)} 0; ${(W * 0.02).toFixed(0)} 0; ${(-W * 0.02).toFixed(0)} 0" dur="${dur}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"/>`,
      };
    case 1:
      // Zoom lent avant.
      return {
        nom: "zoom-avant",
        svg: `<animateTransform attributeName="transform" type="scale" values="1; ${(1.05 + rng() * 0.02).toFixed(3)}; 1" dur="${dur}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"/>`,
      };
    case 2:
      // Travelling latéral gauche → droite.
      return {
        nom: "pan-gauche",
        svg: `<animateTransform attributeName="transform" type="translate" values="${(W * 0.02).toFixed(0)} 0; ${(-W * 0.02).toFixed(0)} 0; ${(W * 0.02).toFixed(0)} 0" dur="${dur}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"/>`,
      };
    default:
      // Zoom lent arrière (léger recul).
      return {
        nom: "zoom-arriere",
        svg: `<animateTransform attributeName="transform" type="scale" values="${(1.05 + rng() * 0.02).toFixed(3)}; 1; ${(1.05 + rng() * 0.02).toFixed(3)}" dur="${dur}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"/>`,
      };
  }
}

/** Surcalque animé de la scène (météo vivante, oiseaux, éclairs). */
function surcalquesAnimes(scene: SceneSpec, dureeSceneS: number, rng: () => number): { svg: string; noms: string[] } {
  const morceaux: string[] = [];
  const noms: string[] = [];

  if (scene.meteo.includes("pluie")) {
    noms.push("pluie-tombante");
    const gouttes = Array.from({ length: 46 }, (_, i) => {
      const x = ((i * 97) % W) + rng() * 20;
      const y = rng() * H - H;
      return `<line x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${(x - 8).toFixed(0)}" y2="${(y + 18).toFixed(0)}" stroke="#B9D9F2" stroke-width="1.7" stroke-opacity="0.55" stroke-linecap="round"/>`;
    }).join("");
    morceaux.push(`<g><g><animateTransform attributeName="transform" type="translate" values="0 0; -60 ${H}" dur="0.9s" repeatCount="indefinite"/>${gouttes}</g></g>`);
  }

  if (scene.meteo.includes("neige")) {
    noms.push("neige-tombante");
    const flocons = Array.from({ length: 40 }, () => {
      const x = rng() * W;
      const y = rng() * H - H;
      const r = 1.6 + rng() * 2.6;
      return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="#FFFFFF" fill-opacity="${(0.45 + rng() * 0.4).toFixed(2)}"/>`;
    }).join("");
    morceaux.push(`<g><g><animateTransform attributeName="transform" type="translate" values="0 0; -30 ${H}" dur="5.5s" repeatCount="indefinite"/>${flocons}</g></g>`);
  }

  if (scene.meteo.includes("orage")) {
    noms.push("eclair");
    noms.push("pluie-tombante");
    // Une tempête emporte sa pluie : couche pluie-tombante jointe à l'éclair.
    const gouttesOrage = Array.from({ length: 40 }, (_, i) => {
      const x = ((i * 89) % W) + rng() * 20;
      const y = rng() * H - H;
      return `<line x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${(x - 9).toFixed(0)}" y2="${(y + 20).toFixed(0)}" stroke="#AFC6DE" stroke-width="2" stroke-opacity="0.5" stroke-linecap="round"/>`;
    }).join("");
    morceaux.push(`<g><g><animateTransform attributeName="transform" type="translate" values="0 0; -70 ${H}" dur="0.75s" repeatCount="indefinite"/>${gouttesOrage}</g></g>`);
    const x = W * (0.25 + rng() * 0.5);
    morceaux.push(`<g>
<rect width="${W}" height="${H}" fill="#FFFFFF" opacity="0">
  <animate attributeName="opacity" values="0;0;0.28;0;0;0.16;0" keyTimes="0;0.18;0.2;0.26;0.6;0.62;0.68" dur="4.2s" repeatCount="indefinite"/>
</rect>
<polyline points="${x.toFixed(0)},${(H * 0.22).toFixed(0)} ${(x - 30).toFixed(0)},${(H * 0.42).toFixed(0)} ${(x + 12).toFixed(0)},${(H * 0.44).toFixed(0)} ${(x - 14).toFixed(0)},${(H * 0.64).toFixed(0)}" stroke="#F5D76E" stroke-width="5" fill="none" stroke-linejoin="round" opacity="0">
  <animate attributeName="opacity" values="0;0;0.95;0;0" keyTimes="0;0.18;0.2;0.3;1" dur="4.2s" repeatCount="indefinite"/>
</polyline>
</g>`);
  }

  if (scene.meteo.includes("brouillard")) {
    noms.push("brouillard-vivant");
    const bandes = Array.from({ length: 3 }, (_, i) => {
      const y = H * (0.42 + i * 0.14);
      return `<ellipse cx="${(W / 2).toFixed(0)}" cy="${y.toFixed(0)}" rx="${(W * 0.72).toFixed(0)}" ry="${(H * 0.05).toFixed(0)}" fill="#DDE3EA" opacity="0">
        <animate attributeName="opacity" values="0.1;0.3;0.1" dur="${(6 + i * 2).toFixed(1)}s" repeatCount="indefinite"/>
      </ellipse>`;
    }).join("");
    morceaux.push(`<g>${bandes}</g>`);
  }

  const oiseaux =
    scene.sujet?.type === "oiseau" ||
    scene.cadre === "foret" ||
    scene.cadre === "ocean" ||
    scene.cadre === "campagne";
  if (oiseaux) {
    noms.push("oiseaux-en-vol");
    const vol = Array.from({ length: 3 }, (_, i) => {
      const y = H * (0.16 + i * 0.07);
      const debut = (i * dureeSceneS) / 3;
      return `<g><animateTransform attributeName="transform" type="translate" values="${(-80).toFixed(0)} ${y.toFixed(0)}; ${(W + 80).toFixed(0)} ${(y - 30).toFixed(0)}" dur="${dureeSceneS.toFixed(2)}s" begin="${(-debut).toFixed(2)}s" repeatCount="indefinite"/>
<path d="M 0 0 q 11 -9 22 0 q 11 -9 22 0" stroke="#16181F" stroke-width="2.6" fill="none" stroke-linecap="round">
  <animate attributeName="d" values="M 0 0 q 11 -9 22 0 q 11 -9 22 0; M 0 6 q 11 7 22 0 q 11 7 22 0; M 0 0 q 11 -9 22 0 q 11 -9 22 0" dur="0.7s" repeatCount="indefinite"/>
</path></g>`;
    }).join("");
    morceaux.push(`<g>${vol}</g>`);
  }

  return { svg: morceaux.join("\n"), noms };
}

/**
 * Génère le storyboard animé. DÉTERMINISTE : même (prompt, scènes, état
 * du réseau, durée) → même animation bit-à-bit.
 */
export function genererVideoScene(
  prompt: string,
  dureeSecondes: number,
  snapshot: NeuralSnapshot,
  scenes: SceneSpec[],
): RenduVideoScene {
  const duree = Math.min(DUREE_MAX, Math.max(DUREE_MIN, Math.round(dureeSecondes)));
  const retenues = (scenes.length > 0 ? scenes : []).slice(0, 4);
  const nb = Math.max(1, retenues.length);
  const dureeScene = duree / nb;
  const groupes: string[] = [];
  const resumeScenes: RenduVideoScene["meta"]["scenes"] = [];

  for (let i = 0; i < nb; i++) {
    const scene = retenues[i]!;
    const rng = rngDepuisSnapshot(snapshot, 10 + i * 7);
    const compose = composerCorpsScene(W, H, scene, snapshot, rng, {
      sujetAnime: true,
      meteoAnimee: true,
    });
    const camera = mouvementCamera(i, dureeScene, rng);
    const surcalques = surcalquesAnimes(scene, dureeScene, rng);
    const animations = [camera.nom, ...surcalques.noms];

    // Fenêtre d'opacité (fondus) — dérivée du même calcul honnête.
    const { values, keyTimes } = fenetreOpacity(i, nb, dureeScene, duree);
    const opacite = nb === 1
      ? `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.04;0.96;1" dur="${duree}s" repeatCount="indefinite"/>`
      : `<animate attributeName="opacity" values="${values}" keyTimes="${keyTimes}" dur="${duree}s" repeatCount="indefinite"/>`;

    groupes.push(`<g opacity="0">
  ${opacite}
  <g transform="translate(${(W / 2).toFixed(0)} ${(H / 2).toFixed(0)})">
    <g>
      ${camera.svg}
      <g transform="translate(${(-W / 2).toFixed(0)} ${(-H / 2).toFixed(0)})">
        ${compose.corps}
        ${surcalques}
      </g>
    </g>
  </g>
</g>`);

    resumeScenes.push({
      sujet: scene.sujet?.type ?? null,
      cadre: scene.cadre,
      moment: scene.moment,
      animations,
    });
  }

  const cartouche = `
<g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif">
  <text x="64" y="${H - 44}" font-size="17" fill="#FFFFFF" fill-opacity="0.88">${echapperXml(tronquer(prompt, 72))}</text>
  <text x="64" y="${H - 20}" font-size="13" fill="#7C5CFF" fill-opacity="0.8">Gen3 v2 storyboard · ${nb} scène(s) · ${duree}s · SNN ${snapshot.nbNeurones}n/${snapshot.nbSynapses}s · poids moyen ${(snapshot.poidsMoyen ?? 0).toFixed(3)}</text>
</g>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Storyboard animé généré localement pour : ${echapperXml(tronquer(prompt, 80))}">
<rect width="${W}" height="${H}" fill="#05050F"/>
${groupes.join("\n")}
${cartouche}
</svg>`;

  return {
    svg,
    width: W,
    height: H,
    dureeSecondes: duree,
    meta: {
      nbScenes: nb,
      dureeSceneS: Number(dureeScene.toFixed(2)),
      scenes: resumeScenes,
    },
  };
}

/** Data URI (SVG animé) prête à persister ou afficher. */
export function videoSceneVersDataUri(svg: string): string {
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(svg, "utf-8").toString("base64")
      : btoa(String.fromCharCode(...new TextEncoder().encode(svg)));
  return `data:image/svg+xml;base64,${base64}`;
}

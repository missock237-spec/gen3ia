/**
 * MOTEUR VISUEL SCÉNIQUE v2 — illustration vectorielle LOCALE, SANS IA
 * EXTERNE, SANS GPU.
 *
 * Évolution majeure du moteur v1 (constellation neuronale) : le sujet
 * DEMANDÉ est désormais DESSINÉ. L'analyseur sémantique
 * (scene-spec.ts) fournit la spécification (sujet, cadre, moment,
 * météo, style, ambiance) et ce moteur compose l'illustration en
 * CALQUES vectoriels :
 *
 *   ciel (moment) → astre → nuages/météo → cadre (mer, montagnes,
 *   forêt, ville, désert, campagne, lac, espace) → SUJET → style.
 *
 * L'état RÉEL du cerveau reste impliqué : graines de composition
 * (positions, jitter, tailles) dérivées du snapshot neuronal, densité
 * d'étoiles / de fenêtres allumées liée aux poids APPRIS. La
 * traçabilité (cartouche + meta) est conservée.
 *
 * HONNÊTETÉ : c'est une ILLUSTRATION VECTORIELLE STYLISÉE — pas du
 * photoréalisme (cf. docs/multimodal/gen3-multimodal.md, écart mesuré
 * avec les niveaux de référence type Leonardo). Sujet ou cadre non
 * reconnus → le moteur V1 (constellation) reste la repli assumé.
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
} from "./snapshot";
import type { SceneSpec } from "./scene-spec";

/** Ratios → dimensions de la toile (identiques au v1). */
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

export interface RenduVisuelScene {
  svg: string;
  width: number;
  height: number;
  /** Traçabilité honnête : calques réellement rendus. */
  meta: {
    calques: string[];
    scene: {
      sujet: string | null;
      cadre: string | null;
      moment: string;
      meteo: string[];
      style: string;
      ambiance: string;
      couverture: number;
    };
  };
}

/* ------------------------------------------------------------------ */
/* Palettes par moment (+ accents couleur demandée)                     */
/* ------------------------------------------------------------------ */

const CIELS: Record<string, ReadonlyArray<string>> = {
  aube: ["#FFD9C0", "#FFB88C", "#F79AA0", "#8FA6C9", "#3D4A6B"],
  jour: ["#BFE3FF", "#7EC4F2", "#4A9FE0", "#2C6FB5", "#1B4582"],
  crepuscule: ["#FFB56B", "#F07C54", "#C6527A", "#6B3FA0", "#2A1B4E"],
  nuit: ["#2E3A67", "#232B52", "#1A2140", "#111634", "#070A1E"],
};

/** Accent chromatique si une couleur est nommée dans le prompt. */
const ACCENTS: Record<string, string> = {
  rouge: "#E0453A", orange: "#F08A3C", jaune: "#F2C94C", vert: "#3FA35C",
  turquoise: "#2EC4B6", bleu: "#2D7DD2", violet: "#7B4FD8", rose: "#EF6BA0",
  noir: "#22252A", blanc: "#F5F7FA", gris: "#8A8F98", dore: "#D9A441",
  argent: "#B9C2CC",
};

function paletteScene(scene: SceneSpec, teinte: number): string[] {
  const ciel = CIELS[scene.moment] ?? CIELS.jour!;
  const accent = scene.couleurPrincipale ? ACCENTS[scene.couleurPrincipale] : undefined;
  const derive = hslVersHex(teinte, 0.55, scene.moment === "nuit" ? 0.4 : 0.55);
  return accent ? [accent, ciel[1]!, derive, ciel[0]!, ciel[ciel.length - 1]!] : [derive, ciel[1]!, ciel[0]!, ciel[3] ?? ciel[0]!, ciel[ciel.length - 1]!];
}

/* ------------------------------------------------------------------ */
/* Aides SVG                                                            */
/* ------------------------------------------------------------------ */

function arrierePlanCiel(w: number, h: number, moment: string, rng: () => number): string {
  const teintes = CIELS[moment] ?? CIELS.jour!;
  const stops = teintes
    .map((c, i) => `<stop offset="${Math.round((i / (teintes.length - 1)) * 100)}%" stop-color="${c}"/>`)
    .join("");
  const gradientId = `ciel-${Math.floor(rng() * 1e6)}`;
  return `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#${gradientId})"/>`;
}

/** Étoiles : densité liée aux poids APPRIS (cerveau plus entraîné → ciel plus peuplé). */
function calqueEtoiles(w: number, h: number, snapshot: NeuralSnapshot, rng: () => number): string {
  const nb = Math.min(180, Math.round(40 + snapshot.poidsMoyen * 120 + snapshot.nbSynapses / 40));
  let etoiles = "";
  for (let i = 0; i < nb; i++) {
    const x = (rng() * w).toFixed(1);
    const y = (rng() * h * 0.55).toFixed(1);
    const r = (0.6 + rng() * 1.6).toFixed(2);
    const o = (0.3 + rng() * 0.7).toFixed(2);
    etoiles += `<circle cx="${x}" cy="${y}" r="${r}" fill="#F5F7FA" fill-opacity="${o}"/>`;
  }
  return `<g aria-label="étoiles">${etoiles}</g>`;
}

function calqueAstre(w: number, h: number, scene: SceneSpec, rng: () => number): string {
  const nuit = scene.moment === "nuit";
  const crepuscule = scene.moment === "crepuscule" || scene.moment === "aube";
  const sujetAstre = scene.sujet?.type === "astre";
  const cx = sujetAstre ? w / 2 : w * (0.68 + rng() * 0.16);
  const cy = sujetAstre
    ? h * 0.34
    : nuit
      ? h * (0.14 + rng() * 0.1)
      : crepuscule
        ? h * (0.4 + rng() * 0.08)
        : h * (0.12 + rng() * 0.1);
  const rayon = sujetAstre ? Math.min(w, h) * 0.16 : Math.min(w, h) * (0.05 + rng() * 0.02);
  const r = rayon.toFixed(1);
  if (nuit) {
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="#F2EFE4" fill-opacity="0.92"/>
<circle cx="${(cx - rayon * 0.3).toFixed(1)}" cy="${(cy - rayon * 0.2).toFixed(1)}" r="${(rayon * 0.16).toFixed(1)}" fill="#D9D4C4" fill-opacity="0.7"/>
<circle cx="${(cx + rayon * 0.25).toFixed(1)}" cy="${(cy + rayon * 0.3).toFixed(1)}" r="${(rayon * 0.11).toFixed(1)}" fill="#D9D4C4" fill-opacity="0.55"/>`;
  }
  const couleur = crepuscule ? "#FFD27D" : "#FFF3B0";
  const rayons = sujetAstre
    ? Array.from({ length: 12 }, (_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        const x1 = cx + Math.cos(angle) * Number(r) * 1.15;
        const y1 = cy + Math.sin(angle) * Number(r) * 1.15;
        const x2 = cx + Math.cos(angle) * Number(r) * 1.5;
        const y2 = cy + Math.sin(angle) * Number(r) * 1.5;
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${couleur}" stroke-width="3" stroke-opacity="0.5" stroke-linecap="round"/>`;
      }).join("")
    : "";
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${couleur}" fill-opacity="0.95"/>${rayons}`;
}

function calqueNuages(w: number, h: number, rng: () => number, scene: SceneSpec): string {
  if (scene.meteo.length === 0 || scene.meteo.every((m) => m === "clair")) return "";
  if (!scene.meteo.some((m) => m === "nuages" || m === "pluie" || m === "orage" || m === "neige")) return "";
  const nb = scene.meteo.includes("orage") ? 6 : 4;
  let nuages = "";
  for (let i = 0; i < nb; i++) {
    const cx = w * (0.1 + rng() * 0.8);
    const cy = h * (0.08 + rng() * 0.18);
    const echelle = (0.7 + rng() * 0.8) * (Math.min(w, h) / 1024) * 60;
    const gris = scene.meteo.includes("orage") ? "#4A4E5E" : "#FFFFFF";
    nuages += `<g fill="${gris}" fill-opacity="${(0.55 + rng() * 0.3).toFixed(2)}">
<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${(echelle * 1.6).toFixed(0)}" ry="${(echelle * 0.62).toFixed(0)}"/>
<circle cx="${(cx - echelle * 0.7).toFixed(0)}" cy="${(cy - echelle * 0.22).toFixed(0)}" r="${(echelle * 0.55).toFixed(0)}"/>
<circle cx="${cx.toFixed(0)}" cy="${(cy - echelle * 0.4).toFixed(0)}" r="${(echelle * 0.72).toFixed(0)}"/>
<circle cx="${(cx + echelle * 0.75).toFixed(0)}" cy="${(cy - echelle * 0.18).toFixed(0)}" r="${(echelle * 0.5).toFixed(0)}"/>
</g>`;
  }
  return `<g aria-label="nuages">${nuages}</g>`;
}

function calqueMeteo(w: number, h: number, scene: SceneSpec, rng: () => number): { svg: string; nom: string | null } {
  let svg = "";
  const noms: string[] = [];
  if (scene.meteo.includes("pluie")) {
    noms.push("pluie");
    let gouttes = "";
    for (let i = 0; i < 90; i++) {
      const x = (rng() * w * 1.1 - w * 0.05).toFixed(0);
      const y = (rng() * h * 0.9).toFixed(0);
      gouttes += `<line x1="${x}" y1="${y}" x2="${Number(x) - 7}" y2="${Number(y) + 16}" stroke="#B9D9F2" stroke-width="1.6" stroke-opacity="0.5" stroke-linecap="round"/>`;
    }
    svg += `<g>${gouttes}</g>`;
  }
  if (scene.meteo.includes("neige")) {
    noms.push("neige");
    let flocons = "";
    for (let i = 0; i < 70; i++) {
      flocons += `<circle cx="${(rng() * w).toFixed(0)}" cy="${(rng() * h).toFixed(0)}" r="${(1.5 + rng() * 2.5).toFixed(1)}" fill="#FFFFFF" fill-opacity="${(0.4 + rng() * 0.5).toFixed(2)}"/>`;
    }
    svg += `<g>${flocons}</g>`;
  }
  if (scene.meteo.includes("brouillard")) {
    noms.push("brouillard");
    let bandes = "";
    for (let i = 0; i < 4; i++) {
      const y = h * (0.35 + i * 0.14);
      bandes += `<ellipse cx="${(w / 2).toFixed(0)}" cy="${y.toFixed(0)}" rx="${(w * 0.72).toFixed(0)}" ry="${(h * (0.045 + rng() * 0.03)).toFixed(0)}" fill="#DDE3EA" fill-opacity="0.24"/>`;
    }
    svg += `<g>${bandes}</g>`;
  }
  if (scene.meteo.includes("orage")) {
    noms.push("orage");
    const x = w * (0.25 + rng() * 0.5);
    svg += `<g stroke="#F5D76E" stroke-width="4" fill="none" stroke-linejoin="round" stroke-opacity="0.9">
<polyline points="${x.toFixed(0)},${(h * 0.24).toFixed(0)} ${(x - 26).toFixed(0)},${(h * 0.4).toFixed(0)} ${(x + 10).toFixed(0)},${(h * 0.42).toFixed(0)} ${(x - 12).toFixed(0)},${(h * 0.6).toFixed(0)}"/>
</g>`;
  }
  return { svg, nom: noms.length > 0 ? noms.join("+") : null };
}

/* CALQUE CADRE — arrière-plans par environnement. ySol = ligne de sol. */
function calqueCadre(w: number, h: number, scene: SceneSpec, snapshot: NeuralSnapshot, rng: () => number): { svg: string; ySol: number; nom: string | null } {
  const yHorizon = h * (scene.cadre === "espace" ? 1.2 : 0.62 + rng() * 0.05);
  switch (scene.cadre) {
    case "ocean":
      return { ySol: h * 0.86, nom: "ocean", svg: `
<g>
<rect x="0" y="${yHorizon.toFixed(0)}" width="${w}" height="${(h - yHorizon).toFixed(0)}" fill="${hslVersHex(208, 0.6, scene.moment === "nuit" ? 0.22 : 0.42)}"/>
${Array.from({ length: 7 }, (_, i) => {
  const y = yHorizon + (h - yHorizon) * ((i + 1) / 8);
  const largeur = 40 + ((snapshot.echantillonSynapses[i]?.[0] ?? i * 37) % 120);
  return `<path d="M ${(w * 0.05 + i * w * 0.13).toFixed(0)} ${y.toFixed(0)} q ${(largeur / 2).toFixed(0)} -8 ${largeur} 0" stroke="#EAF4FB" stroke-width="2.4" fill="none" stroke-opacity="${(0.5 - i * 0.05).toFixed(2)}" stroke-linecap="round"/>`;
}).join("\n")}
<rect x="0" y="${(h * 0.86).toFixed(0)}" width="${w}" height="${(h * 0.14).toFixed(0)}" fill="${scene.moment === "nuit" ? "#5A6478" : "#E8D5A8"}"/>
</g>` };
    case "montagne": {
      const couches = 3;
      let montagnes = "";
      for (let c = 0; c < couches; c++) {
        const yBase = yHorizon + c * h * 0.07;
        const pts: string[] = [`0,${yBase.toFixed(0)}`];
        const nbPics = 4 + c;
        for (let p = 0; p <= nbPics; p++) {
          const x = (w * p) / nbPics;
          const hauteur = h * (0.3 - c * 0.07) * (0.6 + ((snapshot.echantillonSynapses[c * 5 + p]?.[2] ?? 0.5) * 0.8));
          pts.push(`${x.toFixed(0)},${(yBase - hauteur).toFixed(0)}`);
          pts.push(`${(x + w / nbPics / 2).toFixed(0)},${(yBase - hauteur * 0.4).toFixed(0)}`);
        }
        pts.push(`${w},${yBase.toFixed(0)}`);
        montagnes += `<polygon points="${pts.join(" ")}" fill="${hslVersHex(228, 0.32, scene.moment === "nuit" ? 0.2 - c * 0.04 : 0.42 - c * 0.09)}"/>`;
      }
      return { ySol: h * 0.9, nom: "montagne", svg: `<g>${montagnes}</g>` };
    }
    case "foret": {
      let arbres = "";
      for (let rang = 0; rang < 3; rang++) {
        const yBase = yHorizon + rang * h * 0.09;
        const nbArbres = 8 - rang;
        for (let a = 0; a < nbArbres; a++) {
          const x = (w * (a + 0.5)) / nbArbres + (rng() - 0.5) * 40;
          const hauteurArbre = h * (0.12 + rang * 0.05) * (0.8 + (snapshot.echantillonSynapses[rang * 7 + a]?.[2] ?? 0.5) * 0.5);
          arbres += `<polygon points="${x.toFixed(0)},${(yBase - hauteurArbre).toFixed(0)} ${(x - hauteurArbre * 0.32).toFixed(0)},${yBase.toFixed(0)} ${(x + hauteurArbre * 0.32).toFixed(0)},${yBase.toFixed(0)}" fill="${hslVersHex(142, 0.4, scene.moment === "nuit" ? 0.16 + rang * 0.03 : 0.26 + rang * 0.06)}"/>`;
        }
      }
      return { ySol: h * 0.9, nom: "foret", svg: `<g>${arbres}</g>` };
    }
    case "ville": {
      let batiments = "";
      const nb = 10;
      for (let i = 0; i < nb; i++) {
        const largeur = w / nb;
        const x = i * largeur;
        const hauteur = h * (0.18 + ((snapshot.echantillonSynapses[i * 3]?.[2] ?? 0.5) * 0.3));
        const fenetresAllumees = Math.round(4 + snapshot.poidsMoyen * 10);
        batiments += `<rect x="${x.toFixed(0)}" y="${(yHorizon - hauteur).toFixed(0)}" width="${(largeur * 0.86).toFixed(0)}" height="${(hauteur + 2).toFixed(0)}" fill="${hslVersHex(232, 0.28, scene.moment === "nuit" ? 0.16 : 0.4)}"/>
${Array.from({ length: fenetresAllumees }, (_, f) => {
  const fx = x + largeur * (0.14 + (f % 3) * 0.28);
  const fy = yHorizon - hauteur + largeur * (0.2 + Math.floor(f / 3) * 0.3);
  return f % 2 === 0 ? `<rect x="${fx.toFixed(0)}" y="${fy.toFixed(0)}" width="5" height="6" fill="${scene.moment === "nuit" ? "#F5D76E" : "#CFE8FF"}" fill-opacity="0.8"/>` : "";
}).join("")}`;
      }
      return { ySol: h * 0.88, nom: "ville", svg: `<g>${batiments}</g>` };
    }
    case "desert": {
      let dunes = "";
      for (let i = 0; i < 3; i++) {
        const yBase = yHorizon + i * h * 0.08;
        dunes += `<path d="M 0 ${yBase.toFixed(0)} Q ${(w * 0.3).toFixed(0)} ${(yBase - h * 0.05).toFixed(0)} ${(w * 0.6).toFixed(0)} ${yBase.toFixed(0)} T ${w} ${(yBase - h * 0.02).toFixed(0)} V ${h} H 0 Z" fill="${hslVersHex(36, 0.55, scene.moment === "nuit" ? 0.28 - i * 0.04 : 0.62 - i * 0.08)}"/>`;
      }
      return { ySol: h * 0.9, nom: "desert", svg: `<g>${dunes}</g>` };
    }
    case "campagne": {
      let collines = "";
      for (let i = 0; i < 2; i++) {
        const yBase = yHorizon + i * h * 0.1;
        collines += `<path d="M 0 ${(yBase + h * 0.04).toFixed(0)} Q ${(w * 0.25).toFixed(0)} ${(yBase - h * 0.06).toFixed(0)} ${(w * 0.5).toFixed(0)} ${(yBase + h * 0.01).toFixed(0)} T ${w} ${(yBase).toFixed(0)} V ${h} H 0 Z" fill="${hslVersHex(96, 0.42, scene.moment === "nuit" ? 0.24 - i * 0.05 : 0.44 - i * 0.1)}"/>`;
      }
      const champ = Array.from({ length: 9 }, (_, i) => {
        const y = h * 0.84 + i * 5;
        return `<line x1="${(w * 0.05).toFixed(0)}" y1="${y.toFixed(0)}" x2="${(w * 0.95).toFixed(0)}" y2="${(y + 8).toFixed(0)}" stroke="#3FA35C" stroke-width="1.6" stroke-opacity="0.35"/>`;
      }).join("");
      return { ySol: h * 0.88, nom: "campagne", svg: `<g>${collines}${champ}</g>` };
    }
    case "lac":
      return { ySol: h * 0.86, nom: "lac", svg: `
<g>
<rect x="0" y="${yHorizon.toFixed(0)}" width="${w}" height="${(h - yHorizon).toFixed(0)}" fill="${hslVersHex(196, 0.5, scene.moment === "nuit" ? 0.2 : 0.38)}"/>
<ellipse cx="${(w * 0.5).toFixed(0)}" cy="${(h * 0.84).toFixed(0)}" rx="${(w * 0.34).toFixed(0)}" ry="${(h * 0.05).toFixed(0)}" fill="${hslVersHex(196, 0.45, scene.moment === "nuit" ? 0.26 : 0.5)}"/>
<rect x="0" y="${(h * 0.86).toFixed(0)}" width="${w}" height="${(h * 0.14).toFixed(0)}" fill="${scene.moment === "nuit" ? "#47526A" : "#9FBF7A"}"/>
</g>` };
    case "espace": {
      const etoiles = calqueEtoiles(w, h, snapshot, rng);
      const planetes = Array.from({ length: 2 }, (_, i) => {
        const px = w * (0.24 + i * 0.5);
        const py = h * (0.3 + i * 0.32);
        const pr = Math.min(w, h) * (0.1 + i * 0.07);
        const teinte = 18 + i * 140;
        return `<circle cx="${px.toFixed(0)}" cy="${py.toFixed(0)}" r="${pr.toFixed(0)}" fill="${hslVersHex(teinte, 0.5, 0.5)}"/>
<ellipse cx="${px.toFixed(0)}" cy="${py.toFixed(0)}" rx="${(pr * 1.6).toFixed(0)}" ry="${(pr * 0.4).toFixed(0)}" fill="none" stroke="${hslVersHex(teinte + 30, 0.5, 0.65)}" stroke-width="3" stroke-opacity="0.6" transform="rotate(-14 ${px.toFixed(0)} ${py.toFixed(0)})"/>`;
      }).join("");
      return { ySol: h, nom: "espace", svg: `<g>${planetes}</g>${etoiles}` };
    }
    default:
      // Cadre non reconnu : sol générique discret (l'œuvre reste composée).
      return { ySol: h * 0.88, nom: null, svg: `<rect x="0" y="${(h * 0.88).toFixed(0)}" width="${w}" height="${(h * 0.12).toFixed(0)}" fill="${hslVersHex(teinteDuPrompt("sol"), 0.25, scene.moment === "nuit" ? 0.16 : 0.3)}" fill-opacity="0.55"/>` };
  }
}

/* SUJET — dessin vectoriel paramétrique du sujet demandé. */
function calqueSujet(w: number, h: number, scene: SceneSpec, ySol: number, palette: string[], rng: () => number): string {
  if (!scene.sujet) return "";
  const echelle = Math.min(w, h) / 1024;
  const cx = w * (0.42 + rng() * 0.16);
  const c = scene.couleurPrincipale ? ACCENTS[scene.couleurPrincipale] ?? palette[0]! : palette[0]!;
  const sombre = scene.moment === "nuit" || scene.style === "minimal" ? "#16181F" : c;
  const S = (hauteur: number) => hauteur * echelle;

  /** Oreilles en callback : elles dépendent de la tête calculée ici. */
  const quadrupede = (
    corpsH: number,
    pattesH: number,
    oreilles: (teteX: number, teteY: number) => string,
    queue: "courbe" | "brosse" | "longue",
  ) => {
    const corpsY = ySol - S(pattesH + corpsH / 2);
    const teteX = cx + S(corpsH * 0.75);
    const teteY = corpsY - S(corpsH * 0.35);
    return `<g fill="${sombre}">
<ellipse cx="${cx.toFixed(0)}" cy="${corpsY.toFixed(0)}" rx="${S(corpsH * 0.95).toFixed(0)}" ry="${S(corpsH * 0.5).toFixed(0)}"/>
<rect x="${(cx - S(corpsH * 0.7)).toFixed(0)}" y="${(ySol - S(pattesH)).toFixed(0)}" width="${S(corpsH * 0.16).toFixed(0)}" height="${S(pattesH).toFixed(0)}" rx="${S(corpsH * 0.07).toFixed(0)}"/>
<rect x="${(cx + S(corpsH * 0.55)).toFixed(0)}" y="${(ySol - S(pattesH)).toFixed(0)}" width="${S(corpsH * 0.16).toFixed(0)}" height="${S(pattesH).toFixed(0)}" rx="${S(corpsH * 0.07).toFixed(0)}"/>
<circle cx="${teteX.toFixed(0)}" cy="${teteY.toFixed(0)}" r="${S(corpsH * 0.42).toFixed(0)}"/>
${oreilles(teteX, teteY)}
<${queue === "courbe" ? "path" : "rect"} ${queue === "courbe"
      ? `d="M ${(cx - S(corpsH * 0.9)).toFixed(0)} ${(corpsY - S(corpsH * 0.2)).toFixed(0)} q ${S(-corpsH * 0.5).toFixed(0)} ${S(-corpsH * 0.7).toFixed(0)} ${S(corpsH * 0.1).toFixed(0)} ${S(-corpsH * 0.9).toFixed(0)}" stroke="${sombre}" stroke-width="${S(corpsH * 0.14).toFixed(0)}" fill="none" stroke-linecap="round"`
      : `x="${(cx - S(corpsH * 1.15)).toFixed(0)}" y="${(corpsY - S(corpsH * 0.2)).toFixed(0)}" width="${S(corpsH * 0.3).toFixed(0)}" height="${S(corpsH * 0.14).toFixed(0)}" rx="${S(corpsH * 0.07).toFixed(0)}"`}/>
</g>`;
  };

  switch (scene.sujet.type) {
    case "chat":
      return quadrupede(
        110,
        70,
        (tx, ty) =>
          `<polygon points="${(tx - 14).toFixed(0)},${(ty - 30).toFixed(0)} ${(tx - 2).toFixed(0)},${(ty - 52).toFixed(0)} ${(tx + 6).toFixed(0)},${(ty - 28).toFixed(0)}" fill="${sombre}"/><polygon points="${(tx + 20).toFixed(0)},${(ty - 30).toFixed(0)} ${(tx + 30).toFixed(0)},${(ty - 50).toFixed(0)} ${(tx + 36).toFixed(0)},${(ty - 26).toFixed(0)}" fill="${sombre}"/>`,
        "courbe",
      );
    case "chien":
      return quadrupede(
        130,
        85,
        (tx, ty) =>
          `<polygon points="${(tx + 18).toFixed(0)},${(ty - 34).toFixed(0)} ${(tx + 34).toFixed(0)},${(ty - 66).toFixed(0)} ${(tx + 44).toFixed(0)},${(ty - 28).toFixed(0)}" fill="${sombre}"/>`,
        "brosse",
      );
    case "vache":
      return quadrupede(
        170,
        95,
        (tx, ty) =>
          `<circle cx="${(tx + 6).toFixed(0)}" cy="${(ty - 44).toFixed(0)}" r="5" fill="${sombre}"/><circle cx="${(tx + 34).toFixed(0)}" cy="${(ty - 44).toFixed(0)}" r="5" fill="${sombre}"/>`,
        "brosse",
      );
    case "mouton":
      return `<g fill="${sombre}"><ellipse cx="${cx.toFixed(0)}" cy="${(ySol - S(90)).toFixed(0)}" rx="${S(85).toFixed(0)}" ry="${S(55).toFixed(0)}"/>
${[-60, -25, 25, 60].map((dx) => `<rect x="${(cx + S(dx)).toFixed(0)}" y="${(ySol - S(52)).toFixed(0)}" width="${S(13).toFixed(0)}" height="${S(52).toFixed(0)}" rx="6"/>`).join("")}
<circle cx="${(cx - S(85)).toFixed(0)}" cy="${(ySol - S(115)).toFixed(0)}" r="${S(40).toFixed(0)}"/>
${Array.from({ length: 6 }, (_, i) => `<circle cx="${(cx - S(85) + Math.cos((i / 6) * 6.28) * S(34)).toFixed(0)}" cy="${(ySol - S(115) + Math.sin((i / 6) * 6.28) * S(34)).toFixed(0)}" r="${S(16).toFixed(0)}"/>`).join("")}</g>`;
    case "cheval":
      return quadrupede(
        150,
        110,
        (tx, ty) =>
          `<polygon points="${(tx + 12).toFixed(0)},${(ty - 40).toFixed(0)} ${(tx + 26).toFixed(0)},${(ty - 78).toFixed(0)} ${(tx + 36).toFixed(0)},${(ty - 36).toFixed(0)}" fill="${sombre}"/>`,
        "longue",
      );
    case "dragon":
      return `<g fill="${sombre}"><ellipse cx="${cx.toFixed(0)}" cy="${(ySol - S(160)).toFixed(0)}" rx="${S(150).toFixed(0)}" ry="${S(60).toFixed(0)}"/>
<path d="M ${(cx + S(120)).toFixed(0)} ${(ySol - S(190)).toFixed(0)} Q ${(cx + S(260)).toFixed(0)} ${(ySol - S(230)).toFixed(0)} ${(cx + S(320)).toFixed(0)} ${(ySol - S(170)).toFixed(0)} L ${(cx + S(290)).toFixed(0)} ${(ySol - S(150)).toFixed(0)} Z"/>
<path d="M ${(cx - S(20)).toFixed(0)} ${(ySol - S(210)).toFixed(0)} Q ${(cx + S(40)).toFixed(0)} ${(ySol - S(320)).toFixed(0)} ${(cx + S(110)).toFixed(0)} ${(ySol - S(250)).toFixed(0)} Z" fill-opacity="0.85"/>
<path d="M ${(cx + S(30)).toFixed(0)} ${(ySol - S(160)).toFixed(0)} Q ${(cx + S(120)).toFixed(0)} ${(ySol - S(300)).toFixed(0)} ${(cx + S(200)).toFixed(0)} ${(ySol - S(220)).toFixed(0)} Z" fill-opacity="0.7"/>
${[-90, -30, 40, 100].map((dx) => `<rect x="${(cx + S(dx)).toFixed(0)}" y="${(ySol - S(70)).toFixed(0)}" width="${S(18).toFixed(0)}" height="${S(70).toFixed(0)}" rx="8"/>`).join("")}</g>`;
    case "oiseau": {
      const y = ySol - h * 0.16;
      return `<g fill="${sombre}"><ellipse cx="${cx.toFixed(0)}" cy="${y.toFixed(0)}" rx="${S(52).toFixed(0)}" ry="${S(34).toFixed(0)}"/>
<circle cx="${(cx + S(52)).toFixed(0)}" cy="${(y - S(22)).toFixed(0)}" r="${S(24).toFixed(0)}"/>
<polygon points="${(cx + S(74)).toFixed(0)},${(y - S(22)).toFixed(0)} ${(cx + S(98)).toFixed(0)},${(y - S(14)).toFixed(0)} ${(cx + S(74)).toFixed(0)},${(y - S(8)).toFixed(0)}"/>
<path d="M ${(cx - S(10)).toFixed(0)} ${(y - S(6)).toFixed(0)} Q ${(cx + S(30)).toFixed(0)} ${(y - S(70)).toFixed(0)} ${(cx + S(70)).toFixed(0)} ${(y - S(10)).toFixed(0)} Z" fill-opacity="0.8"/>
<path d="M ${(cx - S(30)).toFixed(0)} ${(y - S(4)).toFixed(0)} Q ${(cx + S(4)).toFixed(0)} ${(y - S(60)).toFixed(0)} ${(cx + S(40)).toFixed(0)} ${(y - S(2)).toFixed(0)} Z" fill-opacity="0.6"/></g>`;
    }
    case "papillon": {
      const y = ySol - h * 0.2;
      return `<g><ellipse cx="${cx.toFixed(0)}" cy="${y.toFixed(0)}" rx="${S(9).toFixed(0)}" ry="${S(34).toFixed(0)}" fill="${sombre}"/>
<ellipse cx="${(cx - S(34)).toFixed(0)}" cy="${(y - S(12)).toFixed(0)}" rx="${S(30).toFixed(0)}" ry="${S(22).toFixed(0)}" fill="${palette[2]!}" fill-opacity="0.9"/>
<ellipse cx="${(cx + S(34)).toFixed(0)}" cy="${(y - S(12)).toFixed(0)}" rx="${S(30).toFixed(0)}" ry="${S(22).toFixed(0)}" fill="${palette[2]!}" fill-opacity="0.9"/>
<ellipse cx="${(cx - S(24)).toFixed(0)}" cy="${(y + S(22)).toFixed(0)}" rx="${S(20).toFixed(0)}" ry="${S(16).toFixed(0)}" fill="${palette[1]!}" fill-opacity="0.85"/>
<ellipse cx="${(cx + S(24)).toFixed(0)}" cy="${(y + S(22)).toFixed(0)}" rx="${S(20).toFixed(0)}" ry="${S(16).toFixed(0)}" fill="${palette[1]!}" fill-opacity="0.85"/></g>`;
    }
    case "arbre": {
      const hauteurArbre = S(300);
      return `<g><rect x="${(cx - S(18)).toFixed(0)}" y="${(ySol - hauteurArbre).toFixed(0)}" width="${S(36).toFixed(0)}" height="${hauteurArbre.toFixed(0)}" rx="8" fill="#6B4A2F"/>
<circle cx="${cx.toFixed(0)}" cy="${(ySol - hauteurArbre - S(60)).toFixed(0)}" r="${S(105).toFixed(0)}" fill="${hslVersHex(134, 0.45, scene.moment === "nuit" ? 0.24 : 0.4)}"/>
<circle cx="${(cx - S(62)).toFixed(0)}" cy="${(ySol - hauteurArbre - S(10)).toFixed(0)}" r="${S(72).toFixed(0)}" fill="${hslVersHex(128, 0.42, scene.moment === "nuit" ? 0.2 : 0.36)}"/>
<circle cx="${(cx + S(66)).toFixed(0)}" cy="${(ySol - hauteurArbre - S(16)).toFixed(0)}" r="${S(76).toFixed(0)}" fill="${hslVersHex(140, 0.4, scene.moment === "nuit" ? 0.22 : 0.42)}"/></g>`;
    }
    case "fleur": {
      const hauteurFleur = S(190);
      const cy = ySol - hauteurFleur;
      return `<g><line x1="${cx.toFixed(0)}" y1="${ySol.toFixed(0)}" x2="${cx.toFixed(0)}" y2="${cy.toFixed(0)}" stroke="#3FA35C" stroke-width="${S(9).toFixed(0)}" stroke-linecap="round"/>
<ellipse cx="${(cx - S(26)).toFixed(0)}" cy="${(ySol - hauteurFleur * 0.55).toFixed(0)}" rx="${S(26).toFixed(0)}" ry="${S(11).toFixed(0)}" fill="#3FA35C" transform="rotate(-24 ${(cx - S(26)).toFixed(0)} ${(ySol - hauteurFleur * 0.55).toFixed(0)})"/>
${Array.from({ length: 6 }, (_, i) => {
  const angle = (i / 6) * Math.PI * 2;
  return `<ellipse cx="${(cx + Math.cos(angle) * S(30)).toFixed(0)}" cy="${(cy + Math.sin(angle) * S(30)).toFixed(0)}" rx="${S(20).toFixed(0)}" ry="${S(14).toFixed(0)}" fill="${palette[2]!}" transform="rotate(${(angle * 57.3).toFixed(0)} ${(cx + Math.cos(angle) * S(30)).toFixed(0)} ${(cy + Math.sin(angle) * S(30)).toFixed(0)})"/>`;
}).join("")}
<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${S(14).toFixed(0)}" fill="#F2C94C"/></g>`;
    }
    case "phare": {
      const hauteurPhare = S(330);
      const x = cx;
      return `<g><polygon points="${(x - S(34)).toFixed(0)},${ySol.toFixed(0)} ${(x - S(22)).toFixed(0)},${(ySol - hauteurPhare).toFixed(0)} ${(x + S(22)).toFixed(0)},${(ySol - hauteurPhare).toFixed(0)} ${(x + S(34)).toFixed(0)},${ySol.toFixed(0)}" fill="#E8E3D8"/>
<rect x="${(x - S(38)).toFixed(0)}" y="${(ySol - hauteurPhare * 0.62).toFixed(0)}" width="${S(52).toFixed(0)}" height="${S(26).toFixed(0)}" fill="#C94F44" transform="skewX(0)"/>
<rect x="${(x - S(35)).toFixed(0)}" y="${(ySol - hauteurPhare * 0.32).toFixed(0)}" width="${S(56).toFixed(0)}" height="${S(26).toFixed(0)}" fill="#C94F44"/>
<rect x="${(x - S(30)).toFixed(0)}" y="${(ySol - hauteurPhare - S(20)).toFixed(0)}" width="${S(60).toFixed(0)}" height="${S(24).toFixed(0)}" fill="${sombre}"/>
<circle cx="${x.toFixed(0)}" cy="${(ySol - hauteurPhare - S(8)).toFixed(0)}" r="${S(11).toFixed(0)}" fill="#F5D76E"/>
${scene.moment === "nuit" || scene.moment === "crepuscule" ? `<polygon points="${(x + S(26)).toFixed(0)},${(ySol - hauteurPhare - S(8)).toFixed(0)} ${w},${(ySol - hauteurPhare - S(70)).toFixed(0)} ${w},${(ySol - hauteurPhare + S(40)).toFixed(0)}" fill="#F5D76E" fill-opacity="0.18"/>` : ""}</g>`;
    }
    case "voilier": {
      const y = scene.cadre === "ocean" ? h * 0.8 : ySol;
      return `<g><path d="M ${(cx - S(90)).toFixed(0)} ${(y - S(20)).toFixed(0)} L ${(cx + S(90)).toFixed(0)} ${(y - S(20)).toFixed(0)} L ${(cx + S(62)).toFixed(0)} ${(y + S(26)).toFixed(0)} L ${(cx - S(62)).toFixed(0)} ${(y + S(26)).toFixed(0)} Z" fill="#7A4A2B"/>
<line x1="${cx.toFixed(0)}" y1="${(y - S(20)).toFixed(0)}" x2="${cx.toFixed(0)}" y2="${(y - S(190)).toFixed(0)}" stroke="#5A3A22" stroke-width="${S(8).toFixed(0)}"/>
<polygon points="${(cx + S(8)).toFixed(0)},${(y - S(180)).toFixed(0)} ${(cx + S(8)).toFixed(0)},${(y - S(40)).toFixed(0)} ${(cx + S(88)).toFixed(0)},${(y - S(40)).toFixed(0)}" fill="#F5F2E8"/>
<polygon points="${(cx - S(8)).toFixed(0)},${(y - S(170)).toFixed(0)} ${(cx - S(8)).toFixed(0)},${(y - S(40)).toFixed(0)} ${(cx - S(80)).toFixed(0)},${(y - S(40)).toFixed(0)}" fill="${palette[2]!}" fill-opacity="0.9"/></g>`;
    }
    case "maison":
      return `<g><rect x="${(cx - S(110)).toFixed(0)}" y="${(ySol - S(120)).toFixed(0)}" width="${S(220).toFixed(0)}" height="${S(120).toFixed(0)}" fill="#E8DCC8"/>
<polygon points="${(cx - S(126)).toFixed(0)},${(ySol - S(120)).toFixed(0)} ${cx.toFixed(0)},${(ySol - S(210)).toFixed(0)} ${(cx + S(126)).toFixed(0)},${(ySol - S(120)).toFixed(0)}" fill="#B5543B"/>
<rect x="${(cx - S(22)).toFixed(0)}" y="${(ySol - S(70)).toFixed(0)}" width="${S(44).toFixed(0)}" height="${S(70).toFixed(0)}" rx="3" fill="#7A4A2B"/>
<rect x="${(cx + S(52)).toFixed(0)}" y="${(ySol - S(96)).toFixed(0)}" width="${S(38).toFixed(0)}" height="${S(38).toFixed(0)}" fill="${scene.moment === "nuit" ? "#F5D76E" : "#BFD9EC"}"/>
<rect x="${(cx - S(92)).toFixed(0)}" y="${(ySol - S(96)).toFixed(0)}" width="${S(38).toFixed(0)}" height="${S(38).toFixed(0)}" fill="${scene.moment === "nuit" ? "#F5D76E" : "#BFD9EC"}"/>
<rect x="${(cx + S(70)).toFixed(0)}" y="${(ySol - S(200)).toFixed(0)}" width="${S(26).toFixed(0)}" height="${S(60).toFixed(0)}" fill="#8A6A50"/></g>`;
    case "chateau":
      return `<g fill="#B8B2A6"><rect x="${(cx - S(140)).toFixed(0)}" y="${(ySol - S(150)).toFixed(0)}" width="${S(280).toFixed(0)}" height="${S(150).toFixed(0)}"/>
${[-140, -60, 60, 140].map((dx) => `<rect x="${(cx + S(dx)).toFixed(0)}" y="${(ySol - S(230)).toFixed(0)}" width="${S(44).toFixed(0)}" height="${S(230).toFixed(0)}"/>`).join("")}
${[-140, -60, 60, 140].map((dx) => `<polygon points="${(cx + S(dx - 8)).toFixed(0)},${(ySol - S(230)).toFixed(0)} ${(cx + S(dx + 22)).toFixed(0)},${(ySol - S(230)).toFixed(0)} ${(cx + S(dx + 7)).toFixed(0)},${(ySol - S(300)).toFixed(0)}" fill="#9E4A6B"/>`).join("")}
${Array.from({ length: 7 }, (_, i) => `<rect x="${(cx - S(128) + i * S(42)).toFixed(0)}" y="${(ySol - S(166)).toFixed(0)}" width="${S(20).toFixed(0)}" height="${S(16).toFixed(0)}"/>`).join("")}
<rect x="${(cx - S(24)).toFixed(0)}" y="${(ySol - S(90)).toFixed(0)}" width="${S(48).toFixed(0)}" height="${S(90).toFixed(0)}" rx="${S(24).toFixed(0)} ${S(24).toFixed(0)} 0 0" fill="#3A2E28"/></g>`;
    case "pont":
      return `<g><path d="M ${(cx - S(220)).toFixed(0)} ${ySol.toFixed(0)} Q ${cx.toFixed(0)} ${(ySol - S(140)).toFixed(0)} ${(cx + S(220)).toFixed(0)} ${ySol.toFixed(0)}" fill="none" stroke="#7A7268" stroke-width="${S(22).toFixed(0)}"/>
<rect x="${(cx - S(220)).toFixed(0)}" y="${(ySol - S(120)).toFixed(0)}" width="${S(440).toFixed(0)}" height="${S(16).toFixed(0)}" rx="6" fill="#8A8078"/>
${[-160, -80, 0, 80, 160].map((dx) => `<line x1="${(cx + S(dx)).toFixed(0)}" y1="${(ySol - S(112)).toFixed(0)}" x2="${(cx + S(dx)).toFixed(0)}" y2="${(ySol - S(84)).toFixed(0)}" stroke="#6A6258" stroke-width="6"/>`).join("")}</g>`;
    case "tour":
      return `<g><polygon points="${(cx - S(52)).toFixed(0)},${ySol.toFixed(0)} ${(cx - S(30)).toFixed(0)},${(ySol - S(320)).toFixed(0)} ${(cx + S(30)).toFixed(0)},${(ySol - S(320)).toFixed(0)} ${(cx + S(52)).toFixed(0)},${ySol.toFixed(0)}" fill="#A8A096"/>
<circle cx="${cx.toFixed(0)}" cy="${(ySol - S(340)).toFixed(0)}" r="${S(38).toFixed(0)}" fill="#8A8078"/>
<line x1="${cx.toFixed(0)}" y1="${(ySol - S(378)).toFixed(0)}" x2="${cx.toFixed(0)}" y2="${(ySol - S(430)).toFixed(0)}" stroke="#C94F44" stroke-width="6"/></g>`;
    case "personnage":
      return `<g fill="${sombre}"><circle cx="${cx.toFixed(0)}" cy="${(ySol - S(300)).toFixed(0)}" r="${S(42).toFixed(0)}"/>
<rect x="${(cx - S(34)).toFixed(0)}" y="${(ySol - S(252)).toFixed(0)}" width="${S(68).toFixed(0)}" height="${S(130).toFixed(0)}" rx="20"/>
<rect x="${(cx - S(28)).toFixed(0)}" y="${(ySol - S(122)).toFixed(0)}" width="${S(24).toFixed(0)}" height="${S(122).toFixed(0)}" rx="10"/>
<rect x="${(cx + S(4)).toFixed(0)}" y="${(ySol - S(122)).toFixed(0)}" width="${S(24).toFixed(0)}" height="${S(122).toFixed(0)}" rx="10"/></g>`;
    case "visage":
      return `<g transform="translate(${(cx).toFixed(0)} ${(ySol - h * 0.42).toFixed(0)})">
<ellipse cx="0" cy="0" rx="${S(150).toFixed(0)}" ry="${S(195).toFixed(0)}" fill="${palette[3]!}"/>
<circle cx="${S(-52)}" cy="${S(-30)}" r="${S(14)}" fill="${sombre}"/>
<circle cx="${S(52)}" cy="${S(-30)}" r="${S(14)}" fill="${sombre}"/>
<path d="M ${S(-60)} ${S(-78)} q ${S(22)} ${S(-18)} ${S(44)} 0" stroke="${sombre}" stroke-width="${S(10)}" fill="none" stroke-linecap="round"/>
<path d="M ${S(16)} ${S(-78)} q ${S(22)} ${S(-18)} ${S(44)} 0" stroke="${sombre}" stroke-width="${S(10)}" fill="none" stroke-linecap="round"/>
<path d="M ${S(-44)} ${S(78)} q ${S(44)} ${S(34)} ${S(88)} 0" stroke="${sombre}" stroke-width="${S(9)}" fill="none" stroke-linecap="round"/></g>`;
    case "astre":
      // Rendu assuré par le calque d'astre central (calqueAstre) —
      // pas de double sujet.
      return "";
    case "vaisseau":
      return `<g transform="translate(${(cx).toFixed(0)} ${(ySol - h * 0.4).toFixed(0)})">
<ellipse cx="0" cy="0" rx="${S(46)}" ry="${S(130)}" fill="#D9DDE4"/>
<polygon points="${S(-46)},${S(40)} ${S(-92)},${S(120)} ${S(-40)},${S(96)}" fill="#C94F44"/>
<polygon points="${S(46)},${S(40)} ${S(92)},${S(120)} ${S(40)},${S(96)}" fill="#C94F44"/>
<circle cx="0" cy="${S(-52)}" r="${S(22)}" fill="#8FD4F2"/>
<polygon points="${S(-20)},${S(128)} ${S(20)},${S(128)} 0,${S(200)}" fill="#F5A623"/></g>`;
    case "voiture":
      return `<g><rect x="${(cx - S(150)).toFixed(0)}" y="${(ySol - S(88)).toFixed(0)}" width="${S(300).toFixed(0)}" height="${S(64).toFixed(0)}" rx="${S(20)}" fill="${palette[0]!}"/>
<path d="M ${(cx - S(74)).toFixed(0)} ${(ySol - S(88)).toFixed(0)} q ${S(20)} ${S(-52)} ${S(66)} ${S(-52)} l ${S(70)} 0 q ${S(48)} 0 ${S(58)} ${S(52)} Z" fill="${palette[0]!}"/>
<circle cx="${(cx - S(86)).toFixed(0)}" cy="${(ySol - S(30)).toFixed(0)}" r="${S(30).toFixed(0)}" fill="#22252A"/>
<circle cx="${(cx + S(86)).toFixed(0)}" cy="${(ySol - S(30)).toFixed(0)}" r="${S(30).toFixed(0)}" fill="#22252A"/>
<circle cx="${(cx - S(86)).toFixed(0)}" cy="${(ySol - S(30)).toFixed(0)}" r="${S(12).toFixed(0)}" fill="#8A8F98"/>
<circle cx="${(cx + S(86)).toFixed(0)}" cy="${(ySol - S(30)).toFixed(0)}" r="${S(12).toFixed(0)}" fill="#8A8F98"/></g>`;
    case "velo":
      return `<g stroke="${sombre}" stroke-width="${S(10)}" fill="none"><circle cx="${(cx - S(80)).toFixed(0)}" cy="${(ySol - S(56)).toFixed(0)}" r="${S(56)}"/>
<circle cx="${(cx + S(80)).toFixed(0)}" cy="${(ySol - S(56)).toFixed(0)}" r="${S(56)}"/>
<polyline points="${(cx - S(80)).toFixed(0)},${(ySol - S(56)).toFixed(0)} ${(cx - S(20)).toFixed(0)},${(ySol - S(56)).toFixed(0)} ${(cx + S(24)).toFixed(0)},${(ySol - S(150)).toFixed(0)} ${(cx + S(80)).toFixed(0)},${(ySol - S(56)).toFixed(0)} ${(cx - S(20)).toFixed(0)},${(ySol - S(56)).toFixed(0)}"/>
<line x1="${(cx + S(24)).toFixed(0)}" y1="${(ySol - S(150)).toFixed(0)}" x2="${(cx + S(12)).toFixed(0)}" y2="${(ySol - S(170)).toFixed(0)}"/>
<line x1="${(cx - S(46)).toFixed(0)}" y1="${(ySol - S(56)).toFixed(0)}" x2="${(cx - S(64)).toFixed(0)}" y2="${(ySol - S(150)).toFixed(0)}"/></g>`;
    case "train":
      return `<g><rect x="${(cx - S(180)).toFixed(0)}" y="${(ySol - S(150)).toFixed(0)}" width="${S(360).toFixed(0)}" height="${S(110).toFixed(0)}" rx="${S(20)}" fill="#2E5E4E"/>
<rect x="${(cx + S(110)).toFixed(0)}" y="${(ySol - S(200)).toFixed(0)}" width="${S(60).toFixed(0)}" height="${S(60).toFixed(0)}" rx="6" fill="#3FA35C"/>
<rect x="${(cx - S(150)).toFixed(0)}" y="${(ySol - S(130)).toFixed(0)}" width="${S(80).toFixed(0)}" height="${S(52).toFixed(0)}" rx="6" fill="#BFD9EC"/>
${[-120, 0, 120].map((dx) => `<circle cx="${(cx + S(dx)).toFixed(0)}" cy="${(ySol - S(34)).toFixed(0)}" r="${S(34)}" fill="#22252A"/>`).join("")}
<rect x="0" y="${(ySol - S(10)).toFixed(0)}" width="${w}" height="${S(10)}" fill="#6A6258"/></g>`;
    case "montgolfiere":
      return `<g transform="translate(${(cx).toFixed(0)} ${(ySol - h * 0.44).toFixed(0)})">
<path d="M 0 ${S(-120)} C ${S(-150)} ${S(-120)} ${S(-150)} ${S(80)} 0 ${S(80)} C ${S(150)} ${S(80)} ${S(150)} ${S(-120)} 0 ${S(-120)} Z" fill="${palette[0]!}"/>
<path d="M 0 ${S(-120)} C ${S(-54)} ${S(-120)} ${S(-54)} ${S(80)} 0 ${S(80)} C ${S(54)} ${S(80)} ${S(54)} ${S(-120)} 0 ${S(-120)} Z" fill="${palette[2]!}" fill-opacity="0.85"/>
<rect x="${S(-30)}" y="${S(96)}" width="${S(60)}" height="${S(44)}" rx="6" fill="#7A4A2B"/>
<line x1="${S(-26)}" y1="${S(80)}" x2="${S(-22)}" y2="${S(96)}" stroke="#5A3A22" stroke-width="4"/>
<line x1="${S(26)}" y1="${S(80)}" x2="${S(22)}" y2="${S(96)}" stroke="#5A3A22" stroke-width="4"/></g>`;
    case "poisson": {
      const y = ySol - h * 0.12;
      return `<g><ellipse cx="${cx.toFixed(0)}" cy="${y.toFixed(0)}" rx="${S(90).toFixed(0)}" ry="${S(48).toFixed(0)}" fill="${palette[0]!}"/>
<polygon points="${(cx + S(84)).toFixed(0)},${y.toFixed(0)} ${(cx + S(140)).toFixed(0)},${(y - S(44)).toFixed(0)} ${(cx + S(140)).toFixed(0)},${(y + S(44)).toFixed(0)}" fill="${palette[1]!}"/>
<circle cx="${(cx - S(52)).toFixed(0)}" cy="${(y - S(10)).toFixed(0)}" r="${S(8).toFixed(0)}" fill="#F5F7FA"/>
<circle cx="${(cx - S(50)).toFixed(0)}" cy="${(y - S(10)).toFixed(0)}" r="${S(4).toFixed(0)}" fill="#22252A"/></g>`;
    }
    default:
      return "";
  }
}

/* Style — post-traitement graphique assumé (pas de photoréalisme). */
function filtreStyle(scene: SceneSpec, w: number, h: number): { defs: string; voile: string; nom: string } {
  switch (scene.style) {
    case "minimal":
      return { defs: "", voile: "", nom: "minimal" };
    case "aquarelle":
      return {
        defs: `<filter id="style-aquarelle" x="-6%" y="-6%" width="112%" height="112%"><feGaussianBlur stdDeviation="${Math.max(2, Math.min(w, h) / 340).toFixed(2)}"/></filter>`,
        voile: "",
        nom: "aquarelle",
      };
    case "neon":
      return {
        defs: `<filter id="style-neon" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="10" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
        voile: `<rect width="${w}" height="${h}" fill="#0B0F1E" fill-opacity="0.28"/>`,
        nom: "neon",
      };
    case "bd":
      return { defs: "", voile: `<rect width="${w}" height="${h}" fill="none" stroke="#16181F" stroke-width="${Math.max(4, Math.min(w, h) / 130)}" opacity="0.5"/>`, nom: "bd" };
    case "vintage":
      return { defs: "", voile: `<rect width="${w}" height="${h}" fill="#C8A26A" fill-opacity="0.2"/><rect width="${w}" height="${h}" fill="#2A1B0E" fill-opacity="0.12"/>`, nom: "vintage" };
    default:
      return { defs: "", voile: "", nom: "gen3" };
  }
}

/**
 * Corps de scène RÉUTILISABLE : assemble les calques (sans <svg>,
 * sans cartouche, sans post-traitement de style) — consommé par
 * genererVisuelScene (image v2) ET par le storyboard vidéo v2.
 */
export interface CorpsSceneCompose {
  /** Groupe SVG du corps de scène (à insérer dans un conteneur). */
  corps: string;
  /** Ligne de sol de la scène (ancre des sujets). */
  ySol: number;
  /** Palette résolue (accents couleur + moment). */
  palette: string[];
  /** Liste honnête des calques rendus. */
  calques: string[];
}

export interface OptionsCorpsScene {
  /**
   * Vidéo : le sujet flotte doucement (translate verticale SMIL).
   * L'animation est posée ICI car le sujet est assemblé dans ce corps.
   */
  sujetAnime?: boolean;
  /**
   * Vidéo : EXCLUT les météos statiques (pluie/neige/brouillard/orage)
   * — le storyboard les rend ANIMÉES à la place.
   */
  meteoAnimee?: boolean;
}

export function composerCorpsScene(
  w: number,
  h: number,
  scene: SceneSpec,
  snapshot: NeuralSnapshot,
  rng: () => number,
  opts: OptionsCorpsScene = {},
): CorpsSceneCompose {
  const teinte = teinteDuPrompt(scene.sujet?.label ?? scene.cadre ?? "scene-gen3");
  const palette = paletteScene(scene, teinte);
  const calques: string[] = [];
  const ciel = arrierePlanCiel(w, h, scene.moment, rng);
  const etoiles = scene.moment === "nuit" || scene.cadre === "espace" ? calqueEtoiles(w, h * 0.62, snapshot, rng) : "";
  const astre = calqueAstre(w, h, scene, rng);
  const nuages = calqueNuages(w, h, rng, scene);
  const cadre = calqueCadre(w, h, scene, snapshot, rng);
  const meteo = opts.meteoAnimee ? { svg: "", nom: null } : calqueMeteo(w, h, scene, rng);
  const sujetBrut = calqueSujet(w, h, scene, cadre.ySol, palette, rng);
  const sujet =
    sujetBrut && opts.sujetAnime && scene.sujet
      ? `<g><animateTransform attributeName="transform" type="translate" values="0 0; 0 ${(-(Math.min(w, h) * 0.008)).toFixed(1)}; 0 0" dur="${(2.4 + (snapshot.seed % 9) / 10).toFixed(2)}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"/>${sujetBrut}</g>`
      : sujetBrut;

  // Ombre portée du sujet (ancrage au sol, honnête visuellement).
  const ombre = scene.sujet
    ? `<ellipse cx="${(w * 0.5).toFixed(0)}" cy="${(cadre.ySol + 6).toFixed(0)}" rx="${(Math.min(w, h) * 0.14).toFixed(0)}" ry="${(Math.min(w, h) * 0.022).toFixed(0)}" fill="#000000" fill-opacity="0.22"/>`
    : "";

  const corps = `
${ciel}
${etoiles}
${astre}
${nuages}
${cadre.svg}
${ombre}
${sujet}
${meteo.svg}`;

  if (scene.cadre) calques.push(`cadre:${scene.cadre}`);
  if (scene.moment !== "jour" || scene.sujet?.type === "astre") calques.push("astre");
  if (nuages) calques.push("nuages");
  if (meteo.nom) calques.push(`meteo:${meteo.nom}`);
  // Le sujet « astre » EST le calque d'astre central — pas de double déclaration.
  if (scene.sujet && scene.sujet.type !== "astre") calques.push(`sujet:${scene.sujet.type}`);

  return { corps, ySol: cadre.ySol, palette, calques };
}

/**
 * Génère l'illustration scénique v2. DÉTERMINISTE : même (prompt, scène,
 * état du réseau) → même rendu bit-à-bit.
 */
export function genererVisuelScene(
  prompt: string,
  ratio: string,
  snapshot: NeuralSnapshot,
  scene: SceneSpec,
): RenduVisuelScene {
  const dims = DIMENSIONS[ratio] ?? DIMENSIONS["1:1"]!;
  const { w, h } = dims;
  const rng = rngDepuisSnapshot(snapshot, 4);
  const compose = composerCorpsScene(w, h, scene, snapshot, rng);
  const style = filtreStyle(scene, w, h);
  const groupeAquarelle = scene.style === "aquarelle";

  const cartouche = `
<g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif">
  <text x="${(w * 0.05).toFixed(0)}" y="${(h * 0.945).toFixed(0)}" font-size="${(Math.min(w, h) / 56).toFixed(0)}" fill="#FFFFFF" fill-opacity="0.88">${echapperXml(tronquer(prompt, 64))}</text>
  <text x="${(w * 0.05).toFixed(0)}" y="${(h * 0.972).toFixed(0)}" font-size="${(Math.min(w, h) / 72).toFixed(0)}" fill="${compose.palette[0]!}" fill-opacity="0.8">Gen3 v2 scène · ${echapperXml(tronquer(scene.sujet ? scene.sujet.label : "sans sujet", 18))}${scene.cadre ? ` · ${scene.cadre}` : ""} · ${scene.moment} · SNN ${snapshot.nbNeurones}n/${snapshot.nbSynapses}s</text>
</g>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Illustration scénique générée localement pour : ${echapperXml(tronquer(prompt, 80))}">
${style.defs}
<g${groupeAquarelle ? ' filter="url(#style-aquarelle)"' : ""}>
${compose.corps}
${style.voile}
</g>
${cartouche}
</svg>`;

  const calques = [...compose.calques, `style:${style.nom}`];

  return {
    svg,
    width: w,
    height: h,
    meta: {
      calques,
      scene: {
        sujet: scene.sujet?.type ?? null,
        cadre: scene.cadre,
        moment: scene.moment,
        meteo: scene.meteo,
        style: scene.style,
        ambiance: scene.ambiance,
        couverture: Number(scene.couverture.toFixed(3)),
      },
    },
  };
}

/** Data URI (SVG) prête à persister ou afficher. */
export function visuelSceneVersDataUri(svg: string): string {
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(svg, "utf-8").toString("base64")
      : btoa(String.fromCharCode(...new TextEncoder().encode(svg)));
  return `data:image/svg+xml;base64,${base64}`;
}

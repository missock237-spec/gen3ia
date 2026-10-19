"use client";

/**
 * Toile du Monde — le rendu visuel des simulations.
 *
 * Deux familles de dessins, un seul canvas :
 *  - COURBES : séries temporelles multi-traces avec axes, grille et
 *    légende intégrée ;
 *  - CHAMPS : carte de chaleur d'un champ scalaire 2D (onde, chaleur,
 *    vitesse du fluide, champ électrique) avec colormap scientifique
 *    (violet → cyan → jaune, fidèle à l'esthétique W-DNN).
 *
 * Rendu haute densité (devicePixelRatio) pour rester net sur écrans
 * Retina — et léger : zéro dépendance, Canvas 2D natif.
 */

import { useEffect, useRef } from "react";

import type { Champ2D, Serie } from "@/lib/monde/types";

export interface DonneesToile {
  series: Serie[];
  champ: Champ2D | null;
}

/** Interpole une couleur de la colormap scientifique (t ∈ [0,1]). */
function couleurColormap(t: number): string {
  const x = Math.min(1, Math.max(0, t));
  // Violet #7c3aed → cyan #22d3ee → jaune #fde047
  const stops: Array<[number, [number, number, number]]> = [
    [0, [26, 12, 48]],
    [0.35, [124, 58, 237]],
    [0.65, [34, 211, 238]],
    [1, [253, 224, 71]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (x >= t0 && x <= t1) {
      const r = (x - t0) / (t1 - t0);
      const mix = c0.map((v, k) => Math.round(v + r * (c1[k] - v)));
      return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
    }
  }
  return "rgb(253,224,71)";
}

/** Formate un nombre compact pour les axes. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs >= 1e6 || abs < 1e-3) return v.toExponential(1);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** Dessine les séries (courbes) sur le contexte fourni. */
function dessinerCourbes(
  ctx: CanvasRenderingContext2D,
  largeur: number,
  hauteur: number,
  series: Serie[],
): void {
  const margeG = 64;
  const margeB = 34;
  const margeH = 18;
  const margeD = 18;
  const w = largeur - margeG - margeD;
  const h = hauteur - margeH - margeB;

  // Bornes globales sur toutes les séries (x et y).
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of series) {
    for (const x of s.abscisses) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
    for (const y of s.valeurs) {
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return;
  if (xMax === xMin) xMax = xMin + 1;
  if (yMax === yMin) {
    yMax = yMin + 1;
    yMin -= 1;
  }
  // Marge verticale de 8 %.
  const padY = (yMax - yMin) * 0.08;
  yMin -= padY;
  yMax += padY;

  const px = (x: number) => margeG + ((x - xMin) / (xMax - xMin)) * w;
  const py = (y: number) => margeH + h - ((y - yMin) / (yMax - yMin)) * h;

  // Fond + grille.
  ctx.clearRect(0, 0, largeur, hauteur);
  ctx.strokeStyle = "rgba(139,92,246,0.12)";
  ctx.lineWidth = 1;
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "rgba(226,232,240,0.55)";
  for (let i = 0; i <= 5; i++) {
    const gy = margeH + (h * i) / 5;
    ctx.beginPath();
    ctx.moveTo(margeG, gy);
    ctx.lineTo(largeur - margeD, gy);
    ctx.stroke();
    const valeurY = yMax - ((yMax - yMin) * i) / 5;
    ctx.fillText(fmt(valeurY), 6, gy + 3);
  }
  for (let i = 0; i <= 6; i++) {
    const gx = margeG + (w * i) / 6;
    ctx.beginPath();
    ctx.moveTo(gx, margeH);
    ctx.lineTo(gx, margeH + h);
    ctx.stroke();
    const valeurX = xMin + ((xMax - xMin) * i) / 6;
    ctx.fillText(fmt(valeurX), gx - 12, hauteur - 10);
  }

  // Axes.
  ctx.strokeStyle = "rgba(148,163,184,0.5)";
  ctx.beginPath();
  ctx.moveTo(margeG, margeH);
  ctx.lineTo(margeG, margeH + h);
  ctx.lineTo(largeur - margeD, margeH + h);
  ctx.stroke();

  // Courbes.
  for (const s of series) {
    ctx.strokeStyle = s.couleur;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < s.abscisses.length; i++) {
      const y = s.valeurs[i];
      if (!Number.isFinite(y)) {
        started = false;
        continue;
      }
      const X = px(s.abscisses[i]);
      const Y = py(y);
      if (!started) {
        ctx.moveTo(X, Y);
        started = true;
      } else {
        ctx.lineTo(X, Y);
      }
    }
    ctx.stroke();
  }

  // Légende compacte en haut à droite.
  ctx.font = "11px system-ui, sans-serif";
  let legendeY = margeH + 12;
  for (let i = series.length - 1; i >= 0; i--) {
    const s = series[i];
    ctx.fillStyle = s.couleur;
    ctx.fillRect(largeur - margeD - 150, legendeY - 8, 10, 3);
    ctx.fillStyle = "rgba(226,232,240,0.85)";
    ctx.fillText(s.nom.slice(0, 28), largeur - margeD - 136, legendeY - 4);
    legendeY += 15;
    if (legendeY > margeH + h - 8) break;
  }
}

/** Dessine une carte de chaleur 2D. */
function dessinerChamp(
  ctx: CanvasRenderingContext2D,
  largeur: number,
  hauteur: number,
  champ: Champ2D,
): void {
  ctx.clearRect(0, 0, largeur, hauteur);
  const { largeur: nl, hauteur: nh, valeurs } = champ;

  // Bornes symétriques ou absolues selon les données.
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < valeurs.length; i++) {
    const v = valeurs[i];
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  if (!Number.isFinite(vMin)) return;
  const etendue = Math.max(1e-12, vMax - vMin);

  const celluleW = largeur / nl;
  const celluleH = hauteur / nh;
  for (let j = 0; j < nh; j++) {
    for (let i = 0; i < nl; i++) {
      const t = (valeurs[j * nl + i] - vMin) / etendue;
      ctx.fillStyle = couleurColormap(t);
      ctx.fillRect(i * celluleW, j * celluleH, celluleW + 0.5, celluleH + 0.5);
    }
  }

  // Échelle de couleur (barre latérale).
  const barreW = 14;
  const barreH = hauteur - 40;
  for (let y = 0; y < barreH; y++) {
    const t = 1 - y / barreH;
    ctx.fillStyle = couleurColormap(t);
    ctx.fillRect(largeur - barreW - 10, 20 + y, barreW, 1);
  }
  ctx.fillStyle = "rgba(226,232,240,0.8)";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText(fmt(vMax), largeur - barreW - 6, 16);
  ctx.fillText(fmt(vMin), largeur - barreW - 6, hauteur - 22);
  ctx.fillText(champ.unite, largeur - barreW - 6, hauteur - 10);
}

/** La toile : canvas adaptatif qui dessine courbes OU champ. */
export function ToileMonde({ series, champ, vide }: DonneesToile & { vide: string }) {
  const refCanvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = refCanvas.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dessiner = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const largeur = rect.width;
      const hauteur = rect.height;

      if (champ && champ.valeurs.length > 0) {
        dessinerChamp(ctx, largeur, hauteur, champ);
      } else if (series.length > 0) {
        dessinerCourbes(ctx, largeur, hauteur, series);
      } else {
        // État vide.
        ctx.clearRect(0, 0, largeur, hauteur);
        ctx.fillStyle = "rgba(148,163,184,0.5)";
        ctx.font = "13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(vide, largeur / 2, hauteur / 2);
        ctx.textAlign = "left";
      }
    };

    dessiner();
    const observateur = new ResizeObserver(dessiner);
    observateur.observe(canvas);
    return () => observateur.disconnect();
  }, [series, champ, vide]);

  return <canvas ref={refCanvas} className="monde-toile" aria-label="Visualisation de la simulation" />;
}

"use client";

/**
 * Canvas de visualisation du champ d'ondes — la propagation devient
 * visible : violet pour les amplitudes positives, cyan pour les
 * négatives (identité 2 couleurs Gen3ia), pics de résonance en incandescence
 * blanche, arrivées P2P en anneaux qui s'étendent.
 *
 * Le composant lit un « tampon de rendu » partagé (muté par la boucle
 * du laboratoire) à son propre rythme d'affichage — simulation et
 * rendu sont découplés, aucune allocation par frame.
 */

import { useEffect, useRef } from "react";

import type { Pic } from "@/lib/ondes/types";
import { cx } from "@/lib/ui/cx";

export interface FlashP2P {
  x: number;
  y: number;
  /** Horodatage (performance.now()) de l'arrivée. */
  t: number;
}

export interface TamponRendu {
  amp: Float32Array | null;
  phase: Float32Array | null;
  largeur: number;
  hauteur: number;
  pics: Pic[];
  flashs: FlashP2P[];
}

export function creerTamponRendu(): TamponRendu {
  return { amp: null, phase: null, largeur: 0, hauteur: 0, pics: [], flashs: [] };
}

interface ProprietesCanvasOndes {
  tampon: TamponRendu;
  className?: string;
  /** Étiquette accessible décrivant l'état du champ. */
  labelAria?: string;
}

// Identité 2 couleurs (design system Aurora) — violet/cyan sur fond Nebula.
const VIOLET = [124, 92, 255] as const;
const CYAN = [42, 212, 232] as const;
const FOND = [5, 6, 12] as const;

export function CanvasOndes({ tampon, className, labelAria }: ProprietesCanvasOndes) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const horsEcranRef = useRef<HTMLCanvasElement | null>(null);
  const donneesRef = useRef<ImageData | null>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const contexte = canvas.getContext("2d");
    if (!contexte) return;

    let largeurCss = 0;
    let hauteurCss = 0;

    const redimensionner = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      largeurCss = rect.width;
      hauteurCss = rect.height;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    redimensionner();
    const observateur = new ResizeObserver(redimensionner);
    observateur.observe(canvas);

    const dessiner = (instant: number) => {
      const w = tampon.largeur;
      const h = tampon.hauteur;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      contexte.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Fond profond + vignette douce.
      contexte.fillStyle = "rgb(5 6 12)";
      contexte.fillRect(0, 0, largeurCss, hauteurCss);

      if (tampon.amp && w > 0 && h > 0) {
        // Image hors écran à la résolution de la grille, agrandie lissée.
        let hors = horsEcranRef.current;
        if (!hors) {
          hors = document.createElement("canvas");
          horsEcranRef.current = hors;
        }
        if (hors.width !== w || hors.height !== h) {
          hors.width = w;
          hors.height = h;
          donneesRef.current = null;
        }
        const ctxHors = hors.getContext("2d");
        if (ctxHors) {
          if (!donneesRef.current || donneesRef.current.width !== w || donneesRef.current.height !== h) {
            donneesRef.current = ctxHors.createImageData(w, h);
          }
          const image = donneesRef.current;
          const pixels = image.data;
          const amp = tampon.amp;
          const phase = tampon.phase;
          for (let i = 0; i < w * h; i++) {
            const v = amp[i];
            const a = Math.min(1, Math.abs(v) * 0.55);
            // Modulation lumineuse par la phase (onde vivante).
            const lum = phase ? 0.75 + 0.25 * (0.5 + 0.5 * Math.cos(phase[i])) : 1;
            const cible = v >= 0 ? VIOLET : CYAN;
            const j = i * 4;
            pixels[j] = FOND[0] + (cible[0] - FOND[0]) * a * lum;
            pixels[j + 1] = FOND[1] + (cible[1] - FOND[1]) * a * lum;
            pixels[j + 2] = FOND[2] + (cible[2] - FOND[2]) * a * lum;
            pixels[j + 3] = 255;
          }
          ctxHors.putImageData(image, 0, 0);
          contexte.imageSmoothingEnabled = true;
          contexte.imageSmoothingQuality = "high";
          contexte.globalAlpha = 0.92;
          contexte.drawImage(hors, 0, 0, largeurCss, hauteurCss);
          contexte.globalAlpha = 1;
        }

        // Pics de résonance : incandescence blanche + halo.
        const echelleX = largeurCss / w;
        const echelleY = hauteurCss / h;
        for (const pic of tampon.pics) {
          const px = pic.x * echelleX;
          const py = pic.y * echelleY;
          const intensite = Math.min(1, pic.amplitude / 4);
          const rayon = 6 + 14 * intensite;
          const degrade = contexte.createRadialGradient(px, py, 0, px, py, rayon);
          degrade.addColorStop(0, `rgba(255,255,255,${0.55 * intensite + 0.2})`);
          degrade.addColorStop(0.35, `rgba(${VIOLET[0]},${VIOLET[1]},${VIOLET[2]},${0.35 * intensite})`);
          degrade.addColorStop(1, "rgba(0,0,0,0)");
          contexte.fillStyle = degrade;
          contexte.beginPath();
          contexte.arc(px, py, rayon, 0, Math.PI * 2);
          contexte.fill();
        }

        // Arrivées P2P : anneaux violets qui s'étendent (600 ms).
        const flashsVivants: FlashP2P[] = [];
        for (const flash of tampon.flashs) {
          const age = instant - flash.t;
          if (age > 600) continue;
          flashsVivants.push(flash);
          const progression = age / 600;
          const px = flash.x * echelleX;
          const py = flash.y * echelleY;
          const rayon = 4 + progression * 46;
          contexte.strokeStyle = `rgba(${CYAN[0]},${CYAN[1]},${CYAN[2]},${(1 - progression) * 0.7})`;
          contexte.lineWidth = 2 * (1 - progression) + 0.5;
          contexte.beginPath();
          contexte.arc(px, py, rayon, 0, Math.PI * 2);
          contexte.stroke();
        }
        if (flashsVivants.length !== tampon.flashs.length) {
          tampon.flashs.length = 0;
          tampon.flashs.push(...flashsVivants);
        }
      }

      animRef.current = requestAnimationFrame(dessiner);
    };

    animRef.current = requestAnimationFrame(dessiner);
    return () => {
      cancelAnimationFrame(animRef.current);
      observateur.disconnect();
    };
  }, [tampon]);

  return (
    <canvas
      ref={canvasRef}
      className={cx("h-full w-full", className)}
      role="img"
      aria-label={labelAria ?? "Visualisation temps réel de la propagation des ondes neuronales"}
    />
  );
}

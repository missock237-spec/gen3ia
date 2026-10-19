"use client";

/**
 * La Toile de l'Essaim — visualisation temps réel du réseau d'agents.
 *
 * Au centre, le cortex Gen3 (l'IA principale) — tous les agents y sont
 * raccordés. Autour, chaque nœud de l'essaim (local + distants) orbite
 * avec ses agents spécialisés en satellites ; les impulsions d'ondes
 * (tâches, résultats, battements, fragments) filent le long des liens.
 * L'amplitude de vie d'un nœud module sa luminosité : un nœud rompu
 * rougit et s'éteint avant ré-attribution.
 */

import { useEffect, useRef } from "react";

export interface EtatToileEssaim {
  idNoeud: string;
  /** Nœuds distants : { id, amplitude, specialites, rompu }. */
  distants: Array<{ id: string; amplitude: number; specialites: number; rompu: boolean }>;
  /** Nombre d'agents locaux actifs. */
  agents: number;
  /** Impulsions récentes ( timestamps) pour animer les liens. */
  dernierMessage: number;
}

export function ToileEssaim(props: { lireEtat: () => EtatToileEssaim }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lireRef = useRef(props.lireEtat);
  lireRef.current = props.lireEtat;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const contexte = canvas.getContext("2d");
    if (!contexte) return;

    let raf = 0;
    const t0 = performance.now();

    const dessiner = (t: number) => {
      const etat = lireRef.current();
      const largeur = canvas.clientWidth;
      const hauteur = canvas.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== largeur * dpr || canvas.height !== hauteur * dpr) {
        canvas.width = largeur * dpr;
        canvas.height = hauteur * dpr;
      }
      contexte.setTransform(dpr, 0, 0, dpr, 0, 0);
      contexte.clearRect(0, 0, largeur, hauteur);

      const cx = largeur / 2;
      const cy = hauteur / 2;
      const rayonOrbite = Math.min(largeur, hauteur) * 0.36;

      // ——— halo de fond pulsant (respiration du cortex)
      const respiration = 0.5 + 0.5 * Math.sin((t - t0) / 1400);
      const gradient = contexte.createRadialGradient(cx, cy, 4, cx, cy, rayonOrbite * 1.6);
      gradient.addColorStop(0, `rgba(139, 92, 246, ${0.16 + respiration * 0.1})`);
      gradient.addColorStop(1, "rgba(139, 92, 246, 0)");
      contexte.fillStyle = gradient;
      contexte.fillRect(0, 0, largeur, hauteur);

      const n = etat.distants.length + 1;
      const positions: Array<{ x: number; y: number; rompu: boolean; amplitude: number; local: boolean }> = [];

      // ——— positions des nœuds sur l'orbite (le local en premier)
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2 + (t - t0) / 24000;
        const x = cx + Math.cos(angle) * rayonOrbite;
        const y = cy + Math.sin(angle) * rayonOrbite * 0.78;
        if (i === 0) {
          positions.push({ x, y, rompu: false, amplitude: 1, local: true });
        } else {
          const d = etat.distants[i - 1];
          positions.push({ x, y, rompu: d.rompu, amplitude: d.amplitude, local: false });
        }
      }

      // ——— liens + impulsions (tâches, résultats, battements)
      for (const p of positions) {
        if (p.local) continue;
        contexte.strokeStyle = p.rompu
          ? "rgba(251, 113, 133, 0.18)"
          : `rgba(34, 211, 238, ${0.08 + p.amplitude * 0.14})`;
        contexte.lineWidth = 1;
        contexte.beginPath();
        contexte.moveTo(cx, cy);
        contexte.lineTo(p.x, p.y);
        contexte.stroke();

        // Impulsions filantes : plusieurs points en propagation.
        if (!p.rompu) {
          const periode = 2600;
          const vites = ((t - t0) % periode) / periode;
          for (let k = 0; k < 2; k++) {
            const progr = (vites + k * 0.5) % 1;
            const px = cx + (p.x - cx) * progr;
            const py = cy + (p.y - cy) * progr;
            const taille = 1.2 + Math.sin(progr * Math.PI) * 2;
            contexte.fillStyle = `rgba(103, 232, 249, ${Math.sin(progr * Math.PI) * 0.8})`;
            contexte.beginPath();
            contexte.arc(px, py, taille, 0, Math.PI * 2);
            contexte.fill();
          }
        }
      }

      // ——— le cortex Gen3 au centre
      const rayonCortex = 26 + respiration * 4;
      const gradientCortex = contexte.createRadialGradient(cx, cy, 2, cx, cy, rayonCortex);
      gradientCortex.addColorStop(0, "rgba(196, 181, 253, 0.95)");
      gradientCortex.addColorStop(1, "rgba(139, 92, 246, 0.25)");
      contexte.fillStyle = gradientCortex;
      contexte.beginPath();
      contexte.arc(cx, cy, rayonCortex, 0, Math.PI * 2);
      contexte.fill();
      contexte.fillStyle = "rgba(226, 232, 240, 0.92)";
      contexte.font = "600 11px system-ui";
      contexte.textAlign = "center";
      contexte.fillText("Gen3", cx, cy + 4);

      // ——— les nœuds et leurs agents en satellites
      for (const p of positions) {
        const alpha = p.local ? 0.9 : Math.max(0.25, p.amplitude);
        const couleur = p.rompu ? `rgba(251, 113, 133, ${alpha})` : `rgba(103, 232, 249, ${alpha})`;
        const rayonNoeud = p.local ? 13 : 10 + p.amplitude * 4;

        // Satellites : agents spécialisés (orbite lente).
        const nbSatellites = p.local ? etat.agents : Math.min(5, Math.round(p.amplitude * 5));
        for (let s = 0; s < nbSatellites; s++) {
          const angleSat = (s / Math.max(1, nbSatellites)) * Math.PI * 2 + (t - t0) / 3000;
          const sx = p.x + Math.cos(angleSat) * (rayonNoeud + 8);
          const sy = p.y + Math.sin(angleSat) * (rayonNoeud + 8);
          contexte.fillStyle = p.rompu ? "rgba(251, 113, 133, 0.4)" : "rgba(196, 181, 253, 0.65)";
          contexte.beginPath();
          contexte.arc(sx, sy, 2, 0, Math.PI * 2);
          contexte.fill();
        }

        contexte.fillStyle = couleur;
        contexte.beginPath();
        contexte.arc(p.x, p.y, rayonNoeud, 0, Math.PI * 2);
        contexte.fill();
        contexte.strokeStyle = p.local ? "rgba(196, 181, 253, 0.8)" : `rgba(226, 232, 240, ${alpha * 0.4})`;
        contexte.lineWidth = p.local ? 1.5 : 1;
        contexte.stroke();

        // Étiquette : le nœud local identifiable.
        contexte.fillStyle = p.local ? "rgba(196, 181, 253, 0.9)" : `rgba(226, 232, 240, ${alpha * 0.55})`;
        contexte.font = p.local ? "600 10px system-ui" : "9px system-ui";
        const etiquette = p.local
          ? `ce nœud (${etat.idNoeud.slice(0, 10)})`
          : etat.distants[positions.indexOf(p) - 1]?.id.slice(0, 10) ?? "";
        if (etiquette) contexte.fillText(etiquette, p.x, p.y + rayonNoeud + 13);
      }

      raf = requestAnimationFrame(dessiner);
    };

    raf = requestAnimationFrame(dessiner);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="essaim-topologie">
      <canvas ref={canvasRef} aria-label="Topologie de l'essaim d'agents en temps réel" />
      <div className="essaim-topologie-legende">
        <span>◉ Gen3 — l&apos;IA principale, raccordée à TOUS les agents</span>
        <span>● nœuds de l&apos;essaim (lumière = amplitude de vie)</span>
        <span>· impulsions d&apos;ondes (tâches, résultats, battements)</span>
      </div>
    </div>
  );
}

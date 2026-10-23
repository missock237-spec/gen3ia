import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { clampPercent, formatElapsed, MEDIA_PROGRESS_STATUS_LABELS } from "./media-progress-logic";

/**
 * Task 1-c — CADRE DE PROGRESSION MÉDIA (Mission utilisateur 2 : « à chaque
 * génération d'image ou de vidéo, un cadre qui montre la progression RÉELLE
 * en temps réel »).
 *
 * Convention du dépôt (cf. app/agent-chat-ux.test.ts) : vitest tourne en Node
 * SANS jsdom ni @testing-library/react — les comportements purs (chronomètre,
 * bornes de pourcentage) sont testés par import direct, les aspects visuels
 * (thèmes, pastilles, a11y) sont verrouillés
 * structurellement sur les sources.
 *
 * (Les verrous d'intégration atelier vidéo portaient sur
 * components/video/video-project-workspace.tsx — surface /studio/video
 * supprimée du produit ; le cadre partagé reste consommé par le chat —
 * components/workspace/video-production-card.tsx.)
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const FRAME = "components/media/media-progress-frame.tsx";
const LOGIC = "components/media/media-progress-logic.ts";
const GLOBALS = "app/globals.css";

describe("formatElapsed — chronomètre réel (bornes verrouillées)", () => {
  it("affiche « X s » strictement sous 60 secondes", () => {
    expect(formatElapsed(0)).toBe("0 s");
    expect(formatElapsed(1_000)).toBe("1 s");
    expect(formatElapsed(59_000)).toBe("59 s");
  });

  it("bascule « X min Y s » à partir de 60 s", () => {
    expect(formatElapsed(60_000)).toBe("1 min 0 s");
    expect(formatElapsed(61_000)).toBe("1 min 1 s");
    expect(formatElapsed(3_599_000)).toBe("59 min 59 s");
  });

  it("bascule « X h Y min » à partir d'une heure (3 661 s → « 1 h 1 min »)", () => {
    expect(formatElapsed(3_600_000)).toBe("1 h 0 min");
    expect(formatElapsed(3_661_000)).toBe("1 h 1 min");
    expect(formatElapsed(7_380_000)).toBe("2 h 3 min");
  });

  it("borne les durées négatives (horloge décalée)", () => {
    expect(formatElapsed(-5_000)).toBe("0 s");
  });
});

describe("clampPercent — pourcentage déterminé borné 0..100", () => {
  it("conserve les valeurs dans l'intervalle", () => {
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(42)).toBe(42);
    expect(clampPercent(100)).toBe(100);
  });

  it("borne les débordements", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
  });

  it("null / undefined / NaN → null = mode indéterminé", () => {
    expect(clampPercent(null)).toBeNull();
    expect(clampPercent(undefined)).toBeNull();
    expect(clampPercent(Number.NaN)).toBeNull();
  });
});

describe("Pastilles de statut en français (les 6 états)", () => {
  it("libellés exacts : En file, En cours, En pause, Terminé, Échec, Annulé", () => {
    expect(MEDIA_PROGRESS_STATUS_LABELS.queued).toBe("En file");
    expect(MEDIA_PROGRESS_STATUS_LABELS.running).toBe("En cours");
    expect(MEDIA_PROGRESS_STATUS_LABELS.paused).toBe("En pause");
    expect(MEDIA_PROGRESS_STATUS_LABELS.complete).toBe("Terminé");
    expect(MEDIA_PROGRESS_STATUS_LABELS.failed).toBe("Échec");
    expect(MEDIA_PROGRESS_STATUS_LABELS.cancelled).toBe("Annulé");
    expect(Object.keys(MEDIA_PROGRESS_STATUS_LABELS)).toHaveLength(6);
  });
});

describe("Cadre de progression (structurel) — barres, thèmes, a11y, chronomètre", () => {
  const frame = read(FRAME);

  it("barre déterminée h-1.5 avec transitions Tailwind", () => {
    expect(frame).toContain("h-1.5");
    expect(frame).toContain("transition-all duration-500");
    expect(frame).toContain(`style={{ width: \`\${bounded}%\` }}`);
  });

  it("mode indéterminé : réutilise l'animation .g3-progress de globals.css", () => {
    expect(frame).toContain("g3-progress");
    const globals = read(GLOBALS);
    expect(globals).toContain(".g3-progress::after");
  });

  it("chronomètre réel : tick setInterval 1 s + nettoyage strict quand startedAt est fourni", () => {
    expect(frame).toContain("if (startedAt === undefined) return;");
    expect(frame).toContain("setInterval(() => setNow(Date.now()), 1000)");
    expect(frame).toContain("return () => clearInterval(timer);");
    expect(frame).toContain("formatElapsed(now - startedAt)");
  });

  it("accessibilité : région de statut vivante + progressbar (déterminée et indéterminée)", () => {
    expect(frame).toContain('role="status"');
    expect(frame).toContain('aria-live="polite"');
    expect(frame).toContain('role="progressbar"');
    expect(frame).toContain("aria-valuenow={bounded}");
  });

  it("deux thèmes : dark (atelier par défaut) et light (crème neutre §14 + accents tokens 2 couleurs — Task 125)", () => {
    expect(frame).toContain('tone = "dark"');
    expect(frame).toContain('dark: "border-neutral-200 bg-white"');
    expect(frame).toContain('light: "border-[#E5E1D5] bg-[#FAF9F5]"');
    // Accents 2 couleurs : fill/dot dark = cyan secondaire, light = violet primaire.
    expect(frame).toContain('dark: "bg-[var(--g3-secondary)]"');
    expect(frame).toContain('light: "bg-[var(--g3-primary)]"');
    // Aucun pastel bg-*-50 dans la variante light (règle §14 : hex arbitraires).
    expect(frame).not.toMatch(/light:.*bg-(red|blue|green|emerald|amber|rose|neutral)-50/);
    // Aucune teinte chromatique hors familles violet/cyan (Task 125 : #D97757 banni).
    expect(frame).not.toContain("#D97757");
  });

  it("point pulsant pendant l'exécution + respect de prefers-reduced-motion (globals.css §15)", () => {
    expect(frame).toContain("g3-mpf-pulse");
    expect(frame).toContain("animate-pulse");
    const globals = read(GLOBALS);
    const reduced = globals.slice(globals.indexOf("15. CADRE DE PROGRESSION MÉDIA"));
    expect(reduced).toContain("prefers-reduced-motion: reduce");
    expect(reduced).toContain(".g3-mpf .g3-mpf-pulse { animation: none; }");
    expect(reduced).toContain(".g3-mpf .g3-progress::after { animation: none; }");
  });

  it("actions fantômes françaises : Annuler (états actifs) et Réessayer (échec)", () => {
    expect(frame).toContain("Annuler");
    expect(frame).toContain("Réessayer");
    expect(frame).toContain('status === "queued" || status === "running" || status === "paused"');
    expect(frame).toContain("onRetry && status === \"failed\"");
  });

  it("la logique pure est bien externalisée (testable en Node)", () => {
    const logic = read(LOGIC);
    expect(logic).toContain("export function formatElapsed");
    expect(logic).toContain("export function clampPercent");
  });
});

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
 * (thèmes, pastilles, a11y) et l'intégration atelier vidéo sont verrouillés
 * structurellement sur les sources.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const FRAME = "components/media/media-progress-frame.tsx";
const LOGIC = "components/media/media-progress-logic.ts";
const WORKSPACE = "components/video/video-project-workspace.tsx";
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

  it("deux thèmes : dark (atelier par défaut) et light (palette crème §14 : #D97757, #FAF9F5, #E5E1D5)", () => {
    expect(frame).toContain('tone = "dark"');
    expect(frame).toContain('dark: "border-neutral-200 bg-white"');
    expect(frame).toContain('light: "border-[#E5E1D5] bg-[#FAF9F5]"');
    expect(frame).toContain('light: "bg-[#D97757]"');
    // Aucun pastel bg-*-50 dans la variante light (règle §14 : hex arbitraires).
    expect(frame).not.toMatch(/light:.*bg-(red|blue|green|emerald|amber|rose|neutral)-50/);
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

describe("Intégration atelier vidéo (structurel) — rendu + storyboard", () => {
  const workspace = read(WORKSPACE);

  it("importe et rend le cadre de progression partagé", () => {
    expect(workspace).toContain('from "@/components/media/media-progress-frame"');
    expect(workspace).toContain("<MediaProgressFrame");
  });

  it("clamp ROBUSTE aux deux échelles serveur (0..1 historique, 0..100 résiduel)", () => {
    expect(workspace).toContain("job.progress <= 1 ? job.progress * 100 : job.progress");
    expect(workspace).toContain("Math.max(0, Math.min(100");
  });

  it("rendu : étiquette d'étape STAGE_LABELS + détail segments + chronomètre depuis createdAt", () => {
    expect(workspace).toContain("STAGE_LABELS[job.stage] ?? job.stage");
    expect(workspace).toContain("segment(s) rendu(s)");
    expect(workspace).toContain("correction(s) auto");
    expect(workspace).toContain("Date.parse(job.createdAt)");
    expect(workspace).toContain("startedAt={Number.isFinite(startedAtMs) ? startedAtMs : undefined}");
  });

  it("rendu : Annuler / Réessayer câblés sur les actions PATCH existantes", () => {
    expect(workspace).toContain('jobAction(job.id, "cancel")');
    expect(workspace).toContain('jobAction(job.id, "resume")');
  });

  it("storyboard : progression réelle du lot — sondage GET /assets toutes les 3 s", () => {
    expect(workspace).toContain("}, 3_000);");
    expect(workspace).toContain('authFetch(`/api/video/projects/${project.id}/assets`, { signal: controller.signal })');
    expect(workspace).toContain("img.kind === \"image\" && img.sceneId === s.id");
  });

  it("storyboard : cadre compact tone dark pendant le lot (X/N images prêtes)", () => {
    expect(workspace).toContain('stageLabel="Génération des images de scènes"');
    expect(workspace).toContain("images prêtes");
    expect(workspace).toContain("compact");
    expect(workspace).toContain('tone="dark"');
  });

  it("storyboard : AbortController + nettoyage au démontage + arrêt à la résolution du POST", () => {
    expect(workspace).toContain("new AbortController()");
    expect(workspace).toContain("controller.abort();");
    expect(workspace).toContain("clearInterval(pollRef.current.timer);");
    expect(workspace).toContain("pollRef.current.controller.abort();");
    expect(workspace).toContain("clearInterval(timer);");
    expect(workspace).toContain("await onRefresh();");
  });
});

describe("Lot C4d (Task 101-c) — tick de rendu : jobs et projet chargés en parallèle", () => {
  const workspace = read(WORKSPACE);

  it("le poll 4 s ne séquence plus loadJobs() puis loadProject() (Promise.all)", () => {
    expect(workspace).toContain("await Promise.all([loadJobs(), loadProject()]);");
    // L'ancien enchaînement séquentiel a disparu du sondage.
    expect(workspace).not.toMatch(/await loadJobs\(\);\s*\n\s*await loadProject\(\);/);
    // L'intervalle et la suspension hors onglet visible sont inchangés.
    expect(workspace).toContain("hasActiveJob ? 4_000 : null");
  });
});

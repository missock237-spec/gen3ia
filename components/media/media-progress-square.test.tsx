import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { clampPercent, maxPercentMonotone, MEDIA_PROGRESS_STATUS_LABELS } from "./media-progress-logic";

/**
 * CARRÉ DE PROGRESSION MÉDIA — Task « progression vidéo UI » (1-a).
 *
 * Exigence produit : PLUS de barre — UN CARRÉ affichant LE POURCENTAGE de la
 * création, mis à jour en temps réel, monotone (jamais de régression), avec
 * statuts français et état indéterminé.
 *
 * Convention du dépôt (cf. media-progress-frame.test.tsx) : vitest tourne en
 * Node SANS jsdom ni @testing-library/react — les comportements purs
 * (monotonie, bornes) sont testés par import direct, les aspects visuels
 * (carré, thèmes, a11y, absence de barre) et le câblage (carte de production,
 * fil de chat) sont verrouillés structurellement sur les sources.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const SQUARE = "components/media/media-progress-square.tsx";
const LOGIC = "components/media/media-progress-logic.ts";
const CARD = "components/workspace/video-production-card.tsx";
const CHAT = "components/chat/nova-chat.tsx";

describe("maxPercentMonotone — pourcentage MONOTONE (jamais de régression)", () => {
  it("série 60 → 45 → 80 : affiche 60 puis 80, jamais 45", () => {
    // Simule la ref interne du composant (max déjà affiché).
    let affiche: number | null = null;
    affiche = maxPercentMonotone(affiche, 60);
    expect(affiche).toBe(60);
    affiche = maxPercentMonotone(affiche, 45); // statut serveur incohérent
    expect(affiche).toBe(60); // régression bloquée
    affiche = maxPercentMonotone(affiche, 80);
    expect(affiche).toBe(80); // reprise croissante acceptée
  });

  it("traverse les trous (percent null entre deux événements) sans régresser", () => {
    expect(maxPercentMonotone(60, null)).toBe(60);
    expect(maxPercentMonotone(60, undefined)).toBe(60);
    expect(maxPercentMonotone(60, Number.NaN)).toBe(60);
  });

  it("démarre à la première valeur reçue (ref initiale null)", () => {
    expect(maxPercentMonotone(null, 12)).toBe(12);
    expect(maxPercentMonotone(null, null)).toBeNull();
  });
});

describe("Pourcentage borné 0..100 (arrondi à l'unité)", () => {
  it("conserve les valeurs dans l'intervalle", () => {
    expect(maxPercentMonotone(null, 0)).toBe(0);
    expect(maxPercentMonotone(null, 42)).toBe(42);
    expect(maxPercentMonotone(null, 100)).toBe(100);
  });

  it("borne les débordements", () => {
    expect(maxPercentMonotone(null, -5)).toBe(0);
    expect(maxPercentMonotone(null, 140)).toBe(100);
    expect(maxPercentMonotone(99, 140)).toBe(100);
  });

  it("arrondit à l'unité (fond commun clampPercent)", () => {
    expect(clampPercent(46.6)).toBe(47);
    expect(maxPercentMonotone(null, 46.6)).toBe(47);
    expect(maxPercentMonotone(null, 12.4)).toBe(12);
  });
});

describe("Mode indéterminé sans pourcentage", () => {
  it("logique : aucune valeur reçue → null (le carré pulse, aucun chiffre)", () => {
    expect(clampPercent(null)).toBeNull();
    expect(maxPercentMonotone(null, undefined)).toBeNull();
  });

  it("structurel : pulse du carré réservé à l'indéterminé ACTIF, coupé si reduced-motion", () => {
    const square = read(SQUARE);
    expect(square).toContain("animate-pulse");
    expect(square).toContain("motion-reduce:animate-none");
    expect(square).toContain(
      'const pulse = indetermine && (status === "queued" || status === "running" || status === "paused");',
    );
  });
});

describe("Statuts et libellés français", () => {
  it("les 6 états : En file, En cours, En pause, Terminé, Échec, Annulé", () => {
    expect(MEDIA_PROGRESS_STATUS_LABELS.queued).toBe("En file");
    expect(MEDIA_PROGRESS_STATUS_LABELS.running).toBe("En cours");
    expect(MEDIA_PROGRESS_STATUS_LABELS.paused).toBe("En pause");
    expect(MEDIA_PROGRESS_STATUS_LABELS.complete).toBe("Terminé");
    expect(MEDIA_PROGRESS_STATUS_LABELS.failed).toBe("Échec");
    expect(MEDIA_PROGRESS_STATUS_LABELS.cancelled).toBe("Annulé");
    expect(Object.keys(MEDIA_PROGRESS_STATUS_LABELS)).toHaveLength(6);
  });

  it("le carré rend la pastille de statut et l'étape sous le carré", () => {
    const square = read(SQUARE);
    expect(square).toContain("MEDIA_PROGRESS_STATUS_LABELS[status]");
    expect(square).toContain("stageLabel");
    expect(square).toContain("formatElapsed(now - startedAt)");
  });
});

describe("Carré (structurel) — AUCUNE BARRE, valeur exposée, monotone, thèmes", () => {
  const square = read(SQUARE);

  it("aucune barre : ni le rôle de l'ancien cadre, ni la barre h-1.5, ni remplissage horizontal", () => {
    expect(square).not.toContain('role="progressbar"');
    expect(square).not.toContain("h-1.5");
    expect(square).not.toMatch(/style=\{\{\s*width:/);
    // Le remplissage est VERTICAL (montée de bas en haut dans le carré).
    expect(square).toContain("style={{ height: `${affiche}%` }}");
    expect(square).toContain("absolute inset-x-0 bottom-0");
  });

  it("le carré expose LUI-MÊME sa valeur (aria-valuenow, jamais une barre)", () => {
    expect(square).toContain('role="meter"');
    expect(square).toContain("aria-valuenow={affiche ?? undefined}");
    expect(square).toContain("aria-valuemin={0}");
    expect(square).toContain("aria-valuemax={100}");
    expect(square).toContain("aria-valuetext={affiche !== null ? `${affiche} %` : undefined}");
  });

  it("div carrée aspect-ratio 1/1 ~128 px, pourcentage EN GRAND centré", () => {
    expect(square).toContain("aspect-square h-32 w-32");
    expect(square).toContain("font-bold tabular-nums");
    expect(square).toContain("`${affiche} %`");
    expect(square).toContain('role="status"');
    expect(square).toContain('aria-live="polite"');
    expect(square).toContain("aria-label={libelleAria}");
  });

  it("pourcentage monotone : max déjà affiché conservé en ref interne", () => {
    expect(square).toContain("useRef<number | null>(null)");
    expect(square).toContain("monotoneRef.current = maxPercentMonotone(monotoneRef.current, borne);");
    expect(square).toContain("maxPercentMonotone");
    // La logique pure est bien externalisée (testable en Node).
    const logic = read(LOGIC);
    expect(logic).toContain("export function maxPercentMonotone");
  });

  it("complétion : le carré affiche toujours 100 % (défense en profondeur)", () => {
    expect(square).toContain('status === "complete" ? Math.max(monotoneRef.current ?? 0, 100) : monotoneRef.current');
  });

  it("chronomètre réel : tick setInterval 1 s + nettoyage strict quand startedAt est fourni", () => {
    expect(square).toContain("if (startedAt === undefined) return;");
    expect(square).toContain("setInterval(() => setNow(Date.now()), 1000)");
    expect(square).toContain("return () => clearInterval(timer);");
  });

  it("deux thèmes identiques au cadre : dark (atelier) et light (crème §14)", () => {
    expect(square).toContain('tone = "dark"');
    expect(square).toContain('dark: "border-neutral-200 bg-white"');
    expect(square).toContain('light: "border-[var(--g3-border)] bg-[var(--g3-bg)]"');
    // Accents 2 couleurs : dark = cyan secondaire, light = violet primaire.
    expect(square).toContain('dark: "bg-[var(--g3-secondary-soft)]"');
    expect(square).toContain('light: "bg-[var(--g3-primary-soft)]"');
    expect(square).toContain('dark: "bg-[var(--g3-secondary)]"');
    expect(square).toContain('light: "bg-[var(--g3-primary)]"');
    // Aucun pastel bg-*-50 dans la variante light (règle §14 : hex arbitraires).
    expect(square).not.toMatch(/light:.*bg-(red|blue|green|emerald|amber|rose|neutral)-50/);
    // Aucune teinte chromatique hors familles violet/cyan.
    expect(square).not.toContain("#D97757");
  });
});

describe("Câblage produit — carte de production + fil de chat (le point visible)", () => {
  it("la carte de production vidéo (atelier) consomme le CARRÉ (plus aucun cadre/barre)", () => {
    const card = read(CARD);
    expect(card).toContain("MediaProgressSquare");
    expect(card).not.toContain("MediaProgressFrame");
    // SSE (canal primaire) + sondage (repli) + étapes FR préservés.
    expect(card).toContain("/production/stream");
    expect(card).toContain("/production`");
    expect(card).toContain("const STAGE_LABELS");
    expect(card).toContain("Lancement de la production vidéo");
    expect(card).toContain("tone={tone}");
  });

  it("le chat livre la vidéo dans le fil via la carte DURABLE (artifact_created type « video »)", () => {
    const chat = read(CHAT);
    expect(chat).toContain('case "artifact_created"');
    // LIVRAISON DANS LE FIL : l'artefact vidéo pose videoProjectId sur le
    // message — la carte du fil (carré de progression + lecteur) le rend.
    expect(chat).toContain("videoProjectId: m.videoProjectId ?? ar.videoProjectId");
    expect(chat).toContain('<CarteVideoFil videoProjectId={m.videoProjectId} />');
    expect(chat).toContain("videoProjectId?: string");
  });

  it("la carte du fil AFFICHE AUSSI UN CARRÉ (plus de barre) — .nova-media-carre-*", () => {
    const fil = read("components/chat/carte-video-fil.tsx");
    // Le carré se remplit DU BAS (niveau) avec le pourcentage en grand.
    expect(fil).toContain('className="nova-media-carre"');
    expect(fil).toContain('className="nova-media-carre-niveau" style={{ height: `${progression}%` }}');
    expect(fil).toContain('className="nova-media-carre-pourcentage"');
    // Aucune barre horizontale historique.
    expect(fil).not.toContain("nova-media-barre");
  });
});

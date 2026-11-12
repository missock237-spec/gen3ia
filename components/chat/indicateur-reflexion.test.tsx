import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  LIBELLES_GENERIQUES,
  LIBELLES_PHASE,
  libelleGenere,
  libelleReflexion,
  phaseDepuisEvenement,
  type PhaseReflexion,
} from "./indicateur-reflexion-logique";
import type {
  ConversationMessage,
  ConversationRun,
  RunStep,
} from "@/lib/domain/conversations/types";

/**
 * INDICATEUR DE RÉFLEXION — demande propriétaire : « gen3 doit montrer à
 * l'utilisateur qu'il est en pleine réflexion lors d'une requête ».
 *
 * Convention du dépôt (cf. components/media/media-progress-frame.test.tsx) :
 * vitest tourne en Node SANS jsdom ni @testing-library/react et le tsconfig
 * Next force `jsx: preserve` — les composants .tsx ne sont donc pas
 * importables sous vitest : les exports purs (mapping événements → phases,
 * libellés, rotation déterministe) vivent dans
 * indicateur-reflexion-logique.ts et sont testés par import direct ; les
 * aspects visuels (points pulsants, halo, tokens de thème, a11y) et
 * l'intégration dans nova-chat.tsx sont verrouillés structurellement sur
 * les sources.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const COMPOSANT = "components/chat/indicateur-reflexion.tsx";
const LOGIQUE = "components/chat/indicateur-reflexion-logique.ts";
const MODULE_CSS = "components/chat/indicateur-reflexion.module.css";
const NOVA = "components/chat/nova-chat.tsx";
const SYNC = "components/chat/sync-historique.ts";

/* ---------------- Fixtures minimales (types réels du flux) ---------------- */

const messageServeur: ConversationMessage = {
  id: "msg-1",
  conversationId: "conv-1",
  userId: "u1",
  role: "assistant",
  content: "",
  createdAt: new Date().toISOString(),
};

const run: ConversationRun = {
  id: "run-1",
  userId: "u1",
  conversationId: "conv-1",
  objective: "Prépare un rapport",
  status: "running",
  steps: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const etape = (p: Partial<RunStep>): RunStep => ({
  id: "s1",
  phase: "execution",
  title: "Étape",
  status: "in_progress",
  ...p,
});

/* ---------------- Libellés : la demande du propriétaire verbatim ---------------- */

describe("LIBELLES_PHASE — énoncés exacts (aucune phase inventée)", () => {
  it("couvre exactement les 5 phases existantes dans le flux", () => {
    expect(Object.keys(LIBELLES_PHASE)).toEqual([
      "reflexion",
      "analyse",
      "planification",
      "outils",
      "redaction",
    ]);
  });

  it("« gen3 réfléchit… » est le libellé par défaut (état de pleine réflexion)", () => {
    expect(LIBELLES_PHASE.reflexion).toBe("gen3 réfléchit…");
  });

  it("phases réelles du moteur : analyse / organisation / outils / rédaction", () => {
    expect(LIBELLES_PHASE.analyse).toBe("gen3 analyse votre demande…");
    expect(LIBELLES_PHASE.planification).toBe("gen3 organise sa réponse…");
    expect(LIBELLES_PHASE.outils).toBe("gen3 utilise ses outils…");
    expect(LIBELLES_PHASE.redaction).toBe("gen3 rédige sa réponse…");
  });
});

/* ---------------- Mapping des événements RÉELS du flux ---------------- */

describe("phaseDepuisEvenement — événements réels (lib/domain/conversations/stream-events.ts)", () => {
  it("status(intention) → analyse (le serveur émet « Analyse de votre demande… »)", () => {
    expect(
      phaseDepuisEvenement({ type: "status", phase: "intention", label: "Analyse de votre demande…" }),
    ).toBe<PhaseReflexion>("analyse");
  });

  it("status(plan) → planification ; status(synthesis) → rédaction", () => {
    expect(phaseDepuisEvenement({ type: "status", phase: "plan", label: "…" })).toBe<PhaseReflexion>("planification");
    expect(
      phaseDepuisEvenement({ type: "status", phase: "synthesis", label: "Rédaction du résultat…" }),
    ).toBe<PhaseReflexion>("redaction");
  });

  it("status(execution/image) → null : phase trop large, le libellé serveur parle à sa place", () => {
    expect(
      phaseDepuisEvenement({ type: "status", phase: "execution", label: "Génération de l'image en cours…" }),
    ).toBeNull();
    expect(
      phaseDepuisEvenement({ type: "status", phase: "image", label: "Génération de l'image en cours…" }),
    ).toBeNull();
  });

  it("run_created → planification (un plan d'exécution vient d'être créé)", () => {
    expect(phaseDepuisEvenement({ type: "run_created", run })).toBe<PhaseReflexion>("planification");
  });

  it("step_update avec un outil RÉEL en cours → « utilise ses outils »", () => {
    const outilEnCours = etape({ phase: "tools", toolName: "artifact.create", status: "in_progress" });
    expect(phaseDepuisEvenement({ type: "step_update", runId: "run-1", step: outilEnCours })).toBe<PhaseReflexion>("outils");

    const image = etape({ phase: "execution", toolName: "image.generate", status: "in_progress" });
    expect(phaseDepuisEvenement({ type: "step_update", runId: "run-1", step: image })).toBe<PhaseReflexion>("outils");
  });

  it("step_update phases du run : understanding → analyse, plan → planification, result → rédaction", () => {
    expect(
      phaseDepuisEvenement({ type: "step_update", runId: "run-1", step: etape({ phase: "understanding" }) }),
    ).toBe<PhaseReflexion>("analyse");
    expect(
      phaseDepuisEvenement({ type: "step_update", runId: "run-1", step: etape({ phase: "plan" }) }),
    ).toBe<PhaseReflexion>("planification");
    expect(
      phaseDepuisEvenement({ type: "step_update", runId: "run-1", step: etape({ phase: "result" }) }),
    ).toBe<PhaseReflexion>("redaction");
  });

  it("step_update approval / étape terminée → null (rien à afficher de plus)", () => {
    expect(
      phaseDepuisEvenement({ type: "step_update", runId: "run-1", step: etape({ phase: "approval" }) }),
    ).toBeNull();
    expect(
      phaseDepuisEvenement({
        type: "step_update",
        runId: "run-1",
        step: etape({ phase: "execution", toolName: "video.create", status: "done" }),
      }),
    ).toBeNull();
  });

  it("message_delta / done / turn_started → null (l'indicateur se démonte)", () => {
    expect(phaseDepuisEvenement({ type: "message_delta", delta: "Bonjour" })).toBeNull();
    expect(
      phaseDepuisEvenement({ type: "done", assistantMessage: messageServeur, artifacts: [], approvals: [] }),
    ).toBeNull();
    expect(
      phaseDepuisEvenement({ type: "turn_started", conversationId: "conv-1", userMessage: messageServeur }),
    ).toBeNull();
  });
});

/* ---------------- Priorité du libellé RÉEL du serveur ---------------- */

describe("libelleReflexion — le libellé serveur prime (honnêteté)", () => {
  it("le libellé réel de l'événement status s'affiche tel quel", () => {
    expect(libelleReflexion("reflexion", "Exécution du plan en cours…")).toBe("Exécution du plan en cours…");
  });

  it("libellé vide / espaces / null → repli sur le libellé de la phase", () => {
    expect(libelleReflexion("outils", "")).toBe(LIBELLES_PHASE.outils);
    expect(libelleReflexion("outils", "   ")).toBe(LIBELLES_PHASE.outils);
    expect(libelleReflexion("outils", null)).toBe(LIBELLES_PHASE.outils);
    expect(libelleReflexion(null, undefined)).toBe(LIBELLES_PHASE.reflexion);
  });
});

/* ---------------- Rotation temporelle honnête (déterministe) ---------------- */

describe("libelleGenere — rotation de libellés génériques TOUJOURS vrais", () => {
  it("commence par « gen3 réfléchit… » puis alterne sans jamais inventer une phase", () => {
    expect(LIBELLES_GENERIQUES[0]).toBe("gen3 réfléchit…");
    expect(libelleGenere(0)).toBe("gen3 réfléchit…");
    expect(libelleGenere(1)).toBe("gen3 prépare sa réponse…");
    expect(libelleGenere(2)).toBe("gen3 réfléchit…");
    expect(libelleGenere(3)).toBe("gen3 prépare sa réponse…");
  });

  it("déterministe modulo et borné (cycle négatif / non fini → premier libellé)", () => {
    const grand = 1_000_000;
    expect(libelleGenere(grand)).toBe(libelleGenere(grand % LIBELLES_GENERIQUES.length));
    expect(libelleGenere(-1)).toBe("gen3 réfléchit…");
    expect(libelleGenere(Number.NaN)).toBe("gen3 réfléchit…");
  });
});

/* ---------------- Verrous structurels (composant + CSS module) ---------------- */

describe("IndicateurReflexion (structurel) — a11y, animation douce, thème", () => {
  const source = read(COMPOSANT);
  const logique = read(LOGIQUE);
  const css = read(MODULE_CSS);

  it("accessibilité : aria-busy sur le conteneur + aria-live polite sur le libellé", () => {
    expect(source).toContain('aria-busy="true"');
    expect(source).toContain('aria-live="polite"');
    // Les points décoratifs ne sont jamais annoncés.
    expect(source).toContain('aria-hidden="true"');
  });

  it("rotation figée dès qu'une information réelle existe (aucun libellé périmé)", () => {
    expect(source).toContain("const fige = Boolean(libelleServeur) || (Boolean(phase) && phase !== \"reflexion\")");
    expect(source).toContain("if (fige) return; // phase réelle connue : pas de rotation");
  });

  it("CSS module importé LOCALEMENT (aucune collision avec nova-chat.css)", () => {
    expect(source).toContain('import styles from "./indicateur-reflexion.module.css"');
    expect(css).not.toContain(".nova-"); // ne touche jamais aux classes nova-*
  });

  it("thème : uniquement les tokens --g3-* (clair/sombre automatiques)", () => {
    expect(css).toContain("var(--g3-primary-soft)");
    expect(css).toContain("var(--g3-primary-strong)");
    expect(css).toContain("var(--g3-primary-border)");
    expect(css).toContain("var(--g3-text-secondary)");
    // Aucune couleur hex arbitraire : l'indicateur suit les deux thèmes.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("animation douce : cycles 1,4 s et 1,8 s (< 2 s), points pulsants + halo", () => {
    expect(css).toContain("point-pulse 1.4s ease-in-out infinite");
    expect(css).toContain("halo-respire 1.8s ease-in-out infinite");
    expect(css).toContain("@keyframes point-pulse");
    expect(css).toContain("@keyframes halo-respire");
  });

  it("prefers-reduced-motion : animations coupées, points restent visibles", () => {
    const reduit = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduit).toContain("animation: none");
    expect(reduit).toContain(".point {");
    expect(reduit).toContain("opacity: 0.85");
  });

  it("les événements de flux ne sont importés qu'en type-only (aucun poids runtime)", () => {
    expect(logique).toContain('import type { ConversationStreamEvent, StreamPhase } from "@/lib/domain/conversations/stream-events"');
    expect(logique).toContain('import type { RunStep } from "@/lib/domain/conversations/types"');
  });

  it("le composant re-exporte la logique pure (surface publique stable)", () => {
    expect(source).toContain('export * from "./indicateur-reflexion-logique"');
  });
});

/* ---------------- Verrous d'intégration dans nova-chat.tsx ---------------- */

describe("intégration nova-chat.tsx — rendu dans nova-fil pendant l'attente, sans doublon", () => {
  const source = read(NOVA);

  it("l'indicateur remplace les trois points muets (aucun double affichage)", () => {
    expect(source).toContain("<IndicateurReflexion phase={phase} libelle={libelleFlux} />");
    // L'ancien indicateur muet n'est plus rendu nulle part.
    expect(source).not.toContain("nova-frappe");
    expect(source).not.toContain('aria-label="Gen3ia prépare une réponse"');
  });

  it("affiché UNIQUEMENT pendant l'attente (bulle en cours et vide) — pas pour l'historique", () => {
    // Garde d'affichage : message en cours SANS contenu (écriture progressive).
    expect(source).toContain("m.enCours && !m.content ?");
    // Les messages rechargés du serveur ne portent jamais `enCours`.
    const sync = read(SYNC);
    expect(sync).not.toContain("enCours: true");
  });

  it("phases branchées sur les événements RÉELS : status / run_created / step_update", () => {
    expect(source).toContain('case "status": {');
    expect(source).toContain("setLibelleFlux(event.label || null)");
    expect(source).toContain('case "run_created":');
    expect(source).toContain('case "step_update": {');
    expect(source).toContain("const prochaine = phaseDepuisEvenement(event);");
    expect(source).toContain("if (prochaine) setPhaseReflexion(prochaine);");
  });

  it("départ à « gen3 réfléchit… » à l'envoi + remise à zéro propre au tour terminé", () => {
    expect(source).toContain('setPhaseReflexion("reflexion");');
    expect(source).toContain("setLibelleFlux(null);");
    // Le reset vit dans le finally (done, erreur et arrêt couverts).
    const finallyBloc = source.slice(source.indexOf("} finally {"), source.indexOf("dernierTourVocalRef.current = false"));
    expect(finallyBloc).toContain('setPhaseReflexion("reflexion");');
    expect(finallyBloc).toContain("setLibelleFlux(null);");
  });
});

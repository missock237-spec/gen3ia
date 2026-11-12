/**
 * INDICATEUR DE RÉFLEXION — LOGIQUE PURE (testable en Node, cf. convention
 * du dépôt : components/media/media-progress-logic.ts — vitest tourne sans
 * jsdom et le tsconfig Next force `jsx: preserve`, donc les composants .tsx
 * ne sont pas importables sous vitest : les exports purs vivent ici).
 *
 * La demande propriétaire EXACTE : « gen3 doit montrer à l'utilisateur qu'il
 * est en pleine réflexion lors d'une requête ». Pendant le traitement (de
 * l'envoi du message à la première réponse / au « done »), le fil affiche un
 * état VIVANT — pas un spinner muet :
 *
 *  - « gen3 réfléchit… » dès l'envoi ;
 *  - puis la phase RÉELLE déduite des événements du flux NDJSON
 *    (lib/domain/conversations/stream-events.ts, émis par
 *    lib/domain/conversations/engine*.ts) :
 *      • `status` (phase intention/plan/synthesis + label serveur) →
 *        analyse / organisation de la réponse / rédaction — et le LIBELLÉ
 *        SERVEUR prime quand il existe (« Analyse de votre demande… »,
 *        « Génération de l'image en cours… », « Exécution du plan en
 *        cours… ») ;
 *      • `run_created` (plan d'exécution créé par engine-plan.ts) →
 *        « organise sa réponse » ;
 *      • `step_update` avec `toolName` en cours (artifact.create,
 *        image.generate, video.create, video.status, connectors…) →
 *        « utilise ses outils ».
 *
 *  - HONNÊTETÉ : `phaseDepuisEvenement` renvoie `null` quand l'événement ne
 *    porte RIEN d'affichable (phase execution/image du champ `status`,
 *    étape d'approbation…) — la phase en cours ne bouge pas, on n'invente
 *    jamais une étape qui n'existe pas.
 *  - En l'absence de tout signal, la rotation temporelle reste sur des
 *    libellés génériques TOUJOURS VRAIS pendant l'attente (« gen3
 *    réfléchit… » ⇄ « gen3 prépare sa réponse… »).
 */

import type { ConversationStreamEvent, StreamPhase } from "@/lib/domain/conversations/stream-events";
import type { RunStep } from "@/lib/domain/conversations/types";

/** Phases affichables — uniquement celles qui EXISTENT dans le flux. */
export type PhaseReflexion = "reflexion" | "analyse" | "planification" | "outils" | "redaction";

/** Libellé par phase (français, cf. conventions du dépôt). */
export const LIBELLES_PHASE: Record<PhaseReflexion, string> = {
  reflexion: "gen3 réfléchit…",
  analyse: "gen3 analyse votre demande…",
  planification: "gen3 organise sa réponse…",
  outils: "gen3 utilise ses outils…",
  redaction: "gen3 rédige sa réponse…",
};

/** Rotation honnête (aucune phase inventée) : en attente sans aucun
 *  événement de phase, ces deux énoncés restent vrais en permanence. */
export const LIBELLES_GENERIQUES: readonly string[] = [
  LIBELLES_PHASE.reflexion,
  "gen3 prépare sa réponse…",
];

/** Rotation temporelle déterministe des libellés génériques. */
export function libelleGenere(cycle: number): string {
  if (!Number.isFinite(cycle) || cycle < 0) return LIBELLES_GENERIQUES[0];
  return LIBELLES_GENERIQUES[Math.floor(cycle) % LIBELLES_GENERIQUES.length];
}

/**
 * Événement de flux → phase affichable (pur, déterministe).
 * `null` = l'événement ne porte RIEN d'affichable : la phase en cours ne
 * bouge pas — on n'invente jamais une étape qui n'existe pas.
 */
export function phaseDepuisEvenement(event: ConversationStreamEvent): PhaseReflexion | null {
  switch (event.type) {
    case "status":
      return phaseDepuisEtapeFlux(event.phase);
    case "run_created":
      // Un plan d'exécution vient d'être créé et sera suivi étape par étape.
      return "planification";
    case "step_update":
      return phaseDepuisEtapeRun(event.step);
    default:
      // message_delta / message_complete / done / artifact_created /
      // billing / turn_telemetry / error / approval_created / webgpu_media :
      // rien à mapper (le composant se démonte au premier delta / au done).
      return null;
  }
}

/** Phases du champ `status` du flux (StreamPhase). */
function phaseDepuisEtapeFlux(phase: StreamPhase): PhaseReflexion | null {
  switch (phase) {
    case "intention":
      return "analyse";
    case "plan":
      return "planification";
    case "synthesis":
      return "redaction";
    // "execution" / "image" : trop large pour être affirmé sans mensonge
    // (génération d'image ≠ outils) — le LIBELLÉ SERVEUR de l'événement
    // porte l'information réelle et s'affiche à la place.
    default:
      return null;
  }
}

/** Étapes du run (RunStep — suivi du plan d'exécution, engine-plan.ts). */
function phaseDepuisEtapeRun(step: RunStep): PhaseReflexion | null {
  // Un outil RÉEL en cours d'appel (artifact.create, image.generate,
  // video.create, video.status, connectors…) → « utilise ses outils ».
  if (step.status === "in_progress" && step.toolName) return "outils";
  switch (step.phase) {
    case "understanding":
      return "analyse";
    case "plan":
      return "planification";
    case "tools":
      return "outils";
    case "result":
      return "redaction";
    default:
      return null;
  }
}

/**
 * Libellé final affiché : le libellé RÉEL du serveur prime (il décrit ce
 * qui arrive à l'instant T), sinon le libellé de la phase, sinon générique.
 */
export function libelleReflexion(
  phase: PhaseReflexion | null | undefined,
  libelleServeur: string | null | undefined,
): string {
  const serveur = typeof libelleServeur === "string" ? libelleServeur.trim() : "";
  if (serveur) return serveur;
  return LIBELLES_PHASE[phase ?? "reflexion"];
}

import "server-only";
import type { BusinessEventInput } from "./types";

/**
 * Bus d'événements métier — point d'entrée unique des modules vers le
 * Workflow Engine. Import dynamique à l'appel pour éviter tout cycle
 * statique (les moteurs s'émettent des événements, le Workflow Engine
 * pilote les moteurs).
 *
 * Garanties :
 *  - jamais d'exception remontée à l'appelant (l'automatisation ne doit pas
 *    casser l'opération métier qui la déclenche) ;
 *  - erreurs journalisées en observabilité pino ;
 *  - budget de temps borné (les workflows événementiels s'exécutent dans la
 *    même requête, avec un garde-fou de concurrence côté Workflow Engine).
 */
export async function emitBusinessEvent(input: BusinessEventInput): Promise<{ dispatched: number }> {
  const { dispatchEvent } = await import("./workflow-engine");
  try {
    return await dispatchEvent(input);
  } catch (error) {
    const { executionLogger, safeError } = await import("@/lib/observability/logger");
    executionLogger({ requestId: "engine-event" }).warn(
      { event: "engine.workflow.event_failed", eventType: input.eventType, error: safeError(error) },
      "Émission d'événement métier échouée (ignorée)",
    );
    return { dispatched: 0 };
  }
}

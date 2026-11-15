import {
  FieldValue,
} from "@/lib/r2fs";

import {
  adminDb,
} from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";

import type {
  ToolResult,
} from "./types";

/**
 * GARDE QUOTA (Task 110-e) : l'audit outil (`toolAuditLogs`) est AWAITÉ par
 * lib/tools/executor (executeTool → auditToolExecutionSafe, ToolExecutor.
 * execute) AVANT de retourner le RÉSULTAT de l'outil. Sur Firestore brut,
 * sous quota quotidien épuisé l'écriture pendait SANS lever (Task 97) : un
 * outil RÉUSSI voyait son résultat retenu par l'écriture d'audit jusqu'au
 * timeout de l'étape (120 s par défaut) puis l'étape était marquée échec —
 * travail réel perdu. runFirestoreGuarded (lib/queue/firestore-guard,
 * partagé avec la file de missions 110-d) borne l'écriture à 6 s +
 * disjoncteur : le fail-soft des appelants (try/catch) est conservé mais
 * échoue VITE, le résultat réel est rendu immédiatement.
 */

export async function recordToolAudit(
  params: {
    userId: string;
    projectId?: string;
    agentId?: string;
    executionId?: string;

    toolId: string;

    input: unknown;

    result: ToolResult;
  },
) {
  const ref =
    adminDb
      .collection("toolAuditLogs")
      .doc();

  await runFirestoreGuarded(`tool audit ${params.toolId}`, () => ref.set({
    userId:
      params.userId,

    projectId:
      params.projectId ?? null,

    agentId:
      params.agentId ?? null,

    executionId:
      params.executionId ?? null,

    toolId:
      params.toolId,

    input:
      sanitizeAuditInput(
        params.input,
      ),

    result: {
      status:
        params.result.status,

      output:
        sanitizeAuditInput(
          params.result.output,
        ),

      error:
        params.result.error ??
        null,

      latencyMs:
        params.result.latencyMs,
    },

    createdAt:
      FieldValue.serverTimestamp(),
  }));

  return ref.id;
}

function sanitizeAuditInput(
  value: unknown,
): unknown {
  if (
    value === undefined ||
    value === null
  ) {
    return value;
  }

  if (
    typeof value === "string"
  ) {
    if (
      value.length > 10000
    ) {
      return value.slice(
        0,
        10000,
      );
    }

    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  try {
    const serialized =
      JSON.stringify(value);

    if (
      serialized.length > 20000
    ) {
      return serialized.slice(
        0,
        20000,
      );
    }

    return JSON.parse(
      serialized,
    );
  } catch {
    return "[unserializable]";
  }
}

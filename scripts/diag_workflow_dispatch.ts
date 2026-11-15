/**
 * Diagnostic local du dispatch événementiel avec les env de production.
 * Usage : npx tsx --env-file=.env.diagnostic scripts/diag_workflow_dispatch.ts
 */
(process.env as { NODE_ENV?: string }).NODE_ENV = "production";

// Neutralise le paquet "server-only" (réservé aux composants Next) pour l'exécution Node directe.
import { createRequire } from "node:module";
const nodeRequire = createRequire(import.meta.url);
try {
  const serverOnlyPath = nodeRequire.resolve("server-only");
  nodeRequire.cache[serverOnlyPath] = { id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {} } as never;
} catch {
  // paquet absent : rien à neutraliser
}

async function main() {
  const { createWorkflow, dispatchEvent, listRuns } = await import("../lib/engines/workflow-engine");

  const userId = `diag-${Date.now()}`;

  const workflow = await createWorkflow(userId, {
    name: "DIAG veille facture",
    enabled: true,
    trigger: { type: "event", eventType: "finance.invoice_created" },
    conditions: [],
    steps: [{ id: "note1", name: "Notifier", type: "notification", config: { title: "Diag", body: "facture {{payload.invoiceNumber}}" } }],
  });
  console.log("workflow créé", workflow.id);

  const result = await dispatchEvent({
    userId,
    eventType: "finance.invoice_created",
    payload: { invoiceNumber: "DIAG-1", amount: 100 },
  });
  console.log("dispatchEvent →", JSON.stringify(result));

  const runs = await listRuns(userId);
  console.log("runs:", runs.length, runs.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, steps: r.steps.length })));

  process.exit(0);
}

main().catch((error) => {
  console.error("DIAG FATAL:", error?.message ?? error);
  if (error?.stack) console.error(error.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});

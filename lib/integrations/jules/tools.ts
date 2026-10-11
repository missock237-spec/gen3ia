import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import { julesCreateSession, julesGetSession } from "@/lib/integrations/jules/client";

/**
 * Jules (Google) is an asynchronous coding agent: a session clones the
 * repository, works on the prompt, and produces outputs/PRs. Tasks are
 * fire-and-track, so the tool returns the session name for follow-up reads.
 *
 * Task 121 — le transport HTTP (X-Goog-Api-Key, base v1alpha) vit désormais
 * dans le client service réutilisable `lib/integrations/jules/client.ts` :
 * les tools délèuent et gardent un comportement strictement identique.
 */
const JulesCreateTaskInput = z.object({
  githubRepo: z.string().min(3).max(200).describe("Repository in 'owner/repo' format"),
  prompt: z.string().min(1).max(10_000),
  startingBranch: z.string().max(200).optional(),
});

export const julesCreateTaskTool: ToolDefinition<z.infer<typeof JulesCreateTaskInput>, unknown> = {
  id: "jules.create_task",
  name: "jules.create_task",
  description: "Start an asynchronous coding task with the Jules agent on a GitHub repository. Returns the session to poll.",
  category: "code",
  risk: "high",
  inputSchema: JulesCreateTaskInput,
  async execute(input) {
    const created = await julesCreateSession(input);
    return { session: created.session, state: created.state };
  },
};

const JulesGetTaskInput = z.object({
  session: z.string().min(2).max(200).describe("Session name returned by jules.create_task"),
});

export const julesGetTaskTool: ToolDefinition<z.infer<typeof JulesGetTaskInput>, unknown> = {
  id: "jules.get_task",
  name: "jules.get_task",
  description: "Read the current state and latest updates of a Jules coding session.",
  category: "code",
  risk: "low",
  inputSchema: JulesGetTaskInput,
  async execute(input) {
    const snapshot = await julesGetSession(input.session);
    return {
      state: snapshot.state,
      outputs: snapshot.outputs ?? [],
      errorMessage: snapshot.errorMessage ?? undefined,
    };
  },
};

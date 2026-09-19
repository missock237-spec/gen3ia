import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";

const JULES_API = process.env.JULES_API_BASE_URL ?? "https://jules.googleapis.com/v1alpha";

function apiKey(): string {
  const value = process.env.JULES_API_KEY;
  if (!value) throw new Error("JULES_API_KEY is not configured.");
  return value;
}

async function julesFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${JULES_API}${path}`, {
    ...init,
    headers: {
      "X-Goog-Api-Key": apiKey(),
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jules API ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Jules (Google) is an asynchronous coding agent: a session clones the
 * repository, works on the prompt, and produces outputs/PRs. Tasks are
 * fire-and-track, so the tool returns the session name for follow-up reads.
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
    const [owner, ...rest] = input.githubRepo.split("/");
    const repo = rest.join("/");
    if (!owner || !repo) throw new Error("githubRepo must use the 'owner/repo' format.");
    const data = await julesFetch<{ name?: string; id?: string; state?: string }>("/sessions", {
      method: "POST",
      body: JSON.stringify({
        sourceContext: { source: `repos/${owner}/${repo}`, githubRepo: { owner, repo } },
        prompt: input.prompt,
        ...(input.startingBranch ? { startingBranch: input.startingBranch } : {}),
      }),
    });
    return { session: data.name ?? data.id, state: data.state };
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
    const name = input.session.replace(/^\/+/, "").replace(/^sessions\/?/, "");
    const data = await julesFetch<{ state?: string; outputs?: Array<{ url?: string; type?: string }>; errorMessage?: string }>(
      `/sessions/${encodeURIComponent(name)}`,
    );
    return { state: data.state, outputs: data.outputs ?? [], errorMessage: data.errorMessage ?? undefined };
  },
};

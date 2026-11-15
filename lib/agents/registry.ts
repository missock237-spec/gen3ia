import type { Agent } from "@/lib/firestore/types";

export class AgentRegistry {
  private readonly agents =
    new Map<string, Agent>();

  register(agent: Agent): void {
    this.agents.set(
      agent.id,
      agent
    );
  }

  get(id: string): Agent {
    const agent =
      this.agents.get(id);

    if (!agent) {
      throw new Error(
        `Agent ${id} not found.`
      );
    }

    return agent;
  }

  remove(id: string): void {
    this.agents.delete(id);
  }

  list(): Agent[] {
    return Array.from(
      this.agents.values()
    );
  }
}

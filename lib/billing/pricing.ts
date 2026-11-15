import type {
  TaskType,
} from "@/lib/ai/models";

const DEFAULT_COSTS:
  Record<TaskType, number> = {
    chat: 2,
    reasoning: 5,
    research: 5,
    coding: 5,
    image: 10,
    video: 50,
    audio: 20,
    document: 5,
    automation: 10,
    agent: 10,
  };

export function getTaskCost(
  task: TaskType,
): number {
  return DEFAULT_COSTS[task];
}

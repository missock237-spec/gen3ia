import { RuntimeStep } from "./types";

export class RuntimeScheduler {
  private readonly maxConcurrency: number;

  private running = new Set<string>();

  constructor(maxConcurrency = 4) {
    this.maxConcurrency = Math.max(
      1,
      Math.min(maxConcurrency, 32),
    );
  }

  get capacity(): number {
    return Math.max(
      0,
      this.maxConcurrency - this.running.size,
    );
  }

  canStart(): boolean {
    return this.running.size < this.maxConcurrency;
  }

  start(step: RuntimeStep): void {
    if (!this.canStart()) {
      throw new Error(
        "Runtime concurrency limit reached",
      );
    }

    this.running.add(step.id);
  }

  finish(step: RuntimeStep): void {
    this.running.delete(step.id);
  }

  getRunning(): string[] {
    return [...this.running];
  }
}

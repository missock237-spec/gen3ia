import { randomUUID } from "node:crypto";
import { generateForUser } from "@/lib/billing/ai-execution";
import { getWallet, WALLET_CURRENCY } from "@/lib/billing/wallet";
import { executeToolSecurely } from "./secure-tool-executor";
import { ExecutionPolicy, DEFAULT_EXECUTION_POLICY } from "@/lib/security/execution-policy";
import { RuntimeExecutionState, RuntimePlan, RuntimeStep } from "./types";
import { createCheckpoint, saveCheckpoint } from "./checkpoint";
import { getReadySteps, validateDAG } from "./dag";
import { RuntimeScheduler } from "./scheduler";

/**
 * Configuration d'un agent personnalise du Studio. Injectee dans chaque step
 * LLM : le prompt systeme de l'agent precede TOUJOURS les contraintes de
 * securite du runtime (non negotiables), et les preferences modele/provider
 * orientent le routeur IA.
 */
export interface RuntimeAgentConfig {
  name: string;
  type?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
}

export interface RuntimeRunnerOptions { userId: string; objective: string; plan: RuntimePlan; conversationId?: string; signal?: AbortSignal; policy?: ExecutionPolicy; agent?: RuntimeAgentConfig; }

export class AgentRuntime {
  private state: RuntimeExecutionState;
  private readonly scheduler: RuntimeScheduler;
  private readonly signal?: AbortSignal;
  private readonly policy: ExecutionPolicy;
  private readonly startedAtMs: number;
  private readonly agentConfig?: RuntimeAgentConfig;

  constructor(options: RuntimeRunnerOptions) {
    const validation = validateDAG(options.plan);
    if (!validation.valid) throw new Error(`Invalid agent DAG:\n${validation.errors.join("\n")}`);
    this.signal = options.signal;
    this.policy = options.policy ?? DEFAULT_EXECUTION_POLICY;
    this.agentConfig = options.agent;
    this.scheduler = new RuntimeScheduler(options.plan.maxConcurrency);
    this.startedAtMs = Date.now();
    this.state = {
      executionId: options.plan.executionId || randomUUID(), userId: options.userId, objective: options.objective, ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
      status: "pending", plan: options.plan, observations: [], evaluations: [], outputs: {}, iteration: 0,
      totalRetries: 0, maxTotalRetries: 15,
      billing: { currency: WALLET_CURRENCY, totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
    };
  }

  async run(): Promise<RuntimeExecutionState> {
    this.state.status = "running";
    this.state.startedAt = new Date().toISOString();
    const wallet = await getWallet(this.state.userId);
    if (wallet.availableMinor <= 0) throw new Error(`Insufficient wallet balance. Add funds before starting an AI execution.`);
    await createCheckpoint(this.state);
    try {
      while (this.state.iteration < this.state.plan.maxIterations) {
        this.throwIfCancelled();
        this.assertExecutionBudget();
        this.state.iteration++;
        const completed = this.getCompletedSteps();
        const running = new Set(this.scheduler.getRunning());
        const ready = getReadySteps(this.state.plan, completed, running);
        if (ready.length === 0 && this.scheduler.getRunning().length === 0) break;
        const executable = ready.slice(0, this.scheduler.capacity);
        await Promise.all(executable.map((step) => this.executeStep(step)));
        await saveCheckpoint(this.state);
        if (this.areAllStepsFinished()) break;
      }
      this.finalize();
      await saveCheckpoint(this.state);
      return this.state;
    } catch (error) {
      this.state.status = this.signal?.aborted ? "cancelled" : "failed";
      this.state.error = error instanceof Error ? error.message : String(error);
      this.state.completedAt = new Date().toISOString();
      await saveCheckpoint(this.state);
      throw error;
    }
  }

  private async executeStep(step: RuntimeStep): Promise<void> {
    this.scheduler.start(step);
    step.status = "running";
    const startedAt = Date.now();
    try {
      this.assertExecutionBudget();
      const output = await this.withTimeout(this.dispatch(step), step.timeoutMs);
      step.output = output;
      step.status = "completed";
      this.state.outputs[step.id] = output;
      this.state.observations.push({ stepId: step.id, success: true, output, latencyMs: Date.now() - startedAt, timestamp: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.observations.push({ stepId: step.id, success: false, error: message, latencyMs: Date.now() - startedAt, timestamp: new Date().toISOString() });
      if (step.sideEffect || step.maxRetries <= 0 || this.state.totalRetries >= this.state.maxTotalRetries) { step.status = "failed"; throw error; }
      this.state.totalRetries++;
      step.maxRetries--;
      step.status = "pending";
    } finally {
      this.scheduler.finish(step);
      await saveCheckpoint(this.state);
    }
  }

  private async dispatch(step: RuntimeStep): Promise<unknown> {
    switch (step.type) {
      case "llm": case "document": case "media": return this.executeLLM(step);
      case "tool": return this.executeTool(step);
      case "research": return this.executeTool({ ...step, toolName: step.toolName ?? "web.search" });
      case "code": return this.executeCode(step);
      case "condition": return this.evaluateCondition(step);
      default: throw new Error(`Unsupported runtime step: ${step.type}`);
    }
  }

  private static readonly SAFETY_CONTRACT =
    "Never invent external results, credentials, customer data, transactions or completed actions. Do not perform side effects unless a separately authorized tool step executes them. Be factual, operational and explicit about uncertainty.";

  private static readonly VALID_PROVIDERS = new Set(["groq", "openrouter", "anthropic", "openai", "glm", "huggingface"]);

  private static safeProvider(value?: string): "groq" | "openrouter" | "anthropic" | "openai" | "glm" | "huggingface" | undefined {
    return value && AgentRuntime.VALID_PROVIDERS.has(value) ? (value as "groq" | "openrouter" | "anthropic" | "openai" | "glm" | "huggingface") : undefined;
  }

  private async executeLLM(step: RuntimeStep): Promise<unknown> {
    const dependencyContext = this.getDependencyOutputs(step);
    const role = step.agentRole ?? "general";
    const complexity = role === "analytics" ? 1.35 : role === "orchestrator" ? 1.25 : 1;
    const personalPrompt = this.agentConfig?.systemPrompt?.trim();
    const systemContent = personalPrompt
      ? `You are "${this.agentConfig?.name ?? "Agent"}", a personalized AI agent created in the Gen3ia Studio${this.agentConfig?.type ? ` (specialty: ${this.agentConfig.type})` : ""}.\n\n--- OWNER INSTRUCTIONS (personnalite et mission de l'agent) ---\n${personalPrompt.slice(0, 12_000)}\n--- END OWNER INSTRUCTIONS ---\n\nYou are executing one step of a mission inside the Gen3ia multi-agent runtime. Work only on your assigned responsibility. ${AgentRuntime.SAFETY_CONTRACT}`
      : `You are the ${role} agent inside the Gen3ia multi-agent runtime. Work only on your assigned responsibility. Be factual, operational and explicit about uncertainty. ${AgentRuntime.SAFETY_CONTRACT}`;
    const billed = await generateForUser({
      userId: this.state.userId,
      executionId: this.state.executionId,
      complexity,
      request: {
        task: step.type === "document" ? "document" : "agent",
        ...(AgentRuntime.safeProvider(this.agentConfig?.provider) ? { provider: AgentRuntime.safeProvider(this.agentConfig?.provider) } : {}),
        ...(this.agentConfig?.model ? { model: this.agentConfig.model } : {}),
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: JSON.stringify({ objective: this.state.objective, agentRole: role, step: { id: step.id, name: step.name, description: step.description, input: step.input }, dependencies: dependencyContext }) },
        ],
        maxTokens: 4096,
      },
    });
    this.state.billing.totalChargeMinor += billed.chargeMinor;
    this.state.billing.totalProviderCostEur += billed.providerCostEur;
    this.state.billing.llmInputTokens += billed.response.usage.inputTokens;
    this.state.billing.llmOutputTokens += billed.response.usage.outputTokens;
    return billed.response.text;
  }

  private async executeTool(step: RuntimeStep): Promise<unknown> {
    if (!step.toolName) throw new Error(`Tool step ${step.id} has no toolName`);
    const dependencies = this.getDependencyOutputs(step);
    const input: Record<string, unknown> = Object.keys(dependencies).length > 0 ? { ...step.input, dependencies } : { ...step.input };
    const approvalId = typeof input.approvalId === "string" ? input.approvalId : undefined;
    delete input.approvalId;
    return executeToolSecurely({ userId: this.state.userId, executionId: this.state.executionId, toolName: step.toolName, input, approvalId, policy: this.policy, signal: this.signal });
  }

  private async executeCode(step: RuntimeStep): Promise<unknown> {
    const code = typeof step.input.code === "string" ? step.input.code : null;
    if (!code) throw new Error("Code execution requires input.code");
    return executeToolSecurely({ userId: this.state.userId, executionId: this.state.executionId, toolName: "code.execute", input: { ...step.input, code }, policy: this.policy, signal: this.signal });
  }

  private evaluateCondition(step: RuntimeStep): boolean {
    const expression = step.input.expression;
    if (typeof expression !== "string") return true;
    return Boolean(this.state.outputs[expression]);
  }
  private getDependencyOutputs(step: RuntimeStep): Record<string, unknown> { return Object.fromEntries(step.dependencies.map((dependency) => [dependency, this.state.outputs[dependency]])); }
  private getCompletedSteps(): Set<string> { return new Set(this.state.plan.steps.filter((step) => step.status === "completed").map((step) => step.id)); }
  private areAllStepsFinished(): boolean { return this.state.plan.steps.every((step) => ["completed", "skipped", "failed"].includes(step.status)); }
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Step timeout after ${timeoutMs}ms`)), timeoutMs); }); try { return await Promise.race([promise, timeout]); } finally { if (timer) clearTimeout(timer); } }
  private throwIfCancelled(): void { if (this.signal?.aborted) throw new Error("Agent execution cancelled"); }
  private assertExecutionBudget(): void { if (this.state.iteration > this.policy.maxSteps) throw new Error("Execution step budget exhausted"); if (Date.now() - this.startedAtMs > this.policy.maxExecutionMs) throw new Error("Execution time budget exhausted"); }
  private finalize(): void { const hasFailures = this.state.plan.steps.some((step) => step.status === "failed"); this.state.status = hasFailures ? "failed" : "completed"; this.state.completedAt = new Date().toISOString(); }
}
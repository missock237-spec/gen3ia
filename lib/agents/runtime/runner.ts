import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateForUser } from "@/lib/billing/ai-execution";
import { getWallet, WALLET_CURRENCY } from "@/lib/billing/wallet";
import { getAgentForUser } from "@/lib/agents/repository";
import { executeToolSecurely } from "./secure-tool-executor";
import { ExecutionPolicy, DEFAULT_EXECUTION_POLICY } from "@/lib/security/execution-policy";
import { RuntimeExecutionState, RuntimePlan, RuntimeStep } from "./types";
import { createCheckpoint, saveCheckpoint } from "./checkpoint";
import { getReadySteps, validateDAG } from "./dag";
import { RuntimeScheduler } from "./scheduler";
import { assertNotPaused, assertNotStopped, PauseRequestedError } from "./pause";
import { generateImageWithAgnes, isImageGenerationEnabled } from "@/lib/ai/image-generation";
import { enhanceImagePrompt } from "@/lib/ai/image-prompt-enhancer";
import { RESPONSE_FORMAT_RULES } from "@/lib/ai/response-quality";
import { applyPromptVariables } from "@/lib/ai/prompt-template";
import { verifyOutcomeCriteria, type OutcomeContract } from "@/lib/agents/outcome-contract";
import { buildReplan } from "./replan";

/* ------------------------------------------------------------------ */
/* Completion des livrables document (artifact.create)                 */
/* ------------------------------------------------------------------ */

const ARTIFACT_PLAN_SYSTEM =
  "Tu rédiges le contenu d'un document professionnel pour l'utilisateur de Gen3ia. " +
  "Tu produis UNIQUEMENT un objet JSON : { title: string, format: string, blocks: array }. " +
  "Blocs disponibles : { type: \"title\", text } (une seule fois, en premier), { type: \"heading\", text, level }, " +
  "{ type: \"paragraph\", text } (contenu rédigé intégralement), { type: \"list\", items: [] }, " +
  "{ type: \"table\", columns: [], rows: [[]] }, { type: \"quote\", text }, { type: \"code\", text, language }, { type: \"pageBreak\" }. " +
  "Le contenu doit être complet, professionnel et exploitable : jamais de placeholder, jamais de section vide.";

const ARTIFACT_PLAN_SCHEMA = z.object({
  title: z.string().min(1).max(300),
  format: z.enum(["pdf", "docx", "xlsx", "pptx", "csv", "md", "txt", "json", "html"]),
  blocks: z.array(
    z.object({
      type: z.enum(["title", "heading", "paragraph", "list", "table", "code", "quote", "pageBreak"]),
      text: z.string().max(200_000).optional(),
      level: z.number().int().min(1).max(6).optional(),
      ordered: z.boolean().optional(),
      items: z.array(z.string().max(20_000)).max(2_000).optional(),
      columns: z.array(z.string().max(10_000)).max(1_000).optional(),
      rows: z.array(z.array(z.string().max(10_000)).max(1_000)).max(2_000).optional(),
      language: z.string().max(100).optional(),
    }),
  ).min(1).max(2_000),
});

/** Extrait l'objet JSON d'une réponse modèle (fences markdown tolérées). */
function extractJsonCandidate(raw: string): unknown {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), text].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          /* candidat suivant */
        }
      }
    }
  }
  throw new Error("Le contenu du livrable n'est pas un JSON valide.");
}

/**
 * Configuration d'un agent personnalise du Studio. Injectee dans chaque step
 * LLM : le prompt systeme de l'agent precede TOUJOURS les contraintes de
 * securite du runtime (non negotiables), et les preferences modele/provider
 * orientent le routeur IA.
 */
export interface RuntimeAgentConfig {
  agentId?: string;
  name: string;
  type?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  // Température LLM de l'agent (créativité, 0–2) — injectée dans chaque
  // appel LLM du runtime (défaut moteur sinon).
  temperature?: number;
  // Sous-agents délégables : liste blanche d'ids (étapes type "agent").
  subAgentIds?: string[];
  // Plafond de dépense par exécution en centimes (facturation LLM runner).
  budgetEurMinor?: number;
  // Organisation propriétaire de l'agent (Task 58) : propagée sur l'état
  // d'exécution pour le cloisonnement multi-tenant et la facturation par
  // organisation. Validé EN AMONT par les routes (agent chargé via
  // getAgentForUser — l'appartenance est déjà garantie par le dépôt).
  orgId?: string;
}

export interface RuntimeRunnerOptions { userId: string; projectId?: string; objective: string; plan: RuntimePlan; conversationId?: string; signal?: AbortSignal; policy?: ExecutionPolicy; agent?: RuntimeAgentConfig; /** Organisation propriétaire (Task 58) : source explicite (file mission, tâche workspace) quand aucun agent n'est transmis ; l'orgId de l'agent PRIME sinon. */ orgId?: string; /** Reprise : sorties des étapes déjà complétées (checkpoint) — sans elles, les étapes dépendantes reprendraient à vide. */ initialOutputs?: Record<string, unknown>; /** Échéance horloge (epoch ms) : passé ce seuil, plus AUCUN nouveau lot d'étapes n'est lancé — le runtime se met en PAUSE PROPRE (checkpoint conservé, étapes restantes "pending") au lieu de démarrer un travail qui dépasserait la fenêtre d'exécution. Mécanisme de la file d'attente mission (Task 53, recommandation A de l'audit) : chaque tick exécute une tranche bornée puis ré-enfile la suite. Non défini = comportement inchangé (toute l'exécution dans l'appel). */ batchDeadlineMs?: number; /** Réserve minimale (ms) exigée avant de lancer un lot quand batchDeadlineMs est défini — un lot démarré doit avoir la place de se terminer (timeout d'étape inclus). Défaut : 45 000 ms. */ minBatchReserveMs?: number; /** Contrat de résultat (concepts #1/#2) : critères d'acceptation mesurables — la porte de sortie bloque « completed » tant qu'ils ne sont pas vérifiés. */ outcomeContract?: OutcomeContract; }

export class AgentRuntime {
  private state: RuntimeExecutionState;
  private readonly scheduler: RuntimeScheduler;
  private readonly signal?: AbortSignal;
  private readonly policy: ExecutionPolicy;
  private readonly startedAtMs: number;
  private readonly agentConfig?: RuntimeAgentConfig;
  private readonly projectId?: string;
  private readonly batchDeadline?: number;
  private readonly minBatchReserve: number;
  private criticRounds = 0;
  // AUTONOMIE « FAÇON HUMAIN » (exigence production : l'agent ne s'arrête que
  // lorsqu'il a terminé ET livré) : deux tours de réparation critic au lieu
  // d'un seul — la persistance du travail reste bornée (coût maîtrisé) mais
  // les échecs transitoires sont surmontés à deux niveaux de stratégie.
  private static readonly CRITIC_MAX_ROUNDS = 2;
  private outcomeRepairs = 0;
  private static readonly OUTCOME_MAX_REPAIRS = 1;
  private static readonly GATE_FEEDBACK_LIMIT = 800;
  private replanRounds = 0;
  // Deux replanifications dynamiques (contexte réel + leçons d'évolution) au
  // lieu d'une seule : la mission tente deux stratégies complètes avant de
  // déclarer un échec honnête.
  private static readonly REPLAN_MAX_ROUNDS = 2;

  constructor(options: RuntimeRunnerOptions) {
    const validation = validateDAG(options.plan);
    if (!validation.valid) throw new Error(`Invalid agent DAG:\n${validation.errors.join("\n")}`);
    this.signal = options.signal;
    this.policy = options.policy ?? DEFAULT_EXECUTION_POLICY;
    this.agentConfig = options.agent;
    this.projectId = options.projectId;
    this.batchDeadline = options.batchDeadlineMs;
    this.minBatchReserve = options.minBatchReserveMs ?? 45_000;
    this.scheduler = new RuntimeScheduler(options.plan.maxConcurrency);
    this.startedAtMs = Date.now();
    // Cloisonnement multi-tenant (Task 58) : l'orgId explicite (file, tâche
    // workspace, API) sert de source ; celui de l'agent rattaché prime —
    // il est garanti membre de l'organisation du propriétaire au moment de
    // la création de l'agent (assertOrgAttach du dépôt).
    const runtimeOrgId = options.agent?.orgId?.trim() || options.orgId?.trim() || undefined;
    this.state = {
      executionId: options.plan.executionId || randomUUID(), userId: options.userId, objective: options.objective, ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
      ...(runtimeOrgId ? { orgId: runtimeOrgId } : {}),
      ...(options.outcomeContract ? { outcomeContract: options.outcomeContract } : {}),
      status: "pending", plan: options.plan, observations: [], evaluations: [], outputs: options.initialOutputs ? { ...options.initialOutputs } : {}, iteration: 0,
      totalRetries: 0, maxTotalRetries: 15,
      billing: { currency: WALLET_CURRENCY, totalChargeMinor: 0, totalProviderCostEur: 0, llmInputTokens: 0, llmOutputTokens: 0 },
    };
  }

  /**
   * Persistance du checkpoint TOLÉRANTE aux pannes : un checkpoint est une
   * reprise à chaud, pas une étape métier. Un incident Firestore ne doit
   * JAMAIS marquer une étape réussie comme "failed" ni faire échouer une
   * mission dont le travail LLM/outils a réussi (bug historique : un blip
   * Firestore en fin d'étape condamnait la mission ET gelait la réservation
   * wallet en laissant des fonds bloqués en reservedMinor).
   */
  private async persistCheckpoint(): Promise<void> {
    try {
      await saveCheckpoint(this.state);
    } catch (error) {
      console.error("[runtime] Checkpoint non persisté (exécution poursuivie):", error instanceof Error ? error.message : error);
    }
  }

  async run(): Promise<RuntimeExecutionState> {
    this.state.status = "running";
    this.state.startedAt = new Date().toISOString();
    const wallet = await getWallet(this.state.userId);
    if (wallet.availableMinor <= 0) throw new Error(`Insufficient wallet balance. Add funds before starting an AI execution.`);
    await createCheckpoint(this.state);
    try {
      // Boucle externe = tours de critic. Après une exécution en échec, le
      // critic (déterministe d'abord, LLM ensuite si nécessaire) identifie
      // les étapes à rejouer ; au plus 1 tour de réparation automatique.
      while (true) {
        while (this.state.iteration < this.state.plan.maxIterations) {
          this.throwIfCancelled();
          await this.throwIfPaused();
          await this.throwIfStopped();
          this.assertExecutionBudget();
          if (this.batchDeadline !== undefined && Date.now() + this.minBatchReserve > this.batchDeadline) {
            // File d'attente mission (recommandation A) : la fenêtre de
            // l'invocation arrive à échéance — on ne lance PAS un nouveau
            // lot qui serait coupé par la plateforme (travail payant
            // perdu). Pause PROPRE réutilisant le chemin éprouvé : le
            // checkpoint (lots déjà complétés + outputs) est conservé, les
            // étapes restantes restent "pending" — le tick suivant ré-enfile
            // la suite. Zéro facturation perdue : aucun appel n'est démarré
            // au-delà de l'échéance.
            throw new PauseRequestedError(this.state.executionId);
          }
          this.state.iteration++;
          const completed = this.getCompletedSteps();
          const running = new Set(this.scheduler.getRunning());
          const ready = getReadySteps(this.state.plan, completed, running);
          if (ready.length === 0 && this.scheduler.getRunning().length === 0) break;
          const executable = ready.slice(0, this.scheduler.capacity);
          await Promise.all(executable.map((step) => this.executeStep(step)));
          await this.persistCheckpoint();
          if (this.areAllStepsFinished()) break;
        }
        // Un arrêt demandé pendant le DERNIER lot d'étapes prévaut sur la
        // complétion : l'utilisateur a demandé l'arrêt, l'exécution se
        // termine à l'état cancelled (jamais "completed" après un stop).
        await this.throwIfStopped();
        this.finalize();
        const hasFailedSteps = () => this.state.plan.steps.some((step) => step.status === "failed");
        if (hasFailedSteps() && this.criticRounds < AgentRuntime.CRITIC_MAX_ROUNDS && !this.signal?.aborted) {
          this.criticRounds++;
          const retryStepIds = await this.requestCriticRetry();
          if (retryStepIds && retryStepIds.length > 0) {
            for (const step of this.state.plan.steps) {
              if (step.status === "failed" && retryStepIds.includes(step.id)) step.status = "pending";
            }
            this.state.status = "running";
            delete this.state.error;
            await this.persistCheckpoint();
            continue; // reprend la boucle interne avec les étapes réinitialisées
          }
        }
        // REPLANIFICATION DYNAMIQUE (concept #10) : les étapes ont encore
        // échoué APRÈS la réparation du critic — on ne rejoue PAS bêtement
        // le même plan : le replanificateur réécrit la suite (contexte réel
        // + leçons d'évolution), au plus UNE fois, jamais sur arrêt. Un
        // échec du replanificateur = échec honnête de la mission.
        if (hasFailedSteps() && this.replanRounds < AgentRuntime.REPLAN_MAX_ROUNDS && !this.signal?.aborted) {
          this.replanRounds++;
          try {
            const { plan, usage } = await buildReplan(this.state, {
              userId: this.state.userId,
              executionId: this.state.executionId,
            });
            this.state.billing.totalChargeMinor += usage.chargeMinor;
            this.state.billing.totalProviderCostEur += usage.providerCostEur;
            this.state.billing.llmInputTokens += usage.inputTokens;
            this.state.billing.llmOutputTokens += usage.outputTokens;
            this.state.plan = plan;
            this.state.status = "running";
            delete this.state.error;
            await this.persistCheckpoint();
            continue;
          } catch (error) {
            console.error("[runtime] Replanification impossible (échec conservé):", error instanceof Error ? error.message : error);
          }
        }
        // PORTE DE RÉSULTAT (concepts #1/#2) : sans étape en échec, la
        // mission n'est « completed » que si son contrat de résultat est
        // vérifié. Critères non atteints + failPolicy « retry_once » → une
        // passe de correction des étapes livrables (feedback du verdict
        // injecté dans leur description). Toujours bornée : au plus une
        // passe, jamais sur arrêt utilisateur, juge en échec = porte levée
        // (honnêteté : `unavailable`, jamais de faux « critères atteints »).
        if (!hasFailedSteps() && this.state.outcomeContract && !this.signal?.aborted) {
          const { verification, usage } = await verifyOutcomeCriteria(this.state.outcomeContract, this.state, {
            userId: this.state.userId,
            executionId: this.state.executionId,
          });
          this.state.billing.totalChargeMinor += usage.chargeMinor;
          this.state.billing.totalProviderCostEur += usage.providerCostEur;
          this.state.billing.llmInputTokens += usage.inputTokens;
          this.state.billing.llmOutputTokens += usage.outputTokens;
          this.state.outcomeVerification = verification;
          if (!verification.passed && !verification.unavailable) {
            const repaired =
              this.outcomeRepairs < AgentRuntime.OUTCOME_MAX_REPAIRS &&
              this.state.outcomeContract.failPolicy === "retry_once"
                ? this.resetGateDeliverableSteps(verification.summary)
                : [];
            if (repaired.length > 0) {
              this.outcomeRepairs++;
              this.state.status = "running";
              delete this.state.error;
              await this.persistCheckpoint();
              continue;
            }
            this.state.status = "failed";
            this.state.error = `Critères d'acceptation non atteints : ${verification.summary}`;
            this.state.completedAt = new Date().toISOString();
            await this.persistCheckpoint();
            return this.state;
          }
        }
        break;
      }
      this.finalize();
      await this.persistCheckpoint();
      return this.state;
    } catch (error) {
      if (error instanceof Error && error.name === "PauseRequestedError") {
        // Pause propre : le travail déjà payé est conservé (étapes
        // complétées + outputs), les étapes restantes restent "pending" —
        // la reprise ré-exécute le même plan et saute le terminé.
        this.state.status = "paused";
        await this.persistCheckpoint();
        return this.state;
      }
      if (error instanceof Error && error.name === "StopRequestedError") {
        // ARRÊT définitif demandé par l'utilisateur à tout moment : le
        // travail déjà payé reste dans le checkpoint, l'exécution se
        // termine à l'état "cancelled" — la reprise n'est plus possible.
        this.state.status = "cancelled";
        this.state.completedAt = new Date().toISOString();
        await this.persistCheckpoint();
        return this.state;
      }
      this.state.status = this.signal?.aborted ? "cancelled" : "failed";
      this.state.error = error instanceof Error ? error.message : String(error);
      this.state.completedAt = new Date().toISOString();
      await this.persistCheckpoint();
      throw error;
    }
  }

  /** Consulte le contrôle de pause (tolérant aux pannes Firestore). */
  private async throwIfPaused(): Promise<void> {
    await assertNotPaused(this.state.executionId);
  }

  /** Consulte le contrôle d'arrêt définitif (tolérant aux pannes Firestore). */
  private async throwIfStopped(): Promise<void> {
    await assertNotStopped(this.state.executionId);
  }

  private async executeStep(step: RuntimeStep): Promise<void> {
    this.scheduler.start(step);
    step.status = "running";
    const startedAt = Date.now();
    try {
      this.assertExecutionBudget();
      // L'arrêt utilisateur est consulté AVANT chaque étape : une demande
      // posée pendant le lot courant prend effet au plus vite, sans lancer
      // une nouvelle unité de travail payante.
      await this.throwIfStopped();
      const output = await this.withTimeout(this.dispatch(step), step.timeoutMs);
      step.output = output;
      step.status = "completed";
      this.state.outputs[step.id] = output;
      this.state.observations.push({ stepId: step.id, success: true, output, latencyMs: Date.now() - startedAt, timestamp: new Date().toISOString() });
    } catch (error) {
      // Un arrêt utilisateur n'est JAMAIS une erreur d'étape : il se
      // propage immédiatement (pas de retry, pas de marquage "failed").
      if (error instanceof Error && error.name === "StopRequestedError") {
        step.status = "pending";
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      // Anomalie A2 (Task 45) : un TIMEOUT n'est jamais retryable — le
      // dispatch sous-jacent peut encore tourner (appel LLM payant en
      // cours). Retenter créerait une double exécution + une double
      // facturation. L'étape est donc marquée échouée, comme une étape à
      // effet de bord.
      const isTimeout = /^Step timeout after \d+ms$/.test(message);
      this.state.observations.push({ stepId: step.id, success: false, error: message, latencyMs: Date.now() - startedAt, timestamp: new Date().toISOString() });
      if (isTimeout) {
        step.status = "failed";
        throw error;
      }
      if (step.sideEffect || step.maxRetries <= 0 || this.state.totalRetries >= this.state.maxTotalRetries) { step.status = "failed"; throw error; }
      this.state.totalRetries++;
      step.maxRetries--;
      step.status = "pending";
    } finally {
      this.scheduler.finish(step);
      await this.persistCheckpoint();
    }
  }

  private async dispatch(step: RuntimeStep): Promise<unknown> {
    switch (step.type) {
      case "llm": case "document": return this.executeLLM(step);
      case "media": return this.executeMedia(step);
      case "tool": return this.executeTool(step);
      case "research": return this.executeTool({ ...step, toolName: step.toolName ?? "web.search" });
      case "code": return this.executeCode(step);
      case "condition": return this.evaluateCondition(step);
      case "agent": return this.executeSubAgent(step);
      default: throw new Error(`Unsupported runtime step: ${step.type}`);
    }
  }

  private static readonly SAFETY_CONTRACT =
    "Never invent external results, credentials, customer data, transactions or completed actions. Do not perform side effects unless a separately authorized tool step executes them. Be factual, operational and explicit about uncertainty.";

  /**
   * Compétence image du runtime Gen3ia : une étape `media` génère une VRAIE
   * image via Agnes AI. Le prompt est analysé puis amélioré par LLM (réalisme,
   * cadrage, éclairage) sans jamais modifier le sujet demandé. La sortie est
   * un rendu markdown d'image (affiché directement dans la conversation).
   * Repli : si Agnes n'est pas configuré, l'étape retombe sur une rédaction
   * LLM (comportement historique) au lieu de faire échouer la mission.
   */
  private async executeMedia(step: RuntimeStep): Promise<unknown> {
    const rawPrompt = typeof step.input?.prompt === "string" && (step.input.prompt as string).trim()
      ? String(step.input.prompt).slice(0, 4_000)
      : step.description;
    if (!isImageGenerationEnabled()) {
      return this.executeLLM(step);
    }
    const { prompt } = await enhanceImagePrompt(rawPrompt);
    // Qualité « ultra réaliste » : génération en 2K (détail supérieur),
    // garde-fou de durée aligné sur la politique d'exécution des outils.
    const image = await generateImageWithAgnes({ prompt, size: "2K", timeoutMs: 60_000 });
    const alt = step.name.replace(/[\[\]()"]/g, "").slice(0, 120) || "Image générée";
    return `![${alt}](${image.imageUrl})`;
  }

  /**
   * Délégation à un sous-agent du Studio (étape type "agent").
   * Le sous-agent exécute la tâche avec SA propre identité (nom,
   * instructions du propriétaire, provider/modèle/température) via un
   * appel LLM facturé au propriétaire. Garde-fous :
   *  - liste blanche obligatoire (agentConfig.subAgentIds) ;
   *  - profondeur 1 : un sous-agent ne délègue pas à son tour ;
   *  - aucun outil direct : les actions sensibles restent des étapes
   *    approuvées du plan superviseur (jamais de contournement HITL).
   */
  private async executeSubAgent(step: RuntimeStep): Promise<unknown> {
    const supervisorConfig = this.agentConfig;
    const allowlist = supervisorConfig?.subAgentIds ?? [];
    if (!step.agentId || !allowlist.includes(step.agentId)) {
      throw new Error(`Sous-agent non autorisé pour l'étape ${step.id} (absent de la liste des sous-agents de l'agent).`);
    }
    const sub = await getAgentForUser(this.state.userId, step.agentId);
    if (!sub || sub.status !== "active") {
      throw new Error(`Sous-agent introuvable ou inactif pour l'étape ${step.id}.`);
    }
    const dependencyContext = this.getDependencyOutputs(step);
    const subSystem = sub.systemPrompt?.trim()
      ? `You are "${sub.name}", a specialized AI agent of the Gen3ia Studio. You are consulted by a supervisor agent for ONE delegated task.\n\n--- YOUR INSTRUCTIONS (owner-defined) ---\n${sub.systemPrompt.slice(0, 8_000)}\n--- END INSTRUCTIONS ---\n\nAnswer directly and operationally for the delegated task. ${AgentRuntime.SAFETY_CONTRACT}`
      : `You are "${sub.name}", a specialized Gen3ia agent consulted for one delegated task. Answer directly and operationally. ${AgentRuntime.SAFETY_CONTRACT}`;
    // Task 52 : la réponse du sous-agent est visible dans le livrable de la
    // mission — le contrat de présentation s'applique aussi ici.
    const subSystemWithStyle = `${subSystem}\n\n${RESPONSE_FORMAT_RULES}`;
    const subProvider = sub.modelStrategy === "fixed" ? AgentRuntime.safeProvider(sub.preferredProvider) : undefined;
    const billed = await generateForUser({
      userId: this.state.userId,
      executionId: this.state.executionId,
      complexity: 1,
      request: {
        task: "agent",
        ...(subProvider ? { provider: subProvider } : {}),
        ...(sub.modelStrategy === "fixed" && sub.preferredModel ? { model: sub.preferredModel } : {}),
        ...(typeof sub.temperature === "number" && sub.temperature >= 0 && sub.temperature <= 2 ? { temperature: sub.temperature } : {}),
        messages: [
          { role: "system", content: subSystemWithStyle },
          { role: "user", content: JSON.stringify({ globalObjective: this.state.objective, delegatedTask: { id: step.id, name: step.name, description: step.description }, contextFromPreviousSteps: dependencyContext }) },
        ],
        maxTokens: 4096,
      },
    });
    this.state.billing.totalChargeMinor += billed.chargeMinor;
    this.state.billing.totalProviderCostEur += billed.providerCostEur;
    this.state.billing.llmInputTokens += billed.response.usage.inputTokens;
    this.state.billing.llmOutputTokens += billed.response.usage.outputTokens;
    return `[${sub.name}] ${billed.response.text}`;
  }

  private static readonly VALID_PROVIDERS = new Set(["groq", "openrouter", "anthropic", "openai", "glm", "huggingface"]);

  private static safeProvider(value?: string): "groq" | "openrouter" | "anthropic" | "openai" | "glm" | "huggingface" | undefined {
    return value && AgentRuntime.VALID_PROVIDERS.has(value) ? (value as "groq" | "openrouter" | "anthropic" | "openai" | "glm" | "huggingface") : undefined;
  }

  private async executeLLM(step: RuntimeStep): Promise<unknown> {
    const dependencyContext = this.getDependencyOutputs(step);
    const role = step.agentRole ?? "general";
    const complexity = role === "analytics" ? 1.35 : role === "orchestrator" ? 1.25 : 1;
    const personalPrompt = this.agentConfig?.systemPrompt?.trim();
    // Prompts système avancés : les jetons {{…}} des instructions du
    // propriétaire sont résolus à CHAQUE étape (date/heure réelles, agent) —
    // un jeton inconnu est supprimé, jamais transmis tel quel au modèle.
    const renderedPersonalPrompt = personalPrompt
      ? applyPromptVariables(personalPrompt.slice(0, 12_000), {
          agentName: this.agentConfig?.name,
          agentType: this.agentConfig?.type,
        }).text
      : undefined;
    const systemContent = renderedPersonalPrompt
      ? `You are "${this.agentConfig?.name ?? "Agent"}", a personalized AI agent created in the Gen3ia Studio${this.agentConfig?.type ? ` (specialty: ${this.agentConfig.type})` : ""}.\n\n--- OWNER INSTRUCTIONS (personnalite et mission de l'agent) ---\n${renderedPersonalPrompt}\n--- END OWNER INSTRUCTIONS ---\n\nYou are executing one step of a mission inside the Gen3ia multi-agent runtime. Work only on your assigned responsibility. ${AgentRuntime.SAFETY_CONTRACT}`
      : `You are the ${role} agent inside the Gen3ia multi-agent runtime. Work only on your assigned responsibility. Be factual, operational and explicit about uncertainty. ${AgentRuntime.SAFETY_CONTRACT}`;
    // Task 52 : le texte produit par une étape llm devient la réponse/livrable
    // visible de la mission — il respecte le contrat de présentation (clarté,
    // précision, structure markdown, langue de l'utilisateur).
    const systemWithStyle = `${systemContent}\n\n${RESPONSE_FORMAT_RULES}`;
    const billed = await generateForUser({
      userId: this.state.userId,
      executionId: this.state.executionId,
      complexity,
      request: {
        task: step.type === "document" ? "document" : "agent",
        ...(AgentRuntime.safeProvider(this.agentConfig?.provider) ? { provider: AgentRuntime.safeProvider(this.agentConfig?.provider) } : {}),
        ...(this.agentConfig?.model ? { model: this.agentConfig.model } : {}),
        ...(typeof this.agentConfig?.temperature === "number" && this.agentConfig.temperature >= 0 && this.agentConfig.temperature <= 2
          ? { temperature: this.agentConfig.temperature }
          : {}),
        messages: [
          { role: "system", content: systemWithStyle },
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
    let toolName = step.toolName;
    if (toolName.startsWith("composio:")) {
      const parts = toolName.split(":");
      const toolkit = parts[1];
      const toolSlug = parts.slice(2).join(":");
      if (!toolkit || !toolSlug) throw new Error("Invalid Composio tool selection: " + step.toolName);
      input.toolkit = toolkit;
      input.toolSlug = toolSlug;
      if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) input.arguments = {};
      toolName = "composio.execute";
    }
    if (toolName === "artifact.create") {
      // Le contenu du livrable est finalisé juste avant la génération du
      // fichier — jamais de document vide ni d'échec zod opaque.
      const completedInput = await this.completeArtifactInput(step, input);
      return executeToolSecurely({ userId: this.state.userId, projectId: this.projectId, agentId: this.agentConfig?.agentId, executionId: this.state.executionId, toolName, input: completedInput, approvalId, policy: this.policy, signal: this.signal });
    }
    return executeToolSecurely({ userId: this.state.userId, projectId: this.projectId, agentId: this.agentConfig?.agentId, executionId: this.state.executionId, toolName, input, approvalId, policy: this.policy, signal: this.signal });
  }

  /**
   * Complète les blocs d'un livrable (artifact.create) quand le plan ne les
   * contient pas : un appel de rédaction dédié produit le contenu intégral
   * avant la génération du fichier. Audits 25-b/25-d : les plans « 100% llm »
   * laissaient artifact.create sans entrée valide — le livrable n'était
   * jamais généré.
   */
  private async completeArtifactInput(step: RuntimeStep, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const blocks = Array.isArray(input.blocks) ? (input.blocks as unknown[]) : [];
    if (blocks.length > 0 && typeof input.title === "string" && input.title.trim().length > 0) return input;

    const dependencies = this.getDependencyOutputs(step);
    const billed = await generateForUser({
      userId: this.state.userId,
      executionId: this.state.executionId,
      complexity: 1,
      request: {
        task: "document",
        ...(AgentRuntime.safeProvider(this.agentConfig?.provider) ? { provider: AgentRuntime.safeProvider(this.agentConfig?.provider) } : {}),
        ...(this.agentConfig?.model ? { model: this.agentConfig.model } : {}),
        messages: [
          { role: "system", content: ARTIFACT_PLAN_SYSTEM },
          { role: "user", content: JSON.stringify({ objective: this.state.objective, step: { name: step.name, description: step.description, input: step.input }, dependencies, requestedFormat: typeof input.format === "string" ? input.format : "pdf" }) },
        ],
        maxTokens: 6000,
      },
    });
    this.state.billing.totalChargeMinor += billed.chargeMinor;
    this.state.billing.totalProviderCostEur += billed.providerCostEur;
    this.state.billing.llmInputTokens += billed.response.usage.inputTokens;
    this.state.billing.llmOutputTokens += billed.response.usage.outputTokens;

    let documentPlan: z.infer<typeof ARTIFACT_PLAN_SCHEMA>;
    try {
      documentPlan = ARTIFACT_PLAN_SCHEMA.parse(extractJsonCandidate(billed.response.text));
    } catch (error) {
      throw new Error(`Le contenu du livrable n'a pas pu être rédigé : ${error instanceof Error ? error.message.slice(0, 200) : "réponse non structurée"}`);
    }
    return {
      ...input,
      title: typeof input.title === "string" && input.title.trim().length > 0 ? input.title : documentPlan.title,
      format: typeof input.format === "string" && input.format.length > 0 ? input.format : documentPlan.format,
      blocks: documentPlan.blocks,
    };
  }

  private async executeCode(step: RuntimeStep): Promise<unknown> {
    const code = typeof step.input.code === "string" ? step.input.code : null;
    if (!code) throw new Error("Code execution requires input.code");
    return executeToolSecurely({ userId: this.state.userId, agentId: this.agentConfig?.agentId, executionId: this.state.executionId, toolName: "code.execute", input: { ...step.input, code }, policy: this.policy, signal: this.signal });
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
  private assertExecutionBudget(): void { if (this.state.iteration > this.policy.maxSteps) throw new Error("Execution step budget exhausted"); if (Date.now() - this.startedAtMs > this.policy.maxExecutionMs) throw new Error("Execution time budget exhausted"); this.assertAgentBudget(); }

  /**
   * Plafond de dépense PAR EXÉCUTION défini sur l'agent (budgetEurMinor) :
   * au-delà, toute nouvelle étape est refusée avec une erreur explicite.
   * Les frais déjà engagés restent facturés (principe réel des coûts).
   */
  private assertAgentBudget(): void {
    const cap = this.agentConfig?.budgetEurMinor;
    if (typeof cap !== "number" || cap <= 0) return;
    if (this.state.billing.totalChargeMinor >= cap) {
      throw new Error(`Budget de l'agent atteint pour cette exécution (plafond ${(cap / 100).toFixed(2)} EUR). Augmentez le budget dans le Builder ou simplifiez la mission.`);
    }
  }

  /**
   * Demande au critic les étapes à rejouer après un échec. Import dynamique
   * pour éviter le cycle statique runner <-> critic (le critic importe le
   * barrel du runtime). Fail-soft : un crash du critic ne doit JAMAIS
   * transformer un échec partiel en crash de mission — on renvoie null
   * (pas de retry) et l'échec initial est conservé tel quel.
   */
  private async requestCriticRetry(): Promise<string[] | null> {
    try {
      const { critiqueExecution } = await import("@/lib/agents/critic/service");
      const result = await critiqueExecution(this.state);
      this.state.evaluations.push({
        stepId: "critic",
        success: result.passed,
        score: result.score,
        feedback: result.summary.slice(0, 500),
        shouldRetry: result.retry,
        ...(result.corrections.length > 0 ? { correction: result.corrections.map((correction) => correction.action).join(" | ").slice(0, 500) } : {}),
      });
      if (!result.retry) return null;
      const ids = result.retrySteps.filter((id) => this.state.plan.steps.some((step) => step.id === id && step.status === "failed"));
      return ids;
    } catch (error) {
      console.error("[runtime] Critic indisponible (réparation ignorée):", error instanceof Error ? error.message : error);
      return null;
    }
  }
  private finalize(): void { const hasFailures = this.state.plan.steps.some((step) => step.status === "failed"); this.state.status = hasFailures ? "failed" : "completed"; this.state.completedAt = new Date().toISOString(); }

  /**
   * Passe de correction de la porte de résultat : réinitialise les étapes
   * livrables COMPLÉTÉES (llm/document/media/research) avec le verdict du
   * juge injecté dans leur description — la régénération sait CE QUI manque.
   * Retourne les étapes réinitialisées (vide = aucune réparation possible).
   */
  private resetGateDeliverableSteps(feedback: string): RuntimeStep[] {
    const deliverableTypes = new Set(["llm", "document", "media", "research"]);
    const repaired: RuntimeStep[] = [];
    for (const step of this.state.plan.steps) {
      if (step.status !== "completed" || !deliverableTypes.has(step.type)) continue;
      step.status = "pending";
      const suffix = `Correction requise (critères d'acceptation non atteints) : ${feedback.slice(0, AgentRuntime.GATE_FEEDBACK_LIMIT)}`;
      step.description = `${step.description}\n${suffix}`.slice(0, 2_000);
      repaired.push(step);
    }
    return repaired;
  }
}
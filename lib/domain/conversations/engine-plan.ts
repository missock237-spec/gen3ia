import "server-only";

/**
 * Tour « PLAN d'exécution » : compréhension → plan → outils → approbation → exécution → artefacts, résumé et helpers d'artefacts. Extrait de engine.ts — code déplacé tel quel.
 */

import { appendPreviewLinks } from "./artefact-apps";
import { safeEmitter } from "./stream-events";
import type { ConversationApproval, ConversationArtifact, ConversationRun, RunStep } from "./types";
import { INTERNAL_ACTION_TOOLS } from "@/lib/agents/approval-policy";
import { recordRunOutcome } from "@/lib/ai/auto-improvement";
import { preferFreeForVisibleAnswers } from "@/lib/ai/response-quality";
import { generate, generateStream } from "@/lib/ai/router";
import { extractVideoParams, extractVideoTitle } from "@/lib/ai/video-intent";
import { appendMessage } from "@/lib/chat/repository";
import { createApproval } from "@/lib/domain/approvals/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { createRun, finalizeRun, makeStep, updateRunSteps } from "@/lib/domain/runs/repository";
import { extractJsonObject } from "@/lib/engines/ai-engine";
import { parseConnectorMissing, uniqueToolkits } from "@/lib/integrations/composio/errors";
import { AUTO_APPROVAL_AUDIT_REASON, isAutoApprovable } from "@/lib/security/authorization-mode";
import { isExternalAppConnected } from "@/lib/security/connected-apps";
import { isR2Configured, uploadToR2 } from "@/lib/storage/r2";
import { executeTool } from "@/lib/tools/executor";
import { VIDEO_ASPECT_RATIOS, sanitizeProductionOptions } from "@/lib/tools/media/create-video";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { produceConversationImage } from "./engine-chat";
import type { TurnContext } from "./engine-chat";
import { detectApiWriteIntent } from "./engine-intent";
import { CONVERSATION_EXECUTION_POLICY, condenseToolOutput, conversationToolCatalog, dataScopeForTool, estimatedCostForTool, stepRequiresApproval } from "./engine-tools";
import { SUMMARY_BUDGET_MS, historyForModel, withTimeout } from "./engine-turn";
import type { ConversationTurnResult } from "./engine-turn";

/* ------------------------------------------------------------------ */
/* Tour « plan » — timeline, outils, approbations, artefacts           */
/* ------------------------------------------------------------------ */

export const TOOL_OUTPUT_ARTIFACTS: ReadonlySet<string> = new Set(["artifact.create", "file.create", "zip.create", "voice.speak"]);

/* ------------------------------------------------------------------ */
/* Completion du contenu des livrables (artifact.create)               */
/* ------------------------------------------------------------------ */

const DocumentBlocksSchema = z.object({
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

/**
 * Complète l'entrée d'artifact.create quand le plan ne contient pas les blocs
 * du document : l'IA d'intention ne peut pas pré-rédiger tout un document dans
 * son budget de tokens. Un appel de rédaction dédié produit le contenu
 * intégral, puis l'outil génère le fichier réel (pdf/docx/xlsx/pptx).
 * Retourne null si la rédaction est impossible — l'étape est alors ignorée
 * avec une raison claire (jamais de fichier vide ou corrompu).
 */
async function ensureArtifactInput(
  ctx: TurnContext,
  planned: { title: string; detail?: string },
  toolInput: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const hasTitle = typeof toolInput.title === "string" && toolInput.title.trim().length > 0;
  const blocks = Array.isArray(toolInput.blocks) ? (toolInput.blocks as unknown[]) : [];
  if (hasTitle && blocks.length > 0) return toolInput;

  /**
   * Rédaction via le chemin STREAMING (le même qui produit les applications
   * web en ~35 s) : les fournisseurs « chat » livrent leurs tokens au fil de
   * l'eau et complètent bien avant les appels non-streamés, qui dépassaient
   * le budget sur un JSON de plusieurs milliers de tokens. Le texte collecté
   * est ensuite parsé en JSON (extractJsonObject) et validé par le schéma.
   */
  const draft = async (maxTokens: number, budgetMs: number) => {
    const request = {
      task: "chat" as const,
      messages: [
        {
          role: "system" as const,
          content:
            "Tu rédiges le contenu d'un document professionnel pour l'utilisateur de Gen3ia. " +
            "Tu produis UNIQUEMENT un objet JSON valide (sans texte autour, sans bloc de code) : " +
            '{ "title": "<titre court>", "format": "<format>", "blocks": [...] }. ' +
            "Blocs disponibles : title (une seule fois, en premier), heading (sections), paragraph (texte rédigé), " +
            "list (puces {items}), table ({columns, rows}) si des données le justifient, quote, pageBreak. " +
            "Le contenu doit être rédigé intégralement et de façon professionnelle : jamais de placeholder, " +
            "jamais de « … », jamais de section vide.",
        },
        {
          role: "user" as const,
          content:
            `Demande de l'utilisateur : ${ctx.message.slice(0, 2000)}\n` +
            `Objectif du plan : ${ctx.intent.objective ?? "(celui de la demande)"}\n` +
            `Étape : ${planned.title}${planned.detail ? ` — ${planned.detail}` : ""}\n` +
            `Format attendu : ${typeof toolInput.format === "string" ? toolInput.format : "pdf"}\n` +
            `Titre proposé : ${hasTitle ? String(toolInput.title) : "(à déduire de la demande)"}` +
            `${ctx.priorHistory.length > 0 ? `\n\nContexte récent de la conversation :\n${historyForModel(ctx.priorHistory, 4).map((m) => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content.slice(0, 400)}`).join("\n")}` : ""}`,
        },
      ],
      provider: ctx.provider as never,
      model: ctx.model,
      preferFree: preferFreeForVisibleAnswers(),
      maxTokens,
      metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
    };
    const response = await withTimeout(
      generateStream(request, { onDelta: () => undefined }).catch(() =>
        generate(request),
      ),
      budgetMs,
      "rédaction du livrable",
    );
    return DocumentBlocksSchema.parse(extractJsonObject(response.text));
  };

  try {
    // Première tentative : budget généreux, sortie complète.
    const generated = await draft(6000, 60_000);
    return {
      ...toolInput,
      title: hasTitle ? String(toolInput.title) : generated.title,
      format: typeof toolInput.format === "string" ? toolInput.format : generated.format,
      blocks: generated.blocks,
    };
  } catch (error) {
    console.error(JSON.stringify({
      event: "artifact.redaction_fallback",
      reason: error instanceof Error ? error.message : String(error),
      format: toolInput.format ?? "pdf",
    }));
    // Seconde tentative, plus resserrée : un fournisseur lent ne doit pas
    // priver l'utilisateur de son livrable (pptx/pdf/docx demandé).
    try {
      const generated = await draft(3500, 45_000);
      return {
        ...toolInput,
        title: hasTitle ? String(toolInput.title) : generated.title,
        format: typeof toolInput.format === "string" ? toolInput.format : generated.format,
        blocks: generated.blocks,
      };
    } catch {
      // Rédaction indisponible (timeout, fournisseur saturé) : l'étape sera
      // ignorée proprement avec un message clair pour l'utilisateur.
      return null;
    }
  }
}

export async function runPlanTurn(ctx: TurnContext): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const streaming = Boolean(ctx.onEvent);
  const catalog = conversationToolCatalog();
  const catalogByName = new Map(catalog.map((t) => [t.name, t]));
  const plannedSteps = (ctx.intent.steps ?? []).slice(0, 8);

  const steps: RunStep[] = [
    makeStep({
      phase: "understanding",
      title: "Compréhension de la demande",
      detail: ctx.intent.understanding,
      status: "done",
    }),
    makeStep({
      phase: "plan",
      title: ctx.intent.objective?.slice(0, 200) || "Plan proposé",
      detail: plannedSteps.map((s, i) => `${i + 1}. ${s.title}`).join("\n") || "Exécution directe.",
      status: "done",
    }),
  ];

  const approvals: ConversationApproval[] = [];
  const artifacts: ConversationArtifact[] = [];

  const run = await createRun({
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    projectId: ctx.projectId,
    objective: ctx.intent.objective || ctx.message.slice(0, 500),
    steps,
  });
  // Timeline persistée APRÈS CHAQUE ÉTAPE (et pas seulement à la fin du
  // plan) : si la fonction est tuée par le budget plateforme en cours de
  // route, les étapes déjà réussies restent visibles dans le fil et le run
  // n'est plus un fantôme « running » sans contenu.
  const persistSteps = async () => {
    try {
      await updateRunSteps(ctx.userId, run.id, steps);
    } catch {
      // Timeline best-effort : un incident Firestore ne doit jamais faire
      // échouer une étape dont le travail a réussi.
    }
  };
  await onEvent({ type: "run_created", run: { ...run, status: "running", steps } });
  await onEvent({ type: "status", phase: "execution", label: "Exécution du plan en cours…" });

  let executedSomething = false;
  let anyFailure = false;
  /** Image générée pendant ce tour (affichée sur le message final). */
  let turnImageUrl: string | undefined;
  /** Task 143 — connecteurs Composio requis mais NON connectés par
   * l'utilisateur : collectés pendant l'exécution (erreur typée
   * CONNECTOR_MISSING) pour attacher la carte « Connecter <App> » au
   * message final — l'agent propose alors le bouton de connexion OAuth. */
  const missingConnectors: string[] = [];

  for (const planned of plannedSteps) {
    // Compétence image : l'étape image.generate est interceptée AVANT le
    // catalogue d'outils — la génération réelle (Agnes AI 2K) produit une
    // image attachée au message final et rangée dans les artefacts.
    if (planned.toolName === "image.generate") {
      const step = makeStep({
        phase: "execution",
        title: planned.title,
        detail: planned.detail,
        toolName: "image.generate",
        toolInput: planned.toolInput,
        status: "in_progress",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      const startedAt = new Date().toISOString();
      try {
        const image = await produceConversationImage(
          ctx,
          typeof planned.toolInput?.prompt === "string" ? planned.toolInput.prompt : undefined,
          async ({ label, stage, percent }) => {
            await onEvent({ type: "status", phase: "image", label, stage, percent });
          },
        );
        step.status = "done";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = `Image générée avec ${image.model}.`;
        executedSomething = true;
        turnImageUrl = image.inlineDataUrl ?? image.imageUrl;
        const artifact = await createArtifact({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          projectId: ctx.projectId,
          runId: run.id,
          type: "image",
          title: (typeof planned.toolInput?.prompt === "string" && planned.toolInput.prompt.trim() ? planned.toolInput.prompt.trim() : ctx.message).slice(0, 80),
          url: image.inlineDataUrl ?? image.imageUrl,
          storagePath: image.storagePath,
          note: `Généré par le moteur neuronal Gen3 (${image.model})`,
        });
        artifacts.push(artifact);
        step.artifactId = artifact.id;
        await onEvent({ type: "artifact_created", artifact });
      } catch (error) {
        step.status = "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = error instanceof Error ? error.message : "La génération d'image a échoué.";
        anyFailure = true;
      }
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      continue;
    }

    // Compétence vidéo : l'étape video.create est interceptée AVANT le
    // catalogue d'outils — la production RÉELLE (file autopilotée) démarre
    // immédiatement et l'artefact vidéo (progression temps réel) est rattaché
    // au run, comme pour l'image.
    if (planned.toolName === "video.create") {
      const step = makeStep({
        phase: "execution",
        title: planned.title,
        detail: planned.detail,
        toolName: "video.create",
        toolInput: planned.toolInput,
        status: "in_progress",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      const startedAt = new Date().toISOString();
      try {
        const { createVideoProductionJob } = await import("@/lib/video/production-queue");
        // BRIEF TROP COURT (fix capture 13:02) : DirectorBriefSchema exige
        // 10 caractères minimum — un prompt du planificateur trop court est
        // ENRICHI du message utilisateur (jamais d'échec de validation pour
        // une valeur que la plateforme peut compléter).
        const promptPlan = typeof planned.toolInput?.prompt === "string" ? planned.toolInput.prompt.trim() : "";
        const promptInput =
          promptPlan.length >= 10
            ? promptPlan
            : [promptPlan, ctx.message.trim()].filter((part) => part.length >= 10)[0] ?? `Production vidéo demandée : ${promptPlan || ctx.message.trim()}`;
        // TITRE TROP COURT : VideoProjectCreateSchema exige 3 caractères
        // minimum — repli sur le titre déduit de la demande (extrait vidéo).
        const titlePlan = typeof planned.toolInput?.title === "string" ? planned.toolInput.title.trim() : "";
        const titleInput = titlePlan.length >= 3 ? titlePlan.slice(0, 120) : extractVideoTitle(promptInput);
        const aspectInput = planned.toolInput && typeof planned.toolInput === "object" && "aspectRatio" in planned.toolInput ? String((planned.toolInput as Record<string, unknown>).aspectRatio) : undefined;
        // Contrat aspectRatio (audit 103-f) : source unique — le constant
        // partagé VIDEO_ASPECT_RATIOS du tool video.create (Task 106-a :
        // aligné sur le pipeline, 5 valeurs) valide l'entrée du planificateur.
        const aspectValide = VIDEO_ASPECT_RATIOS.find((ratio) => ratio === aspectInput);
        // Task 106-a — RELAIS COMPLET des paramètres : duration/résolution/
        // langue/style/audience/plateforme/musique/formats dérivés passés
        // tels quels au filtre validé (clés inconnues écartées), puis
        // DÉTECTION complémentaire déterministe depuis la demande (le LLM
        // peut avoir oublié durée/format — l'extraction rattrape).
        const relayed = sanitizeProductionOptions(planned.toolInput);
        if (aspectValide) relayed.aspectRatio = aspectValide;
        const detected = extractVideoParams(promptInput);
        const options = { ...detected, ...relayed };
        // DURÉE HORS-BORNES (fix capture 13:02) : le planificateur transmet
        // FIDÈLEMENT la demande (« une vidéo de 5s » → targetDurationSec: 5)
        // mais le pipeline impose 10..3600 s — on BORNE au lieu d'échouer
        // (la validation écrasait la valeur détectée déjà clampée et faisait
        // échouer TOUTE demande de courte durée : « Le lancement de la
        // production vidéo a échoué »).
        const durationRaw = Number(options.targetDurationSec);
        if (Number.isFinite(durationRaw) && durationRaw > 0) {
          options.targetDurationSec = Math.min(3600, Math.max(10, Math.round(durationRaw)));
        } else {
          delete options.targetDurationSec;
        }
        const job = await createVideoProductionJob({
          userId: ctx.userId,
          prompt: promptInput.slice(0, 4000),
          title: titleInput,
          // Task 107-a — conversation d'origine portée par le job (livraison
          // chat à la complétion, même contrat que le tour vidéo).
          conversationId: ctx.conversationId,
          ...(Object.keys(options).length > 0 ? { options } : {}),
        });
        step.status = "done";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = `Production vidéo lancée (projet ${job.projectId}) — progression en temps réel.`;
        executedSomething = true;
        const artifact = await createArtifact({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          projectId: ctx.projectId,
          runId: run.id,
          type: "video",
          title: promptInput.slice(0, 80),
          note: "Production vidéo autonome — progression en temps réel",
          videoProjectId: job.projectId,
          videoJobId: job.jobId,
        });
        artifacts.push(artifact);
        step.artifactId = artifact.id;
        await onEvent({ type: "artifact_created", artifact });
      } catch (error) {
        step.status = "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = error instanceof Error && /n.est pas disponible/.test(error.message)
          ? "La production vidéo n'est pas disponible sur cette plateforme actuellement."
          : "Le lancement de la production vidéo a échoué.";
        anyFailure = true;
      }
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      continue;
    }

    // Task 106-a — SUIVI vidéo : l'étape video.status est interceptée AVANT
    // le catalogue (même pattern que video.create) — exécution RÉELLE de
    // l'outil, message d'état FR complet (stage, %, avertissements, URL).
    if (planned.toolName === "video.status") {
      const step = makeStep({
        phase: "tools",
        title: planned.title,
        detail: planned.detail,
        toolName: "video.status",
        toolInput: planned.toolInput,
        status: "in_progress",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      const startedAt = new Date().toISOString();
      try {
        const { videoStatusTool } = await import("@/lib/tools/media/video-status");
        const input = planned.toolInput && typeof planned.toolInput === "object" ? planned.toolInput : {};
        const parsed = videoStatusTool.inputSchema.parse(input);
        const output = await videoStatusTool.execute(parsed, { userId: ctx.userId });
        step.status = output.found ? "done" : "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = output.message;
        executedSomething = true;
      } catch (error) {
        step.status = "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = error instanceof Error ? `Suivi vidéo impossible : ${error.message}` : "Suivi vidéo impossible.";
        anyFailure = true;
      }
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      continue;
    }

    // Task 106-a — RÉVISION/PILOTAGE vidéo : pause/reprise/annulation du
    // rendu, révisions conversationnelles (musique, rythme, voix…) et
    // formats dérivés — exécution RÉELLE, message FR actionnable.
    if (planned.toolName === "video.revise") {
      const step = makeStep({
        phase: "tools",
        title: planned.title,
        detail: planned.detail,
        toolName: "video.revise",
        toolInput: planned.toolInput,
        status: "in_progress",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      const startedAt = new Date().toISOString();
      try {
        const { videoReviseTool } = await import("@/lib/tools/media/video-revise");
        const input = planned.toolInput && typeof planned.toolInput === "object" ? planned.toolInput : {};
        const parsed = videoReviseTool.inputSchema.parse(input);
        const output = await videoReviseTool.execute(parsed, { userId: ctx.userId });
        step.status = output.applied ? "done" : "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = output.message;
        executedSomething = true;
      } catch (error) {
        step.status = "failed";
        step.startedAt = startedAt;
        step.finishedAt = new Date().toISOString();
        step.output = error instanceof Error
          ? `Révision impossible : ${error.message.replace(/\s+/g, " ").slice(0, 300)}`
          : "Révision impossible.";
        anyFailure = true;
      }
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      continue;
    }

    const toolEntry = planned.toolName ? catalogByName.get(planned.toolName) : undefined;
    if (planned.toolName && !toolEntry) {
      const step = makeStep({
        phase: "tools",
        title: planned.title,
        detail: `Outil demandé introuvable dans le catalogue : ${planned.toolName}`,
        status: "skipped",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      continue;
    }

    let toolName = planned.toolName ?? undefined;
    const risk = toolEntry?.risk ?? "low";
    // OUTILS INTERNES (directive 10-10) : la génération d'image/vidéo/audio,
    // les fichiers, mémoires et automatisations Gen3ia ne demandent JAMAIS
    // d'approbation — même si le planificateur ou un risque résiduel les
    // marque sensibles. La validation ne concerne que les apps externes non
    // connectées et les actions manipulant des secrets utilisateur.
    const internalTool = toolName ? INTERNAL_ACTION_TOOLS.has(toolName) : false;
    let sensitive = internalTool
      ? false
      : planned.sensitive === true || (toolName ? stepRequiresApproval(risk) : false);

    // APPROBATION CONDITIONNELLE (demande utilisateur) : quand l'app externe
    // ciblée est DÉJÀ CONNECTÉE par l'utilisateur (statut actif), l'agent
    // agit directement — aucune carte de validation. L'approbation ne reste
    // requise que si l'app est non connectée (ou inconnue) et pour le
    // plancher de sécurité invariant (risque critical / ads.publish /
    // file.delete / phone.call).
    let connectedBypass = false;
    if (toolName && sensitive && risk !== "critical") {
      try {
        connectedBypass = await isExternalAppConnected(
          ctx.userId,
          toolName,
          (planned.toolInput ?? {}) as Record<string, unknown>,
        );
      } catch {
        connectedBypass = false;
      }
      if (connectedBypass) {
        sensitive = false;
        console.log(JSON.stringify({
          event: "approval.bypassed_connected_app",
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          toolName,
          risk,
        }));
      }
    }

    // Mode « Autoriser automatiquement » : les actions sensibles NON critiques
    // s'exécutent directement (piste d'audit), le plancher de sécurité reste
    // invariant (ads.publish / file.delete / risque critical).
    const autoAllowed = toolName ? isAutoApprovable(ctx.authorizationMode, toolName, risk) : false;
    if (autoAllowed) {
      console.log(JSON.stringify({
        event: "approval.auto_approved",
        reason: AUTO_APPROVAL_AUDIT_REASON,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        toolName,
        risk,
      }));
    }

    if (toolName && sensitive && !autoAllowed) {
      // Approbation inline : l'étape reste en attente, un outil de contrôle
      // humain est créé avec impact, périmètre de données et coût estimé.
      const step = makeStep({
        phase: "approval",
        title: planned.title,
        detail: planned.detail ?? toolEntry?.description,
        toolName,
        toolInput: planned.toolInput,
        status: "awaiting",
      });
      steps.push(step);
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
      const approval = await createApproval({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        runId: run.id,
        stepId: step.id,
        toolName,
        title: planned.title,
        impact: planned.detail ?? toolEntry?.description ?? planned.title,
        dataScope: dataScopeForTool(toolName, planned.toolInput),
        estimatedCost: estimatedCostForTool(toolName),
        risk,
      });
      approvals.push(approval);
      await onEvent({ type: "approval_created", approval });
      continue;
    }

    // Étape exécutable immédiatement.
    const step = makeStep({
      phase: toolName ? "execution" : "result",
      title: planned.title,
      detail: autoAllowed
        ? `${planned.detail ?? toolEntry?.description ?? ""}\n(${AUTO_APPROVAL_AUDIT_REASON})`
        : planned.detail,
      toolName,
      toolInput: planned.toolInput,
      status: "in_progress",
    });
    steps.push(step);
    await onEvent({ type: "step_update", runId: run.id, step });
    await persistSteps();

    if (toolName) {
      const startedAt = new Date().toISOString();
      let toolInput = (planned.toolInput ?? {}) as Record<string, unknown>;
      // GARDE ANTI-ERREUR : une écriture (méthode/corps énoncés) ne doit
      // JAMAIS passer par web.api (lecture seule) — réécrite en web.api.write.
      if (toolName === "web.api" && catalogByName.get("web.api.write")) {
        const writeIntent = detectApiWriteIntent(ctx.message);
        const hasWriteShape = typeof toolInput.method === "string" || toolInput.body !== undefined;
        if (hasWriteShape || writeIntent) {
          toolName = "web.api.write";
          toolInput = {
            ...toolInput,
            method: (toolInput.method as string) ?? writeIntent?.method ?? "POST",
            ...(toolInput.body !== undefined ? {} : writeIntent?.body ? { body: writeIntent.body } : {}),
          };
          console.log(JSON.stringify({ event: "tool_route_corrected", from: "web.api", to: "web.api.write", conversationId: ctx.conversationId }));
        }
      }
      if (toolName === "artifact.create") {
        // Le contenu du livrable est finalisé juste avant la génération du
        // fichier : jamais de document vide ni d'échec zod opaque.
        const completed = await ensureArtifactInput(ctx, planned, toolInput);
        if (!completed) {
          step.status = "skipped";
          step.detail = `${step.detail ? `${step.detail}\n` : ""}Contenu du livrable indisponible (rédaction impossible pour le moment) — aucun fichier créé.`.trim();
          step.finishedAt = new Date().toISOString();
          await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
          continue;
        }
        toolInput = completed;
      }
      const result = await executeTool({
        userId: ctx.userId,
        executionId: run.id,
        projectId: ctx.projectId,
        toolName,
        input: toolInput,
        policy: CONVERSATION_EXECUTION_POLICY,
      });
      step.startedAt = startedAt;
      step.finishedAt = new Date().toISOString();
      if (result.success) {
        step.status = "done";
        step.output = condenseToolOutput(result.output);
        executedSomething = true;
        if (TOOL_OUTPUT_ARTIFACTS.has(toolName)) {
          const artifact = await artifactFromToolOutput({
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            projectId: ctx.projectId,
            runId: run.id,
            toolName,
            toolInput: planned.toolInput ?? {},
            output: result.output,
          });
          if (artifact) {
            artifacts.push(artifact);
            step.artifactId = artifact.id;
            await onEvent({ type: "artifact_created", artifact });
          }
        }
      } else {
        step.status = "failed";
        step.output = result.error;
        anyFailure = true;
        // Task 143 — connecteur manquant : le toolkit est proposé à la
        // connexion (bouton OAuth sous la réponse), pas seulement signalé.
        const missing = parseConnectorMissing(result.error);
        if (missing && !missingConnectors.includes(missing.toolkit)) {
          missingConnectors.push(missing.toolkit);
        }
      }
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
    } else {
      // Étape de rédaction : traitée par le modèle à la synthèse finale.
      step.status = "done";
      step.finishedAt = new Date().toISOString();
      await onEvent({ type: "step_update", runId: run.id, step });
      await persistSteps();
    }
  }

  // 4) Statut final du run : en attente de validations, terminé, ou échec partiel.
  const hasPending = approvals.length > 0;
  const runStatus = hasPending
    ? ("awaiting_approval" as const)
    : anyFailure && !executedSomething
      ? ("failed" as const)
      : ("completed" as const);
  const resultStep = makeStep({
    phase: "result",
    title: hasPending ? "En attente de votre validation" : "Résultat",
    detail: hasPending
      ? `${approvals.length} action(s) sensible(s) attend(ent) votre approbation ci-dessous.`
      : `${steps.filter((s) => s.status === "done").length} étape(s) réalisée(s).`,
    status: "done",
  });
  steps.push(resultStep);
  await onEvent({ type: "step_update", runId: run.id, step: resultStep });
  await onEvent({ type: "run_status", runId: run.id, status: hasPending ? "awaiting_approval" : runStatus });

  // 5) Synthèse finale de l'assistant (en flux quand le client suit le tour).
  await onEvent({ type: "status", phase: "synthesis", label: "Rédaction du résultat…" });
  const summary = await summarizePlanTurn(ctx, run, steps, artifacts, approvals, hasPending, streaming ? (delta) => onEvent({ type: "message_delta", delta }) : undefined);

  if (hasPending) {
    await updateRunSteps(ctx.userId, run.id, steps);
  } else {
    await finalizeRun(ctx.userId, run.id, runStatus, steps);
  }
  // AUTO-AMÉLIORATION : issue réelle de l'exécution enregistrée (leçons des
  // échecs + progression de complexité) — le système évolue à chaque run.
  void recordRunOutcome({
    userId: ctx.userId,
    objective: run.objective || ctx.message,
    status: runStatus,
    complexityScore: ctx.complexityScore,
    failedSteps: steps
      .filter((s) => s.status === "failed")
      .slice(0, 3)
      .map((s) => ({ title: s.title, detail: s.detail })),
  }).catch(() => undefined);

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    // Contrat ARTEFACTS : tout artefact « app » produit par le plan reçoit
    // son lien web d'aperçu dans le message final.
    content: appendPreviewLinks(summary, artifacts),
    runId: run.id,
    generationStatus: "complete",
    ...(turnImageUrl ? { imageUrl: turnImageUrl } : {}),
    // Task 143 — connecteurs manquants détectés pendant l'exécution : la
    // carte « Connecter <App> » (bouton OAuth) est rendue sous la réponse.
    ...(missingConnectors.length > 0 ? { missingConnectors: uniqueToolkits(missingConnectors) } : {}),
  });
  await onEvent({ type: "message_complete", message: assistantMessage });

  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage,
    run: { ...run, status: runStatus, steps },
    artifacts,
    approvals,
    intent: ctx.intent,
  };
}

/** Synthèse lisible du tour de plan (modèle, avec repli déterministe). */
async function summarizePlanTurn(
  ctx: TurnContext,
  run: ConversationRun,
  steps: RunStep[],
  artifacts: ConversationArtifact[],
  approvals: ConversationApproval[],
  hasPending: boolean,
  onDelta?: (delta: string) => Promise<void> | void,
): Promise<string> {
  const deterministic = [
    `**${run.objective}**`,
    "",
    steps
      .filter((s) => s.phase !== "understanding" && s.phase !== "plan")
      .map((s) => {
        const mark = s.status === "done" ? "✓" : s.status === "awaiting" ? "⏸" : s.status === "failed" ? "✕" : "·";
        return `${mark} ${s.title}${s.output ? ` — ${s.output.slice(0, 300)}` : ""}`;
      })
      .join("\n"),
    artifacts.length > 0
      ? `\nArtefacts produits (téléchargement direct) :\n${artifacts
          .map((a) => `- [${a.title}](/api/files/artifacts/${a.id}?redirect=1)`)
          .join("\n")}`
      : "",
    hasPending ? "\n⚠️ Des actions sensibles attendent votre validation avant exécution." : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const request = {
      task: "chat" as const,
      messages: [
        {
          role: "system" as const,
          content:
            "Tu synthétises le résultat d'un plan d'exécution pour l'utilisateur de Gen3ia. " +
            "Style : concis, factuel, orienté résultat. Mentionne les artefacts créés et, s'il y en a, " +
            "les actions sensibles qui attendent sa validation. Pas de markdown de titre (#). " +
            "RÈGLE ABSOLUE D'HONNÊTETÉ : une étape marquée [failed] n'est PAS livrée — ne dis JAMAIS " +
            "qu'un résultat est livré/terminé/produit si l'étape correspondante est en échec ; cite " +
            "explicitement chaque échec et ce qui reste à faire. Les étapes [done] seules peuvent " +
            "être annoncées comme réalisées, avec leur sortie réelle.",
        },
        {
          role: "user" as const,
          content:
            `Demande : ${ctx.message.slice(0, 1000)}\nObjectif du plan : ${run.objective}\n` +
            `Étapes :\n${steps.map((s) => `- [${s.status}] ${s.title}${s.output ? ` : ${s.output.slice(0, 400)}` : ""}`).join("\n")}\n` +
            `Artefacts : ${artifacts.map((a) => `${a.title} (${a.type})`).join(", ") || "aucun"}\n` +
            `Validations en attente : ${approvals.map((a) => `${a.title} — impact : ${a.impact}`).join(" ; ") || "aucune"}` +
            (ctx.filesContext ? `\n\nContenu réel des fichiers importés :${ctx.filesContext}` : ""),
        },
      ],
      preferFree: preferFreeForVisibleAnswers(),
      maxTokens: 1200,
      metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
    };
    if (onDelta) {
      // Synthèse en flux : les fragments rejoignent le fil en direct.
      const response = await withTimeout(
        generateStream(request, { onDelta }),
        SUMMARY_BUDGET_MS,
        "synthèse du plan",
      );
      return appendFailureAppendix(response.text || deterministic, steps);
    }
    const response = await withTimeout(generate(request), SUMMARY_BUDGET_MS, "synthèse du plan");
    return appendFailureAppendix(response.text || deterministic, steps);
  } catch {
    // Synthèse indisponible (ou flux interrompu) : le repli déterministe est
    // renvoyé d'un bloc — le client remplace le texte en cours par la version
    // finale au moment de message_complete.
    return appendFailureAppendix(deterministic, steps);
  }
}

/**
 * HONNÊTETÉ DE LIVRAISON (étape 3) : annexe DÉTERMINISTE ajoutée au texte
 * final dès qu'une étape est en échec — même si la synthèse LLM omet ou
 * minimise les échecs, l'utilisateur voit la liste exacte de ce qui n'est
 * PAS livré. Pure, testée sans LLM.
 */
export function planFailureAppendix(steps: RunStep[]): string | undefined {
  const failed = steps.filter((s) => s.status === "failed");
  if (failed.length === 0) return undefined;
  const lines = failed.slice(0, 5).map((s) => `- ${s.title}${s.output ? ` — ${s.output.slice(0, 200)}` : ""}`);
  return [
    "",
    "⚠️ Mission incomplète — les éléments suivants ne sont PAS livrés :",
    ...lines,
    failed.length > 5 ? `- … et ${failed.length - 5} autre(s)` : "",
    "Relancez ou demandez-moi de reprendre la mission pour compléter ces étapes.",
  ].filter(Boolean).join("\n");
}

function appendFailureAppendix(text: string, steps: RunStep[]): string {
  const appendix = planFailureAppendix(steps);
  return appendix ? `${text}${appendix}` : text;
}

/* ------------------------------------------------------------------ */
/* Artefact issu d'une sortie d'outil                                  */
/* ------------------------------------------------------------------ */

/** Détecte le type d'artefact adapté à la sortie d'un outil de création. */
export function inferArtifactType(toolName: string, output: unknown): "code" | "document" | "table" | "image" | "report" | "file" | "audio" {
  const outputStr = typeof output === "string" ? output : JSON.stringify(output ?? {});
  if (/data:audio|audio\/|voice\.speak/i.test(outputStr) || toolName.includes("voice")) return "audio";
  if (/image|png|jpe?g|webp/i.test(outputStr)) return "image";
  if (toolName.includes("zip")) return "file";
  if (/```|function |const |class |import /.test(outputStr)) return "code";
  if (/\|.*\|/.test(outputStr) && outputStr.split("\n").filter((l) => l.includes("|")).length > 2) return "table";
  return "document";
}

export async function artifactFromToolOutput(params: {
  userId: string;
  conversationId: string;
  projectId?: string;
  runId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  output: unknown;
}): Promise<ConversationArtifact | null> {
  const outputRecord = (params.output && typeof params.output === "object" ? params.output : {}) as Record<string, unknown>;
  const content =
    typeof params.output === "string"
      ? params.output
      : typeof outputRecord.content === "string"
        ? outputRecord.content
        : typeof outputRecord.markdown === "string"
          ? outputRecord.markdown
          : undefined;
  const url = typeof outputRecord.url === "string" ? outputRecord.url : undefined;
  // Voix générée (voice.speak) : l'audio arrive en data URI. Il est copié
  // dans le stockage permanent quand R2 est configuré, sinon conservé en
  // data URI (bornée) — l'utilisateur obtient un artefact AUDIO lisible et
  // téléchargeable au lieu d'un base64 tronqué dans la timeline.
  const audioDataUri = typeof outputRecord.audioDataUri === "string" && outputRecord.audioDataUri.startsWith("data:audio/")
    ? outputRecord.audioDataUri
    : undefined;
  // Task 113 — l'outil voice.speak a DÉJÀ archivé l'audio en permanence
  // (champ `url` = clé R2 users/<uid>/permanent/ai-audio/…) : on la RÉUTILISE
  // comme storagePath de l'artefact au lieu de re-uploader une deuxième
  // copie — moins d'I/O et surtout PLUS JAMAIS d'artefact audio sans clé
  // résolvable (l'ancien catch muet produisait un artefact dont l'`url`
  // brute n'était pas une URL : lecteur audio muet pour l'utilisateur).
  const toolPermanentKey =
    typeof outputRecord.url === "string" && outputRecord.url.startsWith(`users/${params.userId}/permanent/`)
      ? outputRecord.url
      : undefined;
  let audioStoragePath: string | undefined;
  let audioInlineContent: string | undefined;
  if (audioDataUri && !toolPermanentKey) {
    try {
      const [header, base64] = audioDataUri.split(",");
      const mime = header.slice(5).replace(/;base64$/, "") || "audio/mpeg";
      const buffer = Buffer.from(base64 ?? "", "base64");
      if (buffer.length > 0 && isR2Configured()) {
        const ext = mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : "mp3";
        const key = `users/${params.userId}/permanent/ai-audio/${Date.now()}-${randomUUID()}.${ext}`;
        await uploadToR2(key, buffer, mime);
        audioStoragePath = key;
      } else if (buffer.length > 0 && audioDataUri.length <= 600_000) {
        audioInlineContent = audioDataUri;
      }
    } catch (audioError) {
      // Task 113 — incident JOURNALISÉ (plus de catch muet) : l'audio reste
      // livrable via le data URI inline si la taille le permet.
      console.warn(
        "[conversation] persistance R2 de l'audio voice.speak échouée — repli inline si possible :",
        audioError instanceof Error ? audioError.message : String(audioError),
      );
      if (audioDataUri.length <= 600_000) audioInlineContent = audioDataUri;
    }
  }
  // Les livrables de documents (artifact.create) exposent `storageKey` —
  // même contrat que path/key : le fichier reste téléchargeable depuis le
  // panneau des artefacts (service signé ou repli inline sans R2).
  const storagePath =
    typeof outputRecord.path === "string"
      ? outputRecord.path
      : typeof outputRecord.key === "string"
        ? outputRecord.key
        : typeof outputRecord.storageKey === "string"
          ? outputRecord.storageKey
          : undefined;
  if (!content && !url && !storagePath && !audioStoragePath && !toolPermanentKey && !audioInlineContent) return null;

  const inputTitle = typeof params.toolInput.title === "string" ? params.toolInput.title : undefined;
  const inputFilename = typeof params.toolInput.filename === "string" ? params.toolInput.filename : typeof params.toolInput.name === "string" ? params.toolInput.name : undefined;
  const isAudioArtifact = Boolean(audioStoragePath || toolPermanentKey || audioInlineContent);
  const type = isAudioArtifact
    ? "audio"
    : inferArtifactType(params.toolName, params.output ?? "");
  const note = isAudioArtifact
    ? "Audio généré par la voix IA"
    : `Produit par l'outil ${params.toolName}`;
  return createArtifact({
    userId: params.userId,
    conversationId: params.conversationId,
    projectId: params.projectId,
    runId: params.runId,
    type,
    title: (inputTitle || inputFilename || `Artefact — ${params.toolName}`).slice(0, 200),
    language: typeof params.toolInput.language === "string" ? params.toolInput.language : undefined,
    filename: inputFilename ?? (type === "audio" ? `voix-${Date.now()}.mp3` : undefined),
    content: audioInlineContent ?? content,
    // Task 113 — la clé permanente du tool (archivage à la source) prime :
    // l'artefact est TOUJOURS résolvable via /api/storage/permanent.
    storagePath: audioStoragePath ?? toolPermanentKey ?? storagePath,
    url,
    note,
  });
}

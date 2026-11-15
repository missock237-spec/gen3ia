import "server-only";

/**
 * Tours « application » : mini-app HTML, graphique de données, provisionning d'API personnelle. Extrait de engine.ts — code déplacé tel quel.
 */

import { APP_SYSTEM_PROMPT, appendPreviewLinks, buildAppUserRequest, buildChartHtml, chartDataFromTable, extractHtmlDocument, extractInlineData } from "./artefact-apps";
import type { AppCreationIntent, ChartIntent } from "./artefact-apps";
import { safeEmitter } from "./stream-events";
import { preferFreeForVisibleAnswers } from "@/lib/ai/response-quality";
import { generate, generateStream } from "@/lib/ai/router";
import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { runAI } from "@/lib/engines/ai-engine";
import { getImportedFileContent, listImportedFiles } from "@/lib/files/import";
import { detectApiProvisioning } from "@/lib/integrations/custom-apis/detect";
import { createCustomApi } from "@/lib/integrations/custom-apis/repository";
import type { CustomApiRecord } from "@/lib/integrations/custom-apis/repository";
import type { TurnBase } from "./engine-chat";
import { withTimeout } from "./engine-turn";
import type { ConversationTurnResult } from "./engine-turn";

export async function runAppTurn(ctx: TurnBase, appIntent: AppCreationIntent): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const streaming = Boolean(ctx.onEvent);
  try {
    await onEvent({ type: "status", phase: "execution", label: "Conception de l'application…" });
    const requestMessages = [
      { role: "system" as const, content: APP_SYSTEM_PROMPT },
      { role: "user" as const, content: buildAppUserRequest(ctx.message, appIntent) },
    ];
    const response = await withTimeout(
      streaming
        ? generateStream(
            {
              task: "chat",
              messages: requestMessages,
              provider: ctx.provider as never,
              model: ctx.model,
              preferFree: preferFreeForVisibleAnswers(),
              maxTokens: 32_000,
              metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
            },
            {
              // Le flux d'une application n'est pas affiché token par token :
              // l'utilisateur voit la progression, puis l'aperçu complet.
              onDelta: () => undefined,
            },
          )
        : generate({
            task: "chat",
            messages: requestMessages,
            provider: ctx.provider as never,
            model: ctx.model,
            preferFree: preferFreeForVisibleAnswers(),
            maxTokens: 32_000,
            metadata: { userId: ctx.userId, conversationId: ctx.conversationId },
          }),
      90_000,
      "génération de l'application",
    );
    const html = extractHtmlDocument(response.text);
    if (!html) {
      throw new Error("Le modèle n'a pas produit un document HTML complet — réessayez dans un instant.");
    }

    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "code",
      title: appIntent.title,
      language: "html",
      filename: `${appIntent.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "application"}.html`,
      content: html,
      note: "Application web exécutable — aperçu en direct disponible",
    });
    await onEvent({ type: "artifact_created", artifact });

    const content = appendPreviewLinks(
      [
        `Votre application **${appIntent.title}** est prête et enregistrée dans les artefacts de la conversation.`,
        "Elle s'exécute telle quelle : cliquez sur le lien ci-dessous pour voir le rendu dans votre navigateur, ou utilisez le bouton « Voir le résultat en direct » dans le fil. Pour toute modification (« ajoute un filtre », « change les couleurs »), redemandez-le simplement : une nouvelle version sera publiée.",
      ].join("\n\n"),
      [artifact],
    );
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content,
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Création d'une application web (artefact + aperçu en direct)." },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "La génération de l'application a échoué.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: `Je n'ai pas réussi à générer l'application demandée (${message}). Réessayez en renvoyant votre message — rien n'a été perdu.`,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Création d'une application web (échec de génération)." },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tour « analyse de données » — graphique réel + conclusions          */
/* ------------------------------------------------------------------ */

async function loadChartData(ctx: TurnBase): Promise<{ labels: string[]; values: number[]; source: string } | null> {
  // 1) Fichiers importés explicitement joints à CE message (conversion réelle).
  const fileIds = (ctx.attachments ?? []).map((a) => a.fileId).filter((id): id is string => Boolean(id));
  for (const fileId of fileIds) {
    const record = await getImportedFileContent(ctx.userId, fileId).catch(() => null);
    const structured = record?.structuredPreview;
    if (structured?.headers && structured?.rows) {
      const data = chartDataFromTable(structured.headers, structured.rows, `fichier importé « ${record?.filename ?? fileId} »`);
      if (data) return data;
    }
  }
  // 2) Derniers fichiers importés structurés de l'utilisateur (CSV/XLSX).
  const recent = await listImportedFiles(ctx.userId, 8).catch(() => []);
  for (const record of recent) {
    const full = await getImportedFileContent(ctx.userId, record.id).catch(() => null);
    const structured = full?.structuredPreview;
    if (structured?.headers && structured?.rows) {
      const data = chartDataFromTable(structured.headers, structured.rows, `fichier importé « ${full?.filename ?? record.filename} »`);
      if (data) return data;
    }
  }
  // 3) Données énoncées directement dans le message (« Ventes : 120, … »).
  return extractInlineData(ctx.message);
}

export async function runChartTurn(ctx: TurnBase, chartIntent: ChartIntent): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const data = await loadChartData(ctx);
  if (!data) {
    // Aucune donnée : réponse honnête, JAMAIS de données inventées.
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: [
        "Pour générer un graphique, j'ai besoin de données réelles. Deux façons de me les donner :",
        "1. **Importez un fichier** CSV ou Excel dans la conversation (je le convertis réellement puis je le visualise) ;",
        "2. **Écrivez les valeurs dans votre message**, par exemple : `Ventes : 120, Marketing : 80, Développement : 150`.",
      ].join("\n"),
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Graphique demandé sans aucune donnée disponible." },
    };
  }

  try {
    await onEvent({ type: "status", phase: "execution", label: "Construction du graphique…" });
    // Conclusions réelles : analyse du modèle sur les données (repli déterministe).
    let conclusion = `Total : ${data.values.reduce((a, b) => a + b, 0).toLocaleString("fr-FR")} · Maximum : ${data.labels[data.values.indexOf(Math.max(...data.values))]} (${Math.max(...data.values).toLocaleString("fr-FR")}) · Minimum : ${data.labels[data.values.indexOf(Math.min(...data.values))]} (${Math.min(...data.values).toLocaleString("fr-FR")}) sur ${data.labels.length} catégorie(s).`;
    try {
      const analysis = await withTimeout(
        runAI({
          userId: ctx.userId,
          feature: "conversation-turn",
          task: "chat",
          system: "Tu es analyste de données. À partir du tableau fourni, rédige 2 à 4 phrases factuelles en français : tendance générale, valeurs remarquables (max/min), anomalies éventuelles. Aucune donnée non présente dans le tableau.",
          prompt: `Graphique ${chartIntent.chartType === "pie" ? "de répartition" : chartIntent.chartType === "line" ? "d'évolution" : "comparatif"}.\nDonnées : ${data.labels.map((l, i) => `${l}=${data.values[i]}`).join(", ")}`,
        }),
        20_000,
        "analyse des données",
      );
      if (analysis?.text && analysis.text.trim().length > 20) conclusion = analysis.text.trim();
    } catch {
      // Repli : statistiques déterministes ci-dessus, jamais de silence.
    }

    const html = buildChartHtml({
      title: chartIntent.title,
      chartType: chartIntent.chartType,
      labels: data.labels,
      values: data.values,
      source: data.source,
      conclusion,
    });
    const artifact = await createArtifact({
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      projectId: ctx.projectId,
      type: "code",
      title: chartIntent.title,
      language: "html",
      filename: `graphique-${chartIntent.chartType}.html`,
      content: html,
      note: `Graphique interactif — export PNG/JPG intégré (${data.source})`,
    });
    await onEvent({ type: "artifact_created", artifact });

    const content = appendPreviewLinks(
      [
        `**${chartIntent.title}** — ${data.labels.length} catégorie(s) depuis ${data.source}.`,
        `Analyse : ${conclusion}`,
        "Dans l'aperçu, les boutons **Télécharger PNG / JPG** exportent le graphique en image ; demandez « exporte ces données en xlsx » pour un fichier Excel.",
      ].join("\n\n"),
      [artifact],
    );
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content,
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [artifact],
      approvals: [],
      intent: { mode: "chat", understanding: "Analyse de données réelle (graphique + conclusions)." },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "La construction du graphique a échoué.";
    const assistantMessage = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content: `Je n'ai pas réussi à construire le graphique (${message}). Vos données sont intactes : réessayez en renvoyant votre message.`,
      generationStatus: "failed",
    });
    await onEvent({ type: "message_complete", message: assistantMessage });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Analyse de données (échec de construction)." },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tour « fourniture d'API » — création réelle du connecteur           */
/* ------------------------------------------------------------------ */

interface ApiProvisioningTurnContext extends TurnBase {
  provisioning: NonNullable<ReturnType<typeof detectApiProvisioning>>;
}

export async function runApiProvisioningTurn(ctx: ApiProvisioningTurnContext): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  await onEvent({ type: "status", phase: "execution", label: "Enregistrement de votre API…" });

  let record: CustomApiRecord | null = null;
  let failure: string | undefined;
  try {
    record = await createCustomApi({
      userId: ctx.userId,
      name: ctx.provisioning.name,
      baseUrl: ctx.provisioning.baseUrl,
      description: ctx.provisioning.description,
      authType: ctx.provisioning.authType,
      authHeader: ctx.provisioning.authHeader,
      authValue: ctx.provisioning.authValue,
      queryKey: ctx.provisioning.queryKey,
      enabled: true,
      source: "chat",
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : "Création du connecteur impossible.";
  }

  const authLabel =
    ctx.provisioning.authType === "bearer"
      ? "Bearer (clé détectée)"
      : ctx.provisioning.authType === "header"
        ? `en-tête ${ctx.provisioning.authHeader ?? "Authorization"} (clé détectée)`
        : ctx.provisioning.authType === "query"
          ? "paramètre d'URL (clé détectée)"
          : "aucune (API publique)";

  const content = failure
    ? `Je n'ai pas pu enregistrer votre API : ${failure}`
    : [
        `Connecteur créé et activé : « ${record!.name} »`,
        `- URL de base : ${record!.baseUrl}`,
        `- Authentification : ${authLabel}`,
        "",
        "Je peux maintenant appeler cette API pour de vrai — par exemple :",
        `« Utilise l'API ${record!.name} pour … ».`,
        "Les lectures (GET) s'exécutent directement ; toute modification de données (POST/PUT/PATCH/DELETE) attendra votre validation. Vous pouvez gérer ou désactiver ce connecteur depuis Intégrations.",
      ].join("\n");

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    content,
    generationStatus: "complete",
  });
  await onEvent({ type: "message_complete", message: assistantMessage });

  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage,
    artifacts: [],
    approvals: [],
    intent: { mode: "chat", understanding: "Fourniture d'une API personnelle (connecteur créé)." },
  };
}

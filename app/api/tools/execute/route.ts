import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  protectRoute,
} from "@/lib/security/route-guard";

import { enforceRateLimit } from "@/lib/security/rate-limit";

import {
  executeThroughGateway,
} from "@/lib/execution/execution-gateway";

import {
  createAgentPolicy,
} from "@/lib/security/agent-policy";

import type {
  ExecutionPolicy,
} from "@/lib/security/execution-policy";

import {
  executeTool,
} from "@/lib/tools";

import {
  randomUUID,
} from "crypto";

/**
 * Outils médias RÉELS (audit production du 2026-10-07) : la politique
 * « standard » n'autorisait que web.search/file.read/file.create — les
 * outils médias pourtant enregistrés au registre quand leurs clés API
 * existent (voix ElevenLabs, image Agnes, production vidéo) étaient rejetés
 * en amont par la liste allowedTools (« Tool not allowed: voice.speak »),
 * sans jamais atteindre l'exécuteur.
 *
 * Cette route est la CONSOLE D'EXÉCUTION MANUELLE de l'utilisateur : chaque
 * appel est authentifié et rate-limité (30/min, voir ci-dessous), et
 * l'exécution passe en aval par lib/tools/executor.ts qui applique le
 * kill-switch (arrêt d'urgence), les consentements par catégorie et la
 * piste d'audit. L'élargissement reste donc volontairement minimal et
 * propre à CETTE route : createAgentPolicy n'est PAS modifiée (elle sert
 * aussi à lib/agents/personalized-plan.ts notamment).
 */
const CONSOLE_MEDIA_TOOLS = [
  "voice.speak",
  "voice.list",
  "image.generate",
  "video.create",
] as const;

/**
 * Copie de la politique standard étendue aux outils médias — jamais la
 * politique partagée elle-même (les agents autonomes gardent leur liste).
 *
 * La permission « tool.external » est ajoutée car authorizeTool
 * (lib/security/tool-permissions.ts) exige cette permission pour tout outil
 * de classe external (voice.speak, image.generate) — testé en production
 * le 2026-10-07 : sans elle, la console renvoyait « Permission denied:
 * tool.external » après déblocage de la liste allowedTools. Les gardes
 * aval restent intacts : kill-switch, consentements par catégorie, audit,
 * rate-limit 30/min, profils sécurité par outil.
 */
function createConsolePolicy(): ExecutionPolicy {
  const base =
    createAgentPolicy(
      "standard",
    );

  return {
    ...base,

    allowedTools: [
      ...base.allowedTools,

      ...CONSOLE_MEDIA_TOOLS,
    ],

    permissions: [
      ...base.permissions,

      "tool.external",
    ],
  };
}

export async function POST(
  request: NextRequest,
) {
  const auth =
    await protectRoute(
      request,
    );

  if (!auth.ok) {
    return auth.response;
  }

  const userId =
    auth.context.userId;

  const limit =
    await enforceRateLimit(
      `tools:${userId}`,
      {
        limit: 30,

        windowMs:
          60 * 1000,
      },
    );

  if (!limit.allowed) {
    // Audit 25-c : le 429 n'exposait pas Retry-After (le délai n'était
    // lisible que dans le corps JSON, ignoré par les clients HTTP et les
    // monitors). L'en-tête est exprimé en secondes entières (au moins 1).
    return NextResponse.json(
      {
        success: false,

        error:
          "Too many tool requests.",

        retryAfterMs:
          limit.retryAfterMs,
      },
      {
        status: 429,

        headers: {
          "retry-after": String(
            Math.max(
              1,

              Math.ceil(
                limit.retryAfterMs / 1000,
              ),
            ),
          ),
        },
      },
    );
  }

  try {
    const body =
      await request.json();

    const {
      toolName,
      input,
      executionId,
    } = body;

    if (
      typeof toolName !==
      "string"
    ) {
      return NextResponse.json(
        {
          success: false,

          error:
            "toolName is required.",
        },
        {
          status: 400,
        },
      );
    }

    const resolvedExecutionId =
      typeof executionId === "string" && executionId
        ? executionId
        : randomUUID();

    const policy =
      createConsolePolicy();

    const result =
      await executeThroughGateway({
        userId,

        executionId: resolvedExecutionId,

        toolName,

        input:
          input ?? {},

        policy,

        execute: async () => {
          const toolResult =
            await executeTool({
              userId,

              executionId: resolvedExecutionId,

              toolName,

              input:
                input ?? {},

              policy,
            });

          if (!toolResult.success) {
            throw new Error(
              toolResult.error ??
                `Tool ${toolName} failed.`,
            );
          }

          return toolResult.output;
        },
      });

    return NextResponse.json(
      {
        success: true,

        result,
      },
      {
        status: 200,
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Internal error",
      },
      {
        status:
          error instanceof Error &&
          /permission|policy|denied|not allowed|disabled/i.test(
            error.message,
          )
            ? 403
            : 500,
      },
    );
  }
}

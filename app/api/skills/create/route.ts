import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  requireUser,
} from "@/lib/security/authenticated-request";

import {
  enforceRateLimit,
} from "@/lib/security/rate-limit";

import {
  errorBody,
  errorStatus,
} from "@/lib/security/http-errors";

import {
  SkillFactoryRequestSchema,
} from "@/lib/skills/schema";

import {
  generateSkill,
} from "@/lib/skills/factory";

import {
  createSkill,
} from "@/lib/skills/repository";

import type { StructuredSkillGenerator } from "@/lib/skills/factory";

/**
 * GÉNÉRATEUR LOCAL de la Skill Factory — les LLM externes (OpenAI…)
 * ont été SUPPRIMÉS du projet sur demande de l'utilisateur. La
 * spécification de compétence est construite de façon DÉTERMINISTE
 * depuis la requête elle-même (objectif, type, capacités, outils,
 * contraintes) : aucune génération simulée, aucun champ inventé.
 */
function createGenerator(): StructuredSkillGenerator {
  return {
    async generate(prompt: string) {
      const lignes = prompt.split("\n");
      const champ = (label: string): string => {
        const ligne = lignes.find((l) => l.trim().startsWith(label));
        return ligne ? ligne.slice(label.length).trim() : "";
      };
      const objectif = champ("OBJECTIVE:") || "Compétence Gen3";
      const taskType = champ("TASK TYPE:") || "automation";
      const capabilities = (champ("REQUIRED CAPABILITIES:") || "analyse")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      const tools = (champ("REQUIRED TOOLS:") || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      const expectedOutput = champ("EXPECTED OUTPUT:");

      const nom =
        objectif
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 48) || "competence_gen3";

      return {
        name: nom,
        description: `Compétence générée localement par la Skill Factory Gen3 — objectif : ${objectif}`,
        category: taskType,
        capabilities: (capabilities.length > 0 ? capabilities : ["execution"]).map((c) => ({
          name: c,
          description: `Capacité « ${c} » requise par l'objectif de la compétence.`,
        })),
        inputs: [
          {
            name: "demande",
            type: "string",
            description: "La demande utilisateur à traiter par la compétence.",
            required: true,
          },
        ],
        outputs: [
          {
            name: "resultat",
            type: expectedOutput || "string",
            description: "Le résultat produit par la compétence.",
          },
        ],
        triggers: [nom.split("_").slice(0, 3).join(" ")],
        requiredTools: tools,
        compatibleTasks: [taskType],
        systemInstructions: `Tu es la compétence « ${nom} ». Objectif : ${objectif}. Utilise uniquement les outils déclarés. Échoue honnêtement si les entrées sont insuffisantes.`,
        executionInstructions: [
          `1. Analyser la demande au regard de l'objectif : ${objectif}.`,
          "2. Vérifier que les outils requis sont disponibles (sinon échec explicite).",
          "3. Exécuter le traitement de façon déterministe quand c'est possible.",
          "4. Retourner le résultat et signaler honnêtement toute limite.",
        ].join("\n"),
        evaluationCriteria: [
          "La compétence respecte l'objectif déclaré.",
          "Aucun outil non déclaré n'est invoqué.",
          "Les échecs sont explicites (jamais de résultat fabriqué).",
        ],
      };
    },
  };
}

export async function POST(
  request: NextRequest,
) {
  try {
    const user =
      await requireUser(request);

    // Génération LLM réelle par appel : garde-fou anti-abus.
    const limit =
      await enforceRateLimit(`skills-create:${user.uid}`, { limit: 10, windowMs: 5 * 60 * 1000 });
    if (!limit.allowed) {
      return NextResponse.json(
        errorBody("Trop de créations rapprochées. Réessayez dans quelques instants."),
        { status: 429, headers: { "retry-after": String(Math.ceil((limit.retryAfterMs ?? 60_000) / 1000)) } },
      );
    }

    const body =
      await request.json();

    const input =
      SkillFactoryRequestSchema.parse(
        body,
      );

    const skill =
      await generateSkill(
        createGenerator(),
        input,
        user.uid,
      );

    const saved =
      await createSkill(skill);

    return NextResponse.json(
      {
        skill: saved,
      },
      {
        status: 201,
      },
    );
  } catch (error) {
    // errorStatus préserve le 403 CSRF (HttpError de requireUser), le 401
    // d'authentification et le 503 d'infrastructure — seul le reste tombe
    // au repli 400 de la validation d'entrée.
    return NextResponse.json(
      {
        ...errorBody(error, "Skill creation failed."),
      },
      {
        status: errorStatus(error, 400),
      },
    );
  }
}

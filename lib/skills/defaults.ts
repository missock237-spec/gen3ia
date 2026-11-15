import type {
  SkillDefinitionInput,
} from "./schema";

const now =
  new Date().toISOString();

export const SYSTEM_SKILLS:
  SkillDefinitionInput[] = [
    {
      id: "system_web_research",

      name: "Web Research",

      description:
        "Recherche structurée d'informations sur Internet avec collecte et comparaison de sources.",

      version: 1,

      category: "research",

      capabilities: [
        {
          name: "web-search",
          description:
            "Search public web sources.",
        },
        {
          name: "source-analysis",
          description:
            "Analyze retrieved sources.",
        },
      ],

      inputs: [
        {
          name: "objective",
          type: "string",
          description:
            "Research objective.",
          required: true,
        },
      ],

      outputs: [
        {
          name: "research",
          type: "object",
          description:
            "Structured research with sources.",
        },
      ],

      triggers: [
        "research",
        "search",
        "find information",
        "investigate",
      ],

      requiredTools: [
        "web.search",
        "web.open",
      ],

      compatibleTasks: [
        "research",
        "agent",
      ],

      systemInstructions:
        "Perform structured research and distinguish evidence from assumptions.",

      executionInstructions:
        "Search multiple relevant sources, extract evidence, compare conflicting information, verify dates and preserve source references.",

      evaluationCriteria: [
        "source quality",
        "factual accuracy",
        "coverage",
        "date verification",
        "citation completeness",
      ],

      status: "active",

      visibility: "system",

      authorId: null,

      createdAt: now,

      updatedAt: now,
    },

    {
      id: "system_quality_control",

      name: "Quality Control",

      description:
        "Contrôle qualité d'un résultat produit par un agent.",

      version: 1,

      category: "quality",

      capabilities: [
        {
          name: "quality-analysis",
          description:
            "Evaluate output against requirements.",
        },
      ],

      inputs: [
        {
          name: "objective",
          type: "string",
          description:
            "Original objective.",
          required: true,
        },
        {
          name: "result",
          type: "string",
          description:
            "Generated result.",
          required: true,
        },
      ],

      outputs: [
        {
          name: "evaluation",
          type: "object",
          description:
            "Quality evaluation.",
        },
      ],

      triggers: [
        "evaluate",
        "check",
        "review",
        "quality",
      ],

      requiredTools: [],

      compatibleTasks: [
        "*",
      ],

      systemInstructions:
        "Act as a strict quality-control layer.",

      executionInstructions:
        "Compare the generated result against the objective, identify missing requirements, factual problems, logical errors and opportunities for improvement.",

      evaluationCriteria: [
        "requirement coverage",
        "correctness",
        "consistency",
        "completeness",
      ],

      status: "active",

      visibility: "system",

      authorId: null,

      createdAt: now,

      updatedAt: now,
    },
  ];

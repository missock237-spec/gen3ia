import { z } from "zod";

import type {
  ToolDefinition,
} from "@/lib/tools/types";

import {
  createRepository,
} from "./client";

const CreateRepositorySchema =
  z.object({
    name:
      z.string()
        .min(1)
        .max(100)
        .regex(
          /^[A-Za-z0-9._-]+$/,
        ),

    description:
      z.string()
        .max(350)
        .optional(),

    private:
      z.boolean()
        .default(true),
  });

export const githubCreateRepositoryTool:
  ToolDefinition<
    z.infer<
      typeof CreateRepositorySchema
    >,
    unknown
  > = {
    id:
      "github.create_repository",

    name:
      "Create GitHub Repository",

    description:
      "Create a GitHub repository for a generated project.",

    category:
      "github",

    risk:
      "high",

    inputSchema:
      CreateRepositorySchema,

    async execute(input) {
      return createRepository({
        name:
          input.name,

        description:
          input.description,

        private:
          input.private,

        autoInit:
          true,
      });
    },
  };

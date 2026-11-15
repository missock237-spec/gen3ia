import { z } from "zod";

export const WorkflowNodeTypeSchema =
  z.enum([
    "agent",
    "tool",
    "condition",
    "parallel",
    "approval",
    "transform",
    "output",
  ]);

export type WorkflowNodeType =
  z.infer<
    typeof WorkflowNodeTypeSchema
  >;

export const WorkflowNodeSchema =
  z.object({
    id: z.string().min(1),
    type: WorkflowNodeTypeSchema,

    name: z.string().min(1),

    config: z.record(
      z.string(),
      z.unknown(),
    ).default({}),

    position: z.object({
      x: z.number(),
      y: z.number(),
    }),

    enabled: z.boolean().default(true),
  });

export const WorkflowEdgeSchema =
  z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    condition: z.string().optional(),
  });

export const WorkflowSchema =
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.number().int().positive(),
    nodes: z.array(
      WorkflowNodeSchema,
    ),
    edges: z.array(
      WorkflowEdgeSchema,
    ),
  });

export type Workflow =
  z.infer<typeof WorkflowSchema>;

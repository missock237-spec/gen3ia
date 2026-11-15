import { z } from "zod";
import type { ToolDefinition } from "../types";
import { getArtifactRecord } from "@/lib/documents/artifact-repository";

const inputSchema = z.object({
  artifactId: z.string().min(1).max(128),
});

export const getArtifactTool: ToolDefinition = {
  id: "artifact.get",
  name: "artifact.get",
  description: "Get metadata for an artifact owned by the current user.",
  category: "files",
  risk: "low",
  inputSchema,
  async execute(input, context) {
    const { artifactId } = inputSchema.parse(input);
    const artifact = await getArtifactRecord(artifactId);
    if (!artifact || artifact.ownerId !== context.userId) {
      throw new Error("Artifact not found");
    }
    return artifact;
  },
};

import { z } from "zod";

export const RuntimeArtifactSchema = z.object({
  type: z.literal("artifact"),

  artifactId: z.string(),

  filename: z.string(),

  format: z.string(),

  mimeType: z.string(),

  sizeBytes: z.number().nonnegative(),

  storagePath: z.string(),

  checksum: z.string().optional(),

  createdAt: z.string().optional(),
});

export type RuntimeArtifact =
  z.infer<typeof RuntimeArtifactSchema>;

export function isRuntimeArtifact(
  value: unknown,
): value is RuntimeArtifact {
  return RuntimeArtifactSchema.safeParse(
    value,
  ).success;
}

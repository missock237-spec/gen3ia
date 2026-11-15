import { z } from "zod";

export const ToolCallRequestSchema = z.object({
  tool: z.string().min(1),

  arguments: z.record(
    z.string(),
    z.unknown(),
  ),
});

export type ToolCallRequest = z.infer<
  typeof ToolCallRequestSchema
>;

export function parseToolCalls(
  content: string,
): ToolCallRequest[] {
  try {
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed)) {
      return parsed
        .map((item) =>
          ToolCallRequestSchema.safeParse(item),
        )
        .filter(
          (
            result,
          ): result is {
            success: true;
            data: ToolCallRequest;
          } => result.success,
        )
        .map((result) => result.data);
    }

    const result =
      ToolCallRequestSchema.safeParse(parsed);

    return result.success ? [result.data] : [];
  } catch {
    return [];
  }
}

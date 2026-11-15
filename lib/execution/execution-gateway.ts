import {
  assertPermission,
  assertToolAllowed,
  type ExecutionPolicy,
} from "@/lib/security/execution-policy";

export interface ExecutionRequest {
  userId: string;
  executionId: string;

  toolName: string;

  input: unknown;

  policy: ExecutionPolicy;

  execute: () => Promise<unknown>;
}

function estimateBytes(
  value: unknown,
): number {
  try {
    return Buffer.byteLength(
      JSON.stringify(value),
      "utf8",
    );
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export async function executeThroughGateway(
  request: ExecutionRequest,
): Promise<unknown> {
  assertToolAllowed(
    request.policy,
    request.toolName,
  );

  const inputBytes =
    estimateBytes(request.input);

  if (
    inputBytes >
    request.policy.maxInputBytes
  ) {
    throw new Error(
      "Execution input exceeds the configured limit.",
    );
  }

  const tool =
    request.toolName;

  if (
    tool === "code.execute"
  ) {
    assertPermission(
      request.policy,
      "code.execute",
    );

    if (
      !request.policy
        .allowCodeExecution
    ) {
      throw new Error(
        "Code execution is disabled by policy.",
      );
    }
  }

  if (
    tool.startsWith("file.")
  ) {
    assertPermission(
      request.policy,
      tool === "file.read"
        ? "file.read"
        : "file.write",
    );
  }

  if (
    tool.startsWith(
      "composio.",
    )
  ) {
    assertPermission(
      request.policy,
      "tool.external",
    );

    if (
      !request.policy
        .allowExternalApps
    ) {
      throw new Error(
        "External applications are disabled by policy.",
      );
    }
  }

  const result =
    await request.execute();

  if (
    estimateBytes(result) >
    request.policy.maxOutputBytes
  ) {
    throw new Error(
      "Execution output exceeds the configured limit.",
    );
  }

  return result;
}

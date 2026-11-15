export interface ExecutionLimits {
  maxSteps: number;

  maxExecutionMs: number;

  maxToolExecutionMs: number;

  maxOutputBytes: number;

  maxInputBytes: number;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxSteps: 50,

  maxExecutionMs:
    10 * 60 * 1000,

  maxToolExecutionMs:
    60 * 1000,

  maxOutputBytes:
    5 * 1024 * 1024,

  maxInputBytes:
    2 * 1024 * 1024,
};

export function assertExecutionInputSize(
  input: unknown,
  maxBytes: number,
): void {
  const serialized =
    JSON.stringify(input);

  const bytes =
    Buffer.byteLength(
      serialized,
      "utf8",
    );

  if (bytes > maxBytes) {
    throw new Error(
      `Execution input exceeds ${maxBytes} bytes`,
    );
  }
}

export function assertOutputSize(
  output: unknown,
  maxBytes: number,
): void {
  const serialized =
    typeof output === "string"
      ? output
      : JSON.stringify(output);

  const bytes =
    Buffer.byteLength(
      serialized,
      "utf8",
    );

  if (bytes > maxBytes) {
    throw new Error(
      `Execution output exceeds ${maxBytes} bytes`,
    );
  }
}

const MAX_SCAN_CHARS = 200_000;
const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|access[_-]?token|secret|password|passwd|private[_-]?key)\s*[:=]\s*[^\s,;]{8,}/gi,
  /\b(?:sk|rk|pk)_(?:live|test)?[_-]?[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
];
const PII_PATTERNS: RegExp[] = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:\+?\d[\d .()/-]{7,}\d)\b/g,
];
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (?:all|any|the) (?:previous|prior|above) instructions/gi,
  /system message|developer message|hidden instructions/gi,
  /reveal (?:the )?(?:system|developer) prompt/gi,
  /bypass (?:security|policy|permissions|approval)/gi,
  /disable (?:safety|guardrails|security)/gi,
  /act as (?:root|admin|system)/gi,
];

export interface GuardrailResult {
  allowed: boolean;
  risk: "low" | "medium" | "high";
  reasons: string[];
  redactedText?: string;
}

function scanText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, MAX_SCAN_CHARS);
  try { return JSON.stringify(value).slice(0, MAX_SCAN_CHARS); } catch { return ""; }
}

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(text);
    pattern.lastIndex = 0;
    return matched;
  });
}

export function inspectUntrustedContent(value: unknown): GuardrailResult {
  const text = scanText(value);
  const reasons: string[] = [];
  if (matchesAny(INJECTION_PATTERNS, text)) reasons.push("prompt_injection_signal");
  if (matchesAny(SECRET_PATTERNS, text)) reasons.push("secret_signal");
  if (matchesAny(PII_PATTERNS, text)) reasons.push("pii_signal");
  const highRisk = reasons.includes("secret_signal") || reasons.includes("prompt_injection_signal");
  return { allowed: !highRisk, risk: highRisk ? "high" : reasons.length ? "medium" : "low", reasons };
}

export function redactSensitiveContent(value: unknown): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const pattern of SECRET_PATTERNS) { pattern.lastIndex = 0; text = text.replace(pattern, "[REDACTED_SECRET]"); pattern.lastIndex = 0; }
    for (const pattern of PII_PATTERNS) { pattern.lastIndex = 0; text = text.replace(pattern, "[REDACTED_PII]"); pattern.lastIndex = 0; }
    return text.slice(0, MAX_SCAN_CHARS);
  }
  if (Array.isArray(value)) return value.map(redactSensitiveContent);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = redactSensitiveContent(item);
    return result;
  }
  return value;
}

export function assertSafeToolInput(input: Record<string, unknown>): void {
  const result = inspectUntrustedContent(input);
  if (!result.allowed) throw new Error(`Tool input blocked by security guardrails: ${result.reasons.join(", ")}`);
}

export function assertSafeToolOutput(output: unknown): void {
  const result = inspectUntrustedContent(output);
  if (result.reasons.includes("secret_signal")) throw new Error("Tool output blocked: possible secret or credential disclosure.");
}

export function assertBudgetWithinLimit(budgetMinor: number, maxBudgetMinor: number): void {
  if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0) throw new Error("Invalid budget.");
  if (!Number.isSafeInteger(maxBudgetMinor) || maxBudgetMinor < 0) throw new Error("Invalid maximum budget.");
  if (budgetMinor > maxBudgetMinor) throw new Error("Requested budget exceeds the authorized limit.");
}

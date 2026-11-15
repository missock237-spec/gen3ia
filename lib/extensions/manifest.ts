import { z } from "zod";

/**
 * Gen3ia Extension SDK — manifest of an extension.
 *
 * The manifest is the single source of truth for what an extension is allowed
 * to do. It is validated at every stage (creation, version upload, submission,
 * installation, execution) and never trusted from the client at runtime.
 *
 * IMPORTANT SECURITY MODEL:
 * extension tools are DECLARATIVE HTTP connectors (endpoint + JSON IO schemas).
 * No third-party code ever runs inside the Gen3ia process. A future isolated
 * container runtime can be added behind the same manifest (see lib/extensions/runtime.ts).
 */

export const EXTENSION_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
export const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;
const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const EXTENSION_CATEGORIES = [
  "productivity",
  "marketing",
  "data",
  "ai",
  "devtools",
  "finance",
  "communication",
  "other",
] as const;

export const EXTENSION_PRICING_MODELS = ["free", "one_time", "subscription", "usage"] as const;

export const MAX_TOOLS = 12;
export const MAX_SKILLS = 8;
export const MAX_WORKFLOWS = 8;
export const MAX_SETTINGS = 20;
export const MAX_SECRETS = 20;
export const MAX_PERMISSIONS = 12;
const MAX_TEMPLATE_LENGTH = 100_000;

/**
 * Constrained JSON-Schema-like field descriptor used for tool input/output and
 * user settings. Intentionally limited: no arbitrary JSON Schema constructs,
 * so validation is deterministic and cheap (see validateSimpleField in
 * lib/extensions/schema-validate.ts).
 */
export interface SimpleField {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  required?: boolean;
  enum?: Array<string | number>;
  min?: number;
  max?: number;
  maxLength?: number;
  items?: SimpleField;
  properties?: Record<string, SimpleField>;
}

export const SimpleFieldSchema: z.ZodType<SimpleField> = z.lazy(() =>
  z.object({
    type: z.enum(["string", "number", "boolean", "array", "object"]),
    description: z.string().max(600).optional(),
    required: z.boolean().optional(),
    enum: z.array(z.union([z.string().max(200), z.number()])).max(100).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    maxLength: z.number().int().min(1).max(100_000).optional(),
    items: SimpleFieldSchema.optional(),
    properties: z.record(z.string(), SimpleFieldSchema).optional(),
  }),
);

/** zod v4 has no `.max()` on records — enforce the key count via refine. */
function boundedRecord<T extends z.ZodType>(maxKeys: number, valueSchema: T) {
  return z
    .record(z.string(), valueSchema)
    .refine((value) => Object.keys(value).length <= maxKeys, {
      message: `Object must contain at most ${maxKeys} keys.`,
    });
}

const PermissionStringSchema = z
  .string()
  .trim()
  .max(200)
  .regex(
    /^(http\.fetch:[a-z0-9*.-]+\.[a-z0-9-]+|storage\.read|storage\.write|memory\.read|memory\.write|agent\.invoke)$/,
    "Permission must be http.fetch:<domain> or one of storage.read, storage.write, memory.read, memory.write, agent.invoke",
  );

const TemplateSchema = z.string().max(MAX_TEMPLATE_LENGTH);

const EndpointHeadersSchema = z
  .array(
    z.object({
      name: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]{1,64}$/, "Header name must contain only letters, digits and dashes"),
      value: TemplateSchema,
    }),
  )
  .max(20);

const ExtensionToolSchema = z.object({
  id: z.string().regex(SLUG_REGEX, "Tool id must be a slug").max(64),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(800),
  inputSchema: boundedRecord(40, SimpleFieldSchema).optional(),
  outputSchema: boundedRecord(40, SimpleFieldSchema).optional(),
  endpoint: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: TemplateSchema,
    headers: EndpointHeadersSchema.optional(),
    bodyTemplate: TemplateSchema.optional(),
    timeoutMs: z.number().int().min(1_000).max(15_000).optional(),
  }),
});

const ExtensionSkillSchema = z.object({
  id: z.string().regex(SLUG_REGEX).max(64),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(800),
  instructions: z.string().min(20).max(8_000),
});

const ExtensionWorkflowStepSchema = z.object({
  toolId: z.string().regex(SLUG_REGEX).max(64),
  input: z
    .record(z.string(), z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]))
    .refine((value) => Object.keys(value).length <= 40, { message: "Step input must contain at most 40 keys." }),
});

const ExtensionWorkflowSchema = z.object({
  id: z.string().regex(SLUG_REGEX).max(64),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(800),
  inputSchema: boundedRecord(40, SimpleFieldSchema).optional(),
  steps: z.array(ExtensionWorkflowStepSchema).min(1).max(20),
});

const ExtensionSettingSchema = z.object({
  key: z.string().regex(SLUG_REGEX).max(64),
  label: z.string().trim().min(1).max(100),
  description: z.string().max(400).optional(),
  type: z.enum(["string", "number", "boolean"]),
  default: z.union([z.string().max(2_000), z.number(), z.boolean()]),
});

const PricingSchema = z
  .object({
    model: z.enum(EXTENSION_PRICING_MODELS),
    amountMinor: z.number().int().min(1).max(100_000_000).optional(),
    unitAmountMinor: z.number().int().min(1).max(1_000_000).optional(),
    currency: z.string().trim().length(3).optional(),
    interval: z.enum(["month", "year"]).optional(),
    trialDays: z.number().int().min(0).max(90).optional(),
    maxExecutionsPerDay: z.number().int().min(1).max(10_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.model === "free") {
      if (value.amountMinor !== undefined || value.unitAmountMinor !== undefined) {
        ctx.addIssue({ code: "custom", message: "Free extensions must not define an amount." });
      }
      return;
    }
    if (value.model === "usage") {
      if (!value.unitAmountMinor) {
        ctx.addIssue({ code: "custom", message: "Usage-based pricing requires unitAmountMinor." });
      }
      return;
    }
    if (!value.amountMinor) {
      ctx.addIssue({ code: "custom", message: `${value.model} pricing requires amountMinor.` });
    }
    if (value.model === "subscription" && !value.interval) {
      ctx.addIssue({ code: "custom", message: "Subscription pricing requires an interval (month or year)." });
    }
  });

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  category: (typeof EXTENSION_CATEGORIES)[number];
  tags?: string[];
  permissions: string[];
  secrets?: Record<string, { description: string }>;
  tools?: z.infer<typeof ExtensionToolSchema>[];
  skills?: z.infer<typeof ExtensionSkillSchema>[];
  workflows?: z.infer<typeof ExtensionWorkflowSchema>[];
  settings?: z.infer<typeof ExtensionSettingSchema>[];
  pricing: z.infer<typeof PricingSchema>;
}

export const ExtensionManifestSchema = z
  .object({
    id: z
      .string()
      .regex(EXTENSION_ID_REGEX, "Extension id must be a lowercase slug (3-64 chars, digits, dashes)."),
    name: z.string().trim().min(3).max(80),
    version: z.string().regex(SEMVER_REGEX, "version must be semver MAJOR.MINOR.PATCH"),
    author: z.string().trim().min(1).max(120),
    description: z.string().trim().min(10).max(2_000),
    category: z.enum(EXTENSION_CATEGORIES),
    tags: z.array(z.string().trim().min(2).max(24)).max(10).optional(),
    permissions: z.array(PermissionStringSchema).max(MAX_PERMISSIONS),
    secrets: boundedRecord(
      MAX_SECRETS,
      z.object({ description: z.string().min(1).max(300) }),
    ).optional(),
    tools: z.array(ExtensionToolSchema).max(MAX_TOOLS).optional(),
    skills: z.array(ExtensionSkillSchema).max(MAX_SKILLS).optional(),
    workflows: z.array(ExtensionWorkflowSchema).max(MAX_WORKFLOWS).optional(),
    settings: z.array(ExtensionSettingSchema).max(MAX_SETTINGS).optional(),
    pricing: PricingSchema,
  })
  .strict();

export type ValidatedManifest =
  | { ok: true; manifest: ExtensionManifest; warnings: string[] }
  | { ok: false; errors: string[] };

const TEMPLATE_REF = /\{\{\s*(input|secret)\.([a-zA-Z0-9_.-]+)\s*\}\}/g;

function collectTemplateRefs(template: string): Array<{ scope: string; path: string }> {
  const refs: Array<{ scope: string; path: string }> = [];
  for (const match of template.matchAll(TEMPLATE_REF)) {
    refs.push({ scope: match[1], path: match[2] });
  }
  return refs;
}

function validateToolTemplates(manifest: ExtensionManifest, errors: string[], warnings: string[]) {
  const secretRefs = Object.keys(manifest.secrets ?? {});
  for (const tool of manifest.tools ?? []) {
    const inputFields = new Set(Object.keys(tool.inputSchema ?? {}));
    const urlRefs = collectTemplateRefs(tool.endpoint.url);
    if (urlRefs.some((ref) => ref.scope === "secret")) {
      errors.push(`Tool ${tool.id}: secrets are not allowed in the URL (use headers or body).`);
    }
    for (const ref of urlRefs) {
      if (ref.scope === "input" && !inputFields.has(ref.path.split(".")[0])) {
        errors.push(`Tool ${tool.id}: URL references unknown input field "${ref.path}".`);
      }
    }
    for (const header of tool.endpoint.headers ?? []) {
      for (const ref of collectTemplateRefs(header.value)) {
        if (ref.scope === "secret" && !secretRefs.includes(ref.path)) {
          errors.push(`Tool ${tool.id}: header ${header.name} references undeclared secret "${ref.path}".`);
        }
        if (ref.scope === "input" && !inputFields.has(ref.path.split(".")[0])) {
          errors.push(`Tool ${tool.id}: header ${header.name} references unknown input field "${ref.path}".`);
        }
      }
    }
    if (tool.endpoint.bodyTemplate) {
      if (!["POST", "PUT", "PATCH"].includes(tool.endpoint.method)) {
        errors.push(`Tool ${tool.id}: bodyTemplate is only allowed for POST/PUT/PATCH.`);
      }
      for (const ref of collectTemplateRefs(tool.endpoint.bodyTemplate)) {
        if (ref.scope === "secret" && !secretRefs.includes(ref.path)) {
          errors.push(`Tool ${tool.id}: body references undeclared secret "${ref.path}".`);
        }
        if (ref.scope === "input" && !inputFields.has(ref.path.split(".")[0])) {
          errors.push(`Tool ${tool.id}: body references unknown input field "${ref.path}".`);
        }
      }
    }
    if ((tool.endpoint.headers ?? []).some((h) => h.name.toLowerCase() === "host")) {
      errors.push(`Tool ${tool.id}: overriding the Host header is not allowed.`);
    }
    if (secretRefs.length > 0 && !(tool.endpoint.headers ?? []).some((h) => h.name.toLowerCase() === "authorization")) {
      warnings.push(`Tool ${tool.id}: declares secrets but sends no Authorization header — check the auth scheme.`);
    }
  }
}

/**
 * Full manifest validation: shape (zod), cross-references (templates, workflow
 * steps) and permission/host coherence. Runs at create/version/submit/install.
 */
export function validateManifest(input: unknown): ValidatedManifest {
  const parsed = ExtensionManifestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`) };
  }
  const manifest = parsed.data as ExtensionManifest;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Workflow steps must reference declared tools.
  const toolIds = new Set((manifest.tools ?? []).map((tool) => tool.id));
  for (const workflow of manifest.workflows ?? []) {
    for (const step of workflow.steps) {
      if (!toolIds.has(step.toolId)) {
        errors.push(`Workflow ${workflow.id}: step references undeclared tool "${step.toolId}".`);
      }
    }
  }

  // Every tool endpoint host must be covered by an http.fetch permission.
  for (const tool of manifest.tools ?? []) {
    let host: string | null = null;
    try {
      host = new URL(tool.endpoint.url.replace(/\{\{\s*input[^}]*\}\}/g, "placeholder")).hostname.toLowerCase();
    } catch {
      errors.push(`Tool ${tool.id}: endpoint URL template is not a valid URL.`);
      continue;
    }
    if (!host.includes(".")) {
      errors.push(`Tool ${tool.id}: endpoint host "${host}" must be a public domain.`);
    }
    const covered = manifest.permissions.some((permission) => {
      if (!permission.startsWith("http.fetch:")) return false;
      const grantedHost = permission.slice("http.fetch:".length).replace(/^\*\./, "");
      return host === grantedHost || host.endsWith(`.${grantedHost}`);
    });
    if (!covered) {
      errors.push(`Tool ${tool.id}: no http.fetch permission covers host "${host}".`);
    }
  }

  validateToolTemplates(manifest, errors, warnings);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest, warnings };
}

/** Non-decreasing semver comparison (MAJOR.MINOR.PATCH). */
export function compareSemver(a: string, b: string): number {
  const [a1, a2, a3] = a.split(".").map(Number);
  const [b1, b2, b3] = b.split(".").map(Number);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

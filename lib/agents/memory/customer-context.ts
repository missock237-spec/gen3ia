import { adminDb } from "@/lib/firebase/admin";

const COLLECTION = "agentCustomerContexts";
const MAX_FIELD_LENGTH = 10_000;
const MAX_TAGS = 100;

export interface CustomerContext {
  customerId: string;
  ownerId: string;
  name?: string;
  email?: string;
  phone?: string;
  language?: string;
  tags: string[];
  notes: string[];
  preferences: Record<string, unknown>;
  lastInteractionAt?: number;
  updatedAt: number;
}

function customerRef(ownerId: string, customerId: string) {
  return adminDb.collection(COLLECTION).doc(`${ownerId}_${customerId}`);
}

function cleanString(value: unknown, max = MAX_FIELD_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

export async function getCustomerContext(ownerId: string, customerId: string): Promise<CustomerContext | null> {
  const owner = cleanString(ownerId, 256);
  const customer = cleanString(customerId, 256);
  if (!owner || !customer) throw new Error("ownerId and customerId are required");
  const snapshot = await customerRef(owner, customer).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() ?? {};
  return {
    customerId: customer,
    ownerId: owner,
    name: cleanString(data.name, 500),
    email: cleanString(data.email, 500),
    phone: cleanString(data.phone, 100),
    language: cleanString(data.language, 50),
    tags: Array.isArray(data.tags) ? data.tags.filter((v): v is string => typeof v === "string").slice(0, MAX_TAGS) : [],
    notes: Array.isArray(data.notes) ? data.notes.filter((v): v is string => typeof v === "string").map((v) => v.slice(0, MAX_FIELD_LENGTH)).slice(0, MAX_TAGS) : [],
    preferences: data.preferences && typeof data.preferences === "object" && !Array.isArray(data.preferences) ? data.preferences as Record<string, unknown> : {},
    lastInteractionAt: typeof data.lastInteractionAt === "number" ? data.lastInteractionAt : undefined,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
  };
}

export async function upsertCustomerContext(ownerId: string, customerId: string, patch: Partial<Omit<CustomerContext, "ownerId" | "customerId" | "updatedAt">>): Promise<CustomerContext> {
  const owner = cleanString(ownerId, 256);
  const customer = cleanString(customerId, 256);
  if (!owner || !customer) throw new Error("ownerId and customerId are required");
  const now = Date.now();
  const update = {
    ownerId: owner,
    customerId: customer,
    ...(cleanString(patch.name, 500) ? { name: cleanString(patch.name, 500) } : {}),
    ...(cleanString(patch.email, 500) ? { email: cleanString(patch.email, 500) } : {}),
    ...(cleanString(patch.phone, 100) ? { phone: cleanString(patch.phone, 100) } : {}),
    ...(cleanString(patch.language, 50) ? { language: cleanString(patch.language, 50) } : {}),
    ...(patch.tags ? { tags: patch.tags.filter((v): v is string => typeof v === "string").map((v) => v.slice(0, 200)).slice(0, MAX_TAGS) } : {}),
    ...(patch.notes ? { notes: patch.notes.filter((v): v is string => typeof v === "string").map((v) => v.slice(0, MAX_FIELD_LENGTH)).slice(0, MAX_TAGS) } : {}),
    ...(patch.preferences && typeof patch.preferences === "object" && !Array.isArray(patch.preferences) ? { preferences: patch.preferences } : {}),
    ...(typeof patch.lastInteractionAt === "number" ? { lastInteractionAt: patch.lastInteractionAt } : {}),
    updatedAt: now,
  };
  await customerRef(owner, customer).set(update, { merge: true });
  return (await getCustomerContext(owner, customer))!;
}

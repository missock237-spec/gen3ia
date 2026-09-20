import { createHash, randomBytes } from "node:crypto";
import { verifyFirebaseToken } from "@/lib/firebase/auth-server";
import { verifyDeveloperProjectAccess, createDeveloperApiKey, ensureDeveloperProfile, getDeveloperApiKey } from "./repository";

const KEY_PREFIX = "g3x_";

export function generateDeveloperApiKey() {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, keyHash: hashDeveloperApiKey(key), prefix: `${KEY_PREFIX}${key.slice(4, 10)}` };
}
export function hashDeveloperApiKey(key: string) { return createHash("sha256").update(key.trim()).digest("hex"); }

export interface DeveloperIdentity { userId: string; via: "firebase" | "api_key"; displayName: string; projectId?: string; }

export async function authenticateDeveloper(request: Request): Promise<DeveloperIdentity> {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (token.startsWith(KEY_PREFIX)) {
    const record = await getDeveloperApiKey(hashDeveloperApiKey(token));
    if (!record) throw new Error("Clé API Gen3ia invalide ou révoquée.");
    const projectId = request.headers.get("x-gen3ia-project-id")?.trim() ?? "";
    if (!projectId) throw new Error("Cette clé est liée à un projet Gen3ia. Envoyez X-Gen3ia-Project-Id.");
    if (record.projectId !== projectId) throw new Error("Cette clé API ne peut être utilisée que sur son projet Gen3ia lié.");
    await verifyDeveloperProjectAccess(record.userId, projectId);
    const profile = await ensureDeveloperProfile(record.userId, `developer-${record.userId.slice(0, 8)}`);
    return { userId: record.userId, via: "api_key", displayName: profile.displayName, projectId };
  }
  const decoded = await verifyFirebaseToken(authorization);
  const displayName = (decoded.name && String(decoded.name).slice(0, 80)) || (decoded.email && String(decoded.email).split("@")[0].slice(0, 80)) || `developer-${decoded.uid.slice(0, 8)}`;
  await ensureDeveloperProfile(decoded.uid, displayName);
  return { userId: decoded.uid, via: "firebase", displayName };
}

export async function issueDeveloperApiKey(userId: string, name: string, projectId: string) {
  await verifyDeveloperProjectAccess(userId, projectId);
  const { key, keyHash, prefix } = generateDeveloperApiKey();
  await createDeveloperApiKey({ userId, keyHash, prefix, name, projectId });
  return { key, prefix, name, projectId };
}

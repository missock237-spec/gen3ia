import { adminDb } from "@/lib/firebase/admin";
import { verifyFirebaseAuth, type DecodedIdToken } from "@/lib/firebase/auth-server";

export type PlatformRole = "user" | "developer" | "admin";

export interface PlatformAccess {
  authenticated: boolean;
  role: PlatformRole;
  canDeveloper: boolean;
  canAdmin: boolean;
  userId: string;
}

function claimIsTrue(token: DecodedIdToken, name: string): boolean {
  return (token as unknown as Record<string, unknown>)[name] === true;
}

export async function getPlatformRole(
  userId: string,
  token?: DecodedIdToken,
): Promise<PlatformRole> {
  if (token && (claimIsTrue(token, "admin") || claimIsTrue(token, "developer"))) {
    return claimIsTrue(token, "admin") ? "admin" : "developer";
  }

  const snap = await adminDb.collection("users").doc(userId).get();
  if (snap.exists) {
    const role = snap.get("role");
    if (role === "admin") return "admin";
    if (role === "developer") return "developer";
  }

  return "user";
}

export async function assertDeveloperRole(userId: string): Promise<void> {
  const role = await getPlatformRole(userId);
  if (role !== "developer" && role !== "admin") {
    throw new Error("Developer access required.");
  }
}

export async function getPlatformAccess(
  request: Request | { headers: { get(name: string): string | null } },
): Promise<PlatformAccess> {
  const token = await verifyFirebaseAuth(request);
  const role = await getPlatformRole(token.uid, token);
  return {
    authenticated: true,
    role,
    canDeveloper: role === "developer" || role === "admin",
    canAdmin: role === "admin",
    userId: token.uid,
  };
}

export async function requireDeveloperAccess(
  request: Request | { headers: { get(name: string): string | null } },
): Promise<DecodedIdToken> {
  const token = await verifyFirebaseAuth(request);
  await assertDeveloperRole(token.uid);
  return token;
}

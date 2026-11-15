/**
 * Extension Permission Engine (pure).
 *
 * Extensions request granular permissions in their manifest; users grant them
 * at installation (a snapshot is stored on the installation document). Every
 * runtime action is checked against the SNAPSHOT, so revoking or reinstalling
 * takes effect immediately and a manifest change never silently widens access.
 */

export type ObjectPermission =
  | "storage.read"
  | "storage.write"
  | "memory.read"
  | "memory.write"
  | "agent.invoke";

export type ParsedPermission =
  | { kind: "http.fetch"; host: string }
  | { kind: ObjectPermission };

const OBJECT_PERMISSIONS: ObjectPermission[] = [
  "storage.read",
  "storage.write",
  "memory.read",
  "memory.write",
  "agent.invoke",
];

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // IPv4 literal
  /^\[[0-9a-f:]+\]$/i, // IPv6 literal
  /^0\./,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
];

export function isPrivateHost(host: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

/**
 * Parses a permission string. Returns null when malformed. http.fetch hosts
 * must be public domain names (no IP literals, no localhost).
 */
export function parseExtensionPermission(permission: string): ParsedPermission | null {
  const value = permission.trim().toLowerCase();
  if (OBJECT_PERMISSIONS.includes(value as ObjectPermission)) {
    return { kind: value as ObjectPermission };
  }
  if (!value.startsWith("http.fetch:")) return null;
  const host = value.slice("http.fetch:".length);
  if (!host || !host.includes(".") || isPrivateHost(host)) return null;
  if (!/^[a-z0-9*.-]+$/.test(host)) return null;
  return { kind: "http.fetch", host };
}

/** Canonical key of a permission (lowercase, normalized). */
export function permissionKey(permission: string): string {
  const parsed = parseExtensionPermission(permission);
  if (!parsed) return permission.trim().toLowerCase();
  return parsed.kind === "http.fetch" ? `http.fetch:${parsed.host}` : parsed.kind;
}

/**
 * Checks that every required permission is covered by the granted set.
 * Throws with an explicit message when access must be denied.
 */
export function assertPermissionsGranted(granted: string[], required: string[]): void {
  const grantedKeys = new Set(granted.map(permissionKey));
  for (const requirement of required) {
    const parsed = parseExtensionPermission(requirement);
    if (!parsed) throw new Error(`Extension requests an invalid permission: ${requirement}`);
    if (parsed.kind === "http.fetch") {
      const covered = [...grantedKeys].some((key) => {
        if (!key.startsWith("http.fetch:")) return false;
        const grantedHost = key.slice("http.fetch:".length);
        const bareGranted = grantedHost.replace(/^\*\./, "");
        return (
          parsed.host === grantedHost ||
          parsed.host === bareGranted ||
          parsed.host.endsWith(`.${bareGranted}`)
        );
      });
      if (!covered) throw new Error(`Permission denied: ${requirement} was not granted for this installation.`);
    } else if (!grantedKeys.has(parsed.kind)) {
      throw new Error(`Permission denied: ${parsed.kind} was not granted for this installation.`);
    }
  }
}

/** Extracts the host an endpoint URL targets (lowercase). */
export function endpointHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

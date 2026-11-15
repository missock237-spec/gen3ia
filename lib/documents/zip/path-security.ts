import path from "node:path";

export class UnsafeArchivePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchivePathError";
  }
}

export function sanitizeArchivePath(input: string): string {
  if (!input) {
    throw new UnsafeArchivePathError(
      "Archive path is empty"
    );
  }

  if (input.includes("\0")) {
    throw new UnsafeArchivePathError(
      "Archive path contains NUL byte"
    );
  }

  const normalizedInput = input.replace(/\\/g, "/");

  if (
    normalizedInput.startsWith("/") ||
    normalizedInput.startsWith("//")
  ) {
    throw new UnsafeArchivePathError(
      "Absolute archive paths are forbidden"
    );
  }

  if (/^[a-zA-Z]:\//.test(normalizedInput)) {
    throw new UnsafeArchivePathError(
      "Windows absolute paths are forbidden"
    );
  }

  const normalized = path.posix.normalize(
    normalizedInput
  );

  if (
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new UnsafeArchivePathError(
      "Path traversal detected"
    );
  }

  const segments = normalized
    .split("/")
    .filter(Boolean);

  if (segments.some((segment) => segment === "..")) {
    throw new UnsafeArchivePathError(
      "Path traversal detected"
    );
  }

  return segments.join("/");
}

export function assertSafeExtractionPath(
  extractionRoot: string,
  archivePath: string
): string {
  const safePath =
    sanitizeArchivePath(archivePath);

  const resolvedRoot =
    path.resolve(extractionRoot);

  const resolvedPath =
    path.resolve(
      resolvedRoot,
      safePath
    );

  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(
      `${resolvedRoot}${path.sep}`
    )
  ) {
    throw new UnsafeArchivePathError(
      "Extraction path escapes archive root"
    );
  }

  return resolvedPath;
}

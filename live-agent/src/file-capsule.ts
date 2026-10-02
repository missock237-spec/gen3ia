/**
 * Capsule fichiers du live-agent — accès en lecture/écriture jailé au root
 * autorisé, à base de DESCRIPTEURS vérifiés (zéro fenêtre TOCTOU).
 *
 * Historique : l'ancien chemin `stat(chemin)` puis `readFile(chemin)` laissait
 * une course — le fichier pouvait être remplacé (symlink) ENTRE la vérification
 * et la lecture. Ici le chemin est résolu par la jail, OUVERT avec O_NOFOLLOW
 * (un symlink posé sur le composant final est refusé ELOOP), puis TOUTES les
 * vérifications (type, taille) portent sur le descripteur ouvert (fstat) et la
 * lecture/écriture s'opère sur CE descripteur : les données proviennent
 * toujours de l'inode vérifié.
 */

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

export function createFileCapsule(root: string, maxBytes: number) {
  const resolvedRoot = path.resolve(root);

  /** Jail de résolution — identique à l'ancien safeFilePath (tests conservés). */
  function resolveInside(requestedPath: string): string {
    if (
      !requestedPath ||
      requestedPath.includes("\0") ||
      requestedPath.includes("\\") ||
      requestedPath.split("/").includes("..")
    ) {
      throw new Error("Unsafe live file path.");
    }
    const resolved = path.resolve(resolvedRoot, requestedPath);
    const relative = path.relative(resolvedRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Live file path escapes the authorized root.");
    }
    return resolved;
  }

  return {
    /** Lit un fichier du root autorisé (descripteur vérifié, UTF-8). */
    async read(requestedPath: string): Promise<string> {
      const target = resolveInside(requestedPath);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > maxBytes) {
          throw new Error("Live file is missing, not regular, or exceeds the size limit.");
        }
        return await handle.readFile({ encoding: "utf8" });
      } finally {
        await handle?.close();
      }
    },

    /**
     * Écrit un fichier du root autorisé en DEUX ouvertures sécurisées :
     * 1. O_CREAT|O_EXCL|O_NOFOLLOW — création atomique si le fichier n'existe
     *    pas encore (aucune fenêtre de création non exclusive) ;
     * 2. sur EEXIST : O_WRONLY|O_TRUNC|O_NOFOLLOW — écrasement d'un fichier
     *    EXISTANT sans le recréer (pas de combinaison O_CREAT+O_TRUNC, et le
     *    O_NOFOLLOW de chaque ouverture refuse tout symlink pivot).
     * Sémantique « w » de l'ancien writeFile conservée, mode 0600.
     */
    async write(requestedPath: string, content: string): Promise<number> {
      const target = resolveInside(requestedPath);
      const buffer = Buffer.from(content, "utf8");
      if (buffer.byteLength > maxBytes) {
        throw new Error("Live file exceeds the size limit.");
      }
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        try {
          handle = await open(
            target,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
            0o600,
          );
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code !== "EEXIST") throw error;
          handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
        }
        await handle.writeFile(buffer);
        return buffer.byteLength;
      } finally {
        await handle?.close();
      }
    },
  };
}

/**
 * MIGRATION R2 TOTALE — mock R2 mémoire PARTAGÉ pour les tests E2E.
 *
 * L'environnement E2E (émulateurs Firebase) n'a PAS de bucket R2 : le client
 * R2 (lib/storage/r2) est simulé EN MÉMOIRE avec la sémantique S3
 * conditionnelle COMPLÈTE (If-Match ETag / If-None-Match « * » → 412),
 * car le moteur de données r2fs (lib/r2fs) s'appuie dessus pour les
 * transactions (claims, wallet). Même approche que les mocks unitaires.
 */
import { vi } from "vitest";

export function creerMockR2Memoire() {
  const r2Objects = new Map<string, { body: Buffer; etag: string }>();
  let compteurEtag = 0;

  const absence = (key: string) => {
    const erreur = new Error(`The specified key does not exist. (${key})`);
    erreur.name = "NoSuchKey";
    return erreur;
  };

  const mock = {
    putObject: vi.fn(async ({ key, body }: { key: string; body: Uint8Array | Buffer }) => {
      r2Objects.set(key, { body: Buffer.from(body), etag: `"w${++compteurEtag}"` });
    }),
    getObjectWithEtag: vi.fn(async (key: string) => {
      const hit = r2Objects.get(key);
      if (!hit) return null;
      return { data: hit.body, etag: hit.etag };
    }),
    putObjectConditional: vi.fn(
      async (
        key: string,
        body: Uint8Array | Buffer,
        _contentType: string,
        opts?: { ifMatch?: string; ifNoneMatch?: "*" },
      ) => {
        const existant = r2Objects.get(key);
        // Contrat du client réel : précondition échouée → null (pas d'exception).
        if (opts?.ifMatch && (!existant || existant.etag !== opts.ifMatch)) return null;
        if (opts?.ifNoneMatch === "*" && existant) return null;
        const etag = `"w${++compteurEtag}"`;
        r2Objects.set(key, { body: Buffer.from(body), etag });
        return { etag };
      },
    ),
    deleteObject: vi.fn(async (key: string) => {
      r2Objects.delete(key);
    }),
    deleteObjectConditional: vi.fn(async (key: string, ifMatch: string) => {
      const existant = r2Objects.get(key);
      if (!existant) return true;
      if (existant.etag !== ifMatch) return false;
      r2Objects.delete(key);
      return true;
    }),
    deleteFromR2: vi.fn(async (key: string) => {
      r2Objects.delete(key);
    }),
    listObjectsUnderPrefix: vi.fn(async (prefix: string) =>
      [...r2Objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({
          key,
          sizeBytes: r2Objects.get(key)?.body.byteLength ?? 0,
          updatedAt: new Date().toISOString(),
        })),
    ),
    downloadFromR2: vi.fn(async (key: string): Promise<Buffer> => {
      const hit = r2Objects.get(key);
      if (!hit) throw absence(key);
      return hit.body;
    }),
    /** Réinitialise le stockage mémoire entre les tests. */
    reset: () => r2Objects.clear(),
    /** Statistiques de debug (nombre d'objets). */
    taille: () => r2Objects.size,
    /** Clés présentes (assertions E2E). */
    cles: () => [...r2Objects.keys()],
  };

  return mock;
}

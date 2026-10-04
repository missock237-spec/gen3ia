import { describe, expect, it, vi } from "vitest";

/**
 * video.create — chemin d'erreur « file de production indisponible ».
 *
 * Simulation DÉTERMINISTE et stable d'un module de production absent : la
 * factory du mock LÈVE, exactement comme un module manquant à l'exécution —
 * quel que soit l'état réel de lib/video/production-queue.ts (Task 1-a en
 * parallèle). Verrou : l'import paresseux qui échoue produit une erreur
 * CLAIRE EN FRANÇAIS — jamais un « Cannot find module » brut ni un repli
 * silencieux.
 */

vi.mock("@/lib/video/production-queue", () => {
  throw new Error("Cannot find module '@/lib/video/production-queue'");
});

import { createVideoTool } from "./create-video";

describe("video.create — file de production indisponible", () => {
  it("échec de l'import paresseux → erreur claire en français, pas d'exception brute", async () => {
    await expect(
      createVideoTool.execute(
        { prompt: "Une vidéo de présentation de 60 secondes sur Lyon" },
        { userId: "user-1", executionId: "exec-1" },
      ),
    ).rejects.toThrow(/production vid[ée]o n'est pas disponible/i);
  });

  it("l'erreur française contient la cause réelle (diagnostic conservé)", async () => {
    const error = await createVideoTool
      .execute(
        { prompt: "Une vidéo tutorielle sur la photosynthèse" },
        { userId: "user-1", executionId: "exec-1" },
      )
      .then(
        () => {
          throw new Error("devait échouer");
        },
        (err: unknown) => err as Error,
      );
    // Préfixe français + cause réelle conservée après le séparateur « : ».
    expect(error.message).toMatch(/production vid[ée]o n.est pas disponible.*introuvable\)? : .+/s);
    expect(error.message.length).toBeGreaterThan(
      "La production vidéo n'est pas disponible sur cette plateforme (file de production introuvable) : ".length + 10,
    );
  });
});

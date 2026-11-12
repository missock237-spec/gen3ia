import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  attachmentLimitLabel,
  validateAttachment,
} from "./attachment-policy";

/**
 * POLITIQUE UNIFIÉE DES PIÈCES JOINTES (exigence production) :
 * 15 fichiers maximum par message, 100 Mo maximum par fichier — une seule
 * source de vérité partagée par TOUTES les surfaces (composer, chat agent,
 * import, Knowledge).
 */
describe("politique unifiée des pièces jointes", () => {
  it("fixe les limites de production : 15 fichiers × 100 Mo", () => {
    expect(ATTACHMENT_MAX_FILES).toBe(15);
    expect(ATTACHMENT_MAX_FILE_BYTES).toBe(100 * 1024 * 1024);
    expect(ATTACHMENT_MAX_TOTAL_BYTES).toBe(ATTACHMENT_MAX_FILES * ATTACHMENT_MAX_FILE_BYTES);
  });

  it("le libellé canonique mentionne les deux limites", () => {
    const label = attachmentLimitLabel();
    expect(label).toContain("15");
    expect(label).toContain("100");
  });

  describe("validateAttachment", () => {
    it("accepte un fichier à la limite exacte (100 Mo)", () => {
      const verdict = validateAttachment({ name: "gros-fichier.pdf", size: ATTACHMENT_MAX_FILE_BYTES });
      expect(verdict).toEqual({ ok: true });
    });

    it("rejette au-delà de 100 Mo avec un message lisible", () => {
      const verdict = validateAttachment({ name: "video.mp4", size: ATTACHMENT_MAX_FILE_BYTES + 1 });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/100 Mo/);
    });

    it("rejette un fichier vide", () => {
      const verdict = validateAttachment({ name: "vide.txt", size: 0 });
      expect(verdict.ok).toBe(false);
    });

    it("rejette un nom de fichier invalide", () => {
      const verdict = validateAttachment({ name: "   ", size: 100 });
      expect(verdict.ok).toBe(false);
    });
  });
});

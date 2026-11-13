import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/admin/genapi/paquets/[jeton] — téléchargement du package client
 * à USAGE UNIQUE. Le socle lib/genapi (écrit en parallèle) est MOQUÉ :
 * consommerJetonPaquet brûle le jeton côté socle (atomique). Contrats
 * verrouillés ici :
 *  - succès → 200 binaire, content-type application/gzip, content-disposition
 *    attachment (gen3-client-package.bin.gz), cache-control no-store ;
 *  - jeton consommé/inconnu/expiré → 410 Gone JSON honnête ;
 *  - panne technique du socle → 500 propre (le jeton reste consommable).
 * Le contenu du paquet n'est jamais journalisé par la route.
 *
 * La suite est active dès que le module socle est présent (garde
 * d'existence) — la route l'importe statiquement ; on ne crée JAMAIS un
 * stub lib/genapi dans cette mission (fusion socle).
 */

const consommerJetonPaquetMock = vi.fn();

vi.mock("@/lib/genapi/provisionnement", () => ({
  consommerJetonPaquet: (...args: unknown[]) => consommerJetonPaquetMock(...args),
}));

/** Chemin du module socle moqué (la route l'importe statiquement). */
const SOCLE_PROVISIONNEMENT = path.resolve(import.meta.dirname, "../../../../../../lib/genapi/provisionnement.ts");
const SOCLE_PRESENT = existsSync(SOCLE_PROVISIONNEMENT);

function request(jeton: string): NextRequest {
  return new NextRequest(`https://gen3ia.local/api/admin/genapi/paquets/${jeton}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!SOCLE_PRESENT)(
  "GET /api/admin/genapi/paquets/[jeton] — succès (socle moqué)",
  () => {
    it("renvoie le paquet en gzip en pièce jointe, sans cache", async () => {
      const { GET } = await import("./route");
      const paquet = Buffer.from("paquet genAPI — usage unique");
      consommerJetonPaquetMock.mockResolvedValue({ ok: true, paquet, uid: "u-1" });

      const response = await GET(request("jeton-valide"), {
        params: Promise.resolve({ jeton: "jeton-valide" }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/gzip");
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="gen3-client-package.bin.gz"',
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const corps = Buffer.from(await response.arrayBuffer());
      expect(corps.equals(paquet)).toBe(true);
      expect(consommerJetonPaquetMock).toHaveBeenCalledWith("jeton-valide");
    });
  },
);

describe.skipIf(!SOCLE_PRESENT)(
  "GET /api/admin/genapi/paquets/[jeton] — jeton mort (socle moqué)",
  () => {
    it("jeton consommé → 410 Gone JSON honnête", async () => {
      const { GET } = await import("./route");
      consommerJetonPaquetMock.mockResolvedValue({ ok: false });
      const response = await GET(request("jeton-conomme"), {
        params: Promise.resolve({ jeton: "jeton-conomme" }),
      });
      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("Lien de téléchargement déjà utilisé ou expiré.");
    });

    it("jeton inconnu → 410 Gone (pas de divulgation d'existence)", async () => {
      const { GET } = await import("./route");
      consommerJetonPaquetMock.mockResolvedValue({ ok: false, erreur: "jeton inconnu" });
      const response = await GET(request("introuvable"), {
        params: Promise.resolve({ jeton: "introuvable" }),
      });
      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body.error).toBe("Lien de téléchargement déjà utilisé ou expiré.");
    });

    it("ok:true sans paquet (socle incohérent) → 410, pas de réponse vide", async () => {
      const { GET } = await import("./route");
      consommerJetonPaquetMock.mockResolvedValue({ ok: true });
      const response = await GET(request("jeton-sans-corps"), {
        params: Promise.resolve({ jeton: "jeton-sans-corps" }),
      });
      expect(response.status).toBe(410);
    });
  },
);

describe.skipIf(!SOCLE_PRESENT)(
  "GET /api/admin/genapi/paquets/[jeton] — panne technique (socle moqué)",
  () => {
    it("erreur du socle → 500 propre (le jeton reste consommable)", async () => {
      const { GET } = await import("./route");
      consommerJetonPaquetMock.mockRejectedValue(new Error("panne du daemon"));
      const response = await GET(request("jeton-panne"), {
        params: Promise.resolve({ jeton: "jeton-panne" }),
      });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBeTruthy();
    });
  },
);

import { NextRequest } from "next/server";

import { protectRoute } from "@/lib/security/route-guard";
import { registreEssaim } from "@/lib/essaim-media/registre";
import { orchestrateurEssaim } from "@/lib/essaim-media/orchestrateur";
import { assurerBatteur, ondePorteuse, type ÉvénementEssaim } from "@/lib/essaim-media/onde-porteuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/essaim/canal — L'ONDE PORTEUSE (SSE) : le flux continu par lequel
 * l'IA centrale pousse les parts de tâche vers chaque agent gen3.
 *
 * Côté utilisateur : « les agents sont connectés à l'IA centrale par
 * interférences d'ondes ». Côté ingénierie : Server-Sent Events HTTPS,
 * une fréquence par nœud (`noeud:<id>`), battements de maintien toutes
 * les 15 s. Double ceinture avec le battement POST (/api/essaim/ondes) :
 * un agent qui perd le SSE reste servi via la réponse de son battement.
 */

const KEEPALIVE_MS = 15_000;

export async function GET(request: NextRequest) {
  const guard = await protectRoute(request);
  if (!guard.ok) return guard.response;

  const noeudId = request.nextUrl.searchParams.get("noeudId") ?? "";
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(noeudId)) {
    return new Response("noeudId invalide", { status: 400 });
  }
  if (!registreEssaim.connu(noeudId)) {
    // Un agent annonce TOUJOURS son onde avant d'écouter la fréquence.
    return new Response("noeud inconnu — émettez un battement d'abord", { status: 409 });
  }
  if (!registreEssaim.appartient(noeudId, guard.context.userId)) {
    return new Response("nœud non possédé", { status: 403 });
  }

  assurerBatteur({
    surveiller: () => orchestrateurEssaim.surveiller(),
    attribuer: () => orchestrateurEssaim.attribuer(),
  });

  const encoder = new TextEncoder();
  let désabonner: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const flux = new ReadableStream<Uint8Array>({
    start(controller) {
      const émettre = (data: unknown, event = "onde"): void => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* flux fermé : l'auditeur sera désabonné ci-dessous */
        }
      };

      émettre({ type: "syntonise", noeudId }, "syntonise");

      désabonner = ondePorteuse.écouterNoeud(noeudId, (e: ÉvénementEssaim) => {
        émettre(e, e.type);
      });

      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": battement\n\n"));
        } catch {
          /* flux fermé */
        }
      }, KEEPALIVE_MS);

      request.signal.addEventListener("abort", () => {
        if (keepalive) clearInterval(keepalive);
        désabonner?.();
        try {
          controller.close();
        } catch {
          /* déjà fermé */
        }
      });
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      désabonner?.();
    },
  });

  return new Response(flux, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

import { NextRequest, NextResponse } from "next/server";

import { résoudreIdentitéNœud } from "@/lib/security/noeud-service";
import { registreEssaim } from "@/lib/essaim-media/registre";
import { orchestrateurEssaim } from "@/lib/essaim-media/orchestrateur";
import { ondePorteuse } from "@/lib/essaim-media/onde-porteuse";
import { fusionnerOeuvre, vérifierTaille } from "@/lib/essaim-media/fusion";
import type { ChargeFragment } from "@/lib/essaim-media/types";
import { persistGeneratedBuffer } from "@/lib/media/persist";
import { appendMessage } from "@/lib/chat/repository";
import { createArtifact } from "@/lib/domain/artifacts/repository";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * /api/essaim/resultat — RETOUR DES SIGNAUX vers l'IA centrale.
 *
 * L'agent exécutant téléverse ici le fruit de sa part WebGPU (PNG de
 * keyframe / WAV de segment). Quand la DERNIÈRE part arrive, l'IA centrale
 * ASSOCIE LES SIGNAUX (xfade MP4 / concat WAV, cf. fusion.ts), persiste
 * l'œuvre en R2 permanent, dépose message + artefact dans la conversation
 * du demandeur, puis diffuse l'onde « travail_termine ». Le demandeur
 * reçoit le résultat même si son onglet a changé.
 *
 * En cas d'échec LOCAL du nœud (GPU OOM, onglet figé…) : champ `echec`
 * — la part est immédiatement re-relancée vers un autre agent.
 */

const LIBELLÉS: Record<string, (n: number, appareils: number) => string> = {
  image: (n, a) =>
    `Image photoréaliste GRAND FORMAT générée par l'essaim gen3 — mosaïque de ${n} tuile(s) calculée(s) via le WebGPU de ${a} appareil(s), cousue par l'IA centrale.`,
  voice: (n, a) =>
    `Voix humaine haute qualité générée par l'essaim gen3 — ${n} segment(s) synthétisé(s) par ${a} appareil(s), assemblé(s) en une voix continue.`,
  video: (n, a) =>
    `Vidéo haute qualité générée par l'essaim gen3 — ${n} keyframes photoréalistes calculées EN PARALLÈLE par ${a} appareil(s), assemblées (fondus, 24 img/s) par l'IA centrale.`,
};

export async function POST(request: NextRequest) {
  const guard = await résoudreIdentitéNœud(request);
  if (!guard.ok) return guard.response;

  try {
    const form = await request.formData();
    const noeudId = String(form.get("noeudId") ?? "");
    const fragmentId = String(form.get("fragmentId") ?? "");
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(noeudId) || !fragmentId) {
      return NextResponse.json(
        { success: false, error: "noeudId et fragmentId requis." },
        { status: 400 },
      );
    }
    if (!registreEssaim.appartient(noeudId, guard.context.userId)) {
      return NextResponse.json(
        { success: false, error: "Nœud non enregistré pour ce compte." },
        { status: 403 },
      );
    }

    /* ------------------------------------------- échec local : relance ---- */
    if (String(form.get("echec") ?? "") === "1") {
      const raison = String(form.get("raison") ?? "Échec GPU local").slice(0, 300);
      const f = orchestrateurEssaim.échouerFragment(fragmentId, noeudId, raison);
      const confiés = orchestrateurEssaim.attribuer();
      for (const nf of confiés) {
        if (!nf.noeudId) continue;
        ondePorteuse.publier(
          nf.génération > 0
            ? { type: "relance", noeudId: nf.noeudId, fragment: nf, noeudPerdu: noeudId }
            : { type: "affectation", noeudId: nf.noeudId, fragments: [nf] },
        );
      }
      return NextResponse.json({
        success: true,
        relancé: f ? f.génération <= 3 : false,
        message: f
          ? `Part re-relancée (génération ${f.génération}) vers un autre appareil de l'essaim.`
          : "Part inconnue ou déjà traitée.",
      });
    }

    /* -------------------------------------------- résultat : réception ---- */
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { success: false, error: "Fichier de fragment absent." },
        { status: 400 },
      );
    }
    const octets = new Uint8Array(await file.arrayBuffer());
    const reçu = orchestrateurEssaim.déclarerRésultat(fragmentId, noeudId, octets);
    if (!reçu.ok) {
      return NextResponse.json({ success: false, error: reçu.erreur }, { status: 409 });
    }

    /* --------------------------------- dernière part : ASSOCIATION finale -- */
    if (reçu.fusion) {
      const { job, résultats } = reçu.fusion;
      const plan: ChargeFragment[] = job.fragments.map((f) => f.charge);
      try {
        const oeuvre = await fusionnerOeuvre(job.kind, résultats, {}, plan);
        vérifierTaille(oeuvre.octets);

        const persisté = await persistGeneratedBuffer({
          userId: job.userId,
          buffer: Buffer.from(oeuvre.octets),
          contentType: oeuvre.mime,
          prefix:
            job.kind === "image"
              ? "webgpu-images"
              : job.kind === "voice"
                ? "webgpu-voix"
                : "webgpu-video",
          fallbackUrl: "",
        });

        const appareils = new Set(job.fragments.map((f) => f.noeudId)).size;
        const relancesNote =
          job.relances.length > 0
            ? ` ${job.relances.length} relance(s) automatique(s) ont réattribué des parts d'agents déconnectés.`
            : "";
        const message = await appendMessage({
          conversationId: job.conversationId,
          userId: job.userId,
          role: "assistant",
          content: `${LIBELLÉS[job.kind](job.fragments.length, appareils)}${relancesNote}`,
          ...(job.kind === "image"
            ? { imageUrl: persisté.url }
            : {}),
          provider: "gen3-webgpu",
          model: `gen3-essaim-${job.kind}-v1`,
          generationStatus: "complete",
        });
        const artifact = await createArtifact({
          userId: job.userId,
          conversationId: job.conversationId,
          type: job.kind === "image" ? "image" : job.kind === "voice" ? "audio" : "video",
          title: job.prompt.slice(0, 80),
          url: persisté.url,
          note: `Essaim média gen3 — ${job.fragments.length} fragment(s) WebGPU, ${appareils} appareil(s)`,
        });

        orchestrateurEssaim.scellerJob(job.jobId, persisté.url, oeuvre.octets.byteLength);
        const jobFrais = orchestrateurEssaim.étatJob(job.jobId, job.userId);
        if (jobFrais) {
          jobFrais.livraison = {
            message: message as unknown as Record<string, unknown>,
            artifact: artifact as unknown as Record<string, unknown>,
          };
        }
        ondePorteuse.publier({
          type: "travail_termine",
          userId: job.userId,
          jobId: job.jobId,
          conversationId: job.conversationId,
          kind: job.kind,
          url: persisté.url,
        });

        return NextResponse.json({
          success: true,
          fusionné: true,
          jobId: job.jobId,
          livraison: { message, artifact },
        });
      } catch (error) {
        // Fusion impossible (ffmpeg absent, formats hétérogènes…) : échec
        // HONNÊTE du job — jamais un faux succès.
        job.état = "echoue";
        job.erreur = `Fusion des signaux échouée : ${error instanceof Error ? error.message : "erreur"}`;
        job.terminéA = Date.now();
        return NextResponse.json(
          { success: false, error: job.erreur, jobId: job.jobId },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true, fusionné: false });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: `Retour de résultat rejeté : ${error instanceof Error ? error.message : "erreur"}`,
      },
      { status: 500 },
    );
  }
}

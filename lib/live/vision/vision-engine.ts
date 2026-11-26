/**
 * VISION ENGINE — orchestrateur de la vision réelle (mission GEN3IA LIVE
 * Phase 3, phase critique) : FRAME BUFFER → FRAME SELECTOR (ne pas analyser
 * systématiquement) → SCENE ANALYZER → TEMPORAL ANALYZER → description
 * visuelle complète pour le cerveau. Réutilise comprehension-multimodale
 * (mesures sharp réelles) et remplace l'INTÉRIEUR de vision-decider sans
 * changer son contrat (décision narrée par le moteur Gen3). Aucune mesure
 * inventée : ce qui n'est pas mesurable (OCR) est déclaré indisponible.
 */

import { analyserFrame, creerFrameBuffer, fabriqueGrilleSharp, type FrameAnalysable } from "./frame-selector";
import { analyserScene, type SceneStructurelle } from "./scene-analyzer";
import { analyserTemporalite, type AnalyseTemporelle } from "./temporal-analyzer";
import { lireTexte, type ResultatOcr } from "./ocr-engine";

export interface DescriptionVisuelle {
  /** Frame sélectionnée (le sélecteur a DÉCIDÉ d'analyser). */
  frame: FrameAnalysable;
  scene: SceneStructurelle;
  temporalite: AnalyseTemporelle;
  ocr: ResultatOcr;
  /** Mesures multimodales réelles (comprehension-multimodale) si activé. */
  mesuresImage?: { luminanceMoyenne: number; contraste: number; densiteBords: number };
  /** Interprétation bornée — uniquement à partir des mesures ci-dessus. */
  interpretation: string;
}

export interface VisionEngine {
  /** Traite une frame : sélection → analyse → contexte. Retourne null si ignorée. */
  traiter(jpeg: Buffer): Promise<DescriptionVisuelle | null>;
  /** Contexte visuel accumulé (mémoire temporelle). */
  contexte(): readonly FrameAnalysable[];
  reinitialiser(): void;
}

const globalVision = globalThis as typeof globalThis & { __gen3iaLiveVisionBuffers?: Map<string, ReturnType<typeof creerFrameBuffer>> };

function bufferPour(sessionId: string): ReturnType<typeof creerFrameBuffer> {
  if (!globalVision.__gen3iaLiveVisionBuffers) globalVision.__gen3iaLiveVisionBuffers = new Map();
  let b = globalVision.__gen3iaLiveVisionBuffers.get(sessionId);
  if (!b) {
    b = creerFrameBuffer();
    globalVision.__gen3iaLiveVisionBuffers.set(sessionId, b);
  }
  return b;
}

/** Fabrique par session (mémoire temporelle par session — isolation). */
export function creerVisionEngine(sessionId: string, options: { seuilChangement?: number } = {}): VisionEngine {
  const decoder = fabriqueGrilleSharp();
  const buffer = bufferPour(sessionId);
  return {
    async traiter(jpeg: Buffer): Promise<DescriptionVisuelle | null> {
      const frame = await analyserFrame(jpeg, buffer.derniere(), decoder, { seuilChangement: options.seuilChangement });
      if (!frame.selectionnee) return null; // mission : ne pas tout analyser
      buffer.ajouter(frame);
      const scene = analyserScene(frame);
      const temporalite = analyserTemporalite(buffer.frames());
      const ocr = await lireTexte(jpeg);
      // Mesures fines réelles (réutilisation comprehension-multimodale) :
      let mesuresImage: DescriptionVisuelle["mesuresImage"];
      try {
        const { comprendreImage } = await import("@/lib/neural/multimodal/comprehension-multimodale");
        const img = await comprendreImage(jpeg);
        if (img.comprise) mesuresImage = { luminanceMoyenne: img.luminanceMoyenne, contraste: img.contraste, densiteBords: img.densiteBords };
      } catch {
        /* mesures fines indisponibles : laisses absentes (honnête) */
      }
      const interpretation = [
        `frame analysée (${frame.raison})`,
        scene.interpretation,
        temporalite.contexte,
        ocr.disponible ? "" : "texte non lu (OCR local indisponible — déclaré, jamais inventé)",
      ].filter(Boolean).join(" — ");
      return { frame, scene, temporalite, ocr, mesuresImage, interpretation };
    },
    contexte: () => buffer.frames(),
    reinitialiser: () => {
      globalVision.__gen3iaLiveVisionBuffers?.delete(sessionId);
    },
  };
}

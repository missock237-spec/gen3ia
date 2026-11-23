import { z } from "zod";

import { editerArtefact, editerMediaParUrl, type TypeMédia } from "@/lib/artefacts/edition";
import type { ToolDefinition } from "@/lib/tools/types";

/**
 * OUTIL ARTEFACT.MODIFIER — gen3 MODIFIE une image, un audio ou une vidéo
 * selon la volonté de l'utilisateur exprimée en prompt (le même moteur que
 * le bouton « Modifier » de l'interface). Deux voies :
 *
 *   · `artefactId` — l'artefact EXISTANT est édité et une NOUVELLE VERSION
 *     est enregistrée (l'original reste dans l'historique, 50 versions) ;
 *   · `url` + `type` — un média du fil sans artefact (ex. image générée
 *     localement) est téléchargé, édité, puis enregistré comme NOUVEL
 *     artefact propriété de l'utilisateur.
 *
 * HONNÊTETÉ : les opérations sont réellement appliquées (sharp / PCM-WAV /
 * ffmpeg). Si le prompt ne correspond à aucune opération connue, l'outil
 * REFUSE en listant ce qu'il sait faire — il ne prétend jamais avoir
 * modifié sans avoir modifié.
 */

const modifierSchema = z.object({
  artefactId: z.string().min(1).max(200).optional(),
  url: z.string().url().max(2048).optional(),
  type: z.enum(["image", "audio", "video"]).optional(),
  prompt: z.string().min(2).max(1000),
  titre: z.string().max(200).optional(),
});

interface ModifierOutput {
  ok: boolean;
  artefactId: string;
  type?: TypeMédia;
  version?: number;
  operations?: Array<{ nom: string; libelle: string; valeur?: number }>;
  nonComprises?: string[];
  nouveauFichier?: string;
  details: string;
}

export const artefactModifierTool: ToolDefinition<z.infer<typeof modifierSchema>, ModifierOutput> = {
  id: "artefact.modifier",
  name: "artefact.modifier",
  description:
    "ÉDITION D'ARTEFACT PAR PROMPT — modifier RÉELLEMENT une image, un audio ou une vidéo créés : gen3 interprète la volonté de l'utilisateur (« pivoter à gauche, noir et blanc, luminosité +20 % », « volume −30 % puis fondu 2 s », « couper les 3 premières secondes, 720p ») et applique des transformations RÉELLES (sharp pour l'image, PCM/WAV pour l'audio, ffmpeg pour la vidéo). Passer `artefactId` pour éditer un artefact existant (nouvelle VERSION enregistrée, l'original reste dans l'historique) OU `url`+`type` pour éditer un média du fil (crée un nouvel artefact propriété de l'utilisateur). QUAND L'UTILISER : « modifie l'image que tu viens de créer », « rends cet audio plus fort », « coupe le début de cette vidéo ». Refuse honnêtement si aucune opération connue ne correspond au prompt (la liste des opérations supportées est renvoyée).",
  category: "media",
  risk: "medium",
  inputSchema: modifierSchema,
  async execute(input, contexte): Promise<ModifierOutput> {
    if (!input.artefactId && !input.url) {
      return {
        ok: false,
        artefactId: "",
        details: "Fournir `artefactId` (artefact existant) ou `url` + `type` (média du fil) pour l'édition.",
      };
    }
    if (input.artefactId) {
      const rapport = await editerArtefact({
        userId: contexte.userId,
        artefactId: input.artefactId,
        prompt: input.prompt,
      });
      return {
        ok: true,
        artefactId: rapport.artefactId,
        type: rapport.type,
        version: rapport.version,
        operations: rapport.operations,
        nonComprises: rapport.nonComprises,
        nouveauFichier: rapport.storagePath,
        details: `${rapport.note}${rapport.nonComprises.length > 0 ? ` Non compris (ignoré) : ${rapport.nonComprises.join(", ")}.` : ""} Version ${rapport.version} enregistrée — l'original reste dans l'historique.`,
      };
    }
    const rapport = await editerMediaParUrl({
      userId: contexte.userId,
      type: (input.type ?? "image") as TypeMédia,
      url: input.url as string,
      prompt: input.prompt,
      titre: input.titre,
    });
    return {
      ok: true,
      artefactId: rapport.artefactCree,
      type: rapport.type,
      version: rapport.version,
      operations: rapport.operations,
      nonComprises: rapport.nonComprises,
      nouveauFichier: rapport.storagePath,
      details: `${rapport.note} Nouvel artefact « ${rapport.artefactCree} » créé (téléchargeable), propriété de ce compte.`,
    };
  },
};

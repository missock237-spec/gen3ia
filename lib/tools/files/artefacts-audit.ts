import { z } from "zod";

import {
  listerArtefacts,
  lireArtefact,
  modifierArtefact,
  type FiltresArtefacts,
  type ResultatListing,
} from "@/lib/artefacts/audit";
import type { ToolDefinition } from "../types";

/**
 * artefacts.audit — AUDIT D'ARTEFACTS multi-conversations pour gen3.
 *
 * L'agent peut RETROUVER tout ce qu'il a créé (images, audios, rendus vidéo,
 * documents générés) ou ce que l'utilisateur a donné (pièces jointes importées,
 * documents convertis), LIRE leur contenu (conversion réelle pour le texte,
 * URL signée pour les médias) et MODIFIER un artefact (remplacement de
 * contenu, renommage, correction) — chaque modification crée une NOUVELLE
 * version, l'ancienne reste listable dans l'historique.
 *
 * Échecs honnêtes : artefact introuvable, accès refusé (barrière de propriété
 * stricte — isOwnedPermanentKey / isOwnedVideoKey du dépôt), remplacement de
 * contenu réservé aux documents/code. Les erreurs d'accès PAR SOURCE du
 * listing sont collectées et renvoyées (jamais silenciées).
 */

const inputSchema = z.object({
  action: z.enum(["lister", "lire", "modifier"]),
  /** Identifiant d'artefact retourné par l'action `lister` (requis pour lire/modifier). */
  id: z.string().trim().min(1).max(800).optional(),
  filtres: z
    .object({
      type: z.enum(["document", "image", "video", "audio", "archive", "code"]).optional(),
      origine: z.enum(["gen3", "utilisateur"]).optional(),
      conversationId: z.string().trim().min(1).max(200).optional(),
      recherche: z.string().trim().min(1).max(200).optional(),
      limite: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).max(10_000).optional(),
    })
    .optional(),
  /** NOUVEAU contenu textuel (action modifier — nouvelle version). */
  nouveauContenu: z.string().min(1).max(500_000).optional(),
  /** NOUVEAU nom affichable (action modifier — nouvelle version, clé R2 immuable). */
  nouveauNom: z.string().trim().min(1).max(180).optional(),
  /** Note libre attachée à la modification. */
  note: z.string().trim().min(1).max(500).optional(),
});

function formaterListe(listing: ResultatListing) {
  const resume =
    `${listing.total} artefact(s) correspondant(s)` +
    (listing.tronque ? " — liste TRONQUÉE (cap de scan atteint sur au moins une source)" : "") +
    (listing.erreurs.length > 0 ? ` — ${listing.erreurs.length} source(s) en échec (détail dans erreurs)` : "");
  return {
    success: true as const,
    action: "lister" as const,
    total: listing.total,
    tronque: listing.tronque,
    resume,
    erreurs: listing.erreurs,
    artefacts: listing.artefacts.map((artefact) => ({
      id: artefact.id,
      nom: artefact.nom,
      type: artefact.type,
      origine: artefact.origine,
      conversation: artefact.conversationTitre
        ? `${artefact.conversationTitre} (${artefact.conversationId})`
        : (artefact.conversationId ?? "(hors conversation connue)"),
      creeLe: artefact.creeLe,
      modifieLe: artefact.modifieLe,
      tailleOctets: artefact.tailleOctets,
      version: artefact.version,
      cleStockage: artefact.cleStockage,
    })),
  };
}

export const artefactsAuditTool: ToolDefinition = {
  id: "artefacts.audit",
  name: "artefacts.audit",
  description:
    "Audit des artefacts multi-conversations de l'utilisateur : lister tout ce que gen3 a créé (images, audios, vidéos, documents) ou que l'utilisateur a donné (imports, pièces jointes), lire un artefact (contenu converti ou URL signée), modifier un artefact (nouveau contenu / renommage / note) avec historique de versions — chaque modification crée une nouvelle version, l'ancienne reste listable.",
  category: "files",
  // `modifier` écrit un nouveau contenu (nouvelle version, jamais d'écrasement) : risque medium.
  risk: "medium",
  inputSchema,
  execute: async (input, context) => {
    const parsed = inputSchema.parse(input);

    if (parsed.action === "lister") {
      const filtres: FiltresArtefacts = {
        ...(parsed.filtres?.type ? { type: parsed.filtres.type } : {}),
        ...(parsed.filtres?.origine ? { origine: parsed.filtres.origine } : {}),
        ...(parsed.filtres?.conversationId ? { conversationId: parsed.filtres.conversationId } : {}),
        ...(parsed.filtres?.recherche ? { recherche: parsed.filtres.recherche } : {}),
        ...(parsed.filtres?.limite !== undefined ? { limite: parsed.filtres.limite } : {}),
        ...(parsed.filtres?.offset !== undefined ? { offset: parsed.filtres.offset } : {}),
      };
      return formaterListe(await listerArtefacts(context.userId, filtres));
    }

    if (!parsed.id) throw new Error(`Action ${parsed.action} : identifiant d'artefact requis (récupérez-le via l'action "lister").`);

    if (parsed.action === "lire") {
      const lecture = await lireArtefact(context.userId, parsed.id);
      return { success: true as const, action: "lire" as const, ...lecture };
    }

    // action === "modifier"
    const modification = await modifierArtefact(context.userId, parsed.id, {
      ...(parsed.nouveauContenu ? { nouveauContenu: parsed.nouveauContenu } : {}),
      ...(parsed.nouveauNom ? { nouveauNom: parsed.nouveauNom } : {}),
      ...(parsed.note ? { note: parsed.note } : {}),
    });
    return {
      success: true as const,
      action: "modifier" as const,
      artefactId: modification.id,
      version: modification.version,
      nom: modification.nom,
      cleStockage: modification.cleStockage,
      ancienneCle: modification.ancienneCle,
      raison: modification.raison,
      note: modification.note,
      modifieLe: modification.modifieLe,
      historiqueVersions: modification.historique,
    };
  },
};

/**
 * COLLABORATION — espace de travail partagé (mission LOT 8) : chat de
 * session, annotations partagées, pointeur partagé, partage de fichiers —
 * TOUS comme événements typés du BUS commun (un seul historique, un seul
 * bus : mission LOT 9) avec validation des rôles du session-manager
 * (observateur = lecture seule, jamais d'écriture). Fichiers : métadonnées
 * + capsule via file-capsule EXISTANT (services/live-agent) — pas de doublon.
 */

import { z } from "zod";

import { obtenirBusEvenements, type StoreEvenementsLive } from "../core/live-event-bus";
import type { RoleParticipant } from "../core/live-core-types";

const PointSchema = z.object({ x: z.number().min(0).max(100_000), y: z.number().min(0).max(100_000) });

export const ChatMessageSchema = z.object({ texte: z.string().trim().min(1).max(2000) });
export const AnnotationSchema = z.object({
  forme: z.enum(["rectangle", "cercle", "fleche", "libre"]),
  debut: PointSchema,
  fin: PointSchema,
  couleur: z.enum(["rouge", "vert", "bleu", "jaune"]),
  texte: z.string().max(200).optional(),
});
export const PointeurSchema = z.object({ ...PointSchema.shape });
export const FichierPartageSchema = z.object({
  nom: z.string().trim().min(1).max(255).refine((v) => !v.includes("\\") && !v.split("/").includes("..") && !v.includes("\0"), "nom de fichier dangereux"),
  tailleOctets: z.number().int().min(1).max(50_000_000),
  capsuleId: z.string().min(1).max(128),
});

export type Annotation = z.infer<typeof AnnotationSchema>;
export type FichierPartage = z.infer<typeof FichierPartageSchema>;

/** Permissions d'écriture par rôle (mission LOT 8 : rôles et permissions). */
export function peutEcrire(role: RoleParticipant): boolean {
  // Observateur = lecture seule (mission explicite). Agent : autorisé par
  // le propriétaire via les permissions de session (canal agent).
  return role !== "observateur";
}

export interface CollaborationLive {
  messageChat(de: string, role: RoleParticipant, texte: string): Promise<{ accepte: boolean; raison?: string }>;
  annoter(de: string, role: RoleParticipant, annotation: unknown): Promise<{ accepte: boolean; raison?: string }>;
  deplacerPointeur(de: string, position: unknown): Promise<{ accepte: boolean; raison?: string }>;
  partagerFichier(de: string, role: RoleParticipant, fichier: unknown): Promise<{ accepte: boolean; raison?: string }>;
  historiquePartage(limite?: number): Promise<Array<{ type: string; de?: string; charge?: unknown; horodatage: number }>>;
}

export function creerCollaborationLive(params: {
  sessionId: string;
  storeEvenements?: StoreEvenementsLive;
}): CollaborationLive {
  const bus = obtenirBusEvenements(params.storeEvenements);

  async function publier(type: string, de: string, role: RoleParticipant, charge: unknown): Promise<{ accepte: boolean; raison?: string }> {
    if (!peutEcrire(role)) {
      return { accepte: false, raison: `rôle « ${role} » en lecture seule — l'observateur ne peut pas écrire dans la session partagée (mission LOT 8)`, };
    }
    await bus.publier({ sessionId: params.sessionId, type, source: "participant", emetteur: de, charge });
    return { accepte: true };
  }

  return {
    async messageChat(de, role, texte) {
      const parse = ChatMessageSchema.safeParse({ texte });
      if (!parse.success) return { accepte: false, raison: "message invalide (vide ou > 2000 caractères)" };
      return publier("collab.chat", de, role, { texte: parse.data.texte });
    },
    async annoter(de, role, annotation) {
      const parse = AnnotationSchema.safeParse(annotation);
      if (!parse.success) return { accepte: false, raison: `annotation invalide : ${parse.error.issues[0]?.message ?? "format"}` };
      return publier("collab.annotation", de, role, parse.data);
    },
    async deplacerPointeur(de, position) {
      const parse = PointeurSchema.safeParse(position);
      if (!parse.success) return { accepte: false, raison: "position de pointeur invalide" };
      // Le pointeur est un flux haute fréquence : pas de rôle d'écriture
      // exigé au-delà de la présence (même un observateur a un pointeur).
      await bus.publier({ sessionId: params.sessionId, type: "collab.pointeur", source: "participant", emetteur: de, charge: parse.data });
      return { accepte: true };
    },
    async partagerFichier(de, role, fichier) {
      const parse = FichierPartageSchema.safeParse(fichier);
      if (!parse.success) return { accepte: false, raison: `fichier refusé : ${parse.error.issues[0]?.message ?? "format"}` };
      return publier("collab.fichier", de, role, parse.data);
    },
    async historiquePartage(limite = 100) {
      const tous = await bus.historique(params.sessionId, 500);
      return tous
        .filter((e) => e.type.startsWith("collab."))
        .slice(-limite)
        .map((e) => ({ type: e.type, de: e.emetteur, charge: e.charge, horodatage: e.horodatage }));
    },
  };
}

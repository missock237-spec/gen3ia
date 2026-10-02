import "server-only";

import { adminDb } from "@/lib/firebase/admin";

import { HttpError } from "@/lib/security/http-errors";
import { requireOrgContext, type OrgContext, type OrgRole } from "./organizations";

/**
 * Politique d'accès multi-tenant CENTRALISÉE (recommandation C de l'audit).
 *
 * Avant ce module, chaque ressource métier (agents, base de connaissances,
 * workflows) était cloisonnée par une vérification `ownerId === uid` isolée :
 * les organisations existaient (membres, rôles, quotas) sans qu'aucune
 * ressource ne puisse leur appartenir — le multi-tenant était un squelette.
 *
 * Désormais TOUTE ressource peut être personnelle (sans orgId, comportement
 * historique inchangé) ou rattachée à une organisation (orgId documenté).
 * La matrice d'accès est définie UNE fois ici et consommée par tous les
 * dépôts/routes — plus aucune décision d'accès dispersée :
 *
 *   - ressource personnelle : propriétaire seul (lecture + écriture) ;
 *   - ressource d'organisation :
 *       · owner de la ressource  → lecture + écriture (via "owner") ;
 *       · rôle org "owner"/"admin" → lecture + écriture (gestion d'équipe) ;
 *       · rôle org "member"      → lecture + exécution, PAS de gestion ;
 *       · non-membre             → aucun accès (404 anti-énumération côté
 *         routes : la dénégation est indiscernable d'une ressource absente).
 *
 * Le changement d'orgId (transfert) exige l'écriture sur la ressource ET
 * l'appartenance de l'organisation cible — jamais de rattachement à une org
 * dont l'appelant ne fait pas partie.
 */

const MEMBERSHIP_INDEX = "orgMemberships";
const MAX_USER_ORGS = 50;

export interface ResourceRef {
  ownerId: string;
  orgId?: string | null;
}

/** Origine de l'accès — journalisable pour l'audit de sécurité. */
export type AccessVia = "owner" | "org-owner" | "org-admin" | "org-member" | "none";

export interface ResourceAccess {
  read: boolean;
  write: boolean;
  via: AccessVia;
}

/**
 * Erreur d'accès typée : hérite de HttpError (convention API Gen3ia) pour
 * que errorStatus/errorCode la traduisent nativement (403 FORBIDDEN par
 * défaut) — aucune fuite de structure d'accès dans la réponse.
 */
export class ResourceAccessError extends HttpError {
  constructor(message: string, status: 403 | 400 | 404 = 403) {
    super(status, message, status === 400 ? "INVALID_REQUEST" : status === 404 ? "NOT_FOUND" : "FORBIDDEN");
    this.name = "ResourceAccessError";
  }
}

const READ_WRITE: ResourceAccess = { read: true, write: true, via: "owner" };

function orgAccess(role: OrgRole): ResourceAccess {
  if (role === "owner") return { read: true, write: true, via: "org-owner" };
  if (role === "admin") return { read: true, write: true, via: "org-admin" };
  return { read: true, write: false, via: "org-member" };
}

const NO_ACCESS: ResourceAccess = { read: false, write: false, via: "none" };

/**
 * Résout l'accès d'un utilisateur à une ressource (matrice ci-dessus).
 * Un seul get Firestore dans le pire cas (document de membership org) ;
 * l'appartenance personnelle et le rôle org sont lus dans le même aller.
 */
export async function resolveResourceAccess(userId: string, ref: ResourceRef): Promise<ResourceAccess> {
  if (!userId) return NO_ACCESS;
  if (ref.ownerId === userId) return READ_WRITE;
  const orgId = typeof ref.orgId === "string" ? ref.orgId.trim() : "";
  if (!orgId) return NO_ACCESS;
  try {
    const context = await requireOrgContext(userId, orgId);
    return orgAccess(context.role);
  } catch {
    // Org inexistante ou appelant non-membre : cloisonnement strict.
    return NO_ACCESS;
  }
}

export async function assertResourceRead(userId: string, ref: ResourceRef): Promise<ResourceAccess> {
  const access = await resolveResourceAccess(userId, ref);
  if (!access.read) {
    throw new ResourceAccessError("Ressource introuvable ou accès refusé.", 403);
  }
  return access;
}

export async function assertResourceWrite(userId: string, ref: ResourceRef): Promise<ResourceAccess> {
  const access = await resolveResourceAccess(userId, ref);
  if (!access.write) {
    // Un membre en lecture reçoit le même message qu'un étranger : la
    // dénégation ne révèle pas l'existence d'un niveau d'accès intermédiaire.
    throw new ResourceAccessError("Action réservée au propriétaire ou aux administrateurs.", 403);
  }
  return access;
}

/**
 * Garde de rattachement : l'appelant doit être membre (tous rôles) de
 * l'organisation cible AVANT qu'une ressource ne porte son orgId. Retourne
 * le contexte org (plan/role) pour les quotas éventuels du dépôt appelant.
 */
export async function assertOrgAttach(userId: string, orgId: string): Promise<OrgContext> {
  const clean = typeof orgId === "string" ? orgId.trim() : "";
  if (!clean) throw new ResourceAccessError("Identifiant d'organisation requis.", 400);
  try {
    return await requireOrgContext(userId, clean);
  } catch {
    throw new ResourceAccessError("Organisation introuvable ou accès refusé.", 403);
  }
}

/** Rattachement d'une orgId sur une ressource existante (transfert). */
export async function assertOrgTransfer(userId: string, resource: ResourceRef, targetOrgId: string | undefined): Promise<void> {
  if (targetOrgId === undefined) return; // pas de changement d'org
  const next = typeof targetOrgId === "string" ? targetOrgId.trim() : "";
  // Écrire sur la ressource courante est déjà exigé par le dépôt (policy
  // write) ; ici on valide la DESTINATION : vide = détachement (retour
  // personnel, droit de gestion requis), sinon appartenance de la cible.
  if (next) await assertOrgAttach(userId, next);
}

/**
 * Identifiants des organisations de l'utilisateur (index user→org, plafonné
 * au quota maximum du plan enterprise). Sert aux listes union
 * personnel + organisations sans requête de collection group.
 */
export async function listUserOrgIds(userId: string): Promise<string[]> {
  if (!userId) return [];
  const index = await adminDb.collection(MEMBERSHIP_INDEX)
    .where("userId", "==", userId).limit(MAX_USER_ORGS).get();
  const ids = index.docs
    .map((doc) => String(doc.data().orgId ?? "").trim())
    .filter((orgId) => orgId.length > 0);
  return [...new Set(ids)];
}

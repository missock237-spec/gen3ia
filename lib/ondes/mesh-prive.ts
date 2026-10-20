import "server-only";

/**
 * MESH PRIVÉ (Private Mesh) — « l'IA 100 % locale et décentralisée » du
 * plan Entreprise. Un parc de postes de l'entreprise forme un essaim
 * P2P fermé : aucun paquet d'ondes ne sort du parc, aucune donnée n'est
 * persistée (la signalisation reste volatile et ne relaie QUE les
 * enveloppes d'établissement WebRTC ; l'inférence reste entre pairs).
 *
 * L'admission repose sur un TICKET SIGNÉ (HMAC-SHA256) :
 *
 *  1. l'utilisateur authentifié (plan Entreprise, entitlement
 *     `private_mesh`) demande un ticket à /api/ondes/mesh/ticket ;
 *  2. le serveur signe {salle, uid, exp} — la salle est dérivée du
 *     compte (`mesh-<uid>`) : tous les postes du compte la rejoignent ;
 *  3. chaque enveloppe de signalisation portant une salle `mesh-*` doit
 *     présenter un ticket VALIDE (salle exacte, non expiré) ;
 *  4. sans ticket signé, un acteur extérieur — humain ou IA automatisée
 *     — ne peut ni publier ni lire dans la salle : refus 403.
 *
 * Le ticket est court (10 min) : une fuite éventuelle s'éteint seule.
 * Les salles mesh vivent dans un registre ISOLÉ de l'essaim public.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Durée de vie d'un ticket d'admission (ms) — courte par conception. */
export const TICKET_MESH_TTL_MS = 10 * 60 * 1000;

/** Version du format de ticket. */
const VERSION_TICKET = "v1";

interface ChargeTicket {
  /** Salle privée exacte (`mesh-<uid>`). */
  salle: string;
  /** Utilisateur bénéficiaire (traçabilité d'admission). */
  uid: string;
  /** Expiration (epoch ms). */
  exp: number;
}

/**
 * Clé de signature des tickets — dérivée comme les cookies de session
 * (lib/server/session-cookie.ts) : secret dédié si fourni
 * (MESH_SIGNING_KEY, >= 32 caractères), sinon dérivée de variables
 * d'environnement stables (aucun secret en dur, jamais).
 */
function cleSignature(): Buffer {
  const explicite = process.env.MESH_SIGNING_KEY?.trim();
  if (explicite) {
    return createHash("sha256").update(`gen3ia-mesh-ticket|${explicite}`).digest();
  }
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (sessionSecret) {
    return createHash("sha256").update(`gen3ia-mesh-ticket|${sessionSecret}`).digest();
  }
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL ?? "";
  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    "demo-gen3ia";
  return createHash("sha256").update(`gen3ia-mesh-ticket|${projectId}|${clientEmail}|${privateKey}`).digest();
}

function hmacTicket(charge: string): string {
  return createHmac("sha256", cleSignature()).update(charge).digest("hex");
}

/** Salle privée d'un compte : tous les postes du compte la rejoignent. */
export function salleMeshPour(uid: string): string {
  const empreinte = createHash("sha256").update(`mesh|${uid}`).digest("hex").slice(0, 24);
  return `mesh-${empreinte}`;
}

/** Crée un ticket d'admission signé pour la salle privée du compte. */
export function creerTicketMesh(uid: string, maintenant = Date.now()): { ticket: string; salle: string; expireDansMs: number } {
  const salle = salleMeshPour(uid);
  const charge: ChargeTicket = { salle, uid, exp: maintenant + TICKET_MESH_TTL_MS };
  const corps = Buffer.from(JSON.stringify(charge), "utf-8").toString("base64url");
  return { ticket: `${VERSION_TICKET}.${corps}.${hmacTicket(corps)}`, salle, expireDansMs: TICKET_MESH_TTL_MS };
}

export type VerdictTicket =
  | { valide: true; salle: string; uid: string }
  | { valide: false; raison: "format" | "signature" | "expire" };

/** Vérifie un ticket : format, signature (temps constant), expiration. */
export function verifierTicketMesh(ticket: unknown, maintenant = Date.now()): VerdictTicket {
  if (typeof ticket !== "string") return { valide: false, raison: "format" };
  const morceaux = ticket.split(".");
  if (morceaux.length !== 3 || morceaux[0] !== VERSION_TICKET) return { valide: false, raison: "format" };
  const [, corps, sceau] = morceaux;
  const attendu = hmacTicket(corps);
  const recu = Buffer.from(sceau, "hex");
  const attenduBuf = Buffer.from(attendu, "hex");
  if (recu.length !== attenduBuf.length || !timingSafeEqual(recu, attenduBuf)) {
    return { valide: false, raison: "signature" };
  }
  let charge: ChargeTicket;
  try {
    charge = JSON.parse(Buffer.from(corps, "base64url").toString("utf-8")) as ChargeTicket;
  } catch {
    return { valide: false, raison: "format" };
  }
  if (typeof charge.salle !== "string" || typeof charge.uid !== "string" || typeof charge.exp !== "number") {
    return { valide: false, raison: "format" };
  }
  if (charge.exp <= maintenant) return { valide: false, raison: "expire" };
  return { valide: true, salle: charge.salle, uid: charge.uid };
}

/**
 * Admission d'une requête de signalisation sur une salle privée :
 * le ticket doit être valide ET porter la salle EXACTE demandée
 * (empêche de rejouer un ticket d'une salle vers une autre).
 */
export function autoriserSalleMesh(salle: string, ticket: unknown, maintenant = Date.now()): VerdictTicket {
  const verdict = verifierTicketMesh(ticket, maintenant);
  if (!verdict.valide) return verdict;
  if (verdict.salle !== salle) return { valide: false, raison: "signature" };
  return verdict;
}

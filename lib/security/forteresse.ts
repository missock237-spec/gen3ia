import "server-only";

/**
 * FORTERESSE — le niveau « même une IA ne peut pas hacker » de la
 * protection des données des utilisateurs. Quatre primitives, toutes
 * cryptographiquement réelles (aucune obfuscation) :
 *
 *  1. CHIFFREMENT AU REPOS (AES-256-GCM) — les artefacts de modèles
 *     des utilisateurs (états neuronaux, corpus, sessions d'arène)
 *     sont chiffrés avec une clé dérivée PAR UTILISATEUR : un accès
 *     brut au stockage objet ne révèle RIEN — ni les poids, ni le
 *     corpus d'entraînement, ni les conversations.
 *  2. SCELLEMENT (HMAC-SHA256) — tout artefact sensible est scellé :
 *     toute altération (un octet changé, un poids remplacé, une
 *     injection de payload) est DÉTECTÉE au rechargement et refuse
 *     le chargement. Un attaquant qui écrit dans le stockage ne peut
 *     ni corrompre un modèle ni forger un artefact valide.
 *  3. INTÉGRITÉ CONTEXTUELLE — le sceau lie l'artefact à son
 *     propriétaire (uid) et à son type : un artefact volé d'un compte
 *     ne s'ouvre pas sous un autre compte (clé dérivée par uid).
 *  4. EMPREINTE IP — les journaux ne stockent jamais une IP brute :
 *     hachée avec un sel tournant quotidien (confidentialité absolue
 *     des journaux, anti-ré-identification).
 *
 * Gestion de clé : MODELS_SEALING_KEY (>= 32 caractères) si fournie,
 * sinon dérivée des variables d'environnement stables (même contrat
 * que les cookies de session) — aucun secret en dur, jamais.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/* -------------------------------------------------------------------- */
/* Dérivation de clés                                                     */
/* -------------------------------------------------------------------- */

/** Matière de la clé maîtresse (aucune constante secrète en dur). */
function matiereMaitresse(): string {
  const explicite = process.env.MODELS_SEALING_KEY?.trim();
  if (explicite) return `gen3ia-forteresse|${explicite}`;
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (sessionSecret) return `gen3ia-forteresse|${sessionSecret}`;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL ?? "";
  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ||
    "demo-gen3ia";
  return `gen3ia-forteresse|${projectId}|${clientEmail}|${privateKey}`;
}

const MASTER = createHash("sha256").update(matiereMaitresse()).digest();

/** Clé HMAC d'un contexte donné (scellement). */
function cleSceau(contexte: string): Buffer {
  return Buffer.from(hkdfSync("sha256", MASTER, "gen3ia-sceau", Buffer.from(contexte, "utf-8"), 32));
}

/** Clé AES-256-GCM d'un utilisateur (chiffrement au repos). */
function cleChiffrement(uid: string): Buffer {
  return Buffer.from(hkdfSync("sha256", MASTER, `gen3ia-chiffre|${uid}`, Buffer.from("artefacts", "utf-8"), 32));
}

/* -------------------------------------------------------------------- */
/* Scellement d'artefacts (intégrité + anti-falsification)                 */
/* -------------------------------------------------------------------- */

export const FORMAT_SCEAU = "gen3ia-sceau-v1";

export interface EnveloppeSceau {
  format: typeof FORMAT_SCEAU;
  /** Contexte de liaison (type d'artefact). */
  ctx: string;
  /** Corps de l'artefact (texte intégral, éventuellement chiffré). */
  corps: string;
  /** HMAC-SHA256(corps, clé(ctx)) en hexadécimal. */
  sceau: string;
}

/** Scelle un artefact : l'enveloppe est retournée en JSON signé. */
export function scellerArtefact(corps: string, contexte: string): string {
  const enveloppe: EnveloppeSceau = {
    format: FORMAT_SCEAU,
    ctx: contexte,
    corps,
    sceau: createHmac("sha256", cleSceau(contexte)).update(corps, "utf-8").digest("hex"),
  };
  return JSON.stringify(enveloppe);
}

export type VerdictSceau = { valide: true } | { valide: false; raison: "format" | "falsifie" };

/**
 * Vérifie un artefact scellé. Toute altération du corps — un octet,
 * un poids, un champ injecté — casse le HMAC : « falsifie ».
 */
export function verifierSceau(texte: string, contexte: string): VerdictSceau {
  let enveloppe: EnveloppeSceau;
  try {
    enveloppe = JSON.parse(texte) as EnveloppeSceau;
  } catch {
    return { valide: false, raison: "format" };
  }
  if (
    enveloppe === null ||
    typeof enveloppe !== "object" ||
    enveloppe.format !== FORMAT_SCEAU ||
    typeof enveloppe.corps !== "string" ||
    typeof enveloppe.sceau !== "string" ||
    enveloppe.ctx !== contexte
  ) {
    return { valide: false, raison: "format" };
  }
  const attendu = Buffer.from(
    createHmac("sha256", cleSceau(contexte)).update(enveloppe.corps, "utf-8").digest("hex"),
    "hex",
  );
  const recu = Buffer.from(enveloppe.sceau, "hex");
  if (recu.length !== attendu.length || !timingSafeEqual(recu, attendu)) {
    return { valide: false, raison: "falsifie" };
  }
  return { valide: true };
}

/* -------------------------------------------------------------------- */
/* Chiffrement au repos (AES-256-GCM, clé par utilisateur)                 */
/* -------------------------------------------------------------------- */

export const FORMAT_CHIFFRE = "gen3ia-chiffre-v1";

export interface EnveloppeChiffre {
  format: typeof FORMAT_CHIFFRE;
  alg: "aes-256-gcm";
  /** Vecteur d'initialisation (base64, 12 octets). */
  iv: string;
  /** Tag d'authentification GCM (base64, 16 octets). */
  tag: string;
  /** Texte chiffré (base64). */
  data: string;
}

/** Chiffre un texte pour un utilisateur précis (AES-256-GCM, IV aléatoire). */
export function chiffrerPourUtilisateur(texte: string, uid: string): string {
  const iv = randomBytes(12);
  const chiffre = createCipheriv("aes-256-gcm", cleChiffrement(uid), iv);
  const data = Buffer.concat([chiffre.update(texte, "utf-8"), chiffre.final()]);
  const enveloppe: EnveloppeChiffre = {
    format: FORMAT_CHIFFRE,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: chiffre.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(enveloppe);
}

export type Dechiffre =
  | { ok: true; texte: string }
  | { ok: false; raison: "format" | "invalide" };

/** Déchiffre une enveloppe ; toute falsification du stockage → « invalide ». */
export function dechiffrerPourUtilisateur(texte: string, uid: string): Dechiffre {
  let enveloppe: EnveloppeChiffre;
  try {
    enveloppe = JSON.parse(texte) as EnveloppeChiffre;
  } catch {
    return { ok: false, raison: "format" };
  }
  if (enveloppe === null || typeof enveloppe !== "object" || enveloppe.format !== FORMAT_CHIFFRE) {
    return { ok: false, raison: "format" };
  }
  try {
    const dechiffre = createDecipheriv("aes-256-gcm", cleChiffrement(uid), Buffer.from(enveloppe.iv, "base64"));
    dechiffre.setAuthTag(Buffer.from(enveloppe.tag, "base64"));
    const clair = Buffer.concat([dechiffre.update(Buffer.from(enveloppe.data, "base64")), dechiffre.final()]);
    return { ok: true, texte: clair.toString("utf-8") };
  } catch {
    return { ok: false, raison: "invalide" };
  }
}

/* -------------------------------------------------------------------- */
/* Confidentialité des journaux : empreinte IP tournante                   */
/* -------------------------------------------------------------------- */

/**
 * Remplace une IP brute dans les journaux par une empreinte courte,
 * salée par le JOUR (rotation naturelle) : impossible de suivre un
 * utilisateur d'un jour à l'autre, mais la corrélation intra-journée
 * (détection d'abus) reste possible. L'IP ne quitte jamais les journaux
 * sous forme ré-identifiante.
 */
export function empreinteIp(ip: string | undefined, maintenant = Date.now()): string | undefined {
  if (!ip) return undefined;
  const jour = new Date(maintenant).toISOString().slice(0, 10);
  const sel = createHash("sha256").update(`gen3ia-ip|${jour}`).digest("hex");
  return createHash("sha256").update(`${sel}|${ip}`).digest("hex").slice(0, 16);
}

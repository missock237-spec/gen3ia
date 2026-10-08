import { z } from "zod";

/**
 * Task 108-b — schéma de l'IDENTITÉ utilisateur (base de données R2).
 *
 * La base d'identités vit dans R2 sous `identities/{uid}.json` (un document
 * JSON par utilisateur, sérialisation canonique — voir r2-identity-store.ts).
 * Firebase Auth reste le mécanisme d'IDENTIFIANTS (connexion) ; R2 est la
 * SOURCE DE VÉRITÉ des identités/comptes (contrat lot 108-0).
 *
 * Le document est volontairement autonome (aucune référence Firestore) :
 * il se lit et se valide sans aucune autre dépendance que ce schéma zod.
 */

/**
 * Uids Firebase Auth : A-Za-z0-9_- (1..128). Revalidé par le store AVANT
 * toute composition de clé R2 — un uid hostile ("../x", "a/b", vide) ne
 * peut jamais produire une clé, donc jamais de traversée d'espace de clés.
 */
export const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const UID_SCHEMA = z
  .string()
  .regex(UID_PATTERN, "uid invalide (caractères autorisés : A-Z a-z 0-9 _ -).");

/** Date ISO 8601 du document (le serveur n'écrit que des toISOString()). */
const IsoDateTime = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "Date ISO invalide.",
);

/** Email : format vérifié + longueur RFC (5321) bornée. */
const Email = z.email().max(254);

/** Chaîne trimée bornée, nullable (les champs vides restent null). */
function boundedNullable(max: number) {
  return z.string().trim().max(max).nullable();
}

/**
 * Document d'identité complet — ce qui est STOCKÉ dans R2.
 * Les champs sans valeur restent explicitement `null` (pas d'absence) :
 * la forme du document est stable et diffable.
 */
export const IdentitySchema = z.object({
  uid: UID_SCHEMA,
  email: Email.nullable(),
  emailVerified: z.boolean().default(false),
  displayName: boundedNullable(120),
  firstName: boundedNullable(80),
  lastName: boundedNullable(80),
  username: boundedNullable(60),
  photoURL: z.url().max(2048).nullable(),
  phoneNumber: boundedNullable(32),
  country: boundedNullable(60),
  bio: boundedNullable(500),
  language: z.string().trim().max(30).default("fr"),
  timezone: z.string().trim().max(60).default("UTC"),
  /** CONTRAT lot 108-c : le thème persiste DANS l'identité (base R2). */
  theme: z.enum(["light", "dark"]).default("dark"),
  /** Fournisseurs de connexion vus (dédupliqués, plafonnés). */
  providers: z.array(z.string().trim().max(60)).max(10).default([]),
  plan: z.enum(["free", "pro", "enterprise"]).default("free"),
  role: z.enum(["user", "developer", "admin"]).default("user"),
  status: z.enum(["active", "disabled"]).default("active"),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastLoginAt: IsoDateTime,
  /** Version du format du document (migrations futures). */
  identityVersion: z.literal(1).default(1),
});

export type Identity = z.infer<typeof IdentitySchema>;

/**
 * Champs modifiables PAR L'UTILISATEUR (PUT /api/auth/profile) — tous
 * optionnels, AUCUN champ immutable dedans (email, role, plan, status,
 * providers, dates, uid : mutations serveur uniquement). `strictObject`
 * rejette tout champ inconnu ; les immutables sont filtrés AVANT le parse
 * par le service (voir updateIdentity) pour être ignorés, pas rejetés.
 * Le thème fait partie du contrat lot 108-c : { theme: "light" | "dark" }.
 */
export const IdentityPatchSchema = z.strictObject({
  displayName: boundedNullable(120).optional(),
  firstName: boundedNullable(80).optional(),
  lastName: boundedNullable(80).optional(),
  username: boundedNullable(60).optional(),
  photoURL: z.url().max(2048).nullable().optional(),
  phoneNumber: boundedNullable(32).optional(),
  country: boundedNullable(60).optional(),
  bio: boundedNullable(500).optional(),
  language: z.string().trim().max(30).optional(),
  timezone: z.string().trim().max(60).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

export type IdentityPatch = z.infer<typeof IdentityPatchSchema>;

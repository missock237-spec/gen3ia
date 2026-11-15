import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Chiffrement envelope AES-256-GCM des secrets au repos (secrets
 * d'extensions, secrets HMAC de webhooks sortants).
 *
 * - Clé maître : env SECRETS_ENVELOPE_KEY (passphrase ou base64), dérivée
 *   en clé AES-256 par hachage. Absente → le stockage reste en clair
 *   (comportement hérité) mais le déchiffrement reste compatible.
 * - Format : `enc:v1:<iv>:<tag>:<ciphertext>` (base64url) — le préfixe
 *   identifie la version de clé et autorise une rotation future.
 * - Compatibilité : toute valeur sans préfixe `enc:` est renvoyée telle
 *   quelle (secrets hérités écrits en clair).
 */

const PREFIX = "enc:v1:";

function masterKey(): Buffer | null {
  const raw = process.env.SECRETS_ENVELOPE_KEY?.trim();
  if (!raw) return null;
  // Accepte une passphrase quelconque ou une clé base64 (32 octets décodés).
  const decoded = Buffer.from(raw, "base64");
  return decoded.length === 32 ? decoded : createHash("sha256").update(raw, "utf8").digest();
}

/** Chiffre une valeur secrète. Sans clé maître configurée, renvoie la
 * valeur telle quelle (dégradation explicite, jamais de panne). */
export function encryptSecret(plain: string): string {
  const key = masterKey();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

/** Déchiffre une valeur stockée. Valeurs héritées (sans préfixe) renvoyées
 * telles quelles ; corruption détectée → erreur (jamais de valeur fausse). */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = masterKey();
  if (!key) throw new Error("Secret chiffré mais SECRETS_ENVELOPE_KEY absente — déchiffrement impossible.");
  const [ivPart, tagPart, dataPart] = stored.slice(PREFIX.length).split(":");
  if (!ivPart || !tagPart || !dataPart) throw new Error("Format de secret chiffré invalide.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]);
  return plain.toString("utf8");
}

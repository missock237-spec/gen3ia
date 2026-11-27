/**
 * PP NOISE — primitives cryptographiques éprouvées (node:crypto / OpenSSL).
 *
 * Aucun algorithme maison : DH = X25519 (RFC 7748), chiffrements =
 * ChaCha20-Poly1305 et AES-256-GCM, hachages = SHA-256 et BLAKE2s.
 * La conformité au Noise Protocol Framework (rev34) est prouvée par les
 * vecteurs de test officiels des implémentations de référence (cacophony
 * Go + snow Rust) — voir vectors/official-vectors.json et le test de garde.
 */

import crypto from "node:crypto";

export type CipherName = "ChaChaPoly" | "AESGCM";
export type HashName = "SHA256" | "BLAKE2s";

export const CIPHER_ALGORITHMS: Record<CipherName, string> = {
  ChaChaPoly: "chacha20-poly1305",
  AESGCM: "aes-256-gcm",
};

export const HASH_LENGTHS: Record<HashName, number> = {
  SHA256: 32,
  BLAKE2s: 32,
};

const CIPHER_KEY_LENGTH = 32;
const MAC_LENGTH = 16;
const NONCE_LENGTH = 12;
const DH_LENGTH = 32;

/** Préfixe PKCS#8 DER d'une clé privée X25519 (RFC 8410). */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** Paire X25519 : clé publique brute 32 octets + KeyObject privé (non exporté hors du processus). */
export interface DhKeyPair {
  publicKey: Buffer;
  privateKey: crypto.KeyObject;
}

/** Clé privée X25519 depuis un scalaire brut 32 octets (vecteurs officiels). */
export function x25519FromScalar(scalar: Uint8Array): DhKeyPair {
  const der = Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(scalar)]);
  const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { privateKey, publicKey: x25519PublicKeyOf(privateKey) };
}

/** Paire X25519 fraîche (clé éphémère). */
export function x25519Generate(): DhKeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  return { privateKey, publicKey: Buffer.from(publicKey.export({ type: "spki", format: "der" }).subarray(12)) };
}

/** Clé publique brute (32 octets) d'une clé privée X25519. */
export function x25519PublicKeyOf(privateKey: crypto.KeyObject): Buffer {
  const spki = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
  return Buffer.from(spki.subarray(spki.length - DH_LENGTH));
}

/** DH X25519 : secret partagé brut de 32 octets. */
export function x25519Dh(privateKey: crypto.KeyObject, peerPublicKey: Uint8Array): Buffer {
  const peer = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(peerPublicKey)]),
    format: "der",
    type: "spki",
  });
  return crypto.diffieHellman({ privateKey, publicKey: peer });
}

/**
 * Nonce Noise de 12 octets : 4 octets nuls + compteur 64 bits.
 * · ChaChaPoly : little-endian (rev34 §12.2).
 * · AESGCM : big-endian — convention des implémentations de référence
 *   (snow §CipherAesGcm, cacophony) maintenue pour l'interopérabilité avec
 *   les vecteurs officiels ; les deux encodages coïncident au nonce 0.
 */
function nonceBytes(algorithm: CipherName, counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_LENGTH);
  if (algorithm === "ChaChaPoly") nonce.writeBigUInt64LE(counter, 4);
  else nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

/** Chiffrement AEAD : ciphertext || tag 16 octets. */
export function aeadEncrypt(algorithm: CipherName, key: Uint8Array, counter: bigint, aad: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = crypto.createCipheriv(CIPHER_ALGORITHMS[algorithm] as crypto.CipherGCMTypes, Buffer.from(key), nonceBytes(algorithm, counter), { authTagLength: MAC_LENGTH });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

/** Déchiffrement AEAD — lève sur toute altération (tag invalide). */
export function aeadDecrypt(algorithm: CipherName, key: Uint8Array, counter: bigint, aad: Uint8Array, ciphertextAndTag: Uint8Array): Buffer {
  const data = Buffer.from(ciphertextAndTag);
  const ciphertext = data.subarray(0, data.length - MAC_LENGTH);
  const tag = data.subarray(data.length - MAC_LENGTH);
  const decipher = crypto.createDecipheriv(CIPHER_ALGORITHMS[algorithm] as crypto.CipherGCMTypes, Buffer.from(key), nonceBytes(algorithm, counter), { authTagLength: MAC_LENGTH });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function hashBytes(name: HashName, data: Uint8Array): Buffer {
  return crypto.createHash(name === "SHA256" ? "sha256" : "blake2s256").update(Buffer.from(data)).digest();
}

/** HMAC-Hash utilisé par le HKDF Noise (§4.3). */
function hmac(key: Uint8Array, data: Uint8Array, name: HashName): Buffer {
  return crypto.createHmac(name === "SHA256" ? "sha256" : "blake2s256", Buffer.from(key)).update(Buffer.from(data)).digest();
}

/**
 * HKDF du protocole Noise (rev34 §4.3) — PAS le HKDF RFC 5869 :
 * output_i = HMAC(temp_key, output_{i-1} || i), temp_key = HMAC(ck, ikm).
 */
export function noiseHkdf(chainingKey: Uint8Array, ikm: Uint8Array, numOutputs: 2 | 3, name: HashName): Buffer[] {
  const tempKey = hmac(chainingKey, ikm, name);
  const output1 = hmac(tempKey, Buffer.from([0x01]), name);
  const outputs = [output1];
  if (numOutputs >= 2) outputs.push(hmac(tempKey, Buffer.concat([output1, Buffer.from([0x02])]), name));
  if (numOutputs === 3) outputs.push(hmac(tempKey, Buffer.concat([outputs[1], Buffer.from([0x03])]), name));
  return outputs;
}

/** Génération d'une clé Ed25519 (identité matérielle simulée côté test) — signature uniquement. */
export function ed25519Generate(): { publicKey: Buffer; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: Buffer.from(publicKey.export({ type: "spki", format: "der" }).subarray(12)),
  };
}

export function ed25519Sign(privateKey: crypto.KeyObject, data: Uint8Array): Buffer {
  return crypto.sign(null, Buffer.from(data), privateKey);
}

/**
 * Vérification Ed25519 depuis une clé publique BRUTE (32 octets).
 * Passe par WebCrypto : crypto.verify(null, …) rejette les clés
 * reconstruites depuis le DER (« operation not supported ») alors que la
 * primitive SubtleCrypto les accepte — même chemin que les navigateurs.
 * Renvoie false (jamais d'exception) sur toute signature invalide.
 */
export async function ed25519Verify(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", Buffer.from(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await globalThis.crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(signature), Buffer.from(data));
  } catch {
    return false;
  }
}

/** Empreinte hexadécimale — identifiant PeerID du registre PP. */
export function hex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

export function unhex(text: string): Buffer {
  return Buffer.from(text, "hex");
}

export const MAX_NONCE = 0xffffffffffffffffn;
export const CIPHER_KEY_BYTES = CIPHER_KEY_LENGTH;

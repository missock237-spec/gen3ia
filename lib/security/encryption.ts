import "server-only";

import crypto from "crypto";

import { adminDb } from "@/lib/firebase/admin";

/**
 * CHIFFREMENT SYMÉTRIQUE DES CLÉS API UTILISATEUR (AES-256-GCM).
 *
 * Correctif d'intégration (Task 127) : le module d'origine (commit 81f9c8f)
 * ne compilait pas (ENCRYPTION_KEY possiblement undefined, noms `db` et
 * `provider` non définis). L'INTENTION est conservée — chiffrement AES-GCM
 * au repos + stockage Firestore par fournisseur — avec les conventions du
 * projet : import "server-only", adminDb (moteur r2fs), erreurs actionnables.
 *
 * ⚠️ Convention « secrets jamais en clair » : toute clé d'API utilisateur
 * doit passer par encrypt() AVANT toute persistance.
 */

/** Clé de chiffrement 32 octets hex (ENCRYPTION_KEY) — résolue à l'usage. */
function encryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      "ENCRYPTION_KEY absente ou invalide (64 caractères hex attendus) — le chiffrement des clés API est indisponible.",
    );
  }
  return Buffer.from(raw, "hex");
}

const IV_LENGTH = 16;

/** Chiffre un secret : sortie « iv:authTag:chiffré » (hex). */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/** Déchiffre une sortie de encrypt() — lève si le tag ne correspond pas. */
export function decrypt(encryptedText: string): string {
  const [ivHex, authTagHex, encryptedHex] = encryptedText.split(":");
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Format chiffré invalide (iv:authTag:chiffré attendu).");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Stocke une clé d'API utilisateur CHIFFRÉE, par fournisseur
 * (integrations.apiKeys.<provider> sur le document utilisateur).
 */
export async function storeUserApiKey(userId: string, provider: string, apiKey: string): Promise<void> {
  const encrypted = encrypt(apiKey);
  await adminDb
    .collection("users")
    .doc(userId)
    .set(
      {
        integrations: {
          apiKeys: {
            [provider]: { value: encrypted, createdAt: new Date().toISOString() },
          },
        },
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
}

/** Relit et déchiffre la clé d'API d'un fournisseur (null si absente). */
export async function loadUserApiKey(userId: string, provider: string): Promise<string | null> {
  const snap = await adminDb.collection("users").doc(userId).get();
  if (!snap.exists) return null;
  const data = snap.data() as { integrations?: { apiKeys?: Record<string, { value?: string }> } };
  const stored = data.integrations?.apiKeys?.[provider]?.value;
  return typeof stored === "string" && stored.includes(":") ? decrypt(stored) : null;
}

/**
 * PP SERVEUR — démarrage du nœud système INSIDE le serveur Gen3.
 *
 * C'est la connexion RÉELLE au serveur de Gen3 : le nœud système PP vit dans
 * le MÊME processus que l'application Next.js (instrumentation.ts) — le
 * cerveau, les outils et les moteurs sont appelés EN PROCESSUS, sans réseau
 * interne. Activé par PP_SYSTEM_NODE_ENABLED=1 (Hyperlift/cPanel : variables
 * d'environnement via le bundle GEN3IA_DOTENV).
 *
 * Variables :
 *  · PP_SYSTEM_NODE_ENABLED=1   — démarre le nœud système PP au boot ;
 *  · PP_SYSTEM_NODE_PORT=7601   — port du tunnel WebSocket PP ;
 *  · PP_SEAL_SECRET             — secret d'injection (RAM scellée, plan §4) ;
 *  · PP_REGISTRY_PATH           — chemin du registre JSON 0600 (persistance).
 *
 * Clé de transport stable : dérivée du PP_SEAL_SECRET (HKDF-SHA256, domaine
 * « pp-transport-static-v1 ») — l'identité du serveur survit aux redémarrages
 * sans stockage disque ; sans PP_SEAL_SECRET, clé éphémère par boot
 * (ré-enrôlement requis — comportement documenté, jamais masqué).
 */

import crypto from "node:crypto";

import { TrustRegistry } from "@/lib/pp/registry/trust-registry";
import { getTrustRegistry } from "@/lib/pp/server/signaling-store";
import { x25519FromScalar, hashBytes, noiseHkdf } from "@/lib/pp/noise/suite";
import { createGen3SystemNode, type Gen3SystemNode } from "@/lib/pp/server/system-node";

const globalBoot = globalThis as unknown as { __ppSystemNode?: Gen3SystemNode; __ppTransportStatic?: { publicKey: Buffer; privateKey: crypto.KeyObject } };

/** Clé de transport statique stable (dérivée du secret d'injection). */
function deriveTransportStaticKey(sealSecret: string): { publicKey: Buffer; privateKey: crypto.KeyObject } {
  const [ikm] = noiseHkdf(hashBytes("SHA256", Buffer.from(sealSecret)), Buffer.from("pp-transport-static-v1"), 2, "SHA256");
  return x25519FromScalar(ikm);
}

export function systemNodeTransportStaticPub(): string | null {
  if (globalBoot.__ppTransportStatic) return globalBoot.__ppTransportStatic.publicKey.toString("hex");
  const sealSecret = process.env.PP_SEAL_SECRET;
  if (!sealSecret) return null;
  globalBoot.__ppTransportStatic = deriveTransportStaticKey(sealSecret);
  return globalBoot.__ppTransportStatic.publicKey.toString("hex");
}

/** Démarrage idempotent (appelé par instrumentation.ts register()). */
export async function demarrerNoeudSystemePp(): Promise<{ started: boolean; peerId?: string; port?: number; raison?: string }> {
  if (process.env.PP_SYSTEM_NODE_ENABLED !== "1") {
    return { started: false, raison: "PP_SYSTEM_NODE_ENABLED≠1 — nœud système PP non démarré (documenté)" };
  }
  if (globalBoot.__ppSystemNode) {
    return { started: true, peerId: globalBoot.__ppSystemNode.peerId, port: globalBoot.__ppSystemNode.boundPort };
  }
  const sealSecret = process.env.PP_SEAL_SECRET;
  const staticKeyPair = sealSecret ? deriveTransportStaticKey(sealSecret) : undefined;
  const node = createGen3SystemNode({
    port: Number(process.env.PP_SYSTEM_NODE_PORT || 7601),
    systemUserId: "pp-system-node",
    allowSealedFallback: Boolean(sealSecret),
    sealSecret,
    sealStoragePath: process.env.PP_IDENTITY_SEAL_PATH,
    ...(staticKeyPair ? { identityOverride: staticKeyPair } : {}),
  });
  await node.start();
  globalBoot.__ppSystemNode = node;
  console.log(`[PP] nœud système Gen3 démarré — peerId ${node.peerId.slice(0, 16)}… tunnel ws://0.0.0.0:${node.boundPort} suite ChaChaPoly/SHA256`);
  return { started: true, peerId: node.peerId, port: node.boundPort };
}

/** Arrêt propre (tests, arrêt du conteneur). */
export async function arreterNoeudSystemePp(): Promise<void> {
  await globalBoot.__ppSystemNode?.stop();
  globalBoot.__ppSystemNode = undefined;
}

/** Accès au registre partagé (routes REST + nœud système). */
export function registrePp(): TrustRegistry {
  return getTrustRegistry();
}

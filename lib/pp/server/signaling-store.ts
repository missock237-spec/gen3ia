/**
 * PP SIGNALISATION — instance partagée du registre de confiance.
 *
 * Un seul registre par processus serveur : les routes Next.js (administration
 * REST) et le nœud système PP (tunnels) partagent le MÊME état — une révocation
 * faite au tableau de bord coupe les tunnels vivants immédiatement (plan §3).
 * Stockage : fichier JSON 0600 si PP_REGISTRY_PATH est défini (conteneur
 * persistant Hyperlift / cPanel), sinon mémoire (démonstration, tests).
 */

import { FileRegistryStorage, TrustRegistry } from "@/lib/pp/registry/trust-registry";

const globalStore = globalThis as unknown as { __ppTrustRegistry?: TrustRegistry };

export function getTrustRegistry(): TrustRegistry {
  if (!globalStore.__ppTrustRegistry) {
    const storagePath = process.env.PP_REGISTRY_PATH;
    globalStore.__ppTrustRegistry = new TrustRegistry(storagePath ? new FileRegistryStorage(storagePath) : undefined);
  }
  return globalStore.__ppTrustRegistry;
}

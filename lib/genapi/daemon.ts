import "server-only";

import { resilientQuery, writeCheckpointSet } from "@/lib/db/firestore-resilient";

import { caDisponible } from "@/lib/genapi/openssl";
import { journaliser, provisionnerClient } from "@/lib/genapi/provisionnement";
import { creerServeurGenAPI } from "@/lib/genapi/serveur";

/**
 * genAPI — MASTER DAEMON (l'administrateur réseau invisible).
 *
 * Boucle autonome du système d'exploitation gen3, exécutée sous PM2 sur le
 * VPS souverain AlmaLinux (PAS sur Vercel) :
 *   - chaque cycle scanne `genapiDemandes` (statut « nouveau ») →
 *     provisionnerClient (clé OpenSSL + certificat CA + empreinte allowlist
 *     + paquet usage unique + autodestruction de la clé privée) → la
 *     demande est marquée « traitee » (ou « echec » avec le motif) ;
 *   - au démarrage, monte le serveur gRPC mTLS si la CA racine gen3 est
 *     disponible (port GENAPI_GRPC_PORT, défaut 9443) ;
 *   - cyclesMax/once bornent la boucle pour les tests et les sondes —
 *     JAMAIS de boucle infinie en test.
 */

/** Options de la boucle daemon (bornes pour tests/sondes). */
export interface OptionsDaemonGenAPI {
  /** Pause entre cycles en mode boucle (défaut 5 000 ms, plancher 250 ms). */
  intervalleMs?: number;
  /** Nombre maximal de cycles (tests/sondes) — défaut : boucle infinie. */
  cyclesMax?: number;
  /** Un unique cycle puis retour (équivalent cyclesMax = 1). */
  once?: boolean;
  /** Monter le serveur gRPC mTLS au démarrage (défaut false). */
  demarrerServeur?: boolean;
}

/** Rapport d'une exécution de la boucle daemon. */
export interface RapportDaemonGenAPI {
  cycles: number;
  provisions: number;
  serveurPort?: number;
}

/** Serveur gRPC monté par le daemon (singleton process — jamais deux binds). */
let serveurActif: { arreter: () => Promise<void>; port: number } | null = null;

/** Drapeau d'arrêt gracieux (SIGINT/SIGTERM → le cycle courant se termine). */
let arretDemande = false;

/** Demande l'arrêt gracieux de la boucle (appelée par le script sur signal). */
export function demanderArretGenAPI(): void {
  arretDemande = true;
}

/** Arrête proprement le serveur gRPC monté (utile aux tests/arrêts signaux). */
export async function arreterServeurGenAPI(): Promise<void> {
  if (serveurActif) {
    const serveur = serveurActif;
    serveurActif = null;
    await serveur.arreter();
    await journaliser("serveur_arrete", `gRPC mTLS arrêté (port ${serveur.port}).`);
  }
}

/** Montage du serveur gRPC mTLS (idempotent : un seul bind par process). */
async function monterServeurSiPossible(): Promise<number | undefined> {
  if (serveurActif) return serveurActif.port;
  if (!(await caDisponible())) {
    await journaliser(
      "serveur_non_demarre",
      "CA racine gen3 indisponible : le serveur gRPC mTLS n'est pas monté (vérifier GENAPI_CA_KEY_PATH/GENAPI_CA_CERT_PATH).",
    );
    return undefined;
  }
  const port = Number(process.env.GENAPI_GRPC_PORT ?? 9443) || 9443;
  const gen = await creerServeurGenAPI({
    port,
    cheminCaCert: process.env.GENAPI_CA_CERT_PATH?.trim() || "/etc/gen3ia/genapi/ca.crt",
  });
  const portReel = await gen.demarrer();
  serveurActif = { arreter: gen.arreter, port: portReel };
  await journaliser("serveur_demarre", `Serveur gRPC mTLS gen3 en écoute sur 0.0.0.0:${portReel}.`);
  return portReel;
}

/**
 * Boucle maîtresse du daemon. Traitement d'un cycle :
 * genapiDemandes(statut « nouveau ») → provisionnement → marquage.
 */
export async function boucleDaemonGenAPI(
  options: OptionsDaemonGenAPI = {},
): Promise<RapportDaemonGenAPI> {
  const intervalleMs = Math.max(250, Math.floor(options.intervalleMs ?? 5_000));
  const cyclesCible = options.once ? 1 : Math.max(1, Math.floor(options.cyclesMax ?? Number.POSITIVE_INFINITY));

  let cycles = 0;
  let provisions = 0;
  let serveurPort: number | undefined;
  arretDemande = false;

  if (options.demarrerServeur) {
    try {
      serveurPort = await monterServeurSiPossible();
    } catch (erreur: unknown) {
      await journaliser(
        "serveur_demarrage_ko",
        `Montage du serveur gRPC impossible : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
      );
    }
  }

  while (cycles < cyclesCible && !arretDemande) {
    cycles += 1;
    try {
      const demandes = await resilientQuery<Record<string, unknown>>(
        "genapiDemandes",
        [{ field: "statut", value: "nouveau" }],
        { limit: 20, includeIds: true },
      );
      for (const demande of demandes) {
        const uid = String(demande.uid ?? "").trim();
        const email = String(demande.email ?? "").trim();
        const idDemande = String((demande as { id?: string }).id ?? uid);
        if (!uid || !email) {
          await writeCheckpointSet("genapiDemandes", idDemande, {
            statut: "echec",
            erreur: "Demande incomplète (uid/email manquants).",
            traiteeA: new Date().toISOString(),
          });
          continue;
        }
        const resultat = await provisionnerClient({ uid, email, trigger: "daemon" });
        if (resultat.ok) provisions += 1;
        await writeCheckpointSet("genapiDemandes", idDemande, {
          statut: resultat.ok ? "traitee" : "echec",
          ...(resultat.ok ? { jetonEmisA: new Date().toISOString() } : { erreur: resultat.erreur ?? "Erreur inconnue." }),
          traiteeA: new Date().toISOString(),
        });
      }
    } catch (erreur: unknown) {
      await journaliser(
        "daemon_cycle_ko",
        `Cycle ${cycles} interrompu : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
      );
    }
    if (cycles < cyclesCible) {
      await new Promise((resolve) => setTimeout(resolve, intervalleMs));
    }
  }

  return { cycles, provisions, ...(serveurPort !== undefined ? { serveurPort } : {}) };
}

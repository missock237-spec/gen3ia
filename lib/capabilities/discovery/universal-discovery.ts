/**
 * UNIVERSAL DISCOVERY (UCE-001) — orchestrateur de découverte multi-sources.
 *
 * Interroge en parallèle les adaptateurs réels (npm, PyPI, GitHub, Hugging
 * Face, MCP, APIs), DÉDUPLIQUE (hash source+nom+version), normalise chaque
 * découverte en fiche + enregistre : CapabilityDiscovery (collection
 * cap_discoveries) et Capability au statut « decouverte » — qui N'EST PAS
 * exécutable (mission §8 : découvrir ≠ autoriser).
 *
 * Les découvertes sont des DONNÉES : jamais injectées dans les instructions
 * du cerveau central, jamais exécutées sans le cycle complet d'évaluation.
 */

import "server-only";

import {
  construireCapabilityId,
  maintenantIso,
  type CapabilityDiscovery,
  type DiscoverySource,
} from "../core/capability-contract";
import { decouvrirNpm } from "./npm-discovery";
import { decouvrirPypiParNom } from "./pypi-discovery";
import { decouvrirGithub } from "./github-discovery";
import { decouvrirModeles } from "./model-discovery";
import { decouvrirMcp } from "./mcp-discovery";
import { decouvrirApis } from "./api-discovery";
import { obtenirGestionnaireCapacites } from "../core/capability-manager";
import { sauvegarder } from "../storage/capability-repository";
import { refuserSiSecret } from "../security/secrets-protection";

export const SOURCES_DISPONIBLES: DiscoverySource[] = ["npm", "pypi", "github", "huggingface", "mcp", "api"];

export interface OptionsDecouverteUniverselle {
  requete: string;
  sources?: DiscoverySource[];
  limiteParSource?: number;
  /** Requêtes PyPI nommées exactes (ex. ["requests","numpy"]). */
  nomsPypi?: string[];
  /** Persister les fiches + capacités (défaut : true). */
  persister?: boolean;
  dossier?: string;
}

export interface RapportDecouverte {
  requete: string;
  sources: Record<string, { statut: string; cause?: string; nombre: number }>;
  fiches: CapabilityDiscovery[];
  capacitesCreees: string[];
  totalDecouvertes: number;
  doublonsIgnores: number;
  dureeMs: number;
}

/** Lance la découverte universelle et enregistre les résultats. */
export async function decouvrirUniversellement(options: OptionsDecouverteUniverselle): Promise<RapportDecouverte> {
  const debut = Date.now();
  const sources = options.sources ?? SOURCES_DISPONIBLES;
  const limite = options.limiteParSource ?? 3;

  const taches: Array<{ source: DiscoverySource; promesse: Promise<{ statut: string; cause?: string; fiches: CapabilityDiscovery[] }> }> = [];
  if (sources.includes("npm")) taches.push({ source: "npm", promesse: decouvrirNpm(options.requete, limite) });
  if (sources.includes("github")) taches.push({ source: "github", promesse: decouvrirGithub(options.requete, limite) });
  if (sources.includes("huggingface")) taches.push({ source: "huggingface", promesse: decouvrirModeles(options.requete, limite) });
  if (sources.includes("mcp")) taches.push({ source: "mcp", promesse: decouvrirMcp(options.requete, limite) });
  if (sources.includes("api")) {
    taches.push({
      source: "api",
      promesse: Promise.resolve(decouvrirApis(options.requete, limite)),
    });
  }
  for (const nom of options.nomsPypi ?? []) {
    taches.push({ source: "pypi", promesse: decouvrirPypiParNom(nom) });
  }

  const resultats = await Promise.allSettled(taches.map((t) => t.promesse));
  const parSource: RapportDecouverte["sources"] = {};
  const toutes: CapabilityDiscovery[] = [];
  const vus = new Set<string>();
  let doublons = 0;

  for (let i = 0; i < taches.length; i++) {
    const source = taches[i].source;
    const r = resultats[i];
    if (r.status === "fulfilled") {
      parSource[source] = { statut: r.value.statut, cause: r.value.cause, nombre: r.value.fiches.length };
      for (const fiche of r.value.fiches) {
        if (vus.has(fiche.id)) {
          doublons++;
          continue;
        }
        vus.add(fiche.id);
        toutes.push(fiche);
      }
    } else {
      parSource[source] = { statut: "indisponible", cause: String(r.reason).slice(0, 200), nombre: 0 };
    }
  }

  // Persistance : fiches + capacités au statut « decouverte » (non exécutable).
  const capacitesCreees: string[] = [];
  if (options.persister !== false) {
    const gestionnaire = obtenirGestionnaireCapacites({ dossier: options.dossier });
    for (const fiche of toutes) {
      const garde = refuserSiSecret(JSON.stringify(fiche));
      if (!garde.autorise) continue; // fiche contaminée par un secret : jamais persistée
      try {
        await sauvegarder("discoveries", fiche, { dossier: options.dossier });
        const capacite = await gestionnaire.enregistrerCapacite({
          id: construireCapabilityId("decouverte", fiche.source, fiche.nom),
          kind: fiche.kind,
          origin: "decouverte",
          card: {
            nom: fiche.nom,
            description: fiche.description,
            fonctionnalites: fiche.fonctionnalites,
            source: fiche.source,
            url: fiche.url,
            licence: fiche.licence,
            dependances: fiche.dependances,
            cout: fiche.cout,
            exigences: fiche.exigences,
            risques: fiche.risques,
            verifieLe: fiche.verifieLe,
          },
          version: fiche.version,
          statutInitial: "decouverte",
        });
        capacitesCreees.push(capacite.id);
      } catch (erreur) {
        // Une fiche ratée n'arrête jamais la découverte globale (rapport honnête).
        parSource[fiche.source].cause = `persistance échouée : ${erreur instanceof Error ? erreur.message : String(erreur)}`;
      }
    }
  }

  return {
    requete: options.requete,
    sources: parSource,
    fiches: toutes,
    capacitesCreees,
    totalDecouvertes: toutes.length,
    doublonsIgnores: doublons,
    dureeMs: Date.now() - debut,
  };
}

/** Estampille de fraîcheur d'une découverte (contrôle d'obsolescence). */
export function ageVerificationJours(fiche: Pick<CapabilityDiscovery, "verifieLe">, maintenant = maintenantIso()): number {
  return Math.max(0, Math.floor((Date.parse(maintenant) - Date.parse(fiche.verifieLe)) / 86_400_000));
}

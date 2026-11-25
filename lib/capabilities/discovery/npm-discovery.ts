/**
 * NPM DISCOVERY (UCE-001) — découverte réelle dans le registre npm.
 * Recherche (GET /-/v1/search) puis fiches détaillées (GET /<nom>) :
 * licence, dépréciation, mots-clés, dépendances — données brutes honnêtes,
 * aucun contenu inventé (statut indisponible si le registre répond mal).
 */

import "server-only";

import {
  cleDeduplication,
  maintenantIso,
  type CapabilityDiscovery,
} from "../core/capability-contract";
import { sanitiserTexte } from "../security/secrets-protection";

const TIMEOUT_MS = 8_000;
const PLAFOND = 20;

export interface ResultatRechercheNpm {
  statut: "ok" | "indisponible";
  cause?: string;
  fiches: CapabilityDiscovery[];
}

/** Recherche npm réelle + enrichissement manifeste du top candidats. */
export async function decouvrirNpm(requete: string, limite = 5): Promise<ResultatRechercheNpm> {
  const limiteBornee = Math.max(1, Math.min(limite, PLAFOND));
  try {
    const reponse = await fetch(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(requete)}&size=${limiteBornee}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } },
    );
    if (!reponse.ok) {
      return { statut: "indisponible", cause: `registre npm HTTP ${reponse.status}`, fiches: [] };
    }
    const donnees = (await reponse.json()) as { objects?: Array<{ package?: NpmPackage }> };
    const candidats = (donnees.objects ?? []).map((o) => o.package).filter(Boolean) as NpmPackage[];

    const fiches: CapabilityDiscovery[] = [];
    for (const paquet of candidats.slice(0, limiteBornee)) {
      const manifeste = await manifesteNpm(paquet.name);
      fiches.push(ficheDepuisNpm(paquet, manifeste));
    }
    return { statut: "ok", fiches };
  } catch (erreur) {
    return {
      statut: "indisponible",
      cause: `registre npm injoignable : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
      fiches: [],
    };
  }
}

interface NpmPackage {
  name: string;
  description?: string;
  version?: string;
  keywords?: string[];
  links?: { repository?: string; homepage?: string };
  date?: string;
}

/** Manifeste complet du paquet (licence, scripts, dépendances). */
async function manifesteNpm(nom: string): Promise<{
  license?: string;
  deprecated?: string;
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
} | null> {
  try {
    const reponse = await fetch(`https://registry.npmjs.org/${encodeURIComponent(nom)}/latest`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!reponse.ok) return null;
    return (await reponse.json()) as object as Parameters<typeof ficheDepuisNpm>[1];
  } catch {
    return null;
  }
}

function ficheDepuisNpm(
  paquet: NpmPackage,
  manifeste: { license?: string; deprecated?: string; dependencies?: Record<string, string>; scripts?: Record<string, string> } | null,
): CapabilityDiscovery {
  const risques: string[] = [];
  const fonctionnalites = (paquet.keywords ?? []).slice(0, 8).map((k) => sanitiserTexte(k, 80).texte);
  if (manifeste?.deprecated) risques.push(`déprécié : ${sanitiserTexte(String(manifeste.deprecated), 120).texte}`);
  if (manifeste?.scripts && ["preinstall", "install", "postinstall"].some((s) => manifeste.scripts?.[s])) {
    risques.push("scripts d'installation npm présents (exécution arbitraire à l'installation)");
  }
  if (!manifeste?.license) risques.push("licence absente du manifeste");
  return {
    id: cleDeduplication("npm", paquet.name, paquet.version),
    source: "npm",
    kind: "bibliotheque",
    nom: paquet.name,
    description: sanitiserTexte(paquet.description ?? "description absente du registre", 400).texte,
    fonctionnalites,
    url: paquet.links?.repository ?? paquet.links?.homepage ?? `https://www.npmjs.com/package/${encodeURIComponent(paquet.name)}`,
    licence: manifeste?.license,
    version: paquet.version,
    dependances: Object.keys(manifeste?.dependencies ?? {}).slice(0, 30),
    cout: { gratuit: true, note: "registre npm public" },
    exigences: { reseau: true, systeme: "node" },
    risques,
    statut: "ok",
    verifieLe: maintenantIso(),
    schemaVersion: 1,
  };
}

/** Fiche d'un paquet UNIQUE par nom exact (usage ciblé, ex. comparaisons). */
export async function decouvrirNpmParNom(nom: string): Promise<ResultatRechercheNpm> {
  const manifeste = await manifesteNpm(nom);
  if (!manifeste) {
    return { statut: "indisponible", cause: `paquet « ${nom} » introuvable ou registre injoignable`, fiches: [] };
  }
  return {
    statut: "ok",
    fiches: [
      ficheDepuisNpm(
        { name: nom, description: undefined, version: undefined },
        manifeste,
      ),
    ],
  };
}

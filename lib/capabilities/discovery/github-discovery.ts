/**
 * GITHUB DISCOVERY (UCE-001) — découverte réelle dans l'API GitHub Search.
 * Le token GITHUB_TOKEN est OPTIONNEL : sans token, l'API anonyme est
 * sévèrement limitée (HTTP 403 mesuré en audit) — le résultat est alors un
 * échec honnête, JAMAIS des données fabriquées.
 */

import "server-only";

import {
  cleDeduplication,
  maintenantIso,
  type CapabilityDiscovery,
} from "../core/capability-contract";
import { sanitiserTexte } from "../security/secrets-protection";

const TIMEOUT_MS = 10_000;
const PLAFOND = 20;

export interface ResultatRechercheGithub {
  statut: "ok" | "indisponible";
  cause?: string;
  fiches: CapabilityDiscovery[];
}

/** Recherche de dépôts GitHub (q: « language:ts stars:>100 x »). */
export async function decouvrirGithub(requete: string, limite = 5): Promise<ResultatRechercheGithub> {
  const limiteBornee = Math.max(1, Math.min(limite, PLAFOND));
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const reponse = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(requete)}&per_page=${limiteBornee}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS), headers },
    );
    if (!reponse.ok) {
      const cause = reponse.status === 403
        ? "HTTP 403 : limite anonyme GitHub atteinte — définir GITHUB_TOKEN pour activer cette source"
        : `GitHub HTTP ${reponse.status}`;
      return { statut: "indisponible", cause, fiches: [] };
    }
    const donnees = (await reponse.json()) as { items?: GithubRepo[] };
    const fiches = (donnees.items ?? []).slice(0, limiteBornee).map(ficheDepuisRepo);
    return { statut: "ok", fiches };
  } catch (erreur) {
    return {
      statut: "indisponible",
      cause: `GitHub injoignable : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
      fiches: [],
    };
  }
}

interface GithubRepo {
  full_name: string;
  description?: string | null;
  html_url: string;
  license?: { spdx_id?: string | null } | null;
  topics?: string[];
  stargazers_count?: number;
  pushed_at?: string;
  language?: string | null;
}

function ficheDepuisRepo(repo: GithubRepo): CapabilityDiscovery {
  const risques: string[] = [];
  if (!repo.license?.spdx_id || repo.license.spdx_id === "NOASSERTION") {
    risques.push("licence GitHub non déterminée (spdx absent)");
  }
  return {
    id: cleDeduplication("github", repo.full_name, repo.pushed_at),
    source: "github",
    kind: "bibliotheque",
    nom: repo.full_name,
    description: sanitiserTexte(repo.description ?? "description absente", 400).texte,
    fonctionnalites: (repo.topics ?? []).slice(0, 8),
    url: repo.html_url,
    licence: repo.license?.spdx_id && repo.license.spdx_id !== "NOASSERTION" ? repo.license.spdx_id : undefined,
    dependances: [],
    cout: { gratuit: true, note: `dépôt public — ${repo.stargazers_count ?? 0} étoiles` },
    exigences: { reseau: true, systeme: repo.language === "Python" ? "python" : "node" },
    risques,
    statut: "ok",
    verifieLe: maintenantIso(),
    schemaVersion: 1,
  };
}

/**
 * PYPI DISCOVERY (UCE-001) — découverte réelle dans le registre PyPI.
 * Limite honnête documentée : l'API de recherche PyPI (XML-RPC) est
 * désactivée par PyPI depuis 2021 — la découverte se fait PAR NOM EXACT
 * (GET /pypi/<nom>/json), jamais par scraping ni inventaire.
 */

import "server-only";

import {
  cleDeduplication,
  maintenantIso,
  type CapabilityDiscovery,
} from "../core/capability-contract";
import { sanitiserTexte } from "../security/secrets-protection";

const TIMEOUT_MS = 8_000;

export interface ResultatRecherchePypi {
  statut: "ok" | "indisponible";
  cause?: string;
  fiches: CapabilityDiscovery[];
}

/** Fiche PyPI réelle par nom de paquet. */
export async function decouvrirPypiParNom(nom: string): Promise<ResultatRecherchePypi> {
  try {
    const reponse = await fetch(`https://pypi.org/pypi/${encodeURIComponent(nom.trim())}/json`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (reponse.status === 404) {
      return { statut: "indisponible", cause: `paquet « ${nom} » inexistant sur PyPI (HTTP 404)`, fiches: [] };
    }
    if (!reponse.ok) {
      return { statut: "indisponible", cause: `PyPI HTTP ${reponse.status}`, fiches: [] };
    }
    const donnees = (await reponse.json()) as PypiProjet;
    const info = donnees.info ?? {};
    const licenceBrute = info.license_expression || info.license || undefined;
    const licence = licenceBrute && licenceBrute.length <= 120 ? licenceBrute : undefined;
    const risques: string[] = [];
    if (!licence) risques.push("licence absente des métadonnées (classifiers non analysés automatiquement)");
    return {
      statut: "ok",
      fiches: [
        {
          id: cleDeduplication("pypi", nom, info.version),
          source: "pypi",
          kind: "bibliotheque",
          nom: info.name ?? nom,
          description: sanitiserTexte(info.summary ?? "description absente de PyPI", 400).texte,
          fonctionnalites: extraireClassifiers(info.classifiers ?? []).slice(0, 8),
          url: info.project_urls?.Homepage ?? info.home_page ?? `https://pypi.org/project/${encodeURIComponent(nom)}/`,
          licence,
          version: info.version,
          dependances: Object.keys(donnees.info?.requires_dist ?? {}).length > 0
            ? (info.requires_dist ?? []).map(extraireNomRequis).slice(0, 30)
            : [],
          cout: { gratuit: true, note: "PyPI public" },
          exigences: { reseau: true, python: info.requires_python ?? undefined, systeme: "python" },
          risques,
          statut: "ok",
          verifieLe: maintenantIso(),
          schemaVersion: 1,
        },
      ],
    };
  } catch (erreur) {
    return {
      statut: "indisponible",
      cause: `PyPI injoignable : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
      fiches: [],
    };
  }
}

interface PypiProjet {
  info?: {
    name?: string;
    version?: string;
    summary?: string;
    license?: string | null;
    license_expression?: string | null;
    home_page?: string | null;
    project_urls?: Record<string, string>;
    requires_python?: string | null;
    requires_dist?: string[] | null;
    classifiers?: string[];
  };
}

/** Classifiers utiles (topic/intended audience) → fonctionnalités légibles. */
function extraireClassifiers(classifiers: string[]): string[] {
  return classifiers
    .filter((c) => c.startsWith("Topic ::") || c.startsWith("Programming Language :: Python :: 3"))
    .map((c) => sanitiserTexte(c, 80).texte);
}

/** « requests (>=2.0) » → « requests ». */
function extraireNomRequis(requis: string): string {
  return requis.split(/[(<>=!]/)[0].trim();
}

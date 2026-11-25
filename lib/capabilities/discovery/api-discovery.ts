/**
 * API DISCOVERY (UCE-025) — découverte d'APIs publiques.
 * Méthode honnête : catalogue embarqué d'APIs publiques de référence
 * (champ `verifieLe` daté) + VÉRIFICATION RÉELLE à la demande (appel HTTP
 * de contrôle par le vérificateur, garde SSRF actif) — jamais de promesse
 * de fraîcheur au-delà de ce qui a été réellement testé.
 */

import "server-only";

import {
  cleDeduplication,
  maintenantIso,
  type CapabilityDiscovery,
} from "../core/capability-contract";
import { verifierApiRepond } from "../verification/api-validator";
import { sanitiserTexte } from "../security/secrets-protection";

interface EntreeCatalogue {
  nom: string;
  description: string;
  url: string;
  categorie: string;
  licenceUtil?: string;
}

/** APIs publiques sans clé, de référence (catalogue daté 2026-11). */
const CATALOGUE_APIS: EntreeCatalogue[] = [
  { nom: "wikipedia-api", description: "Encyclopédie libre — recherche et articles (REST, sans clé)", url: "https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=test&srlimit=1", categorie: "connaissances" },
  { nom: "open-meteo", description: "Météo mondiale gratuite sans clé (prévisions + historique)", url: "https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m", categorie: "donnees" },
  { nom: "duckduckgo-ia", description: "Instant Answer DuckDuckGo (réponses courtes sans clé)", url: "https://api.duckduckgo.com/?q=test&format=json&no_html=1", categorie: "connaissances" },
  { nom: "frankfurter", description: "Taux de change BCE, gratuit sans clé", url: "https://api.frankfurter.app/latest", categorie: "donnees" },
  { nom: "github-public-repos", description: "API publique GitHub (repos/commits, limites anonymes)", url: "https://api.github.com/repos/microsoft/vscode", categorie: "developpement" },
];

export interface ResultatRechercheApis {
  statut: "ok" | "indisponible";
  cause?: string;
  fiches: CapabilityDiscovery[];
}

/** Recherche dans le catalogue embarqué (aucun appel réseau). */
export function decouvrirApis(requete: string, limite = 5): ResultatRechercheApis {
  const q = requete.toLowerCase().trim();
  const matches = CATALOGUE_APIS
    .filter((a) => !q || a.description.toLowerCase().includes(q) || a.nom.includes(q) || a.categorie.includes(q))
    .slice(0, Math.max(1, Math.min(limite, 20)));
  if (matches.length === 0) {
    return { statut: "ok", fiches: [], cause: undefined };
  }
  return {
    statut: "ok",
    fiches: matches.map((a) => ({
      id: cleDeduplication("api", a.nom, "catalogue-2026-11"),
      source: "api",
      kind: "api",
      nom: a.nom,
      description: sanitiserTexte(a.description, 300).texte,
      fonctionnalites: [a.categorie],
      url: a.url,
      dependances: [],
      cout: { gratuit: true, note: "API publique sans clé (limites du fournisseur applicables)" },
      exigences: { reseau: true },
      risques: ["données tierces non fiables — validation avant usage", "limites de débit du fournisseur"],
      statut: "ok",
      verifieLe: maintenantIso(),
      schemaVersion: 1,
    })),
  };
}

/** Vérifie EN DIRECT qu'une API du catalogue répond réellement. */
export async function verifierApiCatalogue(nom: string): Promise<{ verifie: boolean; httpStatut?: number; latenceMs: number; cause?: string }> {
  const entree = CATALOGUE_APIS.find((a) => a.nom === nom);
  if (!entree) {
    return { verifie: false, latenceMs: 0, cause: `API « ${nom} » absente du catalogue embarqué` };
  }
  const verdict = await verifierApiRepond(entree.url);
  return { verifie: verdict.verifie, httpStatut: verdict.httpStatut, latenceMs: verdict.latenceMs, cause: verdict.cause };
}

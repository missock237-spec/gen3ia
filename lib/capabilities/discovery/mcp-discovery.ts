/**
 * MCP DISCOVERY (UCE-001) — découverte de serveurs MCP :
 *  1) réutilisation du détecteur réel du dépôt (isMcpServerPackage sur npm) ;
 *  2) catalogue embarqué de serveurs MCP de référence (données statiques,
 *     chaque entrée explicitement datée/vérifiée — jamais présenté comme
 *     une re-découverte en direct).
 */

import "server-only";

import {
  cleDeduplication,
  maintenantIso,
  type CapabilityDiscovery,
} from "../core/capability-contract";
import { decouvrirNpm } from "./npm-discovery";
import { sanitiserTexte } from "../security/secrets-protection";

export interface ResultatRechercheMcp {
  statut: "ok" | "indisponible";
  cause?: string;
  fiches: CapabilityDiscovery[];
  provenance: "npm-live" | "catalogue-embarque" | "mixte";
}

/** Serveurs MCP de référence (catalogue embarqué, vérifié à la main). */
const CATALOGUE_MCP: Array<{ nom: string; description: string; paquet: string; url: string }> = [
  { nom: "modelcontextprotocol-server-filesystem", description: "Accès fichiers sandboxé via MCP (référence officielle)", paquet: "@modelcontextprotocol/server-filesystem", url: "https://github.com/modelcontextprotocol/servers" },
  { nom: "modelcontextprotocol-server-github", description: "API GitHub via MCP (référence officielle)", paquet: "@modelcontextprotocol/server-github", url: "https://github.com/modelcontextprotocol/servers" },
  { nom: "modelcontextprotocol-server-postgres", description: "PostgreSQL en lecture via MCP (référence officielle)", paquet: "@modelcontextprotocol/server-postgres", url: "https://github.com/modelcontextprotocol/servers" },
  { nom: "modelcontextprotocol-server-puppeteer", description: "Navigation web via MCP (référence officielle)", paquet: "@modelcontextprotocol/server-puppeteer", url: "https://github.com/modelcontextprotocol/servers" },
];

/** Découverte MCP : recherche npm ciblée + catalogue embarqué. */
export async function decouvrirMcp(requete: string, limite = 5): Promise<ResultatRechercheMcp> {
  const limiteBornee = Math.max(1, Math.min(limite, PLAFOND_MCP));
  const rechercheNpm = await decouvrirNpm(`${requete} mcp-server`, limiteBornee);
  const fichesNpm = rechercheNpm.statut === "ok"
    ? rechercheNpm.fiches.filter((f) => estPaquetMcp(f.nom, f.fonctionnalites)).map((f) => ({ ...f, source: "mcp" as const }))
    : [];

  const requeteNormalisee = requete.toLowerCase();
  const fichesCatalogue = CATALOGUE_MCP
    .filter((s) => requeteNormalisee === "" || s.description.toLowerCase().includes(requeteNormalisee) || s.nom.includes(requeteNormalisee))
    .slice(0, limiteBornee)
    .map((s) => ficheCatalogue(s));

  const fiches = [...fichesNpm, ...fichesCatalogue].slice(0, limiteBornee);
  const provenance: ResultatRechercheMcp["provenance"] =
    fichesNpm.length > 0 && fichesCatalogue.length > 0 ? "mixte" : fichesNpm.length > 0 ? "npm-live" : "catalogue-embarque";

  if (fiches.length === 0) {
    return {
      statut: rechercheNpm.statut === "ok" ? "ok" : "indisponible",
      cause: rechercheNpm.statut === "ok" ? undefined : rechercheNpm.cause,
      fiches,
      provenance,
    };
  }
  return { statut: "ok", fiches, provenance };
}

const PLAFOND_MCP = 20;

/** Détection MCP : mot-clé explicite dans le nom ou les mots-clés npm. */
function estPaquetMcp(nom: string, motsCles: string[]): boolean {
  const n = nom.toLowerCase();
  return n.includes("mcp") || motsCles.some((k) => k.toLowerCase().includes("mcp") || k.toLowerCase().includes("model-context-protocol"));
}

function ficheCatalogue(s: { nom: string; description: string; paquet: string; url: string }): CapabilityDiscovery {
  return {
    id: cleDeduplication("mcp", s.nom, "catalogue"),
    source: "mcp",
    kind: "connecteur",
    nom: s.nom,
    description: `${sanitiserTexte(s.description, 300).texte} (catalogue embarqué UCE — paquet npm : ${s.paquet})`,
    fonctionnalites: ["mcp", "serveur-outils"],
    url: s.url,
    licence: "MIT",
    dependances: [s.paquet],
    cout: { gratuit: true, note: "open source" },
    exigences: { reseau: true, node: ">=20" },
    risques: ["exécution d'un processus serveur externe — isolation et autorisation obligatoires avant intégration"],
    statut: "ok",
    verifieLe: maintenantIso(),
    schemaVersion: 1,
  };
}

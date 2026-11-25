/**
 * MODEL DISCOVERY (UCE-024) — découverte de modèles IA dans Hugging Face
 * (API publique /api/models). Filtrage honnête : licence lue dans les tags,
 * taille estimée non garantie (jamais annoncée si inconnue).
 */

import "server-only";

import {
  cleDeduplication,
  maintenantIso,
  type CapabilityDiscovery,
} from "../core/capability-contract";

const TIMEOUT_MS = 10_000;
const PLAFOND = 20;

export interface ResultatRechercheModeles {
  statut: "ok" | "indisponible";
  cause?: string;
  fiches: CapabilityDiscovery[];
}

/** Recherche HF : pipeline_tag (task), search, sort=downloads. */
export async function decouvrirModeles(requete: string, limite = 5, pipelineTag?: string): Promise<ResultatRechercheModeles> {
  const limiteBornee = Math.max(1, Math.min(limite, PLAFOND));
  const params = new URLSearchParams({ search: requete, limit: String(limiteBornee), sort: "downloads", direction: "-1" });
  if (pipelineTag) params.set("pipeline_tag", pipelineTag);
  try {
    const reponse = await fetch(`https://huggingface.co/api/models?${params.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!reponse.ok) {
      return { statut: "indisponible", cause: `Hugging Face HTTP ${reponse.status}`, fiches: [] };
    }
    const donnees = (await reponse.json()) as HfModele[];
    const fiches = donnees.slice(0, limiteBornee).map(ficheDepuisModele);
    return { statut: "ok", fiches };
  } catch (erreur) {
    return {
      statut: "indisponible",
      cause: `Hugging Face injoignable : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
      fiches: [],
    };
  }
}

interface HfModele {
  modelId?: string;
  id?: string;
  pipeline_tag?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
}

function licenceDepuisTags(tags: string[]): string | undefined {
  return tags.find((t) => t.startsWith("license:"))?.slice("license:".length);
}

function ficheDepuisModele(m: HfModele): CapabilityDiscovery {
  const nom = m.modelId ?? m.id ?? "modele-sans-nom";
  const tags = m.tags ?? [];
  const licence = licenceDepuisTags(tags);
  const risques: string[] = [];
  if (!licence) risques.push("licence non déclarée dans les tags HF");
  const exclusions = ["commercial", "unlicensed", "other"].filter((x) => licence?.includes(x));
  if (exclusions.length > 0) risques.push(`restriction de licence possible : ${exclusions.join(", ")}`);
  return {
    id: cleDeduplication("huggingface", nom, String(m.likes ?? 0)),
    source: "huggingface",
    kind: "modele",
    nom,
    description: `Modèle IA ${m.pipeline_tag ?? "tâche non précisée"} — ${m.downloads ?? 0} téléchargements, ${m.likes ?? 0} likes (métadonnées HF réelles)`,
    fonctionnalites: [m.pipeline_tag ?? "tache-non-specifiee", ...tags.filter((t) => !t.startsWith("license:")).slice(0, 6)],
    url: `https://huggingface.co/${nom}`,
    licence,
    dependances: [],
    cout: { gratuit: true, note: "poids publics HF (hébergement/téléchargement à la charge de l'infrastructure)" },
    exigences: { reseau: true, gpu: false, systeme: "python" },
    risques,
    statut: "ok",
    verifieLe: maintenantIso(),
    schemaVersion: 1,
  };
}

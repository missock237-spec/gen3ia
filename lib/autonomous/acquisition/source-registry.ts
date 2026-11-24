/**
 * SOURCE REGISTRY (Lot 2 — Gen3ia Autonomous Data Acquisition).
 *
 * Registre persistant des sources autorisées : identité, licence citée,
 * intervalle minimum de débit, tour de rôle (la source la plus ancienne
 * non collectée passe en premier), statut actif/pause.
 *
 * Persistance disque atomique (var/autonomous/acquisition/sources.json) —
 * même mécanique que le core (lifecycle-manager) : aucune dépendance à un
 * service externe, relecture défensive.
 *
 * Sources initiales du plan : Wikipedia (API REST, CC BY-SA), arXiv (API
 * atom, licence arXiv), hubs HF/Kaggle (DÉJÀ collectés par la boucle
 * existante lib/entrainement-auto — type "hub" enregistré pour la
 * traçabilité SANS double collecte : le collecteur saute ce type).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SourceEnregistree } from "./types";

/** Caps mémoire/disque honnêtes : registre borné (plan : sources légères). */
export const MAX_SOURCES = 200;

/** Sources initiales du plan — API publiques, licences citées, débit respecté. */
export function sourcesInitiales(): SourceEnregistree[] {
  return [
    {
      id: "wikipedia-fr",
      url: "https://fr.wikipedia.org/api/rest_v1/page/random/summary",
      type: "wikipedia",
      licence: "CC BY-SA 4.0 (API REST Wikimedia — usages légers documentés)",
      intervalleMinMs: 300_000,
      statut: "actif",
      lotsProduits: 0,
    },
    {
      id: "wikipedia-en",
      url: "https://en.wikipedia.org/api/rest_v1/page/random/summary",
      type: "wikipedia",
      licence: "CC BY-SA 4.0 (API REST Wikimedia — usages légers documentés)",
      intervalleMinMs: 300_000,
      statut: "actif",
      lotsProduits: 0,
    },
    {
      id: "arxiv-cs",
      url: "https://export.arxiv.org/api/query?search_query=cat:cs.AI&max_results=3&sortBy=submittedDate&sortOrder=descending",
      type: "arxiv",
      licence: "arXiv.org — redistribution des métadonnées autorisée (API atom)",
      intervalleMinMs: 600_000,
      statut: "actif",
      lotsProduits: 0,
    },
    {
      id: "hubs-hf-kaggle",
      url: "lib/entrainement-auto (boucle existante — HF + Kaggle)",
      type: "hub",
      licence: "selon dataset (hubs tracés par la boucle d'auto-apprentissage)",
      intervalleMinMs: 900_000,
      statut: "actif",
      lotsProduits: 0,
    },
  ];
}

export class RegistreSources {
  private parId = new Map<string, SourceEnregistree>();

  constructor(
    private readonly dossier: string,
    initial?: SourceEnregistree[],
  ) {
    const chargées = this.charger();
    const deBase = chargées ?? initial ?? sourcesInitiales();
    for (const s of deBase) this.parId.set(s.id, s);
  }

  /** Chemin du fichier de registre. */
  private chemin(): string {
    return join(this.dossier, "acquisition", "sources.json");
  }

  /** Charge le registre persisté (null si absent/illisible — défensif). */
  private charger(): SourceEnregistree[] | null {
    try {
      const brut = readFileSync(this.chemin(), "utf8");
      const parsed = JSON.parse(brut) as { sources?: SourceEnregistree[] };
      if (!Array.isArray(parsed.sources)) return null;
      return parsed.sources.slice(0, MAX_SOURCES);
    } catch {
      return null;
    }
  }

  /** Persiste le registre (atomique tmp+rename, fail-soft). */
  persister(): boolean {
    try {
      const chemin = this.chemin();
      mkdirSync(join(chemin, ".."), { recursive: true });
      const tmp = `${chemin}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ persisteLe: new Date().toISOString(), sources: [...this.parId.values()] }, null, 1),
        "utf8",
      );
      renameSync(tmp, chemin);
      return true;
    } catch {
      return false;
    }
  }

  /** Toutes les sources (ordre de registre). */
  toutes(): SourceEnregistree[] {
    return [...this.parId.values()];
  }

  /** Une source par id. */
  obtenir(id: string): SourceEnregistree | null {
    return this.parId.get(id) ?? null;
  }

  /** Ajoute une source (refus si id existant — pas de doublon). */
  ajouter(source: SourceEnregistree): boolean {
    if (this.parId.has(source.id) || this.parId.size >= MAX_SOURCES) return false;
    this.parId.set(source.id, source);
    return true;
  }

  /** Pause / reprise d'une source (respect d'une source temporairement hostile). */
  definirStatut(id: string, statut: "actif" | "pause", raison?: string): boolean {
    const s = this.parId.get(id);
    if (!s) return false;
    s.statut = statut;
    if (statut === "pause") s.derniereErreur = raison ?? s.derniereErreur;
    return true;
  }

  /**
   * Prochaine source DÛE : type collectable (hub exclu — la boucle
   * existante lib/entrainement-auto s'en charge déjà, zéro doublon),
   * active, dont l'intervalle minimum est écoulé — la plus ancienne
   * collecte en premier (tour de rôle équitable).
   */
  prochaineDue(maintenantMs: number): SourceEnregistree | null {
    const candidates = this.toutes()
      .filter((s) => s.statut === "actif" && s.type !== "hub")
      .filter((s) => !s.derniereCollecteLe || maintenantMs - Date.parse(s.derniereCollecteLe) >= s.intervalleMinMs)
      .sort((a, b) => {
        const ta = a.derniereCollecteLe ? Date.parse(a.derniereCollecteLe) : 0;
        const tb = b.derniereCollecteLe ? Date.parse(b.derniereCollecteLe) : 0;
        return ta - tb;
      });
    return candidates[0] ?? null;
  }

  /** Enregistre le résultat d'une collecte (mesures réelles). */
  noterCollecte(id: string, maintenantIso: string): void {
    const s = this.parId.get(id);
    if (!s) return;
    s.derniereCollecteLe = maintenantIso;
    s.derniereErreur = undefined;
    s.lotsProduits += 1;
  }

  /** Enregistre une erreur honnête (bornée) sans casser le tour de rôle. */
  noterErreur(id: string, message: string): void {
    const s = this.parId.get(id);
    if (!s) return;
    s.derniereCollecteLe = new Date().toISOString(); // respect du débit même en erreur
    s.derniereErreur = message.slice(0, 300);
  }
}

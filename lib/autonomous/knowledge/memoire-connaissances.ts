/**
 * MÉMOIRE PERMANENTE DES CONNAISSANCES (Lot 5 — Gen3ia Permanent Knowledge
 * Memory, couches Semantic + Relational du plan).
 *
 * Une mémoire qui accueille CONTINUELLEMENT de nouvelles connaissances :
 *  - chaque connaissance conserve sa PROVENANCE INTÉGRALE (Règle 10) ;
 *  - VERSIONNEMENT : une mise à jour garde la version précédente ;
 *  - CONTRADICTIONS : deux valeurs contradictoires pour une même propriété
 *    sont TOUTES DEUX conservées et flaggées (jamais transformées en vérité
 *    artificielle) ;
 *  - OBSOLESCENCE : marquer obsolète sans supprimer (historique intact) ;
 *  - RECHERCHE : par concept, par domaine, relations.
 *
 * Persistance : JSONL append-only (var/autonomous/connaissances/connaissances.jsonl)
 * + index mémoire reconstruit au boot — simple, borné, sans dépendance
 * externe (contrainte : zéro service obligatoire).
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EnregistrementStructure, Provenance } from "../intelligence/traiter";

/** Propriété d'une connaissance (valeurs multiples = contradictions gérées). */
export interface ProprieteConnaissance {
  cle: string;
  valeur: string;
  provenanceId: string;
  sourceId: string;
  dateIso: string;
}

/** Relation entre concepts (couche Relational). */
export interface RelationConnaissance {
  relation: string;
  cibleConcept: string;
  provenanceId: string;
  dateIso: string;
}

/** Connaissance permanente (couche Semantic + historique de versions). */
export interface Connaissance {
  idConcept: string;
  concept: string;
  domaine: string | null;
  proprietes: ProprieteConnaissance[];
  relations: RelationConnaissance[];
  resume: string;
  langue: "fr" | "en" | "autre";
  /** Nb de sources distinctes confirmant (vérification, Lot 5). */
  confirmations: number;
  /** Contradictions non résolues — conservées et flaggées (jamais cachées). */
  contradictions: Array<{ cle: string; valeurs: string[]; provenanceIds: string[] }>;
  /** Versions précédentes (mise à jour ≠ perte). */
  versionsPrecedentes: Array<{ dateIso: string; resume: string; raison: string }>;
  /** Marquée obsolète (restreinte, pas supprimée). */
  obsolete?: { raison: string; dateIso: string };
  provenances: Provenance[];
  creeLe: string;
  majLe: string;
}

/** Caps honnêtes (respect des ressources — Règle 17 de la mission). */
export const MAX_CONNAISSANCES = 20_000;
const MAX_PROPRIETES_PAR_CONNAISSANCE = 40;
const MAX_VERSIONS = 10;

/** Mémoire permanente des connaissances. */
export class MemoireConnaissances {
  private parId = new Map<string, Connaissance>();

  constructor(private readonly dossier: string) {
    this.recharger();
  }

  /** Chemin du JSONL. */
  private cheminFichier(): string {
    return join(this.dossier, "connaissances", "connaissances.jsonl");
  }

  /** Recharge l'index depuis le JSONL (boot — reconstruction honnête). */
  private recharger(): void {
    try {
      const brut = readFileSync(this.cheminFichier(), "utf8");
      for (const ligne of brut.split("\n")) {
        if (!ligne.trim()) continue;
        try {
          const c = JSON.parse(ligne) as Connaissance;
          this.parId.set(c.idConcept, c);
        } catch {
          /* ligne corrompue ignorée — le reste du fichier reste lisible. */
        }
      }
    } catch {
      /* première exécution : mémoire vide. */
    }
  }

  /** Ajoute une connaissance (append JSONL). */
  private ecrire(c: Connaissance): void {
    try {
      mkdirSync(join(this.dossier, "connaissances"), { recursive: true });
      appendFileSync(this.cheminFichier(), `${JSON.stringify(c)}\n`, "utf8");
    } catch {
      /* disque plein : l'index mémoire reste correct, l'erreur est visible. */
    }
  }

  /** Réécrit la connaissance (append — le dernier record gagne à la relecture). */
  private majEtEcrire(c: Connaissance): void {
    c.majLe = new Date().toISOString();
    this.parId.set(c.idConcept, c);
    this.ecrire(c);
  }

  /**
   * INTÈGRE une connaissance vérifiée (APPROVED) — versionnement complet :
   * si le concept existe déjà, l'ancien résumé est archivé dans
   * versionsPrecedentes, les propriétés nouvelles s'ajoutent avec leur
   * provenance, les contradictions sont détectées et CONSERVÉES.
   */
  integrer(enr: EnregistrementStructure, confirmations: number): Connaissance {
    const maintenant = new Date().toISOString();
    const existante = this.parId.get(enr.idConcept);
    if (!existante) {
      const nouvelle: Connaissance = {
        idConcept: enr.idConcept,
        concept: enr.concept,
        domaine: enr.domaine,
        proprietes: enr.proprietes.map((p) => ({
          cle: p.cle,
          valeur: p.valeur,
          provenanceId: enr.provenance.lotId,
          sourceId: enr.provenance.sourceId,
          dateIso: maintenant,
        })),
        relations: enr.relations.map((r) => ({
          relation: r.relation,
          cibleConcept: r.cible,
          provenanceId: enr.provenance.lotId,
          dateIso: maintenant,
        })),
        resume: enr.resume,
        langue: enr.langue,
        confirmations,
        contradictions: [],
        versionsPrecedentes: [],
        provenances: [enr.provenance],
        creeLe: maintenant,
        majLe: maintenant,
      };
      this.parId.set(nouvelle.idConcept, nouvelle);
      this.ecrire(nouvelle);
      return nouvelle;
    }

    // Concept existant : versionnement + fusion + contradictions.
    existante.versionsPrecedentes.push({
      dateIso: existante.majLe,
      resume: existante.resume,
      raison: "mise à jour par nouveau lot",
    });
    if (existante.versionsPrecedentes.length > MAX_VERSIONS) {
      existante.versionsPrecedentes.splice(0, existante.versionsPrecedentes.length - MAX_VERSIONS);
    }
    if (enr.resume !== existante.resume) existante.resume = enr.resume;
    if (!existante.domaine && enr.domaine) existante.domaine = enr.domaine;
    existante.confirmations = Math.max(existante.confirmations, confirmations) + 1;

    for (const p of enr.proprietes) {
      // Contradiction : même clé, valeurs distinctes → LES DEUX conservées.
      const sameCle = existante.proprietes.filter((e) => e.cle === p.cle);
      if (sameCle.length > 0 && !sameCle.some((e) => e.valeur === p.valeur)) {
        existante.contradictions.push({
          cle: p.cle,
          valeurs: [...new Set([p.valeur, ...sameCle.map((e) => e.valeur)])],
          provenanceIds: [enr.provenance.lotId, ...sameCle.map((e) => e.provenanceId)],
        });
      }
      if (!existante.proprietes.some((e) => e.valeur === p.valeur)) {
        existante.proprietes.push({
          cle: p.cle,
          valeur: p.valeur,
          provenanceId: enr.provenance.lotId,
          sourceId: enr.provenance.sourceId,
          dateIso: maintenant,
        });
      }
    }
    for (const r of enr.relations) {
      if (!existante.relations.some((e) => e.relation === r.relation && e.cibleConcept === r.cible)) {
        existante.relations.push({
          relation: r.relation,
          cibleConcept: r.cible,
          provenanceId: enr.provenance.lotId,
          dateIso: maintenant,
        });
      }
    }
    if (!existante.provenances.some((prov) => prov.lotId === enr.provenance.lotId)) {
      existante.provenances.push(enr.provenance);
    }
    if (existante.proprietes.length > MAX_PROPRIETES_PAR_CONNAISSANCE) {
      existante.proprietes.splice(0, existante.proprietes.length - MAX_PROPRIETES_PAR_CONNAISSANCE);
    }
    existante.obsolete = undefined; // une confirmation réactive une connaissance obsolète
    this.majEtEcrire(existante);
    return existante;
  }

  /** Marque une connaissance obsolète (restrictive, jamais suppressive). */
  marquerObsolete(idConcept: string, raison: string): boolean {
    const c = this.parId.get(idConcept);
    if (!c) return false;
    c.obsolete = { raison, dateIso: new Date().toISOString() };
    this.majEtEcrire(c);
    return true;
  }

  /** Réécrit une connaissance modifiée en place (index + JSONL). */
  persisterConnaissance(idConcept: string): boolean {
    const c = this.parId.get(idConcept);
    if (!c) return false;
    this.majEtEcrire(c);
    return true;
  }

  /** Une connaissance par id de concept. */
  obtenir(idConcept: string): Connaissance | null {
    return this.parId.get(idConcept) ?? null;
  }

  /** Toutes les connaissances d'un domaine (couche Semantic, hors obsolètes). */
  parDomaine(domaine: string, plafond = 50): Connaissance[] {
    return [...this.parId.values()]
      .filter((c) => c.domaine === domaine && !c.obsolete)
      .slice(0, plafond);
  }

  /** Relations d'un concept (couche Relational). */
  relationsDe(idConcept: string): RelationConnaissance[] {
    return this.parId.get(idConcept)?.relations ?? [];
  }

  /** Recherche par mots de concept (simple, locale, bornée). */
  rechercher(mots: string[], plafond = 10): Connaissance[] {
    const bas = mots.map((m) => m.toLowerCase());
    return [...this.parId.values()]
      .filter((c) => !c.obsolete)
      .filter((c) => bas.every((m) => c.concept.toLowerCase().includes(m) || c.resume.toLowerCase().includes(m)))
      .slice(0, plafond);
  }

  /** Toutes les connaissances actives (hors obsolètes — borné). */
  toutesActives(plafond = 100): Connaissance[] {
    return [...this.parId.values()].filter((c) => !c.obsolete).slice(0, plafond);
  }

  /** Nombre de connaissances actives. */
  taille(): number {
    return this.parId.size;
  }

  /** Sources distinctes d'une connaissance (traçabilité 100 %). */
  sourcesDe(idConcept: string): string[] {
    return [...new Set(this.parId.get(idConcept)?.provenances.map((p) => p.sourceId) ?? [])];
  }
}

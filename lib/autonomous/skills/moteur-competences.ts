/**
 * SKILL DEVELOPMENT ENGINE (Lot 6 du plan « GEN3IA AUTONOMOUS BRAIN »).
 *
 * Transforme les connaissances vérifiées en COMPÉTENCES opérationnelles,
 * selon le processus du plan :
 *   NEW KNOWLEDGE → SKILL IDENTIFICATION → KNOWLEDGE ACQUISITION →
 *   PRACTICE GENERATION → EXECUTION TESTS → ERROR ANALYSIS →
 *   SKILL VALIDATION → SKILL REGISTRY
 *
 * Règle 12 de la mission : les programmes s'exécutent dans un environnement
 * ISOLÉ (réutilisation de l'ExecuteurSandbox existant — processus enfant,
 * timeout, heap plafonné, répertoire détruit, réseau désactivé en docker).
 * Aucune compétence n'est déclarée validée sans ses tests pratiques verts.
 *
 * Honnêteté : une connaissance sans contenu praticable produit une
 * compétence « identifiée » (en étude) — JAMAIS une compétence prétendue.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Connaissance, MemoireConnaissances } from "../knowledge/memoire-connaissances";

/** Statuts d'une compétence (jamais de faux succès). */
export type StatutCompetence = "identifiee" | "en_entrainement" | "validee" | "echec";

/** Un exercice pratique : un script de test isolé qui appelle `emettre(ok)`. */
export interface Exercice {
  id: string;
  consigne: string;
  /** Script JS de test (exécuté dans la sandbox ; reçoit donnees.implementationJs). */
  script: string;
  /** Résultat réel du dernier passage (absent si pas encore exécuté). */
  resultat?: { ok: boolean; dureeMs: number; message: string };
}

/** Compétence du registre. */
export interface Competence {
  id: string;
  nom: string;
  domaine: string | null;
  /** Connaissances sources (provenance de la compétence). */
  baseConnaissances: string[];
  /** Implémentation candidate JS extraite de la connaissance (ou null). */
  implementationJs: string | null;
  exercices: Exercice[];
  statut: StatutCompetence;
  /** Analyse d'erreurs honnête (bornée). */
  analyseErreurs: string[];
  valideLe?: string;
  creeLe: string;
  majLe: string;
}

/**
 * Exécuteur injectable : (script, donnees) → verdict réel. Tests : factice ;
 * production : ExecuteurSandbox (processus enfant isolé, timeout, heap).
 */
export type ExecuteurIsole = (
  script: string,
  donnees?: unknown,
) => Promise<{ ok: boolean; message: string; dureeMs: number }>;

/** Registre persistant des compétences (borné, atomique). */
export class RegistreCompetences {
  private parId = new Map<string, Competence>();

  constructor(private readonly dossier: string) {
    this.charger();
  }

  private chemin(): string {
    return join(this.dossier, "competences", "competences.json");
  }

  private charger(): void {
    try {
      const brut = readFileSync(this.chemin(), "utf8");
      const parsed = JSON.parse(brut) as { competences?: Competence[] };
      for (const c of parsed.competences ?? []) this.parId.set(c.id, c);
    } catch {
      /* première exécution. */
    }
  }

  persister(): boolean {
    try {
      mkdirSync(join(this.dossier, "competences"), { recursive: true });
      const tmp = `${this.chemin()}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ persisteLe: new Date().toISOString(), competences: [...this.parId.values()] }, null, 1),
        "utf8",
      );
      renameSync(tmp, this.chemin());
      return true;
    } catch {
      return false;
    }
  }

  enregistrer(c: Competence): void {
    c.majLe = new Date().toISOString();
    this.parId.set(c.id, c);
  }

  obtenir(id: string): Competence | null {
    return this.parId.get(id) ?? null;
  }

  toutes(): Competence[] {
    return [...this.parId.values()];
  }

  /** Compétences validées (seules considérées opérationnelles). */
  validees(): Competence[] {
    return this.toutes().filter((c) => c.statut === "validee");
  }
}

/** La connaissance contient-elle du contenu praticable (code) ? */
export function contientContenuCode(conn: Connaissance): boolean {
  const corpus = `${conn.resume} ${conn.proprietes.map((p) => p.valeur).join(" ")}`;
  return (
    corpus.includes("```") ||
    /\bfunction\s+\w+\s*\(/.test(corpus) ||
    /\bconst\s+\w+\s*=\s*\(/.test(corpus)
  );
}

/** Extrait une implémentation candidate JS de la connaissance (borné). */
export function extraireImplementation(conn: Connaissance): string | null {
  const corpus = `${conn.resume} ${conn.proprietes.map((p) => p.valeur).join(" ")}`;
  const bloc = corpus.match(/```(?:js|javascript)?\s*([\s\S]*?)```/);
  if (bloc) return bloc[1].trim().slice(0, 4_000);
  const fonction = corpus.match(/function\s+\w+\s*\([^)]*\)\s*\{[\s\S]{0,2000}?\n\}/);
  if (fonction) return fonction[0].trim().slice(0, 4_000);
  const constFn = corpus.match(/const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,2000}?\};/);
  if (constFn) return constFn[0].trim().slice(0, 4_000);
  return null;
}

/** Génère des exercices pratiques DEPUIS la connaissance (borné, honnête). */
export function genererExercices(conn: Connaissance): Exercice[] {
  if (!contientContenuCode(conn)) return []; // honnête : rien à pratiquer
  return [
    {
      id: `${conn.idConcept}-ex1`,
      consigne: `L'implémentation candidate s'exécute ET ses fonctions exportées répondent réellement à un échantillon d'appel (test pratique réel — « ${conn.concept.slice(0, 60)} »).`,
      script: `
        const impl = donnees.implementationJs;
        if (typeof impl !== "string" || impl.trim().length === 0) {
          emettre({ ok: false, message: "implémentation absente" });
        } else {
          try {
            const fabrique = new Function("exports", impl);
            const exports_ = {};
            fabrique(exports_);
            const fonctions = Object.keys(exports_).filter((k) => typeof exports_[k] === "function");
            if (fonctions.length === 0) {
              emettre({ ok: false, message: "aucune fonction exportée — rien à pratiquer" });
            } else {
              let ok = true;
              let message = "";
              for (const nom of fonctions) {
                try {
                  const resultat = exports_[nom](1);
                  if (resultat === undefined) { ok = false; message = nom + "(1) a renvoyé undefined"; break; }
                } catch (e) { ok = false; message = nom + "(1) a levé : " + (e && e.message ? e.message : String(e)); break; }
              }
              emettre({ ok, message: ok ? fonctions.length + " fonction(s) exécutée(s) avec un échantillon réel" : message });
            }
          } catch (e) {
            emettre({ ok: false, message: "erreur d'exécution : " + (e && e.message ? e.message : String(e)) });
          }
        }
      `,
    },
  ];
}

/** Options du moteur de compétences. */
export interface OptionsMoteurCompetences {
  registre: RegistreCompetences;
  memoire: MemoireConnaissances;
  executeur: ExecuteurIsole;
  /** Max de compétences développées par appel (respect des ressources). */
  maxParAppel?: number;
}

/**
 * DÉVELOPPE les compétences à partir des connaissances vérifiées :
 * identification → génération d'exercices → exécution ISOLÉE → analyse
 * d'erreurs → validation (tout vert OBLIGATOIRE) → registre.
 */
export async function developperCompetences(
  options: OptionsMoteurCompetences,
): Promise<{ identifiees: number; validees: number; echecs: number; messages: string[] }> {
  const maxParAppel = options.maxParAppel ?? 3;
  const messages: string[] = [];
  let identifiees = 0;
  let validees = 0;
  let echecs = 0;

  // SKILL IDENTIFICATION : TOUTES les connaissances actives de la mémoire
  // (tous domaines — une compétence peut naître de n'importe quel savoir
  // praticable ; borné par maxParAppel et le plafond mémoire).
  for (const conn of options.memoire.toutesActives(100)) {
    if (identifiees + validees + echecs >= maxParAppel) break;
    if (options.registre.toutes().some((c) => c.baseConnaissances.includes(conn.idConcept))) continue;

      const id = `comp-${conn.idConcept}`;
      const exercices = genererExercices(conn);
      const implementation = extraireImplementation(conn);

      if (exercices.length === 0 || !implementation) {
        // Connaissance sans contenu praticable : IDENTIFIÉE (en étude) —
        // jamais prétendue opérationnelle.
        options.registre.enregistrer({
          id,
          nom: `Compétence issue de « ${conn.concept.slice(0, 50)} »`,
          domaine: conn.domaine,
          baseConnaissances: [conn.idConcept],
          implementationJs: implementation,
          exercices: [],
          statut: "identifiee",
          analyseErreurs: ["connaissance sans contenu praticable — en étude, non opérationnelle"],
          creeLe: new Date().toISOString(),
          majLe: new Date().toISOString(),
        });
        identifiees += 1;
        messages.push(`${id} : identifiée (en étude — aucun exercice praticable)`);
        continue;
      }

      // PRACTICE GENERATION → EXECUTION TESTS (sandbox) → ERROR ANALYSIS
      // → VALIDATION (tout vert obligatoire) → SKILL REGISTRY.
      const competence: Competence = {
        id,
        nom: `Compétence issue de « ${conn.concept.slice(0, 50)} »`,
        domaine: conn.domaine,
        baseConnaissances: [conn.idConcept],
        implementationJs: implementation,
        exercices,
        statut: "en_entrainement",
        analyseErreurs: [],
        creeLe: new Date().toISOString(),
        majLe: new Date().toISOString(),
      };
      let toutVert = true;
      for (const exercice of exercices) {
        const r = await options.executeur(exercice.script, { implementationJs: implementation });
        exercice.resultat = { ok: r.ok, dureeMs: r.dureeMs, message: r.message };
        if (!r.ok) {
          toutVert = false;
          competence.analyseErreurs.push(`${exercice.id} : ${r.message}`.slice(0, 300));
        }
      }
      competence.statut = toutVert ? "validee" : "echec";
      if (toutVert) {
        competence.valideLe = new Date().toISOString();
        validees += 1;
        messages.push(`${id} : VALIDÉE (${exercices.length} test(s) pratique(s) vert(s) en sandbox)`);
      } else {
        echecs += 1;
        messages.push(`${id} : échec des tests pratiques — ${competence.analyseErreurs[0]}`);
      }
      options.registre.enregistrer(competence);
  }
  // Persistance conditionnelle : écrire seulement si quelque chose a été
  // développé (un registre vide n'écrase pas l'état persistant existant).
  if (identifiees + validees + echecs > 0) options.registre.persister();
  return { identifiees, validees, echecs, messages };
}

/**
 * Exécuteur de PRODUCTION : ExecuteurSandbox réel (processus enfant, heap
 * plafonné, timeout, répertoire détruit). Le verdict du script passe par
 * `emettre({ok, message})` — parsé par la sandbox.
 */
export function executerSandboxProduction(): ExecuteurIsole {
  return async (script, donnees) => {
    const { ExecuteurSandbox } = await import("../../agents-os/dispatch/executeur-sandbox");
    const sandbox = new ExecuteurSandbox({ timeoutMs: 10_000, heapMo: 128 });
    const r = await sandbox.executer(script, donnees ?? {});
    const resultat = (r.resultat ?? {}) as { ok?: boolean; message?: string };
    const ok = r.ok && resultat.ok === true;
    const message = resultat.message ?? r.erreur ?? (r.ok ? "exécuté (sans verdict explicite)" : "échec sandbox");
    return { ok, message, dureeMs: r.dureeMs };
  };
}

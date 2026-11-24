/**
 * ANTI-HALLUCINATION ENGINE (Lot 8 du plan « GEN3IA AUTONOMOUS BRAIN »).
 *
 * Fait en sorte que Gen3ia fonde ses réponses sur des connaissances
 * VÉRIFIABLES (Règle 15/16 de la mission, Phase 10 du plan) :
 *
 *  1. analyse de la demande → découpage de la réponse candidate en AFFIRMATIONS ;
 *  2. recherche des connaissances pertinentes (mémoire permanente locale) ;
 *  3. identification des sources (provenance de chaque connaissance mobilisée) ;
 *  4. vérification de cohérence (soutenu / contredit / non vérifié) ;
 *  5. détection des informations manquantes ;
 *  6. évaluation du niveau d'incertitude (mesuré, jamais inventé) ;
 *  7. verdict global avec les références disponibles.
 *
 * Aucune IA externe : appariement lexical local contre la mémoire vérifiée.
 * Un affirmé NON VÉRIFIÉ reste NON VÉRIFIÉ — jamais transformé en vérité.
 */

import type { MemoireConnaissances } from "../knowledge/memoire-connaissances";

/** Verdict d'une affirmation individuelle. */
export type VerdictAffirmation = "SOUTENU" | "CONTREDIT" | "NON_VERIFIE";

/** Une affirmation extraite de la réponse candidate, avec son verdict. */
export interface AffirmationVerifiee {
  affirmation: string;
  verdict: VerdictAffirmation;
  /** Sources (provenances) soutenant ou contredisant l'affirmation. */
  sources: Array<{ sourceId: string; lotId: string; concept: string }>;
  /** Explication honnête du verdict. */
  explication: string;
}

/** Rapport de vérification d'une réponse candidate. */
export interface RapportAntiHallucination {
  /** FONDÉE (≥ 60 % soutenu, 0 contredit) · PARTIELLEMENT_FONDÉE · NON_FONDÉE. */
  verdict: "FONDÉE" | "PARTIELLEMENT_FONDÉE" | "NON_FONDÉE";
  /** Ratio d'affirmations soutenues (mesuré 0..1). */
  tauxSoutien: number;
  affirmations: AffirmationVerifiee[];
  /** Informations manquantes détectées (questions non couvertes par la mémoire). */
  incertitudes: string[];
}

/** Découpe une réponse en affirmations (phrases, borné honnête). */
function affirmer(reponse: string): string[] {
  return reponse
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20)
    .slice(0, 12);
}

/** Mots significatifs d'une phrase (≥ 4 lettres, sans mots vides FR/EN). */
function motsCles(phrase: string): string[] {
  const vides = new Set([
    "cela", "cette", "dont", "entre", "leur", "nous", "vous", "elles", "aussi", "alors", "ainsi", "donc",
    "that", "this", "with", "from", "have", "will", "there", "which", "their", "about", "would", "could",
  ]);
  return [...new Set(
    phrase
      .toLowerCase()
      .split(/[^a-zàâäéèêëîïôöùûüç0-9]+/)
      .filter((m) => m.length >= 4 && !vides.has(m)),
  )].slice(0, 14);
}

/** Jaccard borné entre deux ensembles de mots (similarité honnête). */
function jaccard(a: string[], b: string[]): number {
  const ensA = new Set(a);
  const ensB = new Set(b);
  if (ensA.size === 0 || ensB.size === 0) return 0;
  let inter = 0;
  for (const x of ensA) if (ensB.has(x)) inter += 1;
  return inter / (ensA.size + ensB.size - inter);
}

/**
 * Recherche progressive dans la mémoire : toutes les paires des 4 premiers
 * mots-clés, puis les mots seuls — pour retrouver la connaissance même quand
 * un mot de l'affirmation n'est pas dans le résumé (robustesse honnête).
 */
function rechercherProgressive(memoire: MemoireConnaissances, cles: string[]): ReturnType<MemoireConnaissances["rechercher"]> {
  const premieres = cles.slice(0, 4);
  for (let i = 0; i < premieres.length; i++) {
    for (let j = i + 1; j < premieres.length; j++) {
      const r = memoire.rechercher([premieres[i], premieres[j]], 8);
      if (r.length > 0) return r;
    }
  }
  for (const mot of premieres) {
    const r = memoire.rechercher([mot], 8);
    if (r.length > 0) return r;
  }
  return [];
}

/**
 * VÉRIFIE une réponse candidate contre la mémoire permanente vérifiée :
 * chaque affirmation reçoit SOUTENU (avec sources) / CONTREDIT /
 * NON_VÉRIFIÉ — et le rapport global mesure l'incertitude restante.
 */
export function verifierReponse(reponse: string, memoire: MemoireConnaissances): RapportAntiHallucination {
  const affirmations: AffirmationVerifiee[] = [];
  const incertitudes: string[] = [];

  for (const phrase of affirmer(reponse)) {
    const cles = motsCles(phrase);
    if (cles.length < 2) {
      affirmations.push({
        affirmation: phrase,
        verdict: "NON_VERIFIE",
        sources: [],
        explication: "trop vague pour être vérifiée contre la mémoire (moins de 2 mots significatifs)",
      });
      incertitudes.push(phrase.slice(0, 80));
      continue;
    }
    const candidates = rechercherProgressive(memoire, cles);
    let meilleur: { similarite: number; concept: string; sourceId: string; lotId: string } | null = null;
    let contredit: { concept: string; sourceId: string } | null = null;

    for (const c of candidates) {
      const corpus = `${c.concept} ${c.resume} ${c.proprietes.map((p) => p.valeur).join(" ")}`;
      const similarite = jaccard(cles, motsCles(corpus));
      if (similarite >= 0.22 && (!meilleur || similarite > meilleur.similarite)) {
        const prov = c.provenances[0];
        meilleur = {
          similarite,
          concept: c.concept,
          sourceId: prov?.sourceId ?? "inconnu",
          lotId: prov?.lotId ?? "inconnu",
        };
      }
      // Contradiction : connaissance obsolète ou propriété contradictoire flaggée.
      if (c.contradictions.length > 0 && similarite >= 0.3) {
        contredit = { concept: c.concept, sourceId: c.provenances[0]?.sourceId ?? "inconnu" };
      }
    }

    if (contredit) {
      affirmations.push({
        affirmation: phrase,
        verdict: "CONTREDIT",
        sources: [{ sourceId: contredit.sourceId, lotId: "", concept: contredit.concept }],
        explication: "la mémoire contient des versions contradictoires flaggées sur ce sujet — la réponse doit exposer les deux, pas trancher",
      });
    } else if (meilleur) {
      affirmations.push({
        affirmation: phrase,
        verdict: "SOUTENU",
        sources: [{ sourceId: meilleur.sourceId, lotId: meilleur.lotId, concept: meilleur.concept }],
        explication: `soutenu par la mémoire vérifiée (similarité ${Math.round(meilleur.similarite * 100)} %, provenance tracée)`,
      });
    } else {
      affirmations.push({
        affirmation: phrase,
        verdict: "NON_VERIFIE",
        sources: [],
        explication: "aucune connaissance vérifiée de la mémoire ne couvre cette affirmation — elle doit être présentée comme non vérifiée",
      });
      incertitudes.push(phrase.slice(0, 80));
    }
  }

  const total = affirmations.length;
  const soutenus = affirmations.filter((a) => a.verdict === "SOUTENU").length;
  const contredits = affirmations.filter((a) => a.verdict === "CONTREDIT").length;
  const tauxSoutien = total === 0 ? 0 : Math.round((soutenus / total) * 100) / 100;
  const verdict: RapportAntiHallucination["verdict"] =
    contredits > 0 ? "NON_FONDÉE" : tauxSoutien >= 0.6 ? "FONDÉE" : tauxSoutien > 0 ? "PARTIELLEMENT_FONDÉE" : "NON_FONDÉE";

  return { verdict, tauxSoutien, affirmations, incertitudes };
}

/**
 * COMPOSITEUR DE PROMPTS STRUCTURÉS (Task 138 — optimisation de la qualité
 * des réponses IA).
 *
 * Exigence utilisateur — ingénierie de prompt structurée : « Définissez
 * clairement le rôle, le contexte, les contraintes strictes et le format de
 * sortie attendu (par exemple, Markdown ou JSON). »
 *
 * Avant ce module, chaque moteur assemblait son prompt système à la main :
 * la structure, l'ordre et la présence des sections variaient d'un chemin à
 * l'autre. Le compositeur impose désormais UN squelette normalisé, dans
 * l'ordre que la recherche en ingénierie de prompt établit comme le plus
 * fiable :
 *
 *   1. RÔLE          — qui parle, mission, périmètre
 *   2. CONTEXTE      — état réel du moment (jamais inventé)
 *   3. MÉTHODE       — raisonnement par étapes AVANT de conclure (CoT)
 *   4. CONTRAINTES   — règles strictes et non négociables
 *   5. FORMAT        — format de sortie exact attendu
 *   6. EXEMPLES      — un ou deux exemples de qualité supérieure (few-shot)
 *
 * Sémantique honnête : une section absente ou vide n'est PAS rendue (aucun
 * squelette fantôme), l'ordre est TOUJOURS respecté, le contenu de chaque
 * section est transmis tel quel (le compositeur structure, il ne réécrit pas).
 *
 * Module PUR (aucune dépendance, aucune IO).
 */

/* ------------------------------------------------------------------ */
/* Directive de raisonnement par étapes (Chain-of-Thought interne)     */
/* ------------------------------------------------------------------ */

/**
 * Exigence utilisateur : « Incitez explicitement l'IA à décomposer sa logique
 * et ses hypothèses avant de formuler sa conclusion pour réduire les erreurs
 * d'analyse. »
 *
 * La décomposition se déroule dans la RÉFLEXION du modèle (interne) : la
 * réponse visible ne contient que la conclusion et les éléments utiles —
 * jamais le brouillon brut. Cette formulation remplace l'ancienne
 * interdiction « pas de raisonnement » qui coupait toute élaboration
 * préalable : on encadre le raisonnement au lieu de l'interdire.
 */
export const REASONING_DIRECTIVE = [
  "MÉTHODE DE RAISONNEMENT (déroule-la intégralement dans ta réflexion INTERNE, avant d'écrire la réponse) :",
  "1. IDENTIFIE le type de demande : question factuelle, explication, analyse, comparaison, procédure, calcul, débogage, création… Le format de la réponse suit ce type.",
  "2. DÉCOMPOSE le problème : éléments en jeu, données fournies (historique, fichiers, contexte réel), inconnues à combler.",
  "3. LISTE tes hypothèses EXPLICITEMENT : marque celle qui doit être vérifiée plutôt que supposée — si une hypothèse incertaine change la réponse, signale-le plutôt que de trancher en silence.",
  "4. TRAITE chaque point un par un et vérifie la cohérence AVANT de conclure : chiffres et unités, dates, logique de cause à effet, contradictions internes.",
  "5. FORMULE ensuite ta réponse : la conclusion directe en première ligne, puis le développement structuré.",
  "Ta réflexion préparatoire ne doit JAMAIS apparaître dans la réponse finale : seuls la conclusion et les éléments utiles à l'utilisateur y figurent — mais jamais sauter l'étape de réflexion.",
].join("\n");

/* ------------------------------------------------------------------ */
/* Sections composables                                                */
/* ------------------------------------------------------------------ */

export interface StructuredPromptSections {
  /** RÔLE — identité, mission, périmètre (ex. : charte d'agent). Obligatoire. */
  role: string;
  /** CONTEXTE — état réel du moment (variables résolues, jumeau, mémoire…). */
  context?: string;
  /** MÉTHODE — raisonnement par étapes. Défaut : REASONING_DIRECTIVE. */
  method?: string | false;
  /** CONTRAINTES — règles strictes, une par entrée. */
  constraints?: string[];
  /** FORMAT — contrat de présentation / format de sortie exact. */
  outputFormat?: string;
  /** EXEMPLES — section few-shot DÉJÀ rendue (voir lib/ai/few-shot.ts). */
  examples?: string;
}

const SECTION_TITLES: Record<string, string> = {
  role: "RÔLE",
  context: "CONTEXTE",
  method: "MÉTHODE DE RAISONNEMENT (INTERNE)",
  constraints: "CONTRAINTES STRICTES",
  outputFormat: "FORMAT DE SORTIE",
  examples: "EXEMPLES DE QUALITÉ ATTENDUE",
};

/** Assemble une liste en tirets (une contrainte par ligne, jamais vide). */
function renderConstraints(constraints: string[]): string {
  return constraints
    .map((constraint) => constraint.trim())
    .filter(Boolean)
    .map((constraint) => (constraint.startsWith("-") ? constraint : `- ${constraint}`))
    .join("\n");
}

/**
 * Compose le prompt système structuré complet.
 *  - `role` est la seule section obligatoire (un prompt sans rôle n'a pas de sens) ;
 *  - `method: false` désactive explicitement la directive CoT (tâches où le
 *    raisonnement est déporté ailleurs : classification, extraction JSON…) ;
 *  - chaque section absente/vide disparaît du prompt — aucun squelette fantôme ;
 *  - l'ordre ROLE → CONTEXTE → MÉTHODE → CONTRAINTES → FORMAT → EXEMPLES est
 *    TOUJOURS respecté.
 */
export function composeStructuredPrompt(sections: StructuredPromptSections): string {
  const parts: string[] = [];

  const role = sections.role?.trim();
  if (role) parts.push(`### ${SECTION_TITLES.role}\n${role}`);

  const context = sections.context?.trim();
  if (context) parts.push(`### ${SECTION_TITLES.context}\n${context}`);

  // Défaut : directive de raisonnement par étapes (Chain-of-Thought interne).
  const method = sections.method === false ? "" : (sections.method ?? REASONING_DIRECTIVE).trim();
  if (method) parts.push(`### ${SECTION_TITLES.method}\n${method}`);

  const constraints = renderConstraints(sections.constraints ?? []);
  if (constraints) parts.push(`### ${SECTION_TITLES.constraints}\n${constraints}`);

  const outputFormat = sections.outputFormat?.trim();
  if (outputFormat) parts.push(`### ${SECTION_TITLES.outputFormat}\n${outputFormat}`);

  const examples = sections.examples?.trim();
  if (examples) parts.push(`### ${SECTION_TITLES.examples}\n${examples}`);

  return parts.join("\n\n");
}

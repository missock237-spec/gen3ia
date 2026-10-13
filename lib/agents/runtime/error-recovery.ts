import "server-only";

import { generate } from "@/lib/ai/router";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";

/**
 * BOUCLE DE RÉTROACTION D'EXÉCUTION (Task 138 — robustesse et auto-correction).
 *
 * Exigence utilisateur : « En cas d'erreur d'exécution (comme un échec de
 * compilation ou un retour d'API invalide), l'agent analyse le journal
 * d'erreur, ajuste sa stratégie et réessaie. »
 *
 * Avant ce module, le runtime réessayait À L'AVEUGLE : une étape en échec
 * repassait en « pending » et ré-exécutait EXACTEMENT la même entrée — un
 * échec de compilation rejouait le même code, une entrée d'outil invalide
 * reproduisait la même erreur. Trois leviers sont désormais en place :
 *
 *  1. CLASSIFICATION (`classifyExecutionError`) — chaque erreur d'étape est
 *     typée : transitoire (réseau/fournisseur), entrée invalide (schéma),
 *     échec d'exécution de code (compilation/runtime), budget, auth,
 *     permanente. Une erreur SANS espoir (budget épuisé, permission
 *     refusée) ne consomme PLUS de tentative.
 *
 *  2. JOURNAL DE REPRISE (`buildRecoveryDirective`) — chaque échec est
 *     conservé par étape ; la tentative SUIVANTE reçoit le journal réel des
 *     erreurs précédentes avec une consigne d'ajustement : la reprise sait
 *     POURQUOI elle échoue et COMMENT changer d'approche.
 *
 *  3. RÉPARATION CIBLÉE (`repairGeneratedCode`, `repairToolInput`) — pour un
 *     échec de compilation, le code est CORRIGÉ par LLM à partir du journal
 *     d'erreur avant le réessai ; pour une entrée d'outil invalide, l'entrée
 *     est corrigée selon le schéma de l'outil. Fail-soft : une panne de
 *     réparation retombe sur l'entrée d'origine (comportement historique).
 */

/* ------------------------------------------------------------------ */
/* 1. Classification des erreurs d'exécution                           */
/* ------------------------------------------------------------------ */

export type ExecutionErrorKind =
  | "transient" // réseau / fournisseur indisponible : réessai à l'identique légitime
  | "invalid_input" // entrée invalide : réessai utile UNIQUEMENT après correction
  | "compilation" // échec d'exécution de code : réparer le code puis réessayer
  | "timeout" // délai dépassé (non retentable : l'appel sous-jacent peut tourner)
  | "budget" // budget/wallet épuisé : permanent
  | "auth" // permission refusée / non autorisé : permanent
  | "permanent" // toute erreur sans espoir de réussite au réessai
  | "unknown"; // erreur non classée : comportement historique (réessayable)

export interface ExecutionErrorClassification {
  kind: ExecutionErrorKind;
  /** Une nouvelle tentative a-t-elle une chance RÉELLE de réussir ? */
  retryable: boolean;
  /** Directive d'ajustement injectée à la tentative suivante. */
  strategy: string;
}

interface ErrorPattern {
  kind: ExecutionErrorKind;
  pattern: RegExp;
}

/**
 * Patterns DU PLUS SPÉCIFIQUE AU PLUS GÉNÉRIQUE — le premier qui matche
 * l'emporte (l'ordre est porteur de sens : un « budget » n'est jamais
 * « transient » même si le message contient « retry »).
 */
const ERROR_PATTERNS: readonly ErrorPattern[] = [
  // Budget & facturation (le plancher de dépense est atteint : aucun réessai).
  { kind: "budget", pattern: /\b(budget de l'agent atteint|budget .*([ée]puis|d[ée]pass|atteint|exceed)|budget (de )?(d[ée]pense|ex[ée]cution)|plafond .*eur|wallet|solde insuffisant|insufficient (funds|credit|wallet)|quota .*d[ée]pass|billing)/i },
  // Autorisation / permissions (une permission refusée le reste au réessai).
  { kind: "auth", pattern: /\b(401\b|403\b|unauthorized|forbidden|permission (denied|refus[ée]e)|non autoris[ée]|api key (invalide|invalid)|authentification requise)/i },
  // Timeout du runtime (Anomalie A2 : l'appel sous-jacent peut encore tourner —
  // un réessai créerait une double exécution facturée).
  { kind: "timeout", pattern: /^Step timeout after \d+ms$|\b(execution timeout|d[ée]lai d[ée]pass|timed? ?out)\b/i },
  // Entrée invalide : schéma zod, champ requis, type attendu, sélection invalide.
  { kind: "invalid_input", pattern: /\b(expected (string|number|boolean|array|object)|received (undefined|null|string|number)|zoderror|invalid_type|invalid enum|champ (requis|manquant)|champ obligatoire|required\b|missing\b|validation (failed|refused|error)|invalid tool selection|arguments.*invalide|json (invalide|invalid)|sch[ée]ma non respect)/i },
  // Échec d'exécution de code : compilation, syntaxe, runtime, exit code.
  { kind: "compilation", pattern: /\b(syntaxerror|referenceerror|typeerror:|traceback|exit code (1|[2-9]\d*)|compilation failed|[ée]chec de compilation|stderr|module not found|cannot find module|name '.*' is not defined|unexpected token|indentationerror|valueerror|runtimeerror)\b/i },
  // Transitoire : réseau / fournisseur / limite de débit.
  { kind: "transient", pattern: /\b(429|rate ?limit|too many requests|502|503|504|internal server error|service (unavailable|temporairement indisponible)|econnreset|econnrefused|etimedout|eai_again|fetch failed|network|network error|temporarily|r[ée]essayez|try again|overloaded)\b/i },
];

const STRATEGIES: Record<ExecutionErrorKind, string> = {
  transient: "Erreur transitoire (réseau/fournisseur) : tu peux réexécuter la même approche — l'incident était ponctuel.",
  invalid_input: "Entrée INVALIDE : ne répète PAS l'appel à l'identique — CORRIGE l'entrée d'après le message d'erreur (champs manquants, types, valeurs attendues).",
  compilation: "Échec d'exécution du CODE : corrige le code d'après le journal d'erreur (ligne fautive, type, import manquant) avant de réessayer.",
  timeout: "Délai dépassé : réduis le périmètre du traitement (découpe, moins de données, requête plus ciblée) au lieu de refaire exactement pareil.",
  budget: "Budget épuisé : aucune nouvelle tentative n'est possible — arrête-toi là et rends un compte honnête.",
  auth: "Permission refusée : une autorisation manque (connecteur, clé, consentement) — aucune répétition ne la fera apparaître.",
  permanent: "Erreur permanente : une répétition à l'identique échouerait pareil — change d'approche ou rends l'échec honnêtement.",
  unknown: "Erreur non classée : lis le journal ci-dessous et adapte ton approche avant de réessayer.",
};

/**
 * Classe un message d'erreur d'étape. Définition HONNÊTE de « retryable » :
 *  - transient / invalid_input / compilation / timeout → true : une tentative
 *    AJUSTÉE a une vraie chance (l'entrée sera corrigée, le code réparé, le
 *    périmètre réduit) ;
 *  - budget / auth / permanent → false : le réessai ne peut PAS réussir, on
 *    économise la tentative et la latence.
 * Un message vide ou inconnu reste retryable (comportement historique —
 * jamais de régression du taux de reprise sur erreur non comprise).
 */
export function classifyExecutionError(message: string): ExecutionErrorClassification {
  const text = message?.trim() ?? "";
  for (const { kind, pattern } of ERROR_PATTERNS) {
    if (pattern.test(text)) {
      return { kind, retryable: kind !== "budget" && kind !== "auth" && kind !== "permanent", strategy: STRATEGIES[kind] };
    }
  }
  return { kind: "unknown", retryable: true, strategy: STRATEGIES.unknown };
}

/* ------------------------------------------------------------------ */
/* 2. Journal de reprise (directive injectée à la tentative suivante)   */
/* ------------------------------------------------------------------ */

/** Nombre maximal d'erreurs conservées par étape (journal borné). */
export const MAX_RECOVERY_NOTES_PER_STEP = 3;

/** Longueur maximale conservée d'un message d'erreur (journal borné). */
export const MAX_RECOVERY_NOTE_LENGTH = 800;

/**
 * Construit la directive de reprise : le journal RÉEL des erreurs passées de
 * l'étape + la consigne d'ajustement. Vide si aucune erreur enregistrée.
 */
export function buildRecoveryDirective(errors: readonly string[]): string {
  const notes = errors
    .map((error) => (error ?? "").trim())
    .filter(Boolean)
    .slice(-MAX_RECOVERY_NOTES_PER_STEP)
    .map((error, index) => `Essai ${index + 1} — erreur : ${error.slice(0, MAX_RECOVERY_NOTE_LENGTH)}`);
  if (notes.length === 0) return "";
  return [
    `TENTATIVE(S) PRÉCÉDENTE(S) DE CETTE ÉTAPE ONT ÉCHOUÉ — JOURNAL D'ERREURS RÉEL (analyse-le et AJUSTE ta stratégie : ne répète pas l'approche qui a échoué) :`,
    ...notes.map((note) => `- ${note}`),
    "Ton réexécution doit CORRIGER la cause de l'échec identifiée dans ce journal.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 3. Réparations ciblées par LLM (fail-soft total)                    */
/* ------------------------------------------------------------------ */

const CODE_REPAIR_SYSTEM = [
  "Tu es le réparateur de code du runtime d'agents Gen3ia.",
  "On te donne un code qui a ÉCHOUÉ à l'exécution, le journal d'erreur RÉEL, et l'objectif de l'étape.",
  "Analyse l'erreur (ligne fautive, type, import, logique), puis produis la version CORRIGÉE du code :",
  "- corrige EXACTEMENT la cause de l'échec, sans réécrire ce qui fonctionnait ;",
  "- garde le même langage et la même sortie attendue ;",
  "- n'ajoute aucun commentaire méta, aucune explication — UNIQUEMENT le code.",
  "Réponds STRICTEMENT dans un bloc de code délimité par ``` (ou le code brut si le bloc est impossible).",
].join(" ");

/**
 * Répare un code en échec d'après son journal d'erreur (échec de compilation
 * ou d'exécution). Fail-soft : une panne du réparateur rend le code d'origine
 * (le réessai historique garde alors ses chances sur erreur transitoire).
 */
export async function repairGeneratedCode(params: {
  code: string;
  error: string;
  objective?: string;
}): Promise<string> {
  try {
    const response = await generate({
      task: "coding",
      messages: [
        { role: "system", content: CODE_REPAIR_SYSTEM },
        {
          role: "user",
          content: [
            `OBJECTIF DE L'ÉTAPE : ${(params.objective ?? "").slice(0, 2_000) || "(non précisé)"}`,
            `JOURNAL D'ERREUR : ${params.error.slice(0, 4_000)}`,
            `CODE QUI A ÉCHOUÉ :`,
            "```",
            params.code.slice(0, 16_000),
            "```",
          ].join("\n"),
        },
      ],
      maxTokens: 4_096,
      metadata: { purpose: "error-recovery-code-repair" },
    });
    const fenced = response.text.match(/```[a-zA-Z0-9]*\s*([\s\S]*?)```/);
    const repaired = (fenced?.[1] ?? response.text).trim();
    // Garde : une « réparation » vide ou squelettique ne remplace pas le code.
    if (repaired.length >= Math.min(params.code.trim().length, 40)) return repaired;
    return params.code;
  } catch {
    return params.code;
  }
}

const TOOL_INPUT_REPAIR_SYSTEM = [
  "Tu es le réparateur d'appels d'outils du runtime d'agents Gen3ia.",
  "On te donne un outil (nom + description officielle), l'entrée JSON qui a ÉCHOUÉ la validation, et le message d'erreur réel.",
  "Produis l'entrée JSON CORRIGÉE : corrige les champs fautifs (types, champs manquants, valeurs attendues), conserve toutes les valeurs valides telles quelles.",
  "N'invente AUCUNE valeur métier absente de l'entrée d'origine : un champ manquant sans équivalent déduisible reste absent.",
  "Réponds STRICTEMENT en JSON (l'objet d'entrée corrigé, rien d'autre).",
].join(" ");

/**
 * Répare l'entrée d'une étape outil dont la validation a échoué
 * (« retour d'API invalide » côté schéma). Fail-soft : panne → entrée
 * d'origine.
 */
export async function repairToolInput(params: {
  toolName: string;
  input: Record<string, unknown>;
  error: string;
}): Promise<Record<string, unknown>> {
  try {
    const description = GEN3IA_TOOLS.find((tool) => tool.name === params.toolName)?.description ?? "(outil non répertorié)";
    const response = await generate({
      task: "reasoning",
      messages: [
        { role: "system", content: TOOL_INPUT_REPAIR_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            outil: params.toolName,
            description,
            entreeEchouee: params.input,
            erreur: params.error.slice(0, 2_000),
          }),
        },
      ],
      requiresStructuredOutput: true,
      maxTokens: 2_000,
      metadata: { purpose: "error-recovery-tool-input-repair" },
    });
    const fenced = response.text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidates = [fenced?.[1]?.trim(), response.text.trim()].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* candidat suivant */
      }
    }
    return params.input;
  } catch {
    return params.input;
  }
}

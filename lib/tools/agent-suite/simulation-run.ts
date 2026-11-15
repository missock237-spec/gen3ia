import { z } from "zod";

import type { ToolContext, ToolDefinition } from "@/lib/tools/types";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import { markupToText } from "@/lib/content/html-text";
import { mapWithConcurrency } from "@/lib/video/concurrency";
import { generateStructuredForUser } from "./llm-json";
import { persistMarkdownDeliverable } from "./artifact-deliverable";

/**
 * Task 140 — Outil « simulation.run » — Agentic Social Simulation Studio.
 *
 * Des agents aux profils psychologiques/techniques variés (novice, hacker,
 * acheteur pressé, sceptique, power user…) SIMULENT le comportement de vrais
 * utilisateurs sur une cible (interface, page réelle ou parcours décrit), la
 * testent en STRESS et produisent un RAPPORT DE BUGS COMPORTEMENTAUX.
 *
 * Voies réelles : chaque session de persona est un appel LLM facturé au
 * wallet via generateStructuredForUser (tâche « agent ») exécuté en
 * parallélisme borné (mapWithConcurrency, limite 3) ; la cible peut être une
 * PAGE RÉELLE (récupérée avec la garde SSRF, ancrage du prompt sur le contenu
 * extrait, échec doux) ; le rapport final est PERSISTÉ comme artefact privé
 * via persistMarkdownDeliverable. L'agrégation des constats (sévérité
 * critique/majeur/mineur) est 100 % DÉTERMINISTE — aucun LLM ne décide de la
 * sévérité.
 */

/* ------------------------------------------------------------------ */
/* Schémas                                                            */
/* ------------------------------------------------------------------ */

const SimulationArchetypeSchema = z.enum([
  "novice",
  "hacker",
  "impatient_buyer",
  "skeptic",
  "power_user",
  "custom",
]);

const SimulationPersonaSchema = z.object({
  name: z.string().min(2).max(60),
  archetype: SimulationArchetypeSchema,
  customBrief: z.string().max(1_500).optional(),
});

const SimulationRunInput = z.object({
  targetName: z.string().min(2).max(120),
  targetDescription: z.string().min(20).max(8_000),
  targetUrl: z.string().url().optional(),
  scenario: z.string().min(10).max(4_000),
  personas: z
    .array(SimulationPersonaSchema)
    .min(1)
    .max(6)
    .default([
      { name: "Novice curieux", archetype: "novice" },
      { name: "Acheteur pressé", archetype: "impatient_buyer" },
      { name: "Utilisateur méfiant", archetype: "skeptic" },
    ]),
  depth: z.enum(["quick", "standard", "deep"]).default("standard"),
});

const SimulatedActionSchema = z.object({
  step: z.number().int().min(1),
  action: z.string().max(500),
  expectation: z.string().max(300),
  outcome: z.enum(["success", "friction", "blocker"]),
  note: z.string().max(400).optional(),
});

const SimulatedSessionSchema = z.object({
  personaName: z.string(),
  actions: z.array(SimulatedActionSchema).min(1).max(12),
  satisfactionScore: z.number().int().min(1).max(10),
  frictionPoints: z.array(z.string().max(300)).max(10),
  wouldAbandon: z.boolean(),
});

const SimulationSynthesisSchema = z.object({
  overallScore: z.number().int().min(1).max(10),
  summary: z.string().max(1_200),
  recommendations: z.array(z.string()).max(8),
});

/* ------------------------------------------------------------------ */
/* Types de sortie                                                    */
/* ------------------------------------------------------------------ */

export type SimulationArchetype = z.infer<typeof SimulationArchetypeSchema>;
export type SimulatedSession = z.infer<typeof SimulatedSessionSchema>;
export type SimulationSeverity = "critical" | "major" | "minor";

export interface SimulationFinding {
  severity: SimulationSeverity;
  personas: string[];
  title: string;
  description: string;
  reproduction: string;
}

export interface SimulationRunResult {
  report: {
    overallScore: number;
    summary: string;
    recommendations: string[];
    findings: SimulationFinding[];
    sessions: SimulatedSession[];
  };
  warnings: string[];
  artifactId: string;
  filename: string;
}

/* ------------------------------------------------------------------ */
/* Briefs d'archétypes (constants internes, français)                 */
/* ------------------------------------------------------------------ */

const ARCHETYPE_BRIEFS: Record<SimulationArchetype, string> = {
  novice:
    "Ne connaît rien au produit ni au domaine : clique au hasard, ne lit pas les messages d'erreur (ni rien d'ailleurs), se perd vite, ne connaît ni les raccourcis ni le vocabulaire métier, abandonne dès qu'il ne comprend plus.",
  hacker:
    "Cherche les failles : essaie des entrées malveillantes (XSS, injections SQL, chemins de traversal, payloads exotiques), contourne les règles de validation, teste les limites du système et dénonce toute entrée non assainie.",
  impatient_buyer:
    "Veut acheter en moins de 60 secondes : zappe les étapes, ignore les options, déteste créer un compte ou ressaisir ses informations, abandonne dès qu'une friction (captcha, erreur, attente) ralentit l'achat.",
  skeptic:
    "Se méfie de tout : prix cachés, sécurité du paiement, vie privée, mentions légales. Cherche CGV, politique de confidentialité, mentions de rétractation, compare avant d'acheter, test des reconductions tacites.",
  power_user:
    "Va très vite : raccourcis clavier, navigation directe par URL, onglets multiples, cas limites (quantités énormes, caractères spéciaux, dates impossibles), très exigeant sur la performance et la cohérence des états.",
  custom:
    "Persona librement définie : suis exclusivement le brief personnalisé fourni pour incarner un profil spécifique.",
};

const DEPTH_LABELS: Record<string, string> = {
  quick: "rapide",
  standard: "standard",
  deep: "approfondie",
};

const DEPTH_STEPS_HINT: Record<string, string> = {
  quick: "3 à 5",
  standard: "5 à 8",
  deep: "8 à 12",
};

/* ------------------------------------------------------------------ */
/* Récupération de la cible réelle (fail-soft, garde SSRF)             */
/* ------------------------------------------------------------------ */

const GROUND_MAX_CHARS = 15_000;
const PAGE_MAX_BYTES = 5_000_000;

async function fetchTargetGround(url: string, context: ToolContext): Promise<string> {
  const initial = await assertPublicHttpUrl(url);
  const headers = { "User-Agent": "Gen3ia-AI-Studio/1.0" };
  const signal = context.signal ?? AbortSignal.timeout(15_000);
  let response = await fetch(initial, { redirect: "manual", headers, signal });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("la page cible a renvoyé une redirection sans destination");
    const redirected = await assertPublicHttpUrl(new URL(location, initial).toString());
    response = await fetch(redirected, { redirect: "manual", headers, signal });
    if (response.status >= 300 && response.status < 400) throw new Error("la page cible a renvoyé une chaîne de redirections");
  }
  if (!response.ok) throw new Error(`la page cible a répondu avec le statut HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > PAGE_MAX_BYTES) throw new Error("la page cible dépasse la limite de 5 Mo");
  const html = await response.text();
  if (Buffer.byteLength(html, "utf8") > PAGE_MAX_BYTES) throw new Error("la page cible dépasse la limite de 5 Mo");
  return markupToText(html).slice(0, GROUND_MAX_CHARS);
}

/* ------------------------------------------------------------------ */
/* Agrégation DÉTERMINISTE des constats                               */
/* ------------------------------------------------------------------ */

/** Mots vides français retirés avant comparaison de textes de friction. */
const FRENCH_STOPWORDS = new Set([
  "les", "des", "une", "aux", "est", "sur", "dans", "pour", "avec", "sans", "mais", "ou", "donc", "car", "que",
  "qui", "quoi", "dont", "sont", "celui", "cette", "ces", "son", "ses", "leur", "leurs", "plus", "moins", "tres",
  "trop", "peu", "tout", "toute", "tous", "etaient", "avant", "apres", "pendant", "entre", "vers", "chez", "comme",
  "afin", "ainsi", "alors", "aussi", "cela", "cet", "chaque", "depuis", "dont", "elle", "encore", "jamais",
  "mettre", "faire", "faut", "avait", "avoir", "etre", "elle", "lors", "via", "par", "pas", "ne", "non",
]);

/** Seuil de regroupement Jaccard de deux textes (même friction exprimée deux fois). */
const FRICTION_SIMILARITY_THRESHOLD = 0.4;

function tokenizeFr(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((word) => word.length >= 3 && !FRENCH_STOPWORDS.has(word)));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function truncateText(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + "…";
}

interface TextCluster<T> {
  tokens: Set<string>;
  representative: T;
  members: T[];
}

/** Regroupement glouton DÉTERMINISTE (ordre d'entrée) par similarité Jaccard. */
function clusterByTexts<T>(items: readonly T[], keyOf: (item: T) => string): TextCluster<T>[] {
  const clusters: TextCluster<T>[] = [];
  for (const item of items) {
    const tokens = tokenizeFr(keyOf(item));
    const existing = clusters.find((cluster) => jaccardSimilarity(cluster.tokens, tokens) >= FRICTION_SIMILARITY_THRESHOLD);
    if (existing) existing.members.push(item);
    else clusters.push({ tokens, representative: item, members: [item] });
  }
  return clusters;
}

function uniquePersonaNames(sessions: readonly SimulatedSession[]): string[] {
  return [...new Set(sessions.map((session) => session.personaName))];
}

function reproductionPath(session: SimulatedSession, stopAtStep: number): string {
  const steps = session.actions
    .filter((action) => action.step <= stopAtStep)
    .map((action) => `étape ${action.step} : ${action.action}`);
  return steps.length > 0 ? `${session.personaName} — ${steps.join(" → ")}` : session.personaName;
}

/**
 * Agrège les sessions simulées en constats déterministes :
 *  - chaque action « blocker » → sévérité CRITIQUE ;
 *  - friction exprimée par ≥ 2 personas → sévérité MAJEURE ;
 *  - friction d'un seul persona → sévérité MINEURE.
 *
 * Le regroupement des textes similaires (frictions et blocages) est glouton
 * et déterministe : même entrée ⇒ même sortie, aucun LLM dans cette voie.
 */
export function aggregateSimulationFindings(sessions: readonly SimulatedSession[]): SimulationFinding[] {
  const findings: SimulationFinding[] = [];

  // 1. Blocages (outcome « blocker ») — sévérité critique.
  const blockers = sessions.flatMap((session) =>
    session.actions
      .filter((action) => action.outcome === "blocker")
      .map((action) => ({ session, action })),
  );
  for (const cluster of clusterByTexts(blockers, (entry) => entry.action.action)) {
    const first = cluster.representative;
    const personas = uniquePersonaNames(cluster.members.map((member) => member.session));
    const expectation = first.action.expectation.trim();
    const note = first.action.note?.trim();
    findings.push({
      severity: "critical",
      personas,
      title: `Blocage : ${truncateText(first.action.action, 90)}`,
      description:
        `Parcours interrompu pour ${personas.length} persona(s) (${personas.join(", ")}). ` +
        `Attente brisée : « ${truncateText(expectation, 220)} ».` +
        (note ? ` Note : ${truncateText(note, 220)}.` : ""),
      reproduction: reproductionPath(first.session, first.action.step),
    });
  }

  // 2. Points de friction — majeur si ≥ 2 personas, mineur sinon.
  const frictions = sessions.flatMap((session) =>
    session.frictionPoints.map((point) => ({ session, point })),
  );
  for (const cluster of clusterByTexts(frictions, (entry) => entry.point)) {
    const first = cluster.representative;
    const personas = uniquePersonaNames(cluster.members.map((member) => member.session));
    const severity: SimulationSeverity = personas.length >= 2 ? "major" : "minor";
    // Première action marquée « friction » chez les personas concernés, si elle existe.
    const frictionStep = cluster.members
      .map((member) => member.session.actions.find((action) => action.outcome === "friction"))
      .find(Boolean);
    findings.push({
      severity,
      personas,
      title: truncateText(first.point, 90),
      description:
        `Friction rencontrée par ${personas.length} persona(s) : ${personas.join(", ")}.` +
        (severity === "major" ? " Corrélation inter-personas : le défaut est structurel, pas idiosyncratique." : ""),
      reproduction: frictionStep
        ? `${first.session.personaName} (étape ${frictionStep.step}) : ${truncateText(frictionStep.action, 180)}`
        : `Rejouer le scénario avec : ${personas.join(", ")}.`,
    });
  }

  const severityRank: Record<SimulationSeverity, number> = { critical: 0, major: 1, minor: 2 };
  return findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

/* ------------------------------------------------------------------ */
/* Rendu du rapport (markdown français)                               */
/* ------------------------------------------------------------------ */

function renderSeveritySection(label: string, severity: SimulationSeverity, findings: readonly SimulationFinding[]): string {
  const scoped = findings.filter((finding) => finding.severity === severity);
  if (scoped.length === 0) return `### ${label} (0)\n\nAucun constat de cette sévérité.\n`;
  const lines = [`### ${label} (${scoped.length})`, ""];
  for (const finding of scoped) {
    lines.push(`- **${finding.title}** — personas : ${finding.personas.join(", ")}`);
    lines.push(`  - Constat : ${finding.description}`);
    lines.push(`  - Reproduction : ${finding.reproduction}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderSimulationReport(params: {
  targetName: string;
  depth: string;
  overallScore: number;
  summary: string;
  findings: readonly SimulationFinding[];
  sessions: readonly SimulatedSession[];
  recommendations: readonly string[];
}): string {
  const date = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const lines: string[] = [];

  lines.push(`# Rapport de simulation — ${params.targetName}`, "");
  lines.push(`Généré le ${date} — profondeur « ${DEPTH_LABELS[params.depth] ?? params.depth} » — ${params.sessions.length} persona(s) simulée(s).`, "");

  lines.push("## Vue d'ensemble", "");
  lines.push(`Score global : ${params.overallScore} / 10.`, "");
  lines.push(params.summary.trim(), "");

  lines.push("## Constats par sévérité", "");
  lines.push(renderSeveritySection("Critique", "critical", params.findings));
  lines.push(renderSeveritySection("Majeur", "major", params.findings));
  lines.push(renderSeveritySection("Mineur", "minor", params.findings));

  lines.push("## Détail par persona", "");
  for (const session of params.sessions) {
    lines.push(`### ${session.personaName}`, "");
    lines.push(`Satisfaction : ${session.satisfactionScore} / 10 — abandon probable : ${session.wouldAbandon ? "oui" : "non"}.`, "");
    lines.push("Parcours simulé :", "");
    for (const action of session.actions) {
      lines.push(
        `${action.step}. ${action.action} — attendu : ${action.expectation} → ${action.outcome}` +
          (action.note ? ` (${action.note})` : ""),
      );
    }
    lines.push("");
    if (session.frictionPoints.length > 0) {
      lines.push("Points de friction :", "");
      for (const point of session.frictionPoints) lines.push(`- ${point}`);
      lines.push("");
    }
  }

  lines.push("## Recommandations", "");
  if (params.recommendations.length === 0) {
    lines.push("Aucune recommandation retournée par l'analyse.");
  } else {
    params.recommendations.forEach((recommendation, index) => lines.push(`${index + 1}. ${recommendation}`));
  }
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Outil                                                              */
/* ------------------------------------------------------------------ */

const PERSONA_SYSTEM_PROMPT = `Tu es le moteur de simulation comportementale « Agentic Social Simulation Studio » de Gen3ia.

RÔLE : pour cette exécution, tu INCARNES entièrement une persona d'utilisatrice ou d'utilisateur (profil psychologique et technique fourni). Tu ne commentes pas de l'extérieur : tu AGIS comme cette persona face à la cible, étape par étape, en la testant en STRESS.

MÉTHODE :
- Déroule le scénario demandé PAS À PAS du point de vue de la persona (clics, saisies, hésitations, erreurs, abandons éventuels).
- Reste strictement cohérent avec le niveau de compétence, la patience et les motivations de la persona.
- Chaque étape note l'action réalisée, ce que la persona attendait, et le résultat observé : "success", "friction" (elle progresse mais avec irritation ou perte de temps) ou "blocker" (elle ne peut plus progresser).
- Sois exigeant et réaliste : signale les messages d'erreur absents ou flous, les parcours trop longs, les données non validées, les défauts de confiance.

SORTIE : UNIQUEMENT un objet JSON valide, exactement conforme au schéma :
{"personaName":"…","actions":[{"step":1,"action":"…","expectation":"…","outcome":"success"|"friction"|"blocker","note":"…"}],"satisfactionScore":1,"frictionPoints":["…"],"wouldAbandon":false}

Tout le contenu est en FRANÇAIS. Aucun texte en dehors du JSON.`;

const SYNTHESIS_SYSTEM_PROMPT = `Tu es analyste UX senior chargé de la synthèse d'une simulation utilisateur multi-personas (Agentic Social Simulation Studio de Gen3ia).

RÔLE : à partir UNIQUEMENT des sessions simulées fournies (scores, frictions, blocages, abandons), produis une synthèse honnête et actionnable.

SORTIE : UNIQUEMENT un objet JSON valide exactement conforme au schéma :
{"overallScore":1,"summary":"…","recommendations":["…"]}

Contraintes :
- "overallScore" : entier de 1 à 10 reflétant la qualité comportementale moyenne de la cible (10 = parcours fluide pour toutes les personas).
- "summary" : 400 à 1200 caractères, en français, sans langue de bois, citant les défauts dominants.
- "recommendations" : 3 à 8 recommandations concrètes et priorisées, en français, une par élément.

Aucun texte en dehors du JSON.`;

export const simulationRunTool: ToolDefinition<z.infer<typeof SimulationRunInput>, SimulationRunResult> = {
  id: "simulation.run",
  name: "Agentic Social Simulation Studio",
  description:
    "Simule le comportement de vrais utilisateurs (personas novices, hackers, acheteurs pressés, sceptiques, power users) sur une cible réelle ou décrite, la teste en stress et produit un rapport de bugs comportementaux persisté avec constats par sévérité.",
  category: "system",
  risk: "medium",
  inputSchema: SimulationRunInput,
  async execute(input, context) {
    const warnings: string[] = [];

    // 1. Ancrage sur la page réelle si une URL est fournie (fail-soft).
    let ground = "";
    if (input.targetUrl) {
      try {
        ground = await fetchTargetGround(input.targetUrl, context);
      } catch (error) {
        warnings.push(
          `Impossible de récupérer la page cible (${error instanceof Error ? error.message : String(error)}) — la simulation s'ancre sur la description seule.`,
        );
      }
    }

    // 2. Sessions par persona — parallélisme borné (limite 3), erreurs isolées.
    const outcomes = await mapWithConcurrency(
      input.personas,
      3,
      async (persona) => {
        const brief =
          persona.archetype === "custom" && !persona.customBrief
            ? ARCHETYPE_BRIEFS.custom
            : [ARCHETYPE_BRIEFS[persona.archetype], persona.customBrief].filter(Boolean).join(" ");
        const userPrompt = [
          "CIBLE À TESTER",
          `Nom : ${input.targetName}`,
          `Description : ${input.targetDescription}`,
          ...(ground ? ["", `CONTENU RÉEL DE LA PAGE CIBLE (extrait) :\n${ground}`] : []),
          "",
          "SCÉNARIO À DÉROULER",
          input.scenario,
          "",
          `PERSONA : ${persona.name}`,
          `Profil (${persona.archetype}) : ${brief}`,
          "",
          `PROFONDEUR ATTENDUE : ${DEPTH_LABELS[input.depth]} (${DEPTH_STEPS_HINT[input.depth]} étapes environ).`,
          `Renvoie uniquement le JSON de la session simulée pour « ${persona.name} ».`,
        ].join("\n");

        const session = await generateStructuredForUser({
          userId: context.userId,
          executionId: context.executionId,
          task: "agent",
          system: PERSONA_SYSTEM_PROMPT,
          user: userPrompt,
          schema: SimulatedSessionSchema,
          maxTokens: 2_000,
        });
        // Le nom de persona est imposé côté serveur (déterminisme du rapport).
        return { ...session, personaName: persona.name };
      },
    );

    const sessions: SimulatedSession[] = [];
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        sessions.push(outcome.value);
        return;
      }
      // « rejected » : échec LLM réel ; « skipped » : persona jamais démarrée.
      const reason = outcome.status === "rejected" ? outcome.reason : "session non démarrée";
      warnings.push(
        `La simulation de la persona « ${input.personas[index].name} » a échoué : ${reason instanceof Error ? reason.message : String(reason)}.`,
      );
    });
    if (sessions.length === 0) {
      throw new Error("Aucune session de persona n'a pu être simulée — consultez les avertissements de l'exécution.");
    }

    // 3. Agrégation déterministe des constats.
    const findings = aggregateSimulationFindings(sessions);

    // 4. Synthèse LLM (facturée) au-dessus des sessions simulées.
    const synthesis = await generateStructuredForUser({
      userId: context.userId,
      executionId: context.executionId,
      task: "agent",
      system: SYNTHESIS_SYSTEM_PROMPT,
      user: [
        `CIBLE : ${input.targetName} — ${input.targetDescription}`,
        "",
        "SESSIONS SIMULÉES (agrégats déterministes inclus) :",
        JSON.stringify(
          {
            findings,
            sessions: sessions.map((session) => ({
              personaName: session.personaName,
              satisfactionScore: session.satisfactionScore,
              wouldAbandon: session.wouldAbandon,
              frictionPoints: session.frictionPoints,
              blockers: session.actions.filter((action) => action.outcome === "blocker").map((action) => action.action),
            })),
          },
          null,
          0,
        ),
        "",
        "Produis la synthèse JSON (overallScore, summary, recommendations) en français.",
      ].join("\n"),
      schema: SimulationSynthesisSchema,
      maxTokens: 1_500,
    });

    // 5. Rapport markdown français + persistance artefact réel.
    const markdown = renderSimulationReport({
      targetName: input.targetName,
      depth: input.depth,
      overallScore: synthesis.overallScore,
      summary: synthesis.summary,
      findings,
      sessions,
      recommendations: synthesis.recommendations,
    });
    const persisted = await persistMarkdownDeliverable({
      userId: context.userId,
      executionId: context.executionId,
      title: `Rapport de simulation — ${input.targetName}`,
      markdown,
      nameHint: "rapport-simulation",
    });

    return {
      report: {
        overallScore: synthesis.overallScore,
        summary: synthesis.summary,
        recommendations: synthesis.recommendations,
        findings,
        sessions,
      },
      warnings,
      artifactId: persisted.artifactId,
      filename: persisted.filename,
    };
  },
};

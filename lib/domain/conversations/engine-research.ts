import "server-only";

/* ------------------------------------------------------------------ */
/* DEEP RESEARCH gen3 (parité Gemini)                                  */
/* ------------------------------------------------------------------ */
/* Gemini livre « Deep Research » : un plan de recherche multi-axes,   */
/* une navigation web autonome, puis un rapport structuré et sourcé.   */
/* gen3 implémente la même chaîne avec SES outils RÉELS :              */
/*   1. plan déterministe (zéro LLM — aucune variance, aucune halluc.)  */
/*   2. recherches web réelles par axe (outil web.search — cascade      */
/*      Tavily/Serper/DuckDuckGo/Wikipédia déjà en place)               */
/*   3. lecture approfondie des 2 pages les plus pertinentes (web.open, */
/*      contenu réel récupéré serveur)                                  */
/*   4. rapport structuré rédigé par le moteur avec sources numérotées  */
/* Honnêteté : chaque axe sans résultat est DIT (section « Limites »),  */
/* aucune source n'est jamais inventée, le plan est annoncé tel quel.   */

import { executeTool } from "@/lib/tools/executor";
import { safeEmitter } from "./stream-events";
import { withTimeout } from "./engine-turn";
import type { ConversationTurnResult } from "./engine-turn";
import { CONVERSATION_EXECUTION_POLICY } from "./engine-tools";
import { runChatTurn } from "./engine-chat";
import type { TurnContext } from "./engine-chat";

/* ------------------------------------------------------------------ */
/* Détection déterministe de la demande                                */
/* ------------------------------------------------------------------ */

const DEMANDES_EXPLICITES = [
  /\bdeep research\b/i,
  /^\s*(recherche approfondie|recherche en profondeur|recherche complète|étude approfondie|étude en profondeur)\b/i,
  /^\s*(fais|mène|réalise|effectue|lance|démarre|genère)\b.{0,40}\b(recherche|étude)\b.{0,30}\b(approfondi|profonde|complète)s?\b/i,
  /^\s*fais[- ]moi\s+(une\s+)?(recherche|étude)\b.{0,40}\b(approfondi|profonde|complète)s?\b/i,
] as const;

/** Détection déterministe (aucune variance LLM) : demande explicite de
 *  recherche approfondie en tête de message, ou bouton du composer
 *  (`input.research`) — ce dernier est géré directement dans engine.ts. */
export function estDemandeRechercheApprofondie(message: string): boolean {
  return DEMANDES_EXPLICITES.some((pattern) => pattern.test(message.trim()));
}

/* ------------------------------------------------------------------ */
/* Plan de recherche déterministe                                      */
/* ------------------------------------------------------------------ */

export interface AxeRecherche {
  /** Titre humain de l'axe (affiché dans le flux et le rapport). */
  titre: string;
  /** Requête web réelle exécutée pour cet axe. */
  requete: string;
}

export interface PlanRecherche {
  /** Sujet nettoyé (préfixes de commande retirés). */
  sujet: string;
  axes: AxeRecherche[];
}

const PREFIXES_COMMANDE = [
  /^\s*fais[- ]moi[,\s]+/i,
  /^\s*s'il te plaît[,\s]+/i,
  /^\s*(mène|réalise|effectue|lance|démarre|genère|fais)\s+(une\s+|la\s+|le\s+)?(recherche|étude)\s+(approfondie|en profondeur|complète)\s*(sur|à propos de|concernant|de|du|des|d')?\s*/i,
  /^\s*(recherche|étude)\s+(approfondie|en profondeur|complète)\s*(sur|à propos de|concernant|de|du|des|d')?\s*/i,
  /^\s*deep research\s*[:,-]?\s*/i,
  /^\s*(recherche|étude)\s+en\s+profondeur\s*(sur|à propos de|concernant|de|du|des|d')?\s*/i,
] as const;

/** Construit le plan multi-axes (déterministe, zéro LLM) : la même demande
 *  produit toujours le même plan — l'utilisateur peut le vérifier. */
export function planRechercheApprofondie(message: string, annee = new Date().getFullYear()): PlanRecherche {
  let sujet = message.trim().slice(0, 400);
  for (const prefixe of PREFIXES_COMMANDE) {
    const suivant = sujet.replace(prefixe, "");
    if (suivant !== sujet) {
      sujet = suivant.trim();
      break; // un seul décapage : le reste du message est le sujet
    }
  }
  sujet = sujet.replace(/[\s.!?]+$/, "").slice(0, 220).trim() || message.trim().slice(0, 220);
  const noyau = sujet.slice(0, 180);
  return {
    sujet,
    axes: [
      { titre: "Vue d'ensemble", requete: noyau },
      { titre: "Définitions et mécanismes", requete: `${noyau} définition fonctionnement explication` },
      { titre: "Comparaison, avantages et limites", requete: `${noyau} avantages inconvénients limites comparaison` },
      { titre: "Données et actualités récentes", requete: `${noyau} chiffres statistiques actualités ${annee}` },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Extraction et mise en forme des résultats                           */
/* ------------------------------------------------------------------ */

interface ResultatWeb {
  titre: string;
  url: string;
  resume?: string;
}

/** Shape défensif : web.search renvoie { rapport, __interne.resultats }
 *  (contrat rapport — les résultats bruts vivent dans le champ interne),
 *  mais toute dérive de forme (fournisseur de repli, wrapper, ancien
 *  contrat { results }) doit rester non bloquante. */
function extraireResultats(output: unknown): ResultatWeb[] {
  let candidat: unknown = output;
  if (candidat && typeof candidat === "object") {
    const objet = candidat as Record<string, unknown>;
    const internes = (objet.__interne as { resultats?: unknown } | undefined)?.resultats;
    if (Array.isArray(internes)) {
      candidat = internes;
    } else if ("results" in objet) {
      candidat = objet.results;
    }
  }
  if (!Array.isArray(candidat)) return [];
  const resultats: ResultatWeb[] = [];
  for (const brut of candidat.slice(0, 8)) {
    if (!brut || typeof brut !== "object") continue;
    const item = brut as Record<string, unknown>;
    const url = typeof item.url === "string" ? item.url : "";
    if (!url) continue;
    resultats.push({
      titre: typeof item.title === "string" ? item.title.slice(0, 200) : url,
      url,
      resume: typeof item.snippet === "string" ? item.snippet.slice(0, 400) : undefined,
    });
  }
  return resultats;
}

/* ------------------------------------------------------------------ */
/* Tour de recherche approfondie                                       */
/* ------------------------------------------------------------------ */

const DIRECTIVE_RAPPORT = [
  "Tu livres le RAPPORT DE RECHERCHE APPROFONDIE gen3 (chaîne Deep Research réelle : plan multi-axes → recherches web → pages lues).",
  "Structure imposée : 1) « Synthèse » (5-10 lignes, réponse directe à la demande) ; 2) développements par axe thématique (une section markdown par axe du plan) ; 3) « Points de convergence et divergences » entre sources ; 4) « Sources consultées » (liste numérotée [1], [2]… des URL réellement récupérées) ; 5) « Limites de la recherche » (axes sans résultat, pages inaccessibles — dis-le HONNÊTEMENT, n'invente jamais une source ni un chiffre).",
  "Cite chaque affirmation issue du web avec son numéro de source [n]. Distingue clairement ce que les sources affirment de ce qui relève de ton expertise générale.",
].join("\n");

const MAX_PAGES_OUVERTES = 2;
const BUDGET_RECHERCHE_AXE_MS = 12_000;
const BUDGET_PAGE_MS = 15_000;

export async function runResearchTurn(ctx: Omit<TurnContext, "intent">): Promise<ConversationTurnResult> {
  const onEvent = safeEmitter(ctx.onEvent);
  const plan = planRechercheApprofondie(ctx.message);

  await onEvent({
    type: "status",
    phase: "execution",
    label: `Recherche approfondie — plan de ${plan.axes.length} axes préparé, recherches en cours…`,
    stage: "plan",
  });

  const sections: string[] = [];
  const urlsDejaVues = new Set<string>();
  const pagesCandidates: { url: string; titre: string }[] = [];
  let axesAvecResultats = 0;

  // ÉTAPE 2 — recherches web RÉELLES axe par axe (outil web.search existant,
  // même cascade de fournisseurs que le planificateur ; fail-soft par axe).
  for (const [index, axe] of plan.axes.entries()) {
    await onEvent({
      type: "status",
      phase: "execution",
      label: `Recherche approfondie — axe ${index + 1}/${plan.axes.length} : ${axe.titre}…`,
      stage: "search",
      percent: Math.round((index / plan.axes.length) * 60),
    });
    try {
      const resultat = await withTimeout(
        executeTool({
          userId: ctx.userId,
          executionId: `research-${ctx.conversationId}-${index + 1}`,
          projectId: ctx.projectId,
          toolName: "web.search",
          input: { query: axe.requete, maxResults: 6 },
          policy: CONVERSATION_EXECUTION_POLICY,
        }),
        BUDGET_RECHERCHE_AXE_MS,
        `recherche axe « ${axe.titre} »`,
      );
      const resultats = resultat.success ? extraireResultats(resultat.output) : [];
      if (resultats.length > 0) {
        axesAvecResultats += 1;
        const lignes = resultats.map((r, i) => `- [${index + 1}.${i + 1}] ${r.titre}${r.resume ? ` — ${r.resume}` : ""}\n  URL : ${r.url}`);
        sections.push(`Axe « ${axe.titre} » (requête : « ${axe.requete} ») — ${resultats.length} source(s) :\n${lignes.join("\n")}`);
        // La 1re source inédite de l'axe devient candidate à la lecture approfondie.
        const premiere = resultats.find((r) => !urlsDejaVues.has(r.url));
        if (premiere) {
          urlsDejaVues.add(premiere.url);
          pagesCandidates.push({ url: premiere.url, titre: premiere.titre });
        }
      } else {
        sections.push(`Axe « ${axe.titre} » (requête : « ${axe.requete} ») — aucun résultat exploitable.`);
      }
    } catch (erreur) {
      const raison = erreur instanceof Error ? erreur.message.slice(0, 120) : "indisponible";
      sections.push(`Axe « ${axe.titre} » (requête : « ${axe.requete} ») — recherche indisponible (${raison}).`);
    }
  }

  // ÉTAPE 3 — lecture approfondie des 2 meilleures pages (web.open, contenu
  // réel récupéré serveur) — c'est la différence avec une simple recherche :
  // le rapport s'appuie sur des pages LUES, pas seulement des extraits.
  let contenuPages = "";
  for (const [index, page] of pagesCandidates.slice(0, MAX_PAGES_OUVERTES).entries()) {
    await onEvent({
      type: "status",
      phase: "execution",
      label: `Recherche approfondie — lecture de la page ${index + 1}/${Math.min(MAX_PAGES_OUVERTES, pagesCandidates.length)} : ${page.titre.slice(0, 60)}…`,
      stage: "open",
      percent: 60 + Math.round(((index + 1) / MAX_PAGES_OUVERTES) * 20),
    });
    try {
      const ouverture = await withTimeout(
        executeTool({
          userId: ctx.userId,
          executionId: `research-open-${ctx.conversationId}-${index + 1}`,
          projectId: ctx.projectId,
          toolName: "web.open",
          input: { url: page.url },
          policy: CONVERSATION_EXECUTION_POLICY,
        }),
        BUDGET_PAGE_MS,
        `lecture « ${page.titre} »`,
      );
      const sortie = (ouverture.success ? ouverture.output : undefined) as { url?: string; text?: string } | undefined;
      const texte = typeof sortie?.text === "string" && sortie.text.trim() ? sortie.text.trim().slice(0, 12_000) : "";
      if (texte) {
        contenuPages += `\n\nPage lue « ${page.titre} » (${sortie?.url ?? page.url}) :\n${texte}`;
      } else {
        contenuPages += `\n\nPage « ${page.titre} » (${page.url}) : contenu indisponible (page non textuelle ou inaccessible).`;
      }
    } catch (erreur) {
      const raison = erreur instanceof Error ? erreur.message.slice(0, 120) : "indisponible";
      contenuPages += `\n\nPage « ${page.titre} » (${page.url}) : lecture impossible (${raison}).`;
    }
  }

  // ÉTAPE 4 — le rapport final est rédigé par le moteur de chat avec TOUT
  // le contexte réel réuni (plumbing complet réutilisé : streaming, self-
  // review selon l'effort choisi, persistance, mémoire épisodique).
  const webContextRecherche = [
    `[RECHERCHE APPROFONDIE gen3 — sources RÉELLEMENT récupérées par la plateforme au moment de la demande. Plan de recherche : ${plan.axes.length} axes sur « ${plan.sujet} », ${axesAvecResultats} axe(s) avec résultats.]`,
    sections.join("\n\n"),
    contenuPages ? `[CONTENU DES PAGES OUVERTES — texte réel des pages, tronqué :]${contenuPages}` : "",
  ].filter(Boolean).join("\n\n");
  const webContext = [ctx.webContext, webContextRecherche].filter(Boolean).join("\n\n---\n\n") || undefined;

  await onEvent({
    type: "status",
    phase: "synthesis",
    label: `Recherche approfondie — rédaction du rapport (${axesAvecResultats}/${plan.axes.length} axes exploitables)…`,
    stage: "report",
    percent: 85,
  });

  return runChatTurn({
    ...ctx,
    intent: {
      mode: "chat",
      understanding: `Recherche approfondie multi-axes sur « ${plan.sujet} » (${plan.axes.length} axes, ${axesAvecResultats} avec résultats, ${pagesCandidates.length} page(s) lue(s)).`,
    },
    webContext,
    systemDirectiveAppendix: DIRECTIVE_RAPPORT,
  });
}

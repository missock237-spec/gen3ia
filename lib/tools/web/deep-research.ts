import { z } from "zod";

import { markupToText } from "@/lib/content/html-text";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import { construireRequetesRecherche, evalueDifficulte, MAX_PAGES_RECHERCHE, MIN_PAGES_RECHERCHE } from "@/lib/ai/raisonnement-profond";

import { searchWeb } from "./search";
import type { ToolDefinition } from "../types";

/**
 * RECHERCHE WEB MULTI-PAGES DE GEN3 (demande produit 2026-11-22).
 *
 * Contrairement à web.search (une requête, des extraits), cet outil mène une
 * RECHERCHE APPROFONDIE sur une tâche :
 *  1. évalue la difficulté de l'objectif (déterministe, zéro LLM) ;
 *  2. construit plusieurs requêtes différenciées (cœur + angles d'analyse) ;
 *  3. collecte les candidats (dédup par URL, diversité par domaine —
 *     maximum 3 pages par domaine pour éviter l'homogénéité) ;
 *  4. OUVRE RÉELLEMENT les pages (garde SSRF assertPublicHttpUrl, extraction
 *     texte) jusqu'au budget requis — PLANCHER ABSOLU 10 pages ;
 *  5. renvoie un bloc honnête : pages exigées vs pages ouvertes, échecs
 *     explicites, extraits sourcés — jamais de page inventée.
 *
 * Toute tâche Gen3 passe par ici (planner universel, bouton « Recherche
 * web », contexte systématique du chat) : l'agent comprend la demande avec
 * de vraies sources, proportionnellement à la difficulté du prompt.
 */

const PAGE_TIMEOUT_MS = 12_000;
/** Caractères extraits conservés par page (extrait sourcé). */
const EXTRAIT_PAR_PAGE = 1_600;
/** Pages ouvertes au maximum par exécution (budget global). */
const MAX_PAGES_PAR_EXECUTION = MAX_PAGES_RECHERCHE;
/** Pages maximum par domaine (diversité des sources). */
const MAX_PAR_DOMAINE = 3;

const DeepResearchInput = z.object({
  objective: z.string().min(3).max(20_000),
  /** Plancher demandé par l'appelant (ex. pages calculées par le planner). */
  minPages: z.number().int().min(1).max(MAX_PAGES_RECHERCHE).optional(),
  /** Budget temps total de la recherche (ms). */
  budgetMs: z.number().int().min(5_000).max(180_000).optional(),
});

export interface DeepResearchFinding {
  url: string;
  titre: string;
  extrait: string;
}

export interface DeepResearchResult {
  /** Pages exigées (plancher 10, croît avec la difficulté). */
  pagesRequises: number;
  /** Pages réellement ouvertes et extraites. */
  pagesOuvertes: number;
  /** Pages demandées au moteur mais non lues (échec explicite). */
  echecs: Array<{ url: string; raison: string }>;
  requetes: string[];
  resultats: DeepResearchFinding[];
  /** Synthèse brute sourcée injectable dans un prompt (bornée). */
  synthese: string;
  dureeMs: number;
}

/** Normalise une URL pour dédup (fragment et slash final retirés). */
function normaliserUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const s = parsed.toString();
    return s.endsWith("/") ? s.slice(0, -1) : s;
  } catch {
    return url;
  }
}

/** Ouvre une page publique (SSRF-gardée) et en extrait le texte réel. */
async function ouvrirPage(url: string, signal?: AbortSignal): Promise<string> {
  const safeUrl = await assertPublicHttpUrl(url);
  let response = await fetch(safeUrl, {
    redirect: "manual",
    headers: { "User-Agent": "Gen3ia-AI-Studio/1.0" },
    signal: signal ?? AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("redirection sans cible");
    const redirected = await assertPublicHttpUrl(new URL(location, safeUrl).toString());
    response = await fetch(redirected, {
      redirect: "manual",
      headers: { "User-Agent": "Gen3ia-AI-Studio/1.0" },
      signal: signal ?? AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new Error(`type non supporté : ${contentType}`);
  }
  const html = await response.text();
  if (Buffer.byteLength(html, "utf8") > 5_000_000) throw new Error("page > 5 MiB");
  return markupToText(html);
}

export async function executeDeepResearch(
  input: z.infer<typeof DeepResearchInput>,
  context?: { signal?: AbortSignal },
): Promise<DeepResearchResult> {
  const debut = Date.now();
  const evaluation = evalueDifficulte(input.objective);
  // Plancher ABSOLU 10 pages (exigence produit) — le maximum gagne toujours.
  const pagesRequises = Math.max(MIN_PAGES_RECHERCHE, evaluation.pagesRequises, input.minPages ?? 0);
  const budgetMs = input.budgetMs ?? 60_000;
  const deadline = debut + budgetMs;

  // 1-2. Requêtes différenciées → candidats (dédup + diversité par domaine).
  const requetes = construireRequetesRecherche(input.objective, evaluation);
  const candidats = new Map<string, { url: string; titre: string }>();
  for (const requete of requetes) {
    if (candidats.size >= MAX_PAGES_PAR_EXECUTION * 2 || Date.now() >= deadline - 4_000) break;
    try {
      const resultats = await searchWeb(requete, 10);
      for (const resultat of resultats) {
        const cle = normaliserUrl(resultat.url);
        if (!candidats.has(cle)) candidats.set(cle, { url: resultat.url, titre: resultat.title });
      }
    } catch {
      /* un moteur indisponible n'annule pas la recherche — angle suivant */
    }
  }

  // 3-4. Diversité par domaine puis ouverture réelle des pages.
  const parDomaine = new Map<string, number>();
  const ordonnés = [...candidats.values()].filter((candidat) => {
    try {
      const domaine = new URL(candidat.url).hostname;
      const count = parDomaine.get(domaine) ?? 0;
      if (count >= MAX_PAR_DOMAINE) return false;
      parDomaine.set(domaine, count + 1);
      return true;
    } catch {
      return false;
    }
  });

  const resultats: DeepResearchFinding[] = [];
  const echecs: Array<{ url: string; raison: string }> = [];
  for (const candidat of ordonnés) {
    if (resultats.length >= pagesRequises) break;
    if (Date.now() >= deadline - 2_000) break;
    if (context?.signal?.aborted) break;
    try {
      const texte = await ouvrirPage(candidat.url, context?.signal);
      const extrait = texte.trim().slice(0, EXTRAIT_PAR_PAGE);
      if (!extrait) {
        echecs.push({ url: candidat.url, raison: "page sans texte extractible" });
        continue;
      }
      resultats.push({ url: candidat.url, titre: candidat.titre, extrait });
    } catch (error) {
      echecs.push({ url: candidat.url, raison: error instanceof Error ? error.message : "échec de récupération" });
    }
  }

  // 5. Bloc honnête : la synthèse porte les sources réelles, jamais inventées.
  const synthese = [
    `RECHERCHE WEB APPROFONDIE — objectif : ${input.objective.trim().slice(0, 300)}`,
    `Pages exigées : ${pagesRequises} (difficulté « ${evaluation.niveau} », score ${evaluation.score}/100) — pages réellement lues : ${resultats.length}${echecs.length > 0 ? ` — échecs explicites : ${echecs.length}` : ""}.`,
    ...(resultats.length < pagesRequises
      ? [`NOTE HONNÊTE : budget de ${resultats.length}/${pagesRequises} pages atteint (temps/moteurs) — raisonne avec ces sources réelles et signale la limite.`]
      : []),
    ...resultats.map((finding, index) => `[${index + 1}] ${finding.titre || "(sans titre)"} — ${finding.url}\n${finding.extrait}`),
  ].join("\n\n").slice(0, 60_000);

  return {
    pagesRequises,
    pagesOuvertes: resultats.length,
    echecs,
    requetes,
    resultats,
    synthese,
    dureeMs: Date.now() - debut,
  };
}

export const webDeepResearchTool: ToolDefinition<
  z.infer<typeof DeepResearchInput>,
  DeepResearchResult
> = {
  id: "web.deep_research",
  name: "Web Deep Research",
  description:
    "Recherche web approfondie multi-pages : plusieurs requêtes différenciées puis lecture RÉELLE d'au moins 10 pages web (plancher, croît avec la difficulté de la demande) — renvoie des extraits sourcés pour fonder la compréhension et le raisonnement.",
  category: "web",
  risk: "low",
  inputSchema: DeepResearchInput,
  async execute(input, context) {
    return executeDeepResearch(input, { signal: context.signal });
  },
};

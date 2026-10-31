/**
 * LECTEUR DU RAPPORT D'AMÉLIORATION CONTINUE (it.65) — source unique des
 * surfaces serveur (API /api/neural/domaines + page /vocation + console).
 *
 * Demande propriétaire : « crée un système qui va permettre à gen3
 * d'apprendre du générateur de dataset, pour qu'il puisse toujours
 * continuer à s'améliorer en continu... crée 5 millions de données...
 * entraîne gen3... continue jusqu'à ce qu'il atteigne le niveau requis ».
 *
 * HONNÊTETÉ : le fichier committé (assets/neural-pretrained/
 * amelioration-continue-gen3-it65.json) est produit par la campagne réelle
 * (scripts/amelioration-continue-gen3.ts) — échantillons réellement
 * traités, sondes vs témoin vierge, niveau requis C1-C5 rapporté tel quel
 * (un critère non atteint est affiché comme tel). Si le fichier est absent
 * ou illisible, le lecteur retourne null — AUCUN chiffre inventé.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Chemin du rapport committé par la campagne d'amélioration continue. */
export const RAPPORT_CONTINUE_PATH = join(
  process.cwd(),
  "assets/neural-pretrained/amelioration-continue-gen3-it65.json",
);

/** Forme lue du rapport brut (ce que la campagne écrit — cf. le script). */
interface RapportContinueBrut {
  date?: unknown;
  methode?: unknown;
  contexte?: unknown;
  options?: {
    cyclesParEchantillon?: unknown;
    lrBoost?: unknown;
    tailleLot?: unknown;
    plan?: unknown;
    graine?: unknown;
    epoquesConsolidation?: unknown;
    epoquesMax?: unknown;
  };
  sources?: { generateur?: unknown; depot?: unknown; totalSession?: unknown };
  totalEchantillons?: unknown;
  horlogeFinale?: unknown;
  metabolisme?: { evaluees?: unknown; reposes?: unknown; transmissions?: unknown; ms?: unknown };
  bilan?: {
    donneesParDomaine?: { ok?: unknown; total?: unknown };
    porteursRenforces?: { ok?: unknown; total?: unknown; renfortsTotaux?: unknown };
    stabiliteBandes?: { ok?: unknown; total?: unknown };
    traceParDomaine?: { ok?: unknown; total?: unknown };
    vocabulaire?: { ok?: unknown; total?: unknown };
  };
  niveauRequis?: Record<
    string,
    { requis?: unknown; constate?: unknown; atteint?: unknown } | undefined
  >;
  domaineRapports?: Array<{
    domaine?: unknown;
    label?: unknown;
    bande?: unknown;
    porteurFrequence?: unknown;
    echantillons?: unknown;
    depot?: unknown;
    renforts?: unknown;
    annulations?: unknown;
    porteurLecture?: unknown;
    sondeTrace?: { gain?: unknown };
    sondeVocabulaire?: { gain?: unknown };
    generalisation?: { gain?: unknown };
    lectureBandeStable?: unknown;
  }>;
  limitesHonnetes?: unknown;
}

/** Résumé typé exposé aux surfaces. */
export interface ResumeContinue {
  date: string;
  methode: string;
  contexte: string;
  totalEchantillons: number;
  sources: { generateur: number; depot: number; totalSession: number };
  epoquesConsolidation: number;
  epoquesMax: number;
  lot: number;
  metabolisme: { evaluees: number; reposes: number; transmissions: number; ms: number };
  bilan: {
    donneesParDomaine: { ok: number; total: number };
    porteursRenforces: { ok: number; total: number; renfortsTotaux: number };
    stabiliteBandes: { ok: number; total: number };
    traceParDomaine: { ok: number; total: number };
    vocabulaire: { ok: number; total: number };
  };
  /** Niveau requis C1-C5 : critères opérationnels du propriétaire, rapportés tels quels. */
  niveauRequis: Array<{ critere: string; requis: string; constate: string; atteint: boolean }>;
  parDomaine: Array<{
    id: string;
    label: string;
    bande: number;
    echantillons: number;
    depot: number;
    renforts: number;
    gainTrace: number;
    gainVocabulaire: number;
    gainGeneralisation: number;
    porteurLecture: number;
    bandeStable: boolean;
  }>;
  limitesHonnetes: string[];
}

const CACHE_GLOBAL = globalThis as typeof globalThis & {
  __gen3ResumeContinueIt65?: ResumeContinue | null;
};

/** Valide grossièrement la forme brute (pas de crash sur fichier étranger). */
function estBrutPlausible(v: unknown): v is RapportContinueBrut {
  return (
    typeof v === "object" &&
    v !== null &&
    "totalEchantillons" in v &&
    "bilan" in v &&
    "niveauRequis" in v
  );
}

function nombre(v: unknown, defaut = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : defaut;
}

function chaine(v: unknown, defaut = ""): string {
  return typeof v === "string" ? v : defaut;
}

/**
 * Lit (et met en cache) le résumé de la campagne d'amélioration continue.
 * Retourne null si le rapport committé est absent ou illisible — jamais de
 * valeur fabriquée. `chemin` injectable (tests) : seul le chemin par défaut
 * bénéficie du cache.
 */
export function lireResumeContinue(
  chemin: string = RAPPORT_CONTINUE_PATH,
): ResumeContinue | null {
  const depuisCache =
    chemin === RAPPORT_CONTINUE_PATH ? CACHE_GLOBAL.__gen3ResumeContinueIt65 : undefined;
  if (depuisCache !== undefined) return depuisCache;
  let resume: ResumeContinue | null = null;
  try {
    if (existsSync(chemin)) {
      const brut: unknown = JSON.parse(readFileSync(chemin, "utf8"));
      if (estBrutPlausible(brut)) {
        const r = brut as RapportContinueBrut;
        const parDomaine: ResumeContinue["parDomaine"] = [];
        for (const d of r.domaineRapports ?? []) {
          if (typeof d.domaine !== "string") continue;
          parDomaine.push({
            id: d.domaine,
            label: chaine(d.label),
            bande: nombre(d.bande),
            echantillons: nombre(d.echantillons),
            depot: nombre(d.depot),
            renforts: nombre(d.renforts),
            gainTrace: nombre(d.sondeTrace?.gain),
            gainVocabulaire: nombre(d.sondeVocabulaire?.gain),
            gainGeneralisation: nombre(d.generalisation?.gain),
            porteurLecture: nombre(d.porteurLecture),
            bandeStable: d.lectureBandeStable === true,
          });
        }
        const niveau: ResumeContinue["niveauRequis"] = [];
        for (const [cle, v] of Object.entries(r.niveauRequis ?? {})) {
          if (!v) continue;
          niveau.push({
            critere: cle,
            requis: chaine(v.requis),
            constate: chaine(v.constate),
            atteint: v.atteint === true,
          });
        }
        const limites = Array.isArray(r.limitesHonnetes)
          ? r.limitesHonnetes.filter((l): l is string => typeof l === "string")
          : [];
        resume = {
          date: chaine(r.date),
          methode: chaine(r.methode),
          contexte: chaine(r.contexte),
          totalEchantillons: nombre(r.totalEchantillons),
          sources: {
            generateur: nombre(r.sources?.generateur),
            depot: nombre(r.sources?.depot),
            totalSession: nombre(r.sources?.totalSession),
          },
          epoquesConsolidation: nombre(r.options?.epoquesConsolidation),
          epoquesMax: nombre(r.options?.epoquesMax),
          lot: nombre(r.options?.tailleLot),
          metabolisme: {
            evaluees: nombre(r.metabolisme?.evaluees),
            reposes: nombre(r.metabolisme?.reposes),
            transmissions: nombre(r.metabolisme?.transmissions),
            ms: nombre(r.metabolisme?.ms),
          },
          bilan: {
            donneesParDomaine: {
              ok: nombre(r.bilan?.donneesParDomaine?.ok),
              total: nombre(r.bilan?.donneesParDomaine?.total),
            },
            porteursRenforces: {
              ok: nombre(r.bilan?.porteursRenforces?.ok),
              total: nombre(r.bilan?.porteursRenforces?.total),
              renfortsTotaux: nombre(r.bilan?.porteursRenforces?.renfortsTotaux),
            },
            stabiliteBandes: {
              ok: nombre(r.bilan?.stabiliteBandes?.ok),
              total: nombre(r.bilan?.stabiliteBandes?.total),
            },
            traceParDomaine: {
              ok: nombre(r.bilan?.traceParDomaine?.ok),
              total: nombre(r.bilan?.traceParDomaine?.total),
            },
            vocabulaire: {
              ok: nombre(r.bilan?.vocabulaire?.ok),
              total: nombre(r.bilan?.vocabulaire?.total),
            },
          },
          niveauRequis: niveau,
          parDomaine,
          limitesHonnetes: limites,
        };
      }
    }
  } catch {
    resume = null;
  }
  if (chemin === RAPPORT_CONTINUE_PATH) CACHE_GLOBAL.__gen3ResumeContinueIt65 = resume;
  return resume;
}

/** Invalide le cache (tests). */
export function reinitialiserCacheContinue(): void {
  delete CACHE_GLOBAL.__gen3ResumeContinueIt65;
}

/**
 * LECTEUR DU RAPPORT DE LA SESSION MILLION À DONNÉES UNIQUES (it.63,
 * campagne A) — source unique du résumé pour les surfaces serveur
 * (API /api/neural/domaines + page publique /vocation + console /neural).
 *
 * HONNÊTETÉ : le fichier committé (assets/neural-pretrained/
 * preentrainement-eod-million-19-domaines.json) est produit par la campagne
 * réelle (scripts/preentrainement-million.ts) — 1 005 000 textes UNIQUES
 * par domaine (bijection mixte-radix), chaque échantillon traversant la
 * pipeline EOD complète. Si le fichier est absent ou illisible, le lecteur
 * retourne null — AUCUN chiffre inventé, la surface affiche le repli
 * honnête (campagne non committée).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Chemin du rapport committé par la campagne (session million, campagne A). */
export const RAPPORT_MILLION_PATH = join(
  process.cwd(),
  "assets/neural-pretrained/preentrainement-eod-million-19-domaines.json",
);

/** Forme lue du rapport brut (ce que la campagne écrit — cf. le script). */
interface RapportMillionBrut {
  date?: unknown;
  methode?: unknown;
  contexte?: unknown;
  options?: { cyclesParEchantillon?: unknown; lrBoost?: unknown; tailleLot?: unknown; plan?: unknown };
  sources?: {
    depot?: unknown;
    huggingface?: unknown;
    proceduraux?: unknown;
    totalSession?: unknown;
  };
  totalEchantillons?: unknown;
  bilan?: {
    donneesParDomaine?: { ok?: unknown; total?: unknown };
    porteursRenforces?: { ok?: unknown; total?: unknown; renfortsTotaux?: unknown };
    stabiliteBandes?: { ok?: unknown; total?: unknown };
    traceParDomaine?: { ok?: unknown; total?: unknown };
  };
  assimiles?: { trace?: unknown; total?: unknown };
  sonde?: {
    vocabulaire?: { avant?: unknown; apres?: unknown };
  };
  metabolisme?: { evaluees?: unknown; reposes?: unknown; transmissions?: unknown; ms?: unknown };
  domaines?: Array<{
    domaine?: unknown;
    label?: unknown;
    bande?: unknown;
    porteurFrequence?: unknown;
    echantillons?: unknown;
    renforts?: unknown;
    annulations?: unknown;
    sondeTrace?: { gain?: unknown };
    sondeVocabulaire?: { gain?: unknown };
  }>;
  limitesHonnetes?: unknown;
}

/** Résumé typé exposé aux surfaces (API + page /vocation + console). */
export interface ResumeMillion {
  date: string;
  methode: string;
  contexte: string;
  totalEchantillons: number;
  lot: number;
  cyclesParEchantillon: number;
  plan: string;
  sources: { depot: number; huggingface: number; proceduraux: number; totalSession: number };
  /** Bilan à quatre signaux de la campagne (ok/total, rapportés tels quels). */
  bilan: {
    donneesParDomaine: { ok: number; total: number };
    porteursRenforces: { ok: number; total: number; renfortsTotaux: number };
    stabiliteBandes: { ok: number; total: number };
    traceParDomaine: { ok: number; total: number };
  };
  assimilesTrace: number;
  totalDomaines: number;
  sondeVocabulaire: { avant: number; apres: number };
  metabolisme: { evaluees: number; reposes: number; transmissions: number; ms: number };
  /** Par domaine : échantillons réellement traités + mesures du bus. */
  parDomaine: Array<{
    id: string;
    label: string;
    bande: number;
    porteurFrequence: number;
    echantillons: number;
    renforts: number;
    annulations: number;
    gainTrace: number;
    gainVocabulaire: number;
  }>;
  /** Limites honnêtes documentées par la campagne (rapportées telles quelles). */
  limitesHonnetes: string[];
}

const CACHE_GLOBAL = globalThis as typeof globalThis & {
  __gen3ResumeMillionIt64?: ResumeMillion | null;
};

/** Valide grossièrement la forme brute (pas de crash sur fichier étranger). */
function estBrutPlausible(v: unknown): v is RapportMillionBrut {
  return (
    typeof v === "object" &&
    v !== null &&
    "totalEchantillons" in v &&
    "bilan" in v &&
    "domaines" in v &&
    Array.isArray((v as RapportMillionBrut).domaines)
  );
}

function nombre(v: unknown, defaut = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : defaut;
}

function chaine(v: unknown, defaut = ""): string {
  return typeof v === "string" ? v : defaut;
}

/**
 * Lit (et met en cache) le résumé de la session million (campagne A).
 * Retourne null si le rapport committé est absent ou illisible — jamais de
 * valeur fabriquée. Le paramètre `chemin` est injectable (tests) : seul le
 * chemin par défaut bénéficie du cache (un rapport injecté est relu à
 * chaque appel).
 */
export function lireResumeMillion(
  chemin: string = RAPPORT_MILLION_PATH,
): ResumeMillion | null {
  const depuisCache =
    chemin === RAPPORT_MILLION_PATH ? CACHE_GLOBAL.__gen3ResumeMillionIt64 : undefined;
  if (depuisCache !== undefined) return depuisCache;
  let resume: ResumeMillion | null = null;
  try {
    if (existsSync(chemin)) {
      const brut: unknown = JSON.parse(readFileSync(chemin, "utf8"));
      if (estBrutPlausible(brut)) {
        const r = brut as RapportMillionBrut;
        const parDomaine: ResumeMillion["parDomaine"] = [];
        for (const d of r.domaines ?? []) {
          if (typeof d.domaine !== "string") continue;
          parDomaine.push({
            id: d.domaine,
            label: chaine(d.label),
            bande: nombre(d.bande),
            porteurFrequence: nombre(d.porteurFrequence),
            echantillons: nombre(d.echantillons),
            renforts: nombre(d.renforts),
            annulations: nombre(d.annulations),
            gainTrace: nombre(d.sondeTrace?.gain),
            gainVocabulaire: nombre(d.sondeVocabulaire?.gain),
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
          lot: nombre(r.options?.tailleLot),
          cyclesParEchantillon: nombre(r.options?.cyclesParEchantillon),
          plan: chaine(r.options?.plan),
          sources: {
            depot: nombre(r.sources?.depot),
            huggingface: nombre(r.sources?.huggingface),
            proceduraux: nombre(r.sources?.proceduraux),
            totalSession: nombre(r.sources?.totalSession),
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
          },
          assimilesTrace: nombre(r.assimiles?.trace),
          totalDomaines: nombre(r.assimiles?.total),
          sondeVocabulaire: {
            avant: nombre(r.sonde?.vocabulaire?.avant),
            apres: nombre(r.sonde?.vocabulaire?.apres),
          },
          metabolisme: {
            evaluees: nombre(r.metabolisme?.evaluees),
            reposes: nombre(r.metabolisme?.reposes),
            transmissions: nombre(r.metabolisme?.transmissions),
            ms: nombre(r.metabolisme?.ms),
          },
          parDomaine,
          limitesHonnetes: limites,
        };
      }
    }
  } catch {
    resume = null;
  }
  if (chemin === RAPPORT_MILLION_PATH) CACHE_GLOBAL.__gen3ResumeMillionIt64 = resume;
  return resume;
}

/** Invalide le cache (tests). */
export function reinitialiserCacheMillion(): void {
  delete CACHE_GLOBAL.__gen3ResumeMillionIt64;
}

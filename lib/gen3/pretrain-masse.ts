/**
 * LECTEUR DU RAPPORT DE PRÉ-ENTRAÎNEMENT MASSIF (it.63) — source unique
 * du résumé de campagne pour les surfaces serveur (API /api/neural/domaines
 * + page publique /vocation).
 *
 * HONNÊTETÉ : le fichier committé (assets/neural-pretrained/
 * preentrainement-masse-1m-it63.json) est produit par la campagne réelle
 * (scripts/pretrain-masse-1m-it63.ts) — échantillons réellement traités,
 * sonde TRACE/GÉNÉRALISATION comparée à un cortex témoin. Si le fichier
 * est absent ou illisible, le lecteur retourne null — AUCUN chiffre
 * inventé, la surface affiche alors « campagne non committée ».
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Chemin du rapport committé par la campagne. */
export const RAPPORT_MASSE_PATH = join(
  process.cwd(),
  "assets/neural-pretrained/preentrainement-masse-1m-it63.json",
);

/** Forme lue du rapport (ce que la campagne écrit — cf. le script). */
interface RapportMasseBrut {
  date?: unknown;
  methode?: unknown;
  contexte?: unknown;
  cortex?: unknown;
  options?: { lot?: unknown; epoques?: unknown; seuilAssimile?: unknown; ordonnancement?: unknown };
  sources?: { description?: unknown; domainesSansCorpus?: unknown };
  totalEchantillons?: unknown;
  echantillonsParDomaine?: unknown;
  horlogeFinale?: unknown;
  metabolisme?: unknown;
  sonde?: {
    assimiles?: unknown;
    total?: unknown;
    seuilAssimile?: unknown;
    domaines?: Array<{
      domaine?: unknown;
      bande?: unknown;
      porteurFrequence?: unknown;
      echantillons?: unknown;
      trace?: { ratios?: unknown; ratiosTemoin?: unknown; gain?: unknown; assimile?: unknown };
      generalisation?: { ratio?: unknown; ratioTemoin?: unknown; gain?: unknown };
    }>;
  };
  dureeMs?: unknown;
}

/** Résumé typé exposé aux surfaces (API + page /vocation). */
export interface ResumeMasse {
  date: string;
  methode: string;
  contexte: string;
  epoques: number;
  lot: number;
  totalEchantillons: number;
  echantillonsParDomaine: Record<string, number>;
  assimiles: number;
  totalDomaines: number;
  seuilAssimile: number;
  /** Par domaine : échantillons réellement traités + gains de sonde mesurés. */
  parDomaine: Array<{
    id: string;
    echantillons: number;
    gainTrace: number;
    assimile: boolean;
    gainGeneralisation: number;
  }>;
  /** État de l'artefact cortical committé (amorçage production). */
  artefactCortical: { present: boolean; tailleOctets: number | null };
}

const CACHE_GLOBAL = globalThis as typeof globalThis & {
  __gen3ResumeMasseIt63?: ResumeMasse | null;
};

/** Valide grossièrement la forme brute (pas de crash sur fichier étranger). */
function estBrutPlausible(v: unknown): v is RapportMasseBrut {
  return (
    typeof v === "object" &&
    v !== null &&
    "totalEchantillons" in v &&
    "sonde" in v &&
    typeof (v as RapportMasseBrut).sonde === "object" &&
    (v as RapportMasseBrut).sonde !== null
  );
}

/**
 * Lit (et met en cache) le résumé de la campagne. Retourne null si le
 * rapport committé est absent ou illisible — jamais de valeur fabriquée.
 * Le paramètre `chemin` est injectable (tests) : seul le chemin par défaut
 * bénéficie du cache (un rapport injecté est relu à chaque appel).
 * `cheminCortex` est injectable (tests hermétiques) : par défaut l'artefact
 * cortical réel du dépôt local (présence et taille rapportées telles quelles).
 */
export function lireResumeMasse(
  chemin: string = RAPPORT_MASSE_PATH,
  cheminCortex: string = join(process.cwd(), "assets/neural-pretrained/cortex-v2.bin"),
): ResumeMasse | null {
  const depuisCache =
    chemin === RAPPORT_MASSE_PATH ? CACHE_GLOBAL.__gen3ResumeMasseIt63 : undefined;
  if (depuisCache !== undefined) return depuisCache;
  let resume: ResumeMasse | null = null;
  try {
    if (existsSync(chemin)) {
      const brut: unknown = JSON.parse(readFileSync(chemin, "utf8"));
      if (estBrutPlausible(brut)) {
        const r = brut as RapportMasseBrut;
        const parDomaine: ResumeMasse["parDomaine"] = [];
        for (const d of r.sonde?.domaines ?? []) {
          if (typeof d.domaine !== "string") continue;
          parDomaine.push({
            id: d.domaine,
            echantillons: typeof d.echantillons === "number" ? d.echantillons : 0,
            gainTrace: typeof d.trace?.gain === "number" ? d.trace.gain : 0,
            assimile: d.trace?.assimile === true,
            gainGeneralisation:
              typeof d.generalisation?.gain === "number" ? d.generalisation.gain : 0,
          });
        }
        let tailleOctets: number | null = null;
        try {
          tailleOctets = statSync(cheminCortex).size;
        } catch {
          tailleOctets = null;
        }
        resume = {
          date: typeof r.date === "string" ? r.date : "",
          methode: typeof r.methode === "string" ? r.methode : "",
          contexte: typeof r.contexte === "string" ? r.contexte : "",
          epoques: typeof r.options?.epoques === "number" ? r.options.epoques : 0,
          lot: typeof r.options?.lot === "number" ? r.options.lot : 0,
          totalEchantillons: typeof r.totalEchantillons === "number" ? r.totalEchantillons : 0,
          echantillonsParDomaine:
            typeof r.echantillonsParDomaine === "object" && r.echantillonsParDomaine !== null
              ? (r.echantillonsParDomaine as Record<string, number>)
              : {},
          assimiles: typeof r.sonde?.assimiles === "number" ? r.sonde.assimiles : 0,
          totalDomaines: typeof r.sonde?.total === "number" ? r.sonde.total : 0,
          seuilAssimile: typeof r.sonde?.seuilAssimile === "number" ? r.sonde.seuilAssimile : 0,
          parDomaine,
          artefactCortical: { present: tailleOctets !== null, tailleOctets },
        };
      }
    }
  } catch {
    resume = null;
  }
  if (chemin === RAPPORT_MASSE_PATH) CACHE_GLOBAL.__gen3ResumeMasseIt63 = resume;
  return resume;
}

/** Invalide le cache (tests). */
export function reinitialiserCacheMasse(): void {
  delete CACHE_GLOBAL.__gen3ResumeMasseIt63;
}

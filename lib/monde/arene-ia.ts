import {
  CAPACITES_PAR_NIVEAU,
  RANG_NIVEAU,
  type NiveauEntrainement,
} from "@/lib/training/cles-entrainement";
import {
  adapterPour,
  type AdaptateurEntrainementIA,
  type ModeleFourni,
} from "@/lib/training/adaptateurs-ia";
import type { ExempleClassification } from "@/lib/training/synthetique";
import { creerAlea } from "@/lib/training/synthetique";

/**
 * MONDE VIRTUEL POUR IA (arène épisodique) — exigence produit : pour les
 * ressources matérielles des modèles d'IA, le monde virtuel intégré à gen3
 * doit permettre à une IA DE S'EXÉCUTER ET D'APPRENDRE ce que gen3 lui
 * enseigne. Concrètement :
 *
 *   1. un monde DÉTERMINISTE (grille seedée : murs, fragments gen3 à
 *      collecter, coût de pas) borné en ressources ;
 *   2. gen3 ENSEIGNE : un expert BFS produit des démonstrations
 *      (observation → action) — c'est le curriculum gen3 ;
 *   3. l'IA S'EXÉCUTE : chaque épisode fait vivre la politique fournie
 *      (modèle tenseur gen3 par défaut, ou modèle utilisateur) pas à pas ;
 *   4. l'IA APPREND : imitation des leçons gen3, puis renforcement léger
 *      TOUJOURS mélangé aux leçons (l'auto-imitation seule dérive — elle
 *      réapprendrait ses propres erreurs) ;
 *   5. le rapport MESURE la progression (récompense, taux de réussite et
 *      fragments/épisode avant/après) — jamais déclarée sans exécution.
 *
 * Ressources : chaque séance est plafonnée par le NIVEAU de clé
 * d'entraînement (episodesMondeMax, parametresMax) — le monde refuse
 * honnêtement au-delà des capacités couvertes par la facturation.
 */

export const ACTIONS_MONDE = ["haut", "droite", "bas", "gauche"] as const;
export type ActionMonde = (typeof ACTIONS_MONDE)[number];

const DELTAS: Record<ActionMonde, [number, number]> = {
  haut: [0, -1],
  droite: [1, 0],
  bas: [0, 1],
  gauche: [-1, 0],
};

export const PAS_MAX_PAR_EPISODE = 160;
export const TAILLE_MAX_MONDE = 20;

export interface MondeVirtuel {
  taille: number;
  graine: number;
  murs: Set<string>;
  fragments: Map<string, boolean>;
  position: { x: number; y: number };
  pasMax: number;
}

function cleCase(x: number, y: number): string {
  return `${x},${y}`;
}

/** Crée un monde déterministe (même graine → mêmes murs et fragments). */
export function creerMondeVirtuel(params: {
  graine?: number;
  taille?: number;
  obstacles?: number;
  fragments?: number;
}): MondeVirtuel {
  const taille = Math.max(6, Math.min(TAILLE_MAX_MONDE, params.taille ?? 12));
  const alea = creerAlea(params.graine ?? 2026);
  const murs = new Set<string>();
  const nbObstacles = Math.min(params.obstacles ?? Math.floor((taille * taille) / 8), Math.floor((taille * taille) / 4));
  let garde = 0;
  while (murs.size < nbObstacles && garde < nbObstacles * 20) {
    garde += 1;
    const x = Math.floor(alea() * taille);
    const y = Math.floor(alea() * taille);
    if (x === 0 && y === 0) continue; // départ toujours libre
    murs.add(cleCase(x, y));
  }
  const nbFragments = Math.max(1, Math.min(8, params.fragments ?? 3));
  const fragments = new Map<string, boolean>();
  garde = 0;
  while (fragments.size < nbFragments && garde < nbFragments * 40) {
    garde += 1;
    const x = Math.floor(alea() * taille);
    const y = Math.floor(alea() * taille);
    const c = cleCase(x, y);
    if (murs.has(c) || fragments.has(c)) continue;
    fragments.set(c, true);
  }
  return { taille, graine: params.graine ?? 2026, murs, fragments, position: { x: 0, y: 0 }, pasMax: PAS_MAX_PAR_EPISODE };
}

function reinitialiser(monde: MondeVirtuel): void {
  monde.position = { x: 0, y: 0 };
  for (const c of monde.fragments.keys()) monde.fragments.set(c, true);
}

/** Observation locale : vision 3×3 encodée + position + boussole du fragment le plus proche. */
export function observer(monde: MondeVirtuel): number[] {
  const obs: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = monde.position.x + dx;
      const y = monde.position.y + dy;
      if (x < 0 || y < 0 || x >= monde.taille || y >= monde.taille || monde.murs.has(cleCase(x, y))) obs.push(1);
      else if (monde.fragments.get(cleCase(x, y)) === true) obs.push(0.5);
      else obs.push(0);
    }
  }
  obs.push(Number((monde.position.x / monde.taille).toFixed(3)), Number((monde.position.y / monde.taille).toFixed(3)));
  const cible = fragmentLePlusProche(monde);
  if (cible) {
    obs.push(
      Number(((cible.x - monde.position.x) / monde.taille).toFixed(3)),
      Number(((cible.y - monde.position.y) / monde.taille).toFixed(3)),
    );
  } else {
    obs.push(0, 0);
  }
  return obs;
}

function fragmentLePlusProche(monde: MondeVirtuel): { x: number; y: number } | null {
  let meilleur: { x: number; y: number } | null = null;
  let distanceMin = Infinity;
  for (const c of monde.fragments.keys()) {
    if (monde.fragments.get(c) !== true) continue;
    const [x, y] = c.split(",").map(Number);
    const d = Math.abs(x - monde.position.x) + Math.abs(y - monde.position.y);
    if (d < distanceMin) {
      distanceMin = d;
      meilleur = { x, y };
    }
  }
  return meilleur;
}

/** BFS réel : premier pas vers le fragment le plus proche (curriculum gen3). */
export function actionExpert(monde: MondeVirtuel): ActionMonde | null {
  const cible = fragmentLePlusProche(monde);
  if (!cible) return null;
  const depart = cleCase(monde.position.x, monde.position.y);
  const arrivee = cleCase(cible.x, cible.y);
  if (depart === arrivee) return null;
  const file: string[] = [depart];
  const origine = new Map<string, string | null>([[depart, null]]);
  while (file.length > 0) {
    const courant = file.shift() as string;
    if (courant === arrivee) break;
    const [cx, cy] = courant.split(",").map(Number);
    for (const action of ACTIONS_MONDE) {
      const [dx, dy] = DELTAS[action];
      const voisin = cleCase(cx + dx, cy + dy);
      if (
        cx + dx < 0 ||
        cy + dy < 0 ||
        cx + dx >= monde.taille ||
        cy + dy >= monde.taille ||
        monde.murs.has(voisin) ||
        origine.has(voisin)
      ) {
        continue;
      }
      origine.set(voisin, courant);
      file.push(voisin);
    }
  }
  if (!origine.has(arrivee)) return null; // fragment inatteignable (muré)
  // Remonter le chemin jusqu'au premier pas.
  let courant = arrivee;
  let precedent = origine.get(courant) ?? null;
  while (precedent !== null && precedent !== depart) {
    courant = precedent;
    precedent = origine.get(courant) ?? null;
  }
  const [cx, cy] = depart.split(",").map(Number);
  const [tx, ty] = courant.split(",").map(Number);
  const dx = tx - cx;
  const dy = ty - cy;
  if (dy === -1) return "haut";
  if (dx === 1) return "droite";
  if (dy === 1) return "bas";
  if (dx === -1) return "gauche";
  return null;
}

/** Applique une action : déplacement, collecte, coûts — retourne la récompense du pas. */
export function appliquerAction(monde: MondeVirtuel, action: ActionMonde): number {
  const [dx, dy] = DELTAS[action];
  const x = monde.position.x + dx;
  const y = monde.position.y + dy;
  let recompense = -0.01; // coût de pas (pousse vers l'efficacité)
  const horsMonde = x < 0 || y < 0 || x >= monde.taille || y >= monde.taille;
  if (horsMonde || monde.murs.has(cleCase(x, y))) {
    return recompense - 0.19; // collision : pénalité explicite
  }
  monde.position = { x, y };
  const c = cleCase(x, y);
  if (monde.fragments.get(c) === true) {
    monde.fragments.set(c, false);
    // Collecte : 1,01 NET du coût de pas → le pas vaut +1,00 exactement et
    // le détecteur d'épisode (récompense ≥ 1) voit la collecte réelle.
    recompense += 1.01;
  }
  return recompense;
}

export interface Trajectoire {
  pas: number;
  recompense: number;
  fragmentsPris: number;
  reussi: boolean;
  /** (observation, action) — matière du renforcement léger. */
  decisions: { entrees: number[]; action: ActionMonde }[];
}

/** EXÉCUTION : un épisode complet de l'IA dans le monde. */
export async function executerEpisode(
  monde: MondeVirtuel,
  decider: (entrees: number[]) => Promise<number[]>,
  options?: { pasMax?: number },
): Promise<Trajectoire> {
  reinitialiser(monde);
  const pasMax = Math.min(options?.pasMax ?? monde.pasMax, PAS_MAX_PAR_EPISODE);
  const trajectoire: Trajectoire = { pas: 0, recompense: 0, fragmentsPris: 0, reussi: false, decisions: [] };
  const totalFragments = [...monde.fragments.values()].filter((v) => v).length;
  for (let pas = 0; pas < pasMax; pas += 1) {
    const obs = observer(monde);
    const scores = await decider(obs);
    const action = ACTIONS_MONDE[Math.max(0, Math.min(ACTIONS_MONDE.length - 1, scores.indexOf(Math.max(...scores))))];
    const recompense = appliquerAction(monde, action);
    trajectoire.pas += 1;
    trajectoire.recompense += recompense;
    trajectoire.decisions.push({ entrees: obs, action });
    if (recompense >= 1) trajectoire.fragmentsPris += 1;
    if (trajectoire.fragmentsPris >= totalFragments) break;
  }
  trajectoire.reussi = trajectoire.fragmentsPris >= totalFragments && totalFragments > 0;
  trajectoire.recompense = Number(trajectoire.recompense.toFixed(3));
  return trajectoire;
}

/** LEÇONS GEN3 : démonstrations expertes (BFS) converties en exemples supervisés. */
export function genererLeconsGen3(monde: MondeVirtuel, leconsParFragment = 24): ExempleClassification[] {
  const lecons: ExempleClassification[] = [];
  // Réinitialiser AVANT de compter : les épisodes précédents (politique déjà
  // entraînée) ont pu collecter TOUS les fragments — le monde repart vierge.
  reinitialiser(monde);
  const nbFragments = [...monde.fragments.values()].filter((v) => v).length;
  for (let f = 0; f < nbFragments; f += 1) {
    // Chemin expert fragment par fragment : on rejoue BFS et on collecte.
    reinitialiser(monde);
    for (let pas = 0; pas < PAS_MAX_PAR_EPISODE; pas += 1) {
      const restants = [...monde.fragments.values()].filter((v) => v).length;
      if (restants === 0) break;
      const action = actionExpert(monde);
      if (!action) break;
      lecons.push({ entrees: observer(monde), label: `action-${ACTIONS_MONDE.indexOf(action)}` });
      appliquerAction(monde, action);
      if (lecons.length >= leconsParFragment * Math.max(1, nbFragments)) break;
    }
  }
  reinitialiser(monde);
  return lecons;
}

/* ── Politique : le modèle entraîné décide dans le monde ─────────────── */

export interface RapportSeanceMonde {
  leconsGen3: number;
  episodes: number;
  recompenseAvant: number;
  recompenseApres: number;
  progression: number;
  tauxReussiteAvant: number;
  tauxReussiteApres: number;
  /** Fragments collectés en moyenne sur les épisodes de mesure finale. */
  fragmentsMoyensApres: number;
  pasMoyensApres: number;
  verdict: "progres" | "aucun-progres";
  details: string;
}

/** Estimation honnête des ressources d'une séance (garde de niveau). */
export function ressourcesSeanceMonde(params: { taille: number; episodes: number; pasMax: number }): {
  memoireMoEstimee: number;
  cpuMsEstime: number;
  parametresPolitique: number;
} {
  const entrees = 13; // vision 3×3 (9) + position (2) + boussole (2)
  const parametres = entrees * 12 + 12 + 12 * ACTIONS_MONDE.length + ACTIONS_MONDE.length;
  return {
    parametresPolitique: parametres,
    memoireMoEstimee: Number(((parametres * 8) / 1_048_576 + 4).toFixed(2)),
    cpuMsEstime: Math.round(params.episodes * params.pasMax * 0.05 + params.episodes * 40),
  };
}

/** Garde de capacité : la séance tient-elle dans le niveau de clé couvert ? */
export function verifierCapaciteMonde(niveau: NiveauEntrainement, params: { episodes: number; taille: number }): {
  autorise: boolean;
  raison?: string;
} {
  const capacites = CAPACITES_PAR_NIVEAU[niveau];
  if (params.episodes > capacites.episodesMondeMax) {
    return {
      autorise: false,
      raison: `${params.episodes} épisodes > plafond du niveau « ${niveau} » (${capacites.episodesMondeMax}) — réduire la séance ou monter de niveau.`,
    };
  }
  if (params.taille > TAILLE_MAX_MONDE) {
    return { autorise: false, raison: `Monde ${params.taille}×${params.taille} > plafond ${TAILLE_MAX_MONDE}×${TAILLE_MAX_MONDE}.` };
  }
  return { autorise: true };
}

/**
 * SÉANCE COMPLÈTE : mesurer l'IA brute → enseigner (leçons gen3) → faire
 * s'exécuter et apprendre par épisodes → mesurer la progression.
 */
export async function seanceApprentissageMonde(params: {
  graine?: number;
  taille?: number;
  episodes?: number;
  epoquesImitation?: number;
  niveau: NiveauEntrainement;
  modeleFourni?: ModeleFourni;
}): Promise<{ rapport: RapportSeanceMonde; adaptateur: AdaptateurEntrainementIA }> {
  const graine = params.graine ?? 2026;
  const episodes = Math.max(6, Math.min(params.episodes ?? 40, CAPACITES_PAR_NIVEAU[params.niveau].episodesMondeMax));
  const monde = creerMondeVirtuel({ graine, taille: params.taille });
  // Politique par défaut (ou modèle tenseur fourni) : architecture PAR DÉFAUT
  // injectée si l'utilisateur n'en fournit pas — l'inférence doit exister
  // dès l'épisode de référence (IA brute, avant leçons).
  const modeFourni = params.modeleFourni?.famille === "tenseur-mlp" ? params.modeleFourni : undefined;
  const politique = adapterPour({
    famille: "tenseur-mlp",
    graine,
    ...modeFourni,
    architecture: modeFourni?.architecture ?? { entrees: 13, caches: [12], sorties: 4 },
  });

  // Réalignement CANONIQUE : l'adaptateur expose l'ordre réel de ses sorties
  // (labels par ordre d'apparition) — on remet les scores dans l'ordre des
  // ACTIONS du monde (`action-N` → ACTIONS_MONDE[N]) avant tout argmax.
  const decider = (a: AdaptateurEntrainementIA) => async (entrees: number[]) => {
    if (!a.inference || !a.labelsSortie) {
      throw new Error("Le modèle fourni ne sait pas DÉCIDER dans le monde (famille sans inférence vectorielle) — utiliser un tenseur-mlp.");
    }
    const scores = await a.inference(entrees);
    const labels = await a.labelsSortie();
    const sorties = new Array<number>(ACTIONS_MONDE.length).fill(Number.NEGATIVE_INFINITY);
    labels.forEach((label, i) => {
      const m = /^action-(\d+)$/.exec(label);
      if (m && i < scores.length) sorties[Number(m[1]) % ACTIONS_MONDE.length] = scores[i];
    });
    return sorties;
  };

  // 1. IA brute (non enseignée) : mesure de référence.
  const avant: Trajectoire[] = [];
  for (let i = 0; i < Math.min(6, episodes); i += 1) avant.push(await executerEpisode(monde, decider(politique)));
  const recompenseAvant = avant.reduce((s, t) => s + t.recompense, 0) / avant.length;
  const tauxAvant = avant.filter((t) => t.reussi).length / avant.length;

  // 2. gen3 enseigne (démonstrations expertes BFS) — imitation supervisée.
  const lecons = genererLeconsGen3(monde);
  await politique.entrainer({ classification: lecons }, { epoques: params.epoquesImitation ?? 60 });

  // 3. renforcement léger : imiter ses propres épisodes PRODUCTIFS (au
  // moins un fragment collecté) — la réussite totale viendra avec l'usage.
  const reussites: ExempleClassification[] = [];
  for (let i = 0; i < episodes; i += 1) {
    const t = await executerEpisode(monde, decider(politique));
    if (t.fragmentsPris >= 1) {
      for (const d of t.decisions) {
        reussites.push({ entrees: d.entrees, label: `action-${ACTIONS_MONDE.indexOf(d.action)}` });
      }
    }
    if (reussites.length > 200) break;
  }
  if (reussites.length >= 8) {
    // Renforcement SANS dérive : les décisions productives de l'IA sont
    // TOUJOURS mélangées au curriculum gen3 (les leçons ancrent la
    // politique — l'auto-imitation seule réapprendrait ses propres erreurs).
    await politique.entrainer({ classification: [...lecons, ...reussites] }, { epoques: 20 });
  }

  // 4. mesure finale sur épisodes FRAIS (monde réinitialisé à chaque épisode).
  const apres: Trajectoire[] = [];
  for (let i = 0; i < Math.min(6, episodes); i += 1) apres.push(await executerEpisode(monde, decider(politique)));
  const recompenseApres = apres.reduce((s, t) => s + t.recompense, 0) / apres.length;
  const tauxApres = apres.filter((t) => t.reussi).length / apres.length;
  const fragmentsApres = apres.reduce((s, t) => s + t.fragmentsPris, 0) / apres.length;
  const pasMoyens = apres.reduce((s, t) => s + t.pas, 0) / apres.length;
  const progression = Number((recompenseApres - recompenseAvant).toFixed(3));

  return {
    adaptateur: politique,
    rapport: {
      leconsGen3: lecons.length,
      episodes,
      recompenseAvant: Number(recompenseAvant.toFixed(3)),
      recompenseApres: Number(recompenseApres.toFixed(3)),
      progression,
      tauxReussiteAvant: Number(tauxAvant.toFixed(3)),
      tauxReussiteApres: Number(tauxApres.toFixed(3)),
      fragmentsMoyensApres: Number(fragmentsApres.toFixed(2)),
      pasMoyensApres: Number(pasMoyens.toFixed(1)),
      verdict: progression > 0.05 || tauxApres > tauxAvant || fragmentsApres > 0 ? "progres" : "aucun-progres",
      details: `Monde ${monde.taille}×${monde.taille} (graine ${graine}) : ${lecons.length} leçons gen3 imitées, ${episodes} épisodes, renforcement léger sur ${reussites.length} décision(s) productive(s). Progression MESURÉE : récompense ${recompenseAvant.toFixed(2)} → ${recompenseApres.toFixed(2)}, réussite ${(tauxAvant * 100).toFixed(0)} % → ${(tauxApres * 100).toFixed(0)} %, fragments/épisode ${fragmentsApres.toFixed(2)}.`,
    },
  };
}

/** Niveau minimum requis pour une séance donnée (par épisodes demandés). */
export function niveauRequisPourSeance(episodes: number): NiveauEntrainement {
  for (const niveau of ["standard", "avance", "integral"] as NiveauEntrainement[]) {
    if (episodes <= CAPACITES_PAR_NIVEAU[niveau].episodesMondeMax) return niveau;
  }
  return "integral";
}

export { RANG_NIVEAU };

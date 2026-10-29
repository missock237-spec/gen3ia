/**
 * RENDU SPATIOTEMPOREL PAR ONDES — portage fidèle du shader
 * `node.amplitude (1).pdf` (miroir CPU) et boucle de génération du
 * `Gen3VideoEngine` utilisateur (« La Boucle d'Enregistrement Vidéo en
 * Temps Réel.pdf »).
 *
 * Chaque nœud porte une position (posX, posY) dans l'image : son onde
 * cos(ω·t + φ + 0.01·x + 0.01·y) est ÉCLATÉE sur les pixels voisins
 * (noyau gaussien, comme l'injection d'impulsions du champ W-DNN). La
 * règle RPIA vidéo (persistance de phase) lie les trames successives —
 * le mouvement est continu entre images voisines, par construction.
 *
 * La trame produite est un VRAI tampon RGBA (largeur × hauteur × 4),
 * prêt pour un encodeur vidéo (WebCodecs, ffmpeg). Adaptation
 * documentée : la source ne fournit pas `renderFrame` — l'éclatement
 * gaussien est l'implémentation retenue, cohérente avec la physique du
 * champ et déterministe.
 *
 * Module PUR : aucune dépendance Node ni navigator.
 */

import { BORNES_RPIA, RPIA_DEFAUTS, borner, rapportDepuisHistorique } from "./types-entrainement";
import type { ConfigRPIA, NoeudOnde3D, OndeCible, RapportEntrainement } from "./types-entrainement";

/** Options de création du moteur de rendu. */
export interface OptionsRendu {
  /** Graine déterministe (défaut 42). */
  graine?: number;
}

/** Garde-fou mémoire : une séquence ne dépasse jamais 600 trames. */
export const MAX_TRAMES = 600;

export class MoteurRenduSpatiotemporel {
  readonly largeur: number;
  readonly hauteur: number;
  readonly nbNoeuds: number;
  private noeuds: NoeudOnde3D[];

  constructor(largeur = 320, hauteur = 180, nbNoeuds = 2048, options?: OptionsRendu) {
    if (!Number.isInteger(largeur) || largeur < 16 || largeur > 1920) {
      throw new Error(`Largeur invalide : ${largeur} (16 – 1920).`);
    }
    if (!Number.isInteger(hauteur) || hauteur < 16 || hauteur > 1080) {
      throw new Error(`Hauteur invalide : ${hauteur} (16 – 1080).`);
    }
    if (!Number.isInteger(nbNoeuds) || nbNoeuds < 1 || nbNoeuds > 65536) {
      throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (1 – 65536).`);
    }
    this.largeur = largeur;
    this.hauteur = hauteur;
    this.nbNoeuds = nbNoeuds;
    this.noeuds = new Array<NoeudOnde3D>(nbNoeuds);

    // Dispersion déterministe des nœuds sur l'image : suites à nombre
    // d'or / racine carrée (faibles trous, reproductible, seed fixe).
    let graine = (options?.graine ?? 42) >>> 0;
    const alea = () => {
      graine = (graine * 1664525 + 1013904223) >>> 0;
      return graine / 0xffffffff;
    };
    const CONST_OR = 0.618033988749895;
    for (let i = 0; i < nbNoeuds; i++) {
      this.noeuds[i] = {
        amplitude: 0.5 + alea() * 0.5,
        frequence: 0.5 + alea() * 4.0, // rad/s : mouvement lent à modéré
        phase: alea() * Math.PI * 2,
        amortissement: 0.01,
        posX: ((i * CONST_OR) % 1) * (largeur - 1),
        posY: ((i * CONST_OR * 2) % 1) * (hauteur - 1),
      };
    }
  }

  /** Copie défensive de l'état courant des nœuds. */
  etat(): NoeudOnde3D[] {
    return this.noeuds.map((n) => ({ ...n }));
  }

  /**
   * UN pas de guidage vidéo — MIRROIR exact du shader spatiotemporel.
   * `cibleMouvement` (longueur N) porte l'onde de mouvement désirée à
   * l'instant `temps` (secondes). @returns erreur moyenne après pas.
   */
  pasGuidage(cibleMouvement: OndeCible, guidage: number, temps: number): number {
    this.verifierCible(cibleMouvement);
    this.verifierGuidage(guidage);
    this.verifierTemps(temps);
    for (let i = 0; i < this.nbNoeuds; i++) {
      const noeud = this.noeuds[i];
      const ondeSpatio =
        noeud.amplitude *
        Math.cos(noeud.frequence * temps + noeud.phase + noeud.posX * 0.01 + noeud.posY * 0.01);
      const interference = ondeSpatio - cibleMouvement[i];

      // Persistance de phase : lie les trames successives (fluidité).
      noeud.phase += guidage * interference * 0.05;
      // Arrière-plans stabilisés, sujets animés.
      noeud.amortissement = borner(
        noeud.amortissement + interference * 0.001,
        BORNES_RPIA.amortissementVideoMin,
        BORNES_RPIA.amortissementVideoMax,
      );
      // Énergie cinétique de l'onde.
      noeud.amplitude = borner(
        noeud.amplitude - interference * 0.02,
        BORNES_RPIA.amplitudeMin,
        BORNES_RPIA.amplitudeMax,
      );
    }

    // Mesurer APRÈS les mises à jour, au même instant : l'ancien code
    // renvoyait l'erreur calculée avant la mise à jour alors que le contrat
    // annonçait une erreur post-pas. Cela décalait aussi les rapports d'une
    // itération et pouvait masquer une régression.
    return this.calculerErreur(cibleMouvement, temps);
  }

  /** Erreur moyenne du champ courant à un instant donné. */
  erreurCourante(cibleMouvement: OndeCible, temps: number): number {
    this.verifierCible(cibleMouvement);
    this.verifierTemps(temps);
    return this.calculerErreur(cibleMouvement, temps);
  }

  /** Entraîne le champ de mouvement vers la cible pendant `pas` pas. */
  entrainerVers(
    cibleMouvement: OndeCible,
    pas: number,
    guidage = 0.5,
    config: ConfigRPIA = RPIA_DEFAUTS,
  ): RapportEntrainement {
    this.verifierCible(cibleMouvement);
    if (!Number.isInteger(pas) || pas < 1 || pas > 1_000_000) {
      throw new Error(`Nombre de pas invalide : ${pas} (entier entre 1 et 1 000 000 requis).`);
    }
    this.verifierGuidage(guidage);
    if (
      !config ||
      typeof config !== "object" ||
      !Number.isFinite(config.tauxApprentissage) ||
      config.tauxApprentissage < 0 ||
      !Number.isFinite(config.pasDeTemps) ||
      config.pasDeTemps <= 0 ||
      !Number.isFinite((pas - 1) * config.pasDeTemps)
    ) {
      throw new Error(
        "Configuration vidéo invalide : taux fini ≥ 0 et pas de temps fini > 0 requis.",
      );
    }
    const erreurAvant = this.erreurCourante(cibleMouvement, 0);
    const historique: number[] = [];
    let temps = 0;
    for (let p = 0; p < pas; p++) {
      historique.push(this.pasGuidage(cibleMouvement, guidage, temps));
      temps += config.pasDeTemps;
    }
    return rapportDepuisHistorique(historique, erreurAvant);
  }

  /**
   * Rend UNE trame RGBA à l'instant `temps` : chaque nœud éclate son
   * onde spatiotemporelle dans un voisinage gaussien (rayon calibré sur
   * la densité de nœuds), les contributions se somment puis sont
   * normalisées → gris [0, 255] → RGBA opaque. Déterministe.
   */
  rendreTrame(temps: number): Float32Array {
    return rasteriserTrame(this.noeuds, this.largeur, this.hauteur, temps);
  }

  /**
   * Génère une séquence complète (portage de la boucle
   * `generateGen3VideoSequence`) : `dureeSecondes × fps` trames au
   * maximum (garde MAX_TRAMES), chaque trame guidée vers l'onde cible
   * PUIS rendue — le mouvement est entraîné ET rendu en un flux.
   *
   * @param onTrame callback optionnel (progression : index, total).
   * @returns Les trames RGBA rendues, dans l'ordre temporel.
   */
  genererSequence(
    dureeSecondes: number,
    fps: number,
    ondeCible: OndeCible,
    guidage = 0.5,
    onTrame?: (indexTrame: number, totalTrames: number) => void,
  ): { trames: Float32Array[]; totalTrames: number } {
    this.verifierCible(ondeCible);
    if (!Number.isFinite(dureeSecondes) || dureeSecondes <= 0) {
      throw new Error(`Durée vidéo invalide : ${dureeSecondes} (nombre fini > 0 requis).`);
    }
    if (!Number.isFinite(fps) || fps <= 0 || fps > 60) {
      throw new Error(`Fréquence d'images invalide : ${fps} (0 < fps ≤ 60).`);
    }
    this.verifierGuidage(guidage);
    const totalDemande = Math.round(dureeSecondes * fps);
    const totalTrames = Math.min(MAX_TRAMES, Math.max(1, totalDemande));

    const trames: Float32Array[] = [];
    let temps = 0;
    for (let f = 0; f < totalTrames; f++) {
      temps = f / fps;
      this.pasGuidage(ondeCible, guidage, temps);
      trames.push(this.rendreTrame(temps));
      onTrame?.(f + 1, totalTrames);
    }
    return { trames, totalTrames };
  }

  private calculerErreur(cible: OndeCible, temps: number): number {
    let somme = 0;
    for (let i = 0; i < this.nbNoeuds; i++) {
      const noeud = this.noeuds[i];
      const onde =
        noeud.amplitude *
        Math.cos(noeud.frequence * temps + noeud.phase + noeud.posX * 0.01 + noeud.posY * 0.01);
      somme += Math.abs(onde - cible[i]);
    }
    return somme / this.nbNoeuds;
  }

  private verifierGuidage(guidage: number): void {
    if (!Number.isFinite(guidage) || guidage < 0) {
      throw new Error(`Guidage invalide : ${guidage} (nombre fini ≥ 0 requis).`);
    }
  }

  private verifierTemps(temps: number): void {
    if (!Number.isFinite(temps) || temps < 0) {
      throw new Error(`Temps vidéo invalide : ${temps} (nombre fini ≥ 0 requis).`);
    }
  }

  private verifierCible(cible: OndeCible): void {
    if (cible.length !== this.nbNoeuds) {
      throw new Error(
        `Cible incompatible : ${cible.length} valeurs reçues, ${this.nbNoeuds} nœuds.`,
      );
    }
    for (let i = 0; i < cible.length; i++) {
      if (!Number.isFinite(cible[i])) {
        throw new Error(`Cible non finie à l'index ${i}.`);
      }
    }
  }
}

/**
 * PROJECTION « NŒUDS → TRAME » — la fonction pure partagée par le miroir
 * CPU (ci-dessus) et le moteur WebGPU (moteurs-webgpu.ts) : éclatement
 * gaussien de l'onde de chaque nœud, somme des contributions, normalisation
 * → gris [0, 255] → RGBA opaque. Le shader jumeau (SHADER_RASTERISATION_VIDEO
 * + SHADER_FINALISATION_VIDEO) implémente la MÊME physique en virgule fixe
 * entière (déterministe sous exécution parallèle).
 */
export function rasteriserTrame(
  noeuds: readonly NoeudOnde3D[],
  largeur: number,
  hauteur: number,
  temps: number,
): Float32Array {
  const w = largeur;
  const h = hauteur;
  const nbNoeuds = noeuds.length;
  const trame = new Float32Array(w * h * 4);
  const accumulateur = new Float32Array(w * h);
  const poidsPixels = new Float32Array(w * h);

  // Rayon d'éclatement : couvre l'image quel que soit le nombre de nœuds.
  const rayon = Math.max(3, Math.sqrt((w * h) / nbNoeuds) * 1.5);
  const rayon2 = rayon * rayon;

  for (let i = 0; i < nbNoeuds; i++) {
    const noeud = noeuds[i];
    const valeur =
      noeud.amplitude *
      Math.cos(noeud.frequence * temps + noeud.phase + noeud.posX * 0.01 + noeud.posY * 0.01);

    const x0 = Math.max(0, Math.floor(noeud.posX - rayon));
    const x1 = Math.min(w - 1, Math.ceil(noeud.posX + rayon));
    const y0 = Math.max(0, Math.floor(noeud.posY - rayon));
    const y1 = Math.min(h - 1, Math.ceil(noeud.posY + rayon));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - noeud.posX;
        const dy = y - noeud.posY;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rayon2) continue;
        const poids = Math.exp(-d2 / (rayon2 * 0.4));
        const idx = y * w + x;
        accumulateur[idx] += valeur * poids;
        poidsPixels[idx] += poids;
      }
    }
  }

  for (let p = 0; p < w * h; p++) {
    const valeur = poidsPixels[p] > 0 ? accumulateur[p] / poidsPixels[p] : 0;
    const gris = Math.round(borner(valeur * 0.5 + 0.5, 0, 1) * 255);
    const o = p * 4;
    trame[o] = gris;
    trame[o + 1] = gris;
    trame[o + 2] = gris;
    trame[o + 3] = 255;
  }
  return trame;
}

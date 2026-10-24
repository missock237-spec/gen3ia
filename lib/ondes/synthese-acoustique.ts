/**
 * SYNTHÈSE ACOUSTIQUE PAR RÉSONANCE — portage fidèle du shader
 * `node.amplitude.pdf` (miroir CPU) et du `Gen3AudioEngine` utilisateur.
 *
 * Chaque nœud est un oscillateur AUDIBLE (20 – 20 000 Hz). Le guidage
 * RPIA ajuste la phase (calage du timing) et la fréquence (épousage du
 * timbre) pour converger vers l'onde cible — voix, son, musique. Le
 * tampon PCM produit est un VRAI signal audio jouable (encodage WAV
 * 16 bits fourni) : aucune simulation déclarée, du son réel sort.
 *
 * Module PUR : aucune dépendance Node ni navigator (le WAV produit est
 * consommé par WebAudio côté navigateur, par la route /api/ondes/rpia
 * côté serveur, et par les tests).
 */

import {
  BORNES_RPIA,
  RPIA_DEFAUTS,
  borner,
  rapportDepuisHistorique,
} from "./types-entrainement";
import type { ConfigRPIA, NoeudAcoustique, OndeCible, RapportEntrainement } from "./types-entrainement";

/** Options de création du synthétiseur. */
export interface OptionsSynthetiseur {
  /** Graine déterministe (défaut 42). */
  graine?: number;
  /** Fréquence d'échantillonnage (défaut 44100 Hz, comme la source). */
  frequenceEchantillonnage?: number;
}

export class SynthetiseurAcoustique {
  readonly nbNoeuds: number;
  readonly frequenceEchantillonnage: number;
  private noeuds: NoeudAcoustique[];

  constructor(nbNoeuds = 1024, options?: OptionsSynthetiseur) {
    if (!Number.isInteger(nbNoeuds) || nbNoeuds < 1) {
      throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (entier ≥ 1 requis).`);
    }
    this.nbNoeuds = nbNoeuds;
    this.frequenceEchantillonnage = options?.frequenceEchantillonnage ?? 44100;
    this.noeuds = new Array<NoeudAcoustique>(nbNoeuds);

    let graine = (options?.graine ?? 42) >>> 0;
    const alea = () => {
      graine = (graine * 1664525 + 1013904223) >>> 0;
      return graine / 0xffffffff;
    };

    for (let i = 0; i < nbNoeuds; i++) {
      // Voix et sons usuels : init déterministe dans la bande vocale/médium
      // (80 – 4 080 Hz), le guidage RPIA pousse ensuite vers la cible.
      this.noeuds[i] = {
        amplitude: 0.5,
        frequence: 80 + alea() * 4000,
        phase: alea() * Math.PI * 2,
        amortissement: 0.01,
      };
    }
  }

  /** Copie défensive de l'état courant des oscillateurs. */
  etat(): NoeudAcoustique[] {
    return this.noeuds.map((n) => ({ ...n }));
  }

  /**
   * UN pas de guidage acoustique — MIRROIR exact du shader
   * `node.amplitude.pdf`. `cible` (longueur N) porte l'onde sonore
   * désirée à l'instant `temps` (secondes). @returns erreur moyenne.
   */
  pasGuidage(cible: OndeCible, guidage: number, temps: number): number {
    this.verifierCible(cible);
    let somme = 0;
    for (let i = 0; i < this.nbNoeuds; i++) {
      const noeud = this.noeuds[i];
      const onde = noeud.amplitude * Math.sin(2.0 * Math.PI * noeud.frequence * temps + noeud.phase);
      const interference = onde - cible[i];

      // RPIA acoustique : phase = timing, fréquence = timbre (clamp fidèle).
      noeud.phase -= guidage * interference * 0.1;
      noeud.frequence = borner(
        noeud.frequence - interference * 5.0,
        BORNES_RPIA.frequenceAudioMin,
        BORNES_RPIA.frequenceAudioMax,
      );
      // Anti-saturation (clipping) : amortissement contrôlé.
      noeud.amortissement = borner(
        noeud.amortissement + Math.abs(interference) * 0.001,
        BORNES_RPIA.amortissementAudioMin,
        BORNES_RPIA.amortissementAudioMax,
      );

      somme += Math.abs(interference);
    }
    return somme / this.nbNoeuds;
  }

  /**
   * Entraîne les oscillateurs vers l'onde cible pendant `pas` pas de
   * guidage (temps global avancé de `config.pasDeTemps` à chaque pas).
   */
  entrainerVers(
    cible: OndeCible,
    pas: number,
    guidage = 0.5,
    config: ConfigRPIA = RPIA_DEFAUTS,
  ): RapportEntrainement {
    this.verifierCible(cible);
    if (!Number.isInteger(pas) || pas < 1) {
      throw new Error(`Nombre de pas invalide : ${pas} (entier ≥ 1 requis).`);
    }
    const historique: number[] = [];
    let temps = 0;
    for (let p = 0; p < pas; p++) {
      historique.push(this.pasGuidage(cible, guidage, temps));
      temps += config.pasDeTemps;
    }
    return rapportDepuisHistorique(historique);
  }

  /**
   * Génère un VRAI tampon PCM mono Float32 de `dureeSecondes` : à chaque
   * échantillon, la somme des ondes acoustiques des nœuds (normalisée)
   * est rendue et bornée [-1, 1]. Longueur = durée × fréquence
   * d'échantillonnage (fidèle : 0.5 s @ 44100 → 22050 échantillons).
   */
  genererBuffer(dureeSecondes: number): Float32Array {
    if (!Number.isFinite(dureeSecondes) || dureeSecondes <= 0 || dureeSecondes > 60) {
      throw new Error(`Durée invalide : ${dureeSecondes} (0 < durée ≤ 60 s).`);
    }
    const nbEchantillons = Math.round(dureeSecondes * this.frequenceEchantillonnage);
    return this.mixerIntervalle(0, nbEchantillons);
  }

  /**
   * MIXE UN INTERVALLE d'échantillons [debut, debut + nbEchantillons) —
   * la fonction pure partagée par genererBuffer, le traitement PAR BLOCS
   * du moteur WebGPU (moteurs-webgpu.ts, blockStep 1024 de la source) et
   * le shader jumeau SHADER_MIX_AUDIO. Mêmes formules partout : somme des
   * oscillateurs pondérée par l'amortissement (anti-saturation),
   * normalisation 1/N puis ×2, bornée [-1, 1].
   */
  mixerIntervalle(debut: number, nbEchantillons: number): Float32Array {
    if (!Number.isInteger(debut) || debut < 0) {
      throw new Error(`Début d'intervalle invalide : ${debut} (entier ≥ 0 requis).`);
    }
    if (!Number.isInteger(nbEchantillons) || nbEchantillons < 1) {
      throw new Error(`Nombre d'échantillons invalide : ${nbEchantillons} (entier ≥ 1 requis).`);
    }
    const pcm = new Float32Array(nbEchantillons);
    const normalisation = 1 / Math.max(1, this.nbNoeuds);

    for (let s = 0; s < nbEchantillons; s++) {
      const temps = (debut + s) / this.frequenceEchantillonnage;
      let somme = 0;
      for (let i = 0; i < this.nbNoeuds; i++) {
        const noeud = this.noeuds[i];
        // L'amortissement contrôle la contribution : un oscillateur très
        // amorti s'efface du mix (rôle anti-saturation de la source).
        const contribution = noeud.amplitude * (1 - Math.min(1, noeud.amortissement * 8));
        somme += contribution * Math.sin(2.0 * Math.PI * noeud.frequence * temps + noeud.phase);
      }
      pcm[s] = borner(somme * normalisation * 2, -1, 1);
    }
    return pcm;
  }

  private verifierCible(cible: OndeCible): void {
    if (cible.length !== this.nbNoeuds) {
      throw new Error(
        `Cible incompatible : ${cible.length} valeurs reçues, ${this.nbNoeuds} oscillateurs.`,
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
 * Encode un tampon PCM mono Float32 [-1, 1] en WAV 16 bits (en-tête
 * RIFF standard) — le fichier binaire jouable partout (WebAudio, lecteur
 * système, navigateur). Retourne un ArrayBuffer autonome.
 */
export function versWav(pcm: Float32Array, frequenceEchantillonnage = 44100): ArrayBuffer {
  const nbEchantillons = pcm.length;
  const octetsDonnees = nbEchantillons * 2;
  const tampon = new ArrayBuffer(44 + octetsDonnees);
  const vue = new DataView(tampon);

  const ecrireTexte = (offset: number, texte: string) => {
    for (let i = 0; i < texte.length; i++) vue.setUint8(offset + i, texte.charCodeAt(i));
  };

  ecrireTexte(0, "RIFF");
  vue.setUint32(4, 36 + octetsDonnees, true);
  ecrireTexte(8, "WAVE");
  ecrireTexte(12, "fmt ");
  vue.setUint32(16, 16, true); // taille du bloc fmt
  vue.setUint16(20, 1, true); // PCM
  vue.setUint16(22, 1, true); // mono
  vue.setUint32(24, frequenceEchantillonnage, true);
  vue.setUint32(28, frequenceEchantillonnage * 2, true); // débit octets
  vue.setUint16(32, 2, true); // alignement bloc
  vue.setUint16(34, 16, true); // bits par échantillon
  ecrireTexte(36, "data");
  vue.setUint32(40, octetsDonnees, true);

  let offset = 44;
  for (let i = 0; i < nbEchantillons; i++) {
    const echantillon = Math.max(-1, Math.min(1, pcm[i]));
    vue.setInt16(offset, echantillon < 0 ? echantillon * 0x8000 : echantillon * 0x7fff, true);
    offset += 2;
  }
  return tampon;
}

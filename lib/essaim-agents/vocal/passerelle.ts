/**
 * La Passerelle Vocale — Voice-to-Wave de bout en bout.
 *
 *  1. CAPTURE — getUserMedia (micro) + AnalyserNode : trames PCM locales ;
 *  2. SPECTRE — analyserSpectre (FFT radix-2 locale) : impulsions vocales ;
 *  3. INJECTION — les impulsions partent dans le champ W-DNN ET dans
 *     l'essaim (callback `surOndes`) : la parole devient propagation ;
 *  4. IA PRINCIPALE — la transcription textuelle (dictée locale
 *     navigateur si disponible, sinon saisie) est soumise au cortex
 *     Gen3 via `consulterIA` — l'agent vocal reste CONNECTÉ à l'IA
 *     principale, jamais autonome ;
 *  5. RÉPONSE — synthèse vocale LOCALE (SpeechSynthesis), prosodie
 *     modulée par la résonance du champ : zéro API tierce, zéro frais.
 *
 * Note honnête sur la « téléphonie » : cette passerelle traite les
 * flux vocaux EN DIRECT dans le navigateur. Passer un appel téléphonique
 * sortant exige un pont WebRTC→SIP opéré par l'utilisateur (le projet
 * ne dépend d'aucun service vocal centralisé).
 */

import {
  analyserSpectre,
  prosodieDepuisResonance,
  type ImpulsionVocale,
} from "./spectre";

export type EtatPasserelle =
  | "inactif"
  | "ecoute"
  | "analyse"
  | "reflexion"
  | "parole"
  | "erreur";

export interface OptionsPasserelle {
  /** Fréquence d'analyse (ms, défaut 90 — ~11 trames/s). */
  periodiciteMs?: number;
  /** Injecte les impulsions vocales dans le champ/essaim. */
  surOndes?: (impulsions: ImpulsionVocale[], amplitude: number) => void;
  /** Consulte l'IA principale Gen3 avec le texte compris. */
  consulterIA: (texte: string) => Promise<string>;
  surEtat?: (etat: EtatPasserelle, detail?: string) => void;
  /** Voix parlée (le texte de réponse de l'IA principale). */
  surReponse?: (texte: string) => void;
}

export class PasserelleVocale {
  private flux: MediaStream | null = null;
  private contexte: AudioContext | null = null;
  private analyseur: AnalyserNode | null = null;
  private minuteur: ReturnType<typeof setInterval> | null = null;
  private etat: EtatPasserelle = "inactif";
  private readonly options: OptionsPasserelle;
  /** Dernières impulsions (inspection console). */
  dernieresImpulsions: ImpulsionVocale[] = [];
  dernierAmplitude = 0;

  constructor(options: OptionsPasserelle) {
    this.options = options;
  }

  get etatActuel(): EtatPasserelle {
    return this.etat;
  }

  private changer(etat: EtatPasserelle, detail?: string): void {
    this.etat = etat;
    this.options.surEtat?.(etat, detail);
  }

  /** Démarre l'écoute : le micro alimente le spectre en continu. */
  async demarrer(): Promise<void> {
    if (this.flux) return;
    try {
      this.changer("ecoute", "Demande du micro…");
      this.flux = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.contexte = new AudioContext();
      const source = this.contexte.createMediaStreamSource(this.flux);
      this.analyseur = this.contexte.createAnalyser();
      this.analyseur.fftSize = 2048;
      this.analyseur.smoothingTimeConstant = 0.5;
      source.connect(this.analyseur);

      const donnees = new Float32Array(this.analyseur.fftSize);
      this.minuteur = setInterval(() => {
        if (!this.analyseur) return;
        this.analyseur.getFloatTimeDomainData(donnees);
        const impulsions = analyserSpectre(donnees);
        this.dernieresImpulsions = impulsions;
        this.dernierAmplitude = impulsions.reduce((a, i) => a + i.amplitude, 0) / (impulsions.length || 1);
        if (impulsions.length > 0) {
          this.options.surOndes?.(impulsions, this.dernierAmplitude);
        }
      }, this.options.periodiciteMs ?? 90);
      this.changer("ecoute", "Micro actif — le spectre vocal propage des ondes.");
    } catch (e) {
      this.changer("erreur", e instanceof Error ? e.message : "Micro indisponible.");
      await this.nettoyer();
    }
  }

  /**
   * Soumet un texte (dicté ou saisi) à l'IA principale puis PARLE la
   * réponse avec une prosodie modulée par la résonance. Le cycle
   * complet : voix → onde → Gen3 → onde → voix.
   */
  async converser(texte: string, resonance?: { ordreR: number; energie: number }): Promise<string> {
    const propre = texte.trim();
    if (!propre) throw new Error("Rien à soumettre à l'IA principale.");
    this.changer("reflexion", `L'IA principale réfléchit : « ${propre.slice(0, 60)}… »`);
    try {
      const reponse = await this.options.consulterIA(propre);
      this.changer("parole", "Synthèse vocale locale en cours…");
      await this.parler(reponse, resonance);
      this.options.surReponse?.(reponse);
      this.changer("ecoute", "Réponse prononcée — le micro reste actif.");
      return reponse;
    } catch (e) {
      this.changer("erreur", e instanceof Error ? e.message : "La conversation a échoué.");
      throw e;
    }
  }

  /** Synthèse vocale LOCALE (SpeechSynthesis), prosodie par résonance. */
  async parler(texte: string, resonance?: { ordreR: number; energie: number }): Promise<void> {
    if (typeof speechSynthesis === "undefined") {
      // Navigateur sans synthèse : la réponse reste textuelle (honnête).
      return;
    }
    const prosodie = prosodieDepuisResonance(resonance?.ordreR ?? 0.3, resonance?.energie ?? 0.2);
    return new Promise((resoudre) => {
      const utterance = new SpeechSynthesisUtterance(texte.slice(0, 600));
      utterance.lang = "fr-FR";
      utterance.pitch = prosodie.pitch;
      utterance.rate = prosodie.rate;
      utterance.onend = () => resoudre();
      utterance.onerror = () => resoudre(); // une synthèse ratée n'arrête pas l'essaim
      speechSynthesis.speak(utterance);
    });
  }

  /** Arrête l'écoute et libère le micro. */
  async arreter(): Promise<void> {
    await this.nettoyer();
    this.changer("inactif", "Micro libéré.");
  }

  private async nettoyer(): Promise<void> {
    if (this.minuteur) clearInterval(this.minuteur);
    this.minuteur = null;
    this.flux?.getTracks().forEach((t) => t.stop());
    this.flux = null;
    try {
      await this.contexte?.close();
    } catch {
      // Contexte déjà fermé.
    }
    this.contexte = null;
    this.analyseur = null;
  }
}

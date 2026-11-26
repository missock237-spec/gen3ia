/**
 * CONVERSATION VOCALE — machine à états de la conversation bidirectionnelle
 * (mission LOT 4 : l'utilisateur parle, Gen3ia comprend, répond oralement,
 * peut être INTERROMPU, la conversation ne recharge jamais la page).
 *
 * Flux : écoute → VAD début → segment audio → [ASR injectable] → texte
 * → [cerveau injectable = Gen3ia Core] → réponse → [TTS injectable] →
 * lecture progressive → interruption possible à tout instant (barge-in :
 * TTS stoppé proprement, retour écoute immédiat) → écoute.
 *
 * HONNÊTETÉ (règles 5 et 12) : ASR/TTS sont des ADAPTATEURS remplaçables —
 * sans adaptateur branché, la conversation passe en REPLI TEXTE explicite
 * (événement vocal.repli-texte), jamais de fausse voix. Les adaptateurs
 * Web Speech (navigateur) sont livrés séparément et déclarés non validés
 * tant qu'aucun test navigateur réel n'a été exécuté.
 */

import { Vad, type ConfigVad } from "./vad";

export type EtatConversation = "ecoute" | "transcription" | "reflexion" | "parole" | "repli-texte" | "fermee";

/** Adaptateur ASR remplaçable (reconnaissance vocale en continu). */
export interface AdaptateurAsr {
  readonly nom: string;
  /** Transcrit un segment WAV PCM16 mono (retourne "" si rien de compris). */
  transcrire(wav: Buffer): Promise<string>;
}

/** Adaptateur TTS remplaçable (synthèse vocale en streaming). */
export interface AdaptateurTts {
  readonly nom: string;
  /** Lit le texte ; retourne un identifiant de lecture stoppable. */
  lire(texte: string): Promise<{ lectureId: string }>;
  /** Arrêt immédiat (interruption utilisateur). */
  arreter(lectureId: string): Promise<void>;
}

/** Cerveau injectable — l'implémentation réelle passe par Gen3ia Core. */
export interface CerveauVocal {
  repondre(texteUtilisateur: string, contexteVisuel?: string): Promise<string>;
}

export interface EvenementConversation {
  type:
    | "etat.change"
    | "vocal.debut"
    | "vocal.fin"
    | "transcription"
    | "reponse"
    | "interruption"
    | "vocal.repli-texte"
    | "erreur";
  etat?: EtatConversation;
  texte?: string;
  raison?: string;
  horodatage: number;
}

export interface ConversationVocale {
  /** Un segment WAV du flux micro — pilote la machine à états. */
  segment(wav: Buffer): Promise<EvenementConversation[]>;
  /** Interruption explicite (barge-in) : parole stoppée, retour écoute. */
  interrompre(): Promise<EvenementConversation>;
  /** Message texte en repli (aucune voix disponible). */
  messageTexte(texte: string): Promise<EvenementConversation[]>;
  etat(): EtatConversation;
  fermer(): void;
}

const HISTORIQUE_MAX = 40;

export function creerConversationVocale(params: {
  configVad?: ConfigVad;
  asr?: AdaptateurAsr | null;
  tts?: AdaptateurTts | null;
  cerveau: CerveauVocal;
  /** Contexte visuel partagé (mission : réponses contextualisées — LOT 5). */
  contexteVisuel?: () => string | undefined;
}): ConversationVocale {
  const vad = new Vad(params.configVad);
  // L'écoute reste ouverte dès qu'un ASR existe : sans TTS, les réponses
  // arrivent en texte (repli explicite par réponse) — l'utilisateur garde
  // la voix en entrée. Sans ASR, le vocal d'entrée est impossible : repli.
  let etat: EtatConversation = params.asr ? "ecoute" : "repli-texte";
  let lectureEnCours: string | null = null;
  const historique: string[] = [];

  function changer(nouveau: EtatConversation, evenements: EvenementConversation[]): void {
    if (nouveau !== etat) {
      etat = nouveau;
      evenements.push({ type: "etat.change", etat, horodatage: Date.now() });
    }
  }

  async function envoyerAuCerveau(texte: string, evenements: EvenementConversation[]): Promise<void> {
    changer("reflexion", evenements);
    try {
      const reponse = await params.cerveau.repondre(texte, params.contexteVisuel?.());
      historique.push(`U: ${texte.slice(0, 120)}`, `G: ${reponse.slice(0, 120)}`);
      if (historique.length > HISTORIQUE_MAX) historique.splice(0, historique.length - HISTORIQUE_MAX);
      evenements.push({ type: "reponse", texte: reponse, horodatage: Date.now() });
      if (params.tts) {
        changer("parole", evenements);
        const { lectureId } = await params.tts.lire(reponse);
        lectureEnCours = lectureId;
      } else {
        changer("repli-texte", evenements);
        evenements.push({ type: "vocal.repli-texte", texte: reponse, raison: "aucun TTS branché — réponse livrée en texte", horodatage: Date.now() });
      }
    } catch (erreur) {
      evenements.push({ type: "erreur", raison: erreur instanceof Error ? erreur.message : String(erreur), horodatage: Date.now() });
      changer(params.asr ? "ecoute" : "repli-texte", evenements);
    }
  }

  return {
    async segment(wav: Buffer): Promise<EvenementConversation[]> {
      const evenements: EvenementConversation[] = [];
      if (etat === "parole" || etat === "reflexion") {
        // Le micro reste à l'écoute pendant la réponse : un début de parole
        // du UTILISATEUR interrompt (barge-in — mission LOT 4-6/7).
        const r = vad.traiter(wav);
        if (r.evenement === "parole.debut") {
          const interruption = await this.interrompre();
          evenements.push(interruption);
        }
        return evenements;
      }
      if (etat !== "ecoute") return evenements; // repli-texte : pas de VAD
      const r = vad.traiter(wav);
      if (r.evenement === "parole.debut") {
        evenements.push({ type: "vocal.debut", horodatage: Date.now(), raison: `RMS ${r.rms.toFixed(3)} (${r.classe})` });
      } else if (r.evenement === "parole.fin") {
        evenements.push({ type: "vocal.fin", horodatage: Date.now() });
        if (!params.asr) {
          changer("repli-texte", evenements);
          evenements.push({ type: "vocal.repli-texte", raison: "parole détectée mais aucun ASR branché — saisie texte requise", horodatage: Date.now() });
          return evenements;
        }
        changer("transcription", evenements);
        try {
          const texte = await params.asr.transcrire(wav);
          evenements.push({ type: "transcription", texte, horodatage: Date.now() });
          if (texte.trim()) await envoyerAuCerveau(texte, evenements);
          else changer("ecoute", evenements);
        } catch (erreur) {
          evenements.push({ type: "erreur", raison: `ASR « ${params.asr.nom} » : ${erreur instanceof Error ? erreur.message : String(erreur)}`, horodatage: Date.now() });
          changer("ecoute", evenements);
        }
      }
      return evenements;
    },

    async interrompre(): Promise<EvenementConversation> {
      if (lectureEnCours && params.tts) {
        try {
          await params.tts.arreter(lectureEnCours);
        } catch {
          /* TTS déjà arrêté — sans effet */
        }
      }
      lectureEnCours = null;
      const evenement: EvenementConversation = { type: "interruption", horodatage: Date.now(), raison: "barge-in : réponse interrompue, retour écoute" };
      etat = params.asr ? "ecoute" : "repli-texte";
      evenement.etat = etat;
      return evenement;
    },

    async messageTexte(texte: string): Promise<EvenementConversation[]> {
      const evenements: EvenementConversation[] = [];
      await envoyerAuCerveau(texte, evenements);
      return evenements;
    },

    etat: () => etat,
    fermer: () => {
      lectureEnCours = null;
      etat = "fermee";
      vad.reinitialiser();
    },
  };
}

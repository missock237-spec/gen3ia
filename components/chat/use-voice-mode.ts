"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * USE VOICE MODE CONTINU — conversation vocale MAINS LIBRES, fluide et
 * synchronisée (demande utilisateur : « interagir avec un humain via le
 * chat vocal de manière fluide ; le test doit être synchronisé avec la
 * voix une fois que l'utilisateur l'a activée »).
 *
 * Le mode dictée existant (`use-voice-input`) est SINGLE-SHOT : un appui
 * = un tour dicté, la réponse n'est lue que pour ce tour. Ce module ajoute
 * le MODE CONTINU : une fois ACTIVÉ par l'utilisateur,
 *
 *   écoute → (transcript envoyé) → attente de la réponse gen3 →
 *   → (réponse reçue) → LECTURE VOCALE SYNCHRONISÉE →
 *   → (fin réelle de lecture) → RÉARMEMENT AUTOMATIQUE du micro → écoute → …
 *
 * Le cycle tourne jusqu'à la désactivation explicite. Deux garanties :
 *  · le micro N'EST PAS armé pendant que gen3 parle (pas d'auto-écoute de
 *    la voix du système — la boucle acoustique est évitée par la machine
 *    à états, c'est la synchronisation demandée) ;
 *  · la lecture est réellement terminée avant de réarmer (promesse branchée
 *    sur le callback de fin de synthèse — jamais un timer devin).
 *
 * HONNÊTETÉ : aucune dépendance externe — la lecture utilise la synthèse
 * native branchée par l'appelant (Kokoro WebGPU puis speechSynthesis) ;
 * si le navigateur ne supporte pas la reconnaissance, le mode refuse de
 * s'activer avec un message explicite (dégradation assumée).
 *
 * La LOGIQUE DU CYCLE vit dans une machine à états PURE + un contrôleur
 * PUR (`creerCycleVoixContinue`) exportés et testés hors DOM (vitest
 * environment=node — convention du dépôt) ; le hook React est un fin
 * wrapper qui reflète l'état du contrôleur.
 */

export type EtatCycleVoix = "inactif" | "silence" | "ecoute" | "attente-reponse" | "lecture" | "erreur";

export type EvenementVoixContinue =
  | { type: "ACTIVER"; supported: boolean }
  | { type: "DESACTIVER" }
  | { type: "DEBUT_ECOUTE" }
  | { type: "TRANSCRIPT_ENVOYE" }
  | { type: "REPONSE_RECU" }
  | { type: "LECTURE_TERMINEE" }
  | { type: "ERREUR"; message?: string };

export interface EtatMachineVoix {
  etat: EtatCycleVoix;
  /** Message humain quand l'activation est impossible (non support). */
  messageErreur?: string;
}

/** Réarmement du micro demandé au retour au silence ? (le contrôleur l'écoute
 *  une fois — c'est lui qui arme réellement SpeechRecognition). */
export function rearmementDemande(etat: EtatMachineVoix, precedent: EtatMachineVoix): boolean {
  return precedent.etat !== "silence" && etat.etat === "silence";
}

/** MACHINE À ÉTATS PURE du cycle voix continue — la même fonction en prod
 *  et en test ; toute transition illégale reste dans un état sûr. */
export function transitionVoixContinue(courant: EtatMachineVoix, evenement: EvenementVoixContinue): EtatMachineVoix {
  switch (evenement.type) {
    case "ACTIVER":
      if (!evenement.supported) {
        return {
          etat: "inactif",
          messageErreur: "Reconnaissance vocale non supportée par ce navigateur — le mode voix continue est indisponible.",
        };
      }
      // L'activation lance le premier cycle : attente du DEBUT_ECOUTE armé par le contrôleur.
      return { etat: "silence" };
    case "DESACTIVER":
      return { etat: "inactif" };
    case "DEBUT_ECOUTE":
      if (courant.etat === "silence") return { etat: "ecoute" };
      return courant;
    case "TRANSCRIPT_ENVOYE":
      if (courant.etat === "ecoute") return { etat: "attente-reponse" };
      return courant;
    case "REPONSE_RECU":
      if (courant.etat === "attente-reponse") return { etat: "lecture" };
      return courant;
    case "LECTURE_TERMINEE":
      if (courant.etat === "lecture") return { etat: "silence" };
      return courant;
    case "ERREUR":
      // Une erreur de micro ou de synthèse ne coupe PAS le mode : retour au
      // silence (réarmement) avec le message pour l'UI — la conversation
      // vocale reste fluide, l'utilisateur peut toujours désactiver.
      if (courant.etat === "inactif") return courant;
      return { etat: "silence", messageErreur: evenement.message };
    default:
      return courant;
  }
}

/* ───────────────── Contrôleur PUR du cycle (testé hors DOM) ───────────────── */

export interface OptionsVoixContinue {
  /** Le navigateur supporte-t-il la reconnaissance ? (detecterSupportReconnaissance) */
  supported: boolean;
  /** ARME le micro (saisieVocale.demarrer côté NovaChat). */
  ecouter: () => void;
  /** Coupe le micro (saisieVocale.annuler côté NovaChat). */
  arreterEcoute: () => void;
  /** Lit le texte à voix haute — résout quand la lecture est RÉELLEMENT
   *  terminée (promesse branchée sur le callback de fin de synthèse). */
  lire: (texte: string) => Promise<void>;
  /** Message humain pour l'UI (erreur micro, non support…). */
  onErreur?: (message: string) => void;
  /** Notification du transcript envoyé (le hook relaie l'envoi réel). */
  onTranscriptEnvoye?: (texte: string) => void;
  /** Notifié à chaque changement d'état du cycle (le hook reflète l'UI). */
  onChange?: (etat: EtatMachineVoix) => void;
}

export interface ControleurVoixContinue {
  /** Mode ACTIVÉ (le cycle tourne jusqu'à désactiver()). */
  actif: () => boolean;
  /** État courant de la machine (pour l'UI). */
  etat: () => EtatMachineVoix;
  /** Active le mode voix continu et arme le premier cycle d'écoute. */
  activer: () => void;
  /** Désactive le mode : micro coupé, lecture interrompue. */
  desactiver: () => void;
  /** Signal du hook d'écoute : le micro a commencé à écouter. */
  notifierDebutEcoute: () => void;
  /** Signal : le transcript final a été envoyé à gen3. */
  notifierTranscriptEnvoye: (texte: string) => void;
  /** Signal : la réponse gen3 est prête — lecture SYNCHRONISÉE. */
  notifierReponse: (texte: string) => void;
  /** Signal d'erreur du cycle (micro/synthèse) — ne coupe pas le mode. */
  notifierErreur: (message: string) => void;
}

/** Contrôleur du cycle voix continue : machine à états + effets de bord
 *  (réarmement du micro au retour au silence, lecture branchée sur la
 *  promesse de fin réelle). Toute l'intelligence du mode vit ICI — le hook
 *  React n'est qu'un miroir d'état. */
export function creerCycleVoixContinue(options: OptionsVoixContinue): ControleurVoixContinue {
  let actif = false;
  let etat: EtatMachineVoix = { etat: "inactif" };

  const appliquer = (evenement: EvenementVoixContinue) => {
    const precedent = etat;
    etat = transitionVoixContinue(etat, evenement);
    if (etat.messageErreur) options.onErreur?.(etat.messageErreur);
    options.onChange?.(etat);
    // Réarmement AUTOMATIQUE : retour NOUVEAU au silence pendant que le mode
    // est actif — le micro se réarme seul (fluidité mains libres).
    if (actif && rearmementDemande(etat, precedent)) options.ecouter();
  };

  return {
    actif: () => actif,
    etat: () => etat,
    activer() {
      actif = true;
      appliquer({ type: "ACTIVER", supported: options.supported });
    },
    desactiver() {
      actif = false;
      options.arreterEcoute(); // micro coupé immédiatement
      appliquer({ type: "DESACTIVER" });
    },
    notifierDebutEcoute() {
      appliquer({ type: "DEBUT_ECOUTE" });
    },
    notifierTranscriptEnvoye(texte: string) {
      options.onTranscriptEnvoye?.(texte);
      appliquer({ type: "TRANSCRIPT_ENVOYE" });
    },
    notifierReponse(texte: string) {
      appliquer({ type: "REPONSE_RECU" });
      // Lecture SYNCHRONISÉE : la promesse résout à la FIN RÉELLE de la
      // synthèse — la machine ne repasse au silence (donc ne réarme pas le
      // micro) qu'après la lecture complète. Un échec de lecture ne coupe
      // pas le mode : ERREUR ramène au silence → reprise d'écoute.
      void options
        .lire(texte)
        .then(() => appliquer({ type: "LECTURE_TERMINEE" }))
        .catch(() => appliquer({ type: "ERREUR", message: "La lecture vocale a échoué — le cycle reprend à l'écoute." }));
    },
    notifierErreur(message: string) {
      appliquer({ type: "ERREUR", message });
    },
  };
}

/* ──────────────────────────────── Le hook ──────────────────────────────── */

export interface VoixContinue {
  /** Mode ACTIVÉ (le cycle tourne jusqu'à désactiver()). */
  actif: boolean;
  /** État du cycle pour l'UI (« Écoute en cours… », « gen3 répond… », …). */
  etatCycle: EtatCycleVoix;
  /** Dernier message d'erreur humain (chaîne vide = rien). */
  message: string;
  /** Active le mode voix continu et arme le premier cycle d'écoute. */
  activer: () => void;
  /** Désactive le mode : micro coupé, lecture interrompue. */
  desactiver: () => void;
  /** Signal du hook d'écoute : le micro a commencé à écouter. */
  notifierDebutEcoute: () => void;
  /** Signal : le transcript final a été envoyé à gen3. */
  notifierTranscriptEnvoye: (texte: string) => void;
  /** Signal : la réponse gen3 est prête — lecture SYNCHRONISÉE. */
  notifierReponse: (texte: string) => void;
  /** Signal d'erreur du cycle (micro/synthèse) — ne coupe pas le mode. */
  notifierErreur: (message: string) => void;
}

/** Fin wrapper React autour du contrôleur pur — conforme aux conventions
 *  du dépôt (logique testée hors DOM, hook = miroir d'état). */
export function useVoiceModeContinu(options: OptionsVoixContinue): VoixContinue {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const cycleRef = useRef<ControleurVoixContinue | null>(null);
  const [actif, setActif] = useState(false);
  const [etatMachine, setEtatMachine] = useState<EtatMachineVoix>({ etat: "inactif" });

  const synchroniser = useCallback((suivant: EtatMachineVoix) => {
    setEtatMachine(suivant);
    // Le mode ACTIVÉ/DÉSACTIVÉ est reflété depuis le contrôleur (source de vérité).
    setActif(cycleRef.current?.actif() ?? false);
  }, []);

  const cycle = useCallback((): ControleurVoixContinue => {
    if (!cycleRef.current) {
      cycleRef.current = creerCycleVoixContinue({
        get supported() {
          return optionsRef.current.supported;
        },
        ecouter: () => optionsRef.current.ecouter(),
        arreterEcoute: () => optionsRef.current.arreterEcoute(),
        lire: (texte) => optionsRef.current.lire(texte),
        onErreur: (message) => optionsRef.current.onErreur?.(message),
        onTranscriptEnvoye: (texte) => optionsRef.current.onTranscriptEnvoye?.(texte),
        onChange: synchroniser,
      });
    }
    return cycleRef.current;
  }, [synchroniser]);

  const activer = useCallback(() => cycle().activer(), [cycle]);
  const desactiver = useCallback(() => cycle().desactiver(), [cycle]);
  const notifierDebutEcoute = useCallback(() => cycle().notifierDebutEcoute(), [cycle]);
  const notifierTranscriptEnvoye = useCallback((texte: string) => cycle().notifierTranscriptEnvoye(texte), [cycle]);
  const notifierReponse = useCallback((texte: string) => cycle().notifierReponse(texte), [cycle]);
  const notifierErreur = useCallback((message: string) => cycle().notifierErreur(message), [cycle]);

  /* Désactivation propre au démontage : micro coupé, cycle remis à zéro. */
  useEffect(() => {
    return () => {
      cycleRef.current?.desactiver();
      cycleRef.current = null;
    };
  }, []);

  return {
    actif,
    etatCycle: etatMachine.etat,
    message: etatMachine.messageErreur ?? "",
    activer,
    desactiver,
    notifierDebutEcoute,
    notifierTranscriptEnvoye,
    notifierReponse,
    notifierErreur,
  };
}

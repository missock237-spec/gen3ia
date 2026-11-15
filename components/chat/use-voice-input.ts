"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * USE VOICE INPUT — saisie vocale NATIVE navigateur (Web Speech API).
 *
 * Brique partagée du chat voix (demande utilisateur n°3 : appui sur le
 * bouton d'envoi sans prompt écrit → activation de l'écoute) — encapsule
 * SpeechRecognition / webkitSpeechRecognition : fr-FR, single-shot
 * (continuous=false), interimResults pour l'affichage en direct.
 *
 * HONNÊTETÉ : aucune dépendance externe, aucun faux moteur — si le
 * navigateur ne supporte pas la reconnaissance vocale, `supported` vaut
 * false et l'interface affiche un message explicite (dégradation assumée).
 *
 * Types Web Speech : declarations locales minimales (SpeechRecognition ne
 * fait pas partie de lib.dom.d.ts) — aucune dépendance @types ajoutée.
 *
 * Machine à états simple : {inactif | ecoute | erreur}. La logique pure
 * (détection de support, extraction du transcript, messages d'erreur,
 * branchement d'une instance) est EXPORTÉE et testée hors DOM (vitest
 * environment=node) ; le hook lui-même est un fin wrapper navigateur.
 */

/* ─────────────── Déclarations Web Speech locales (minimales) ─────────────── */

export interface ReconnaissanceAlternativeLike {
  transcript: string;
}

export interface ReconnaissanceResultatLike {
  isFinal: boolean;
  length: number;
  [index: number]: ReconnaissanceAlternativeLike;
}

export interface ReconnaissanceEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: ReconnaissanceResultatLike;
  };
}

export interface ReconnaissanceErreurEventLike {
  error: string;
  message?: string;
}

export interface ReconnaissanceLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: ReconnaissanceEventLike) => void) | null;
  onerror: ((event: ReconnaissanceErreurEventLike) => void) | null;
  onend: (() => void) | null;
}

export type ConstructeurReconnaissance = new () => ReconnaissanceLike;

/* ─────────────────────────── Logique pure (testée) ─────────────────────────── */

/** Détection honnête du support (garde SSR : false hors navigateur). */
export function detecterSupportReconnaissance(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    SpeechRecognition?: ConstructeurReconnaissance;
    webkitSpeechRecognition?: ConstructeurReconnaissance;
  };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** Codes d'erreur Web Speech → message honnête en français.
 *  « aborted » (annulation volontaire) → chaîne vide (silencieux). */
export function messageErreurVoix(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone refusé — autorisez le micro dans votre navigateur pour dicter.";
    case "no-speech":
      return "Aucune voix détectée — réessayez.";
    case "network":
      return "Reconnaissance vocale indisponible (réseau) — réessayez.";
    case "audio-capture":
      return "Aucun microphone détecté sur cet appareil.";
    case "aborted":
      return "";
    default:
      return "La saisie vocale a rencontré un problème. Réessayez.";
  }
}

export interface TranscriptExtrait {
  /** Texte final reconnu (concaténé, trim) — peut être vide. */
  final: string;
  /** Texte provisoire (affichage en direct) — peut être vide. */
  interim: string;
}

/** Extrait les transcript final / interim d'un événement onresult. */
export function extraireTranscriptFinal(event: ReconnaissanceEventLike): TranscriptExtrait {
  let final = "";
  let interim = "";
  for (let i = 0; i < event.results.length; i++) {
    const resultat = event.results[i];
    let texte = "";
    for (let j = 0; j < resultat.length; j++) {
      texte += resultat[j]?.transcript ?? "";
    }
    texte = texte.trim();
    if (!texte) continue;
    if (resultat.isFinal) final = final ? `${final} ${texte}` : texte;
    else interim = interim ? `${interim} ${texte}` : texte;
  }
  return { final, interim };
}

export interface CallbacksReconnaissance {
  /** Texte final reconnu (délivré au onend par le hook). */
  surTranscriptFinal: (texte: string) => void;
  /** Texte provisoire (affichage en direct). */
  surInterim: (texte: string) => void;
  /** Erreur détectée (message humain déjà traduit, chaîne vide = silencieux). */
  surErreur: (message: string) => void;
  /** Fin d'écoute (onend) — délivre le transcript final accumulé. */
  surFin: (final: string) => void;
}

/** Construit et branche une instance SpeechRecognition (fr-FR, single-shot,
 *  interimResults) autour des callbacks fournis — factory exportée pour
 *  être testée hors DOM avec un constructeur factice. */
export function creerReconnaissance(
  constructeur: ConstructeurReconnaissance,
  callbacks: CallbacksReconnaissance,
  options?: { lang?: string },
): ReconnaissanceLike {
  const reconnaissance = new constructeur();
  reconnaissance.lang = options?.lang ?? "fr-FR";
  reconnaissance.continuous = false;
  reconnaissance.interimResults = true;
  reconnaissance.maxAlternatives = 1;

  let final = "";
  reconnaissance.onresult = (event) => {
    const extrait = extraireTranscriptFinal(event);
    callbacks.surInterim(extrait.interim);
    if (extrait.final) final = extrait.final;
  };
  reconnaissance.onerror = (event) => {
    const message = messageErreurVoix(event.error);
    if (message) callbacks.surErreur(message);
  };
  reconnaissance.onend = () => callbacks.surFin(final.trim());

  return reconnaissance;
}

/* ──────────────────────────────── Le hook ──────────────────────────────── */

export type EtatVoix = "inactif" | "ecoute" | "erreur";

export interface OptionsEntreeVocale {
  /** Transcript FINAL reconnu (le tour vocal part alors automatiquement). */
  onTranscript: (texte: string) => void;
  /** Erreur humaine (micro refusé, réseau, non support…). */
  onErreur?: (message: string) => void;
  /** Langue (défaut fr-FR). */
  lang?: string;
}

export interface EntreeVocale {
  etat: EtatVoix;
  /** Texte provisoire en cours de reconnaissance (affichage direct). */
  texteInterim: string;
  /** false = navigateur sans Web Speech (dégradation honnête). */
  supported: boolean;
  /** Démarre l'écoute (micro). */
  demarrer: () => void;
  /** Arrêt propre : le transcript final accumulé sera délivré. */
  arreter: () => void;
  /** Annulation : RIEN n'est délivré (re-clic sur le bouton). */
  annuler: () => void;
}

export function useVoiceInput(options: OptionsEntreeVocale): EntreeVocale {
  /* Dernière référence d'options (les callbacks changent à chaque rendu
   * sans recréer l'écoute en cours). */
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const reconnaissanceRef = useRef<ReconnaissanceLike | null>(null);
  const annuleRef = useRef(false);
  const [etat, setEtat] = useState<EtatVoix>("inactif");
  const [texteInterim, setTexteInterim] = useState("");
  const supported = useMemo(detecterSupportReconnaissance, []);

  const nettoyer = useCallback(() => {
    const reconnaissance = reconnaissanceRef.current;
    reconnaissanceRef.current = null;
    if (reconnaissance) {
      reconnaissance.onresult = null;
      reconnaissance.onerror = null;
      reconnaissance.onend = null;
    }
  }, []);

  const demarrer = useCallback(() => {
    if (!supported) {
      optionsRef.current.onErreur?.("Reconnaissance vocale non supportée par ce navigateur.");
      return;
    }
    if (reconnaissanceRef.current) return; // déjà en écoute
    const w = window as unknown as {
      SpeechRecognition?: ConstructeurReconnaissance;
      webkitSpeechRecognition?: ConstructeurReconnaissance;
    };
    const constructeur = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!constructeur) {
      optionsRef.current.onErreur?.("Reconnaissance vocale non supportée par ce navigateur.");
      return;
    }
    annuleRef.current = false;
    setTexteInterim("");
    try {
      const reconnaissance = creerReconnaissance(
        constructeur,
        {
          surTranscriptFinal: () => {
            /* le final est accumulé dans creerReconnaissance et délivré au onend */
          },
          surInterim: (texte) => setTexteInterim(texte),
          surErreur: (message) => {
            if (message) {
              setEtat("erreur");
              optionsRef.current.onErreur?.(message);
            }
          },
          surFin: (final) => {
            nettoyer();
            setEtat((courant) => (courant === "erreur" ? "erreur" : "inactif"));
            setTexteInterim("");
            if (!annuleRef.current && final) optionsRef.current.onTranscript(final);
          },
        },
        { lang: optionsRef.current.lang },
      );
      reconnaissanceRef.current = reconnaissance;
      setEtat("ecoute");
      reconnaissance.start();
    } catch {
      // start() peut lever (InvalidStateError…) : dégradation honnête.
      nettoyer();
      setEtat("erreur");
      optionsRef.current.onErreur?.("La saisie vocale n'a pas pu démarrer. Réessayez.");
    }
  }, [supported, nettoyer]);

  const arreter = useCallback(() => {
    const reconnaissance = reconnaissanceRef.current;
    if (!reconnaissance) return;
    try {
      reconnaissance.stop(); // onend délivrera le transcript final accumulé
    } catch {
      /* onend fera le nettoyage */
    }
  }, []);

  const annuler = useCallback(() => {
    annuleRef.current = true;
    const reconnaissance = reconnaissanceRef.current;
    if (reconnaissance) {
      try {
        reconnaissance.abort();
      } catch {
        /* ignore */
      }
    }
    nettoyer();
    setEtat("inactif");
    setTexteInterim("");
  }, [nettoyer]);

  /* Nettoyage au démontage : le micro est libéré, rien n'est délivré. */
  useEffect(() => {
    return () => {
      annuleRef.current = true;
      const reconnaissance = reconnaissanceRef.current;
      if (reconnaissance) {
        try {
          reconnaissance.abort();
        } catch {
          /* ignore */
        }
      }
      nettoyer();
    };
  }, [nettoyer]);

  return { etat, texteInterim, supported, demarrer, arreter, annuler };
}

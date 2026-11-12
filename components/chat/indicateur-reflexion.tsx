"use client";

/**
 * INDICATEUR DE RÉFLEXION — la demande propriétaire EXACTE : « gen3 doit
 * montrer à l'utilisateur qu'il est en pleine réflexion lors d'une requête ».
 *
 * Rendu dans le fil (nova-fil) pendant TOUT le traitement — de l'envoi de la
 * demande à la première réponse / au « done » — à la place des trois points
 * muets historiques (une seule source : pas de doublon). Disparition
 * propre : dès que `message_delta` remplit la bulle (écriture progressive)
 * ou au `done` / `message_complete`, le composant se démonte (la garde
 * d'affichage est `message.enCours && !message.content` côté nova-chat.tsx) ;
 * il ne s'affiche JAMAIS sur un rechargement d'historique (les messages
 * serveur ne portent jamais `enCours`).
 *
 * Contenu vivant : « gen3 réfléchit… » + la phase RÉELLE déduite des
 * événements du flux (voir indicateur-reflexion-logique.ts — la logique
 * pure y vit pour rester testable en Node, convention media-progress-logic).
 *
 * ACCESSIBILITÉ : `aria-busy` sur le conteneur, `aria-live="polite"` sur le
 * libellé, points décoratifs en aria-hidden, animation douce (< 2 s de
 * cycle) respectant `prefers-reduced-motion` (cf. indicateur-reflexion.module.css).
 */

import * as React from "react";

import { LIBELLES_PHASE, libelleGenere, type PhaseReflexion } from "./indicateur-reflexion-logique";
import styles from "./indicateur-reflexion.module.css";

// Surface publique : la logique pure est re-exportée (l'API reste
// ./indicateur-reflexion côté nova-chat.tsx).
export * from "./indicateur-reflexion-logique";

export interface IndicateurReflexionProps {
  /** Phase déduite des événements RÉELS du flux (undefined = générique). */
  phase?: PhaseReflexion | null;
  /** Libellé réel reçu du serveur (événement `status`) — prioritaire. */
  libelle?: string | null;
  /** Période de rotation des libellés génériques (ms, défaut 4000). */
  periodeRotationMs?: number;
}

/**
 * Indicateur vivant « gen3 réfléchit… » : points qui pulsent + halo doux
 * (module CSS local, tokens --g3-*), libellé annoncé poliment, aria-busy.
 */
export function IndicateurReflexion({
  phase,
  libelle,
  periodeRotationMs = 4000,
}: IndicateurReflexionProps) {
  const [cycle, setCycle] = React.useState(0);

  // Fige la rotation dès qu'une information RÉELLE existe (libellé serveur
  // ou phase déduite) — l'énoncé reste exact en continu.
  const libelleServeur = typeof libelle === "string" ? libelle.trim() : "";
  const fige = Boolean(libelleServeur) || (Boolean(phase) && phase !== "reflexion");

  React.useEffect(() => {
    if (fige) return; // phase réelle connue : pas de rotation
    const periode = Math.max(1000, periodeRotationMs);
    const timer = window.setInterval(() => setCycle((c) => c + 1), periode);
    return () => window.clearInterval(timer);
  }, [fige, periodeRotationMs]);

  const texte = libelleServeur
    ? libelleServeur
    : phase && phase !== "reflexion"
      ? LIBELLES_PHASE[phase]
      : libelleGenere(cycle);

  return (
    <div className={styles.conteneur} aria-busy="true" data-phase={phase ?? "reflexion"}>
      <span className={styles.halo} aria-hidden="true">
        <span className={styles.point} />
        <span className={styles.point} />
        <span className={styles.point} />
      </span>
      <span className={styles.libelle} aria-live="polite">
        {texte}
      </span>
    </div>
  );
}

export default IndicateurReflexion;

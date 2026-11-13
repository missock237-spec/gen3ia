"use client";

import React from "react";

import { pourcentageDepuis } from "./carte-video-fil-logique";

/**
 * CARTE VIDÉO DU FIL DE CONVERSATION (2026-11-12) — le chaînon manquant de
 * « la vidéo n'est pas réellement créée et envoyée dans la conversation ».
 *
 * CONSTAT : le chat épuré n'affichait NI l'event artifact_created NI la carte
 * workspace (VideoProductionCard vit hors du fil) ; le message de livraison
 * ne portait qu'une URL présignée 900 s — morte avant le clic. L'utilisateur
 * n'a donc jamais VU sa vidéo dans la conversation.
 *
 * COMPORTEMENT :
 *  - progression réelle (stage + %) tant que la production tourne — canal
 *    SSE GET /api/video/projects/<id>/production/stream, repli sondage 5 s
 *    (mêmes canaux que la carte workspace) ;
 *  - CONTRAT 0..1 → POURCENTAGE (fix 2026-11-13 « la barre de progression
 *    n'augmente pas ») : le serveur stocke la progression en 0..1 (contrat
 *    UI ×100, cf. video-production-card) — la carte du fil applique la
 *    même conversion tolérante, le carré SE REMPLIT au fil des étapes ;
 *  - CARRÉ DE PROGRESSION (demande propriétaire 2026-11-13 : plus de
 *    barre horizontale — un CARRÉ affichant le pourcentage en grand, qui
 *    se remplit du bas comme un niveau) : styles .nova-media-carre-* ;
 *    le texte « Production vidéo — {stage} ({NN} %) » est CONSERVÉ tel
 *    quel à côté du carré (les sondes production Python le lisent via
 *    .nova-fil, cf. scripts/verifie-voix-video-production.py) ;
 *  - progression MONOTONE + ÉTAT CONSERVÉ : un incident passager du canal
 *    de statut (réseau, disjoncteur de stockage 503) ne ramène JAMAIS le
 *    carré en arrière ni à zéro — le dernier état connu reste affiché et
 *    le canal retente ;
 *  - lecteur <video controls> dès que le master existe : GET
 *    .../render renvoie output.playbackUrl PRÉSIGNÉE FRAÎCHE à chaque
 *    appel (jamais d'URL figée expirée dans le fil) ;
 *  - échec affiché honnêtement avec l'étape atteinte.
 *
 * Léger volontairement : la carte workspace reste l'atelier complet
 * (montage, révisions, exports) — ici on LIVRE dans la conversation.
 */

type EtatCarte =
  | { type: "chargement" }
  | { type: "progression"; stage: string; progress: number }
  | { type: "prete"; url: string }
  | { type: "echec"; detail: string };

const STAGES_FR: Record<string, string> = {
  project: "création du projet",
  plan: "plan du réalisateur",
  script: "écriture du scénario",
  assets: "génération des visuels",
  voice: "narration vocale",
  render: "montage et rendu",
  done: "finalisation",
};

const TERMINAUX = new Set(["completed", "failed", "cancelled"]);

export function CarteVideoFil({ videoProjectId }: { videoProjectId: string }) {
  const [etat, setEtat] = React.useState<EtatCarte>({ type: "chargement" });
  // Plafond monotone de la progression affichée (0..100) : un canal qui
  // trébuche (réseau, 503 disjoncteur) ne fait JAMAIS reculer le carré.
  const plafond = React.useRef(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let vivant = true;
    let source: EventSource | null = null;
    let minuterie: ReturnType<typeof setInterval> | null = null;

    /** Lecteur : GET .../render → sortie du job terminé (URL fraîche). */
    const resoudreLecteur = async (): Promise<string | null> => {
      const reponse = await fetch(`/api/video/projects/${videoProjectId}/render`, { signal: controller.signal });
      if (!reponse.ok) return null;
      const data = (await reponse.json()) as {
        jobs?: Array<{ status?: string; output?: { playbackUrl?: string | null } }>;
      };
      const termine = data.jobs?.find((j) => j.status === "completed");
      return termine?.output?.playbackUrl ?? null;
    };

    const statutDepuisProduction = (st: { status?: string; stage?: string; progress?: number; error?: string; masterUrl?: string | null }): EtatCarte => {
      if (st.status === "completed") {
        // LECTEUR DURABLE DIRECT (fix 2026-11-13 « la vidéo n'est jamais
        // envoyée ») : le statut de production porte désormais l'URL durable
        // RELATIVE du master (/api/media/durable?path=…) — cookie de session
        // automatique, re-signature fraîche à chaque lecture. Un seul saut au
        // lieu de la chaîne GET .../render + présignature qui trébuchait et
        // laissait la carte figée sur « finalisation (100 %) » en production.
        if (typeof st.masterUrl === "string" && st.masterUrl.length > 0) {
          return { type: "prete", url: st.masterUrl };
        }
        return { type: "chargement" }; // lecteur résolu séparément
      }
      if (st.status === "failed" || st.status === "cancelled") {
        const label = STAGES_FR[st.stage ?? ""] ?? st.stage ?? "production";
        return { type: "echec", detail: `Production interrompue (${label})${st.error ? " — " + st.error.slice(0, 160) : ""}.` };
      }
      // MONOTONE : le carré ne peut que se remplir — le plafond connu gagne
      // toujours contre une lecture plus basse (tick en cours, cache…).
      const pct = pourcentageDepuis(st.progress);
      if (pct !== null && pct > plafond.current) plafond.current = pct;
      return {
        type: "progression",
        stage: STAGES_FR[st.stage ?? ""] ?? st.stage ?? "préparation",
        progress: plafond.current,
      };
    };

    const interroger = async () => {
      try {
        // INCIDENT PASSAGER (réseau, disjoncteur de stockage → 503) : on
        // garde l'état courant (carré inchangé) — le prochain cycle retente.
        const st = await fetch(`/api/video/projects/${videoProjectId}/production`, { signal: controller.signal })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (!st || typeof st !== "object") return;
        const etatSuivant = statutDepuisProduction(st as { status?: string; stage?: string; progress?: number; error?: string });
        if (etatSuivant.type === "chargement") {
          const url = await resoudreLecteur();
          if (url && vivant) {
            plafond.current = 100;
            setEtat({ type: "prete", url });
          } else if (vivant) {
            plafond.current = Math.max(plafond.current, 99);
            setEtat({ type: "progression", stage: "finalisation", progress: plafond.current });
          }
        } else if (vivant) {
          setEtat(etatSuivant);
        }
      } catch {
        /* réseau : retenté au prochain cycle */
      }
    };

    // Cycle initial immédiat, puis SSE si disponible, sinon sondage 5 s.
    void interroger();
    try {
      source = new EventSource(`/api/video/projects/${videoProjectId}/production/stream`);
      source.onmessage = (e) => {
        try {
          const st = JSON.parse(e.data) as { status?: string; stage?: string; progress?: number; error?: string; masterUrl?: string | null };
          if (TERMINAUX.has(st.status ?? "")) {
            void interroger(); // terminé → résout le lecteur (URL fraîche)
          } else if (vivant) {
            setEtat(statutDepuisProduction(st));
          }
        } catch {
          /* message SSE illisible : sondage prend le relais */
        }
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (minuterie === null && vivant) minuterie = setInterval(() => void interroger(), 5000);
      };
    } catch {
      if (minuterie === null && vivant) minuterie = setInterval(() => void interroger(), 5000);
    }
    // Sondage de complément même avec SSE (le flux peut ne pas tout porter).
    if (minuterie === null) minuterie = setInterval(() => void interroger(), 8000);

    return () => {
      vivant = false;
      controller.abort();
      source?.close();
      if (minuterie !== null) clearInterval(minuterie);
    };
  }, [videoProjectId]);

  if (etat.type === "prete") {
    return (
      <figure className="nova-media-carte">
        <video src={etat.url} controls preload="metadata" className="nova-media-video" />
        <figcaption>Vidéo terminée — lecture directement dans ce fil.</figcaption>
      </figure>
    );
  }
  if (etat.type === "echec") {
    return (
      <figure className="nova-media-carte echec">
        <figcaption>Production vidéo : {etat.detail}</figcaption>
      </figure>
    );
  }
  const progression = etat.type === "progression" ? etat.progress : 0;
  return (
    /* CARRÉ DE PROGRESSION (2026-11-13) : le pourcentage est affiché EN
     * GRAND dans le carré, qui se remplit du bas comme un niveau. Contraste
     * calculé via data-contraste (< 55 % → texte blanc sur pastille sombre
     * translucide ; ≥ 55 % → texte sombre sur pastille claire). Le rôle
     * progressbar + aria-valuenow/min/max sont conservés, avec un libellé
     * explicite. figcaption reste un enfant direct de <figure> (dernier
     * enfant : HTML valide) — son texte, lu par les sondes via .nova-fil,
     * est strictement inchangé. */
    <figure className="nova-media-carte nova-media-carte-progress">
      <div
        className="nova-media-carre"
        role="progressbar"
        aria-valuenow={progression}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Progression de création de la vidéo : ${progression} %`}
        data-contraste={progression < 55 ? "sombre" : "clair"}
      >
        <div className="nova-media-carre-niveau" style={{ height: `${progression}%` }} />
        <span className="nova-media-carre-pourcentage">{progression} %</span>
      </div>
      <figcaption>
        Production vidéo {etat.type === "progression" ? `— ${etat.stage} (${progression} %)` : "— chargement du lecteur…"}
      </figcaption>
    </figure>
  );
}

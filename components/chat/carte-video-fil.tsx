"use client";

import React from "react";

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

    const statutDepuisProduction = (st: { status?: string; stage?: string; progress?: number; error?: string }): EtatCarte => {
      if (st.status === "completed") return { type: "chargement" }; // lecteur résolu séparément
      if (st.status === "failed" || st.status === "cancelled") {
        const label = STAGES_FR[st.stage ?? ""] ?? st.stage ?? "production";
        return { type: "echec", detail: `Production interrompue (${label})${st.error ? " — " + st.error.slice(0, 160) : ""}.` };
      }
      return {
        type: "progression",
        stage: STAGES_FR[st.stage ?? ""] ?? st.stage ?? "préparation",
        progress: typeof st.progress === "number" ? st.progress : 0,
      };
    };

    const interroger = async () => {
      try {
        const st = await fetch(`/api/video/projects/${videoProjectId}/production`, { signal: controller.signal })
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({}));
        const etatSuivant = statutDepuisProduction(st as { status?: string; stage?: string; progress?: number; error?: string });
        if (etatSuivant.type === "chargement") {
          const url = await resoudreLecteur();
          if (url && vivant) setEtat({ type: "prete", url });
          else if (vivant) setEtat({ type: "progression", stage: "finalisation", progress: 99 });
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
          const st = JSON.parse(e.data) as { status?: string; stage?: string; progress?: number; error?: string };
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
  const progression = etat.type === "progression" ? Math.round(etat.progress) : 0;
  return (
    <figure className="nova-media-carte">
      <figcaption>
        Production vidéo {etat.type === "progression" ? `— ${etat.stage} (${progression} %)` : "— chargement du lecteur…"}
      </figcaption>
      <div className="nova-media-barre" role="progressbar" aria-valuenow={progression} aria-valuemin={0} aria-valuemax={100}>
        <div className="nova-media-barre-remplie" style={{ width: `${progression}%` }} />
      </div>
    </figure>
  );
}

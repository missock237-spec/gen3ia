"use client";

import React from "react";

/**
 * ARTEFACT ACTIONS — le bouton « Modifier » et le bouton « Télécharger »
 * sur les médias créés par gen3 (demande utilisateur : « si un utilisateur
 * décide de le modifier il doit avoir un bouton de modifications qui va
 * permettre que gen3 modifie son image créée selon la volonté de
 * l'utilisateur via le prompt — et pareil pour l'audio et la vidéo » ;
 * « chaque utilisateur peut télécharger les artefacts créés »).
 *
 * · TÉLÉCHARGER : artefact → route authentifiée de téléchargement forcé ;
 *   média du fil sans artefact → lien direct.
 * · MODIFIER : un prompt inline est envoyé à /api/artefacts/modifier —
 *   l'artefact existant gagne une VERSION, un média sans artefact devient
 *   un NOUVEL artefact propriété du compte ; l'aperçu est rechargé depuis
 *   la route de téléchargement (inline) avec cache-bust.
 *
 * HONNÊTETÉ : l'UI n'affiche que ce que le serveur a réellement appliqué
 * (liste des opérations renvoyées, message de refus sinon).
 */

export interface ArtefactActionsProps {
  /** Identifiant d'artefact (si le média est un artefact versionné). */
  artefactId?: string;
  /** URL du média (image du fil, audio/vidéo généré) — sert d'entrée d'édition si pas d'artefact. */
  url?: string;
  type: "image" | "audio" | "video";
  titre?: string;
  /** Aperçu rechargé après édition (le parent peut réagir). */
  onApercuMisAJour?: (src: string) => void;
}

type EtatEdition = "inactif" | "saisie" | "envoi" | "ok" | "erreur";

export function ArtefactActions({ artefactId, url, type, titre, onApercuMisAJour }: ArtefactActionsProps) {
  const [etat, setEtat] = React.useState<EtatEdition>("inactif");
  const [prompt, setPrompt] = React.useState("");
  const [resultat, setResultat] = React.useState<{ message: string; artefactId?: string; version?: number } | null>(null);
  const [erreur, setErreur] = React.useState("");

  const peutEditer = Boolean(artefactId || url);

  const modifier = async () => {
    if (!prompt.trim()) return;
    setEtat("envoi");
    setErreur("");
    try {
      const corps: Record<string, unknown> = { prompt: prompt.trim(), type, titre };
      if (artefactId) corps.artefactId = artefactId;
      else if (url) {
        corps.url = url;
        corps.type = type;
      }
      const reponse = await fetch("/api/artefacts/modifier", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corps),
        cache: "no-store",
      });
      const donnees = (await reponse.json()) as {
        ok?: boolean;
        artefactId?: string;
        version?: number;
        details?: string;
        error?: string;
        message?: string;
      };
      if (!reponse.ok || donnees.ok === false) {
        setErreur(donnees.error || donnees.message || "L'édition a été refusée par gen3 (voir le détail).");
        setEtat("erreur");
        return;
      }
      setResultat({
        message: donnees.details || "Édition appliquée.",
        artefactId: donnees.artefactId,
        version: donnees.version,
      });
      setEtat("ok");
      setPrompt("");
      if (donnees.artefactId && onApercuMisAJour) {
        onApercuMisAJour(`/api/artefacts/${donnees.artefactId}/telecharger?apercu=1&v=${Date.now()}`);
      }
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Erreur réseau pendant l'édition.");
      setEtat("erreur");
    }
  };

  return (
    <div className="nova-artefact-actions">
      <div className="nova-artefact-actions-ligne">
        {artefactId ? (
          <a className="nova-artefact-btn" href={`/api/artefacts/${artefactId}/telecharger`}>
            ⬇ Télécharger
          </a>
        ) : url && type === "image" ? (
          <a className="nova-artefact-btn" href={url} download target="_blank" rel="noreferrer">
            ⬇ Télécharger
          </a>
        ) : null}
        {peutEditer ? (
          <button
            type="button"
            className="nova-artefact-btn"
            onClick={() => setEtat(etat === "saisie" ? "inactif" : "saisie")}
            disabled={etat === "envoi"}
            title="Demander à gen3 de modifier ce média (prompt)"
          >
            ✎ Modifier
          </button>
        ) : null}
        {etat === "envoi" ? <span className="nova-artefact-etat">gen3 modifie…</span> : null}
      </div>

      {etat === "saisie" || etat === "erreur" ? (
        <div className="nova-artefact-editeur">
          <textarea
            className="nova-artefact-prompt"
            rows={2}
            value={prompt}
            placeholder={
              type === "image"
                ? "Ex. : pivoter à gauche, noir et blanc, luminosité +20 %, recadrer carré…"
                : type === "audio"
                  ? "Ex. : volume −30 %, couper les 3 premières secondes, fondu 2 s…"
                  : "Ex. : couper les 5 premières secondes, vitesse 2×, 720p…"
            }
            onChange={(e) => setPrompt(e.target.value)}
            aria-label="Prompt de modification"
          />
          <div className="nova-artefact-actions-ligne">
            <button type="button" className="nova-artefact-btn primaire" onClick={() => void modifier()} disabled={!prompt.trim()}>
              Appliquer avec gen3
            </button>
            <button type="button" className="nova-artefact-btn" onClick={() => { setEtat("inactif"); setErreur(""); }}>
              Annuler
            </button>
          </div>
          {etat === "erreur" && erreur ? <p className="nova-artefact-erreur">{erreur}</p> : null}
        </div>
      ) : null}

      {etat === "ok" && resultat ? (
        <div className="nova-artefact-resultat">
          <p>{resultat.message}</p>
          {resultat.artefactId ? (
            <a className="nova-artefact-btn" href={`/api/artefacts/${resultat.artefactId}/telecharger`}>
              ⬇ Télécharger la version {resultat.version ?? 1}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default ArtefactActions;

"use client";

/**
 * Arène d'interférence — L'ACCÉLÉRATEUR DE PARTICULES POUR IA.
 *
 * L'utilisateur voit ici ses modèles s'entraîner mutuellement dans le
 * monde d'ondes :
 *
 *  · deux champs physiquement identiques reçoivent les réponses du
 *    PROFESSEUR et de l'ÉLÈVE, traduites en ondes par le codec ;
 *  · l'interférence est mesurée : résonance constructive (les ondes
 *    s'amplifient — l'élève avait raison) ou destructive (les ondes
 *    s'annulent — l'élève est corrigé par distillation) ;
 *  · le rendu montre les DEUX champs et leur SUPERPOSITION (le terme
 *    d'interférence y est directement visible) ;
 *  · à la fin de la session, le modèle élève amélioré est exportable —
 *    les ondes ont physiquement modifié son état (paires rééduquées,
 *    poids d'usage, mémoire fréquentielle hebbienne).
 *
 * Tout se joue DANS LE NAVIGATEUR : aucun serveur, aucun LLM externe —
 * le professeur et l'élève sont des CortexLangagierGen3 exécutés en
 * local, comme dans le Studio (métriques réelles, jamais simulées).
 * L'interface n'a AUCUNE logique d'entraînement propre : elle observe
 * `EntrainementParResonance` via l'observateur de rounds.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DIM_ARENE,
  EntrainementParResonance,
  type ResultatRound,
} from "@/lib/ondes/arene";
import { CORPUS_GEN3 } from "@/lib/neural/generation/corpus";
import { CortexLangagierGen3, type EtatLangage } from "@/lib/neural/generation/language";
import { DUREE_MAX_ENTRAINEMENT_MS } from "@/lib/training/timebox";
import { cx } from "@/lib/ui/cx";

import "./arene-ondes.css";

/* -------------------------------------------------------------------- */
/* Rendu heatmap des champs                                              */
/* -------------------------------------------------------------------- */

const TAILLE_CANVAS = 288;

function dessinerChamp(
  canvas: HTMLCanvasElement,
  amplitudes: Float32Array,
  dim: number,
  mode: "violet" | "cyan" | "interference",
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const cellule = TAILLE_CANVAS / dim;
  ctx.fillStyle = "#0b0b14";
  ctx.fillRect(0, 0, TAILLE_CANVAS, TAILLE_CANVAS);

  let maxAbs = 1e-6;
  for (let i = 0; i < amplitudes.length; i++) {
    const a = Math.abs(amplitudes[i]);
    if (a > maxAbs) maxAbs = a;
  }

  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const v = amplitudes[y * dim + x] / maxAbs;
      const intensite = Math.min(1, Math.abs(v));
      let r = 0;
      let g = 0;
      let b = 0;
      if (mode === "violet") {
        r = Math.round(120 + 119 * intensite);
        g = Math.round(80 * intensite);
        b = Math.round(60 + 195 * intensite);
      } else if (mode === "cyan") {
        r = Math.round(30 * intensite);
        g = Math.round(50 + 181 * intensite);
        b = Math.round(90 + 148 * intensite);
      } else {
        // Superposition : constructif = lumière blanche, destructif = extinction rouge sombre.
        if (v >= 0) {
          r = Math.round(40 + 205 * intensite);
          g = Math.round(40 + 205 * intensite);
          b = Math.round(70 + 185 * intensite);
        } else {
          r = Math.round(130 * intensite);
          g = Math.round(18 * intensite);
          b = Math.round(48 * intensite);
        }
      }
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x * cellule, y * cellule, cellule + 0.5, cellule + 0.5);
    }
  }
}

/* -------------------------------------------------------------------- */
/* Composant                                                             */
/* -------------------------------------------------------------------- */

type ModeAreneUi = "gen3" | "duel";
type ProfilEleve = "vierge" | "amnesique" | "complet";

export default function AreneOndes() {
  const canvasProfRef = useRef<HTMLCanvasElement | null>(null);
  const canvasEleveRef = useRef<HTMLCanvasElement | null>(null);
  const canvasSuperpositionRef = useRef<HTMLCanvasElement | null>(null);

  const [mode, setMode] = useState<ModeAreneUi>("gen3");
  const [profilEleve, setProfilEleve] = useState<ProfilEleve>("amnesique");
  const [nomModeleEleve, setNomModeleEleve] = useState("");
  const [nomModeleProf, setNomModeleProf] = useState("");
  const [etatEleveImporte, setEtatEleveImporte] = useState<EtatLangage | null>(null);
  const [etatProfImporte, setEtatProfImporte] = useState<EtatLangage | null>(null);
  const [roundsMax, setRoundsMax] = useState(25);

  const [enCours, setEnCours] = useState(false);
  const [roundCourant, setRoundCourant] = useState(0);
  const [rounds, setRounds] = useState<ResultatRound[]>([]);
  const [message, setMessage] = useState("");
  const [exportDisponible, setExportDisponible] = useState(false);

  const entrainementRef = useRef<EntrainementParResonance | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const annuleRef = useRef(false);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const stats = useMemo(() => {
    const renforcees = rounds.filter((r) => r.action === "renforcee").length;
    const distillees = rounds.filter((r) => r.action === "distillee").length;
    const juges = renforcees + distillees;
    const rewards = rounds.filter((r) => r.action !== "ignoree").map((r) => r.mesures.reward);
    const rewardMoyen = rewards.length > 0 ? rewards.reduce((s, v) => s + v, 0) / rewards.length : 0;
    return { juges, renforcees, distillees, rewardMoyen };
  }, [rounds]);

  /* ----------------------- Import de modèles ------------------------- */

  const importerModele = useCallback(async (fichier: File, role: "eleve" | "professeur") => {
    try {
      const corps = await fichier.text();
      const data = JSON.parse(corps) as Record<string, unknown>;
      const candidat = (data.modele ?? data) as Record<string, unknown>;
      if (!Array.isArray(candidat.pairesPersonnalisees)) {
        setMessage("Fichier refusé : ce n'est pas un modèle gen3-language-model (pairesPersonnalisees absentes).");
        return;
      }
      const etat: EtatLangage = {
        pairesPersonnalisees: (candidat.pairesPersonnalisees as Array<Record<string, unknown>>)
          .filter((p) => typeof p?.motif === "string" && typeof p?.reponse === "string")
          .map((p) => ({
            motif: String(p.motif),
            reponse: String(p.reponse),
            theme: typeof p.theme === "string" ? p.theme : "arene",
          })),
        poidsUsage: {},
      };
      if (candidat.poidsUsage && typeof candidat.poidsUsage === "object") {
        for (const [cle, poids] of Object.entries(candidat.poidsUsage as Record<string, unknown>)) {
          if (typeof poids === "number" && poids > 0) etat.poidsUsage[cle] = poids;
        }
      }
      if (role === "eleve") {
        setEtatEleveImporte(etat);
        setNomModeleEleve(fichier.name.replace(/\.json$/i, ""));
      } else {
        setEtatProfImporte(etat);
        setNomModeleProf(fichier.name.replace(/\.json$/i, ""));
        setMode("duel");
      }
      setMessage(`Modèle « ${fichier.name} » chargé (${etat.pairesPersonnalisees.length} paires personnalisées).`);
    } catch {
      setMessage("Fichier illisible : JSON invalide.");
    }
  }, []);

  /* --------------------------- Session ------------------------------- */

  const lancerSession = useCallback(() => {
    if (enCours) return;

    // — Participants (tous locaux, aucun LLM externe) —
    const prof = new CortexLangagierGen3();
    prof.apprendre(CORPUS_GEN3);
    if (mode === "duel" && etatProfImporte) prof.importerEtat(etatProfImporte);

    const eleve = new CortexLangagierGen3();
    eleve.apprendre(CORPUS_GEN3);
    if (profilEleve === "amnesique") {
      for (let i = 0; i < CORPUS_GEN3.length; i++) {
        if (i % 4 === 0) eleve.reeducer(CORPUS_GEN3[i].motif, "Je ne sais pas encore.", CORPUS_GEN3[i].theme);
      }
    }
    if (profilEleve === "vierge") eleve.oublierPersonnalisees();
    if (etatEleveImporte) eleve.importerEtat(etatEleveImporte);

    const entrainement = new EntrainementParResonance(prof, eleve);
    entrainementRef.current = entrainement;

    // — Questions : motifs importés d'abord, puis le corpus —
    const motifs: string[] = [];
    if (etatEleveImporte) motifs.push(...etatEleveImporte.pairesPersonnalisees.map((p) => p.motif));
    motifs.push(...CORPUS_GEN3.map((p) => p.motif));
    const questions = [...new Set(motifs)].slice(0, Math.max(1, roundsMax));

    setEnCours(true);
    setRounds([]);
    setRoundCourant(0);
    setExportDisponible(false);
    setMessage("");

    const observateur = (a: Float32Array, b: Float32Array): void => {
      if (canvasProfRef.current) dessinerChamp(canvasProfRef.current, a, DIM_ARENE, "violet");
      if (canvasEleveRef.current) dessinerChamp(canvasEleveRef.current, b, DIM_ARENE, "cyan");
      if (canvasSuperpositionRef.current) {
        const somme = new Float32Array(a.length);
        for (let i = 0; i < a.length; i++) somme[i] = a[i] + b[i];
        dessinerChamp(canvasSuperpositionRef.current, somme, DIM_ARENE, "interference");
      }
    };

    let index = 0;
    const historique: ResultatRound[] = [];
    const etapeSuivante = (): void => {
      if (annuleRef.current || index >= questions.length) {
        setEnCours(false);
        setExportDisponible(historique.some((r) => r.action !== "ignoree"));
        setMessage(
          annuleRef.current
            ? "Session interrompue — l'élève conserve ce qu'il a appris jusqu'ici."
            : `Session terminée : ${historique.filter((r) => r.action === "renforcee").length} résonances, ${historique.filter((r) => r.action === "distillee").length} distillations. Exportez l'élève amélioré ci-dessous.`,
        );
        return;
      }
      const vue = entrainement.round(questions[index], observateur);
      historique.push(vue);
      setRounds([...historique]);
      setRoundCourant(index + 1);
      index += 1;
      timerRef.current = setTimeout(etapeSuivante, 30);
    };
    etapeSuivante();
  }, [enCours, mode, profilEleve, roundsMax, etatEleveImporte, etatProfImporte]);

  const arreterSession = useCallback(() => {
    annuleRef.current = true;
  }, []);

  /* --------------------------- Export -------------------------------- */

  const exporterEleve = useCallback(() => {
    const entrainement = entrainementRef.current;
    if (!entrainement || rounds.length === 0) {
      setMessage("Lancez d'abord une session : il n'y a rien à exporter.");
      return;
    }
    const corps = JSON.stringify(
      {
        format: "gen3-language-model",
        version: 1,
        moteur: "gen3-arene",
        entraineLe: new Date().toISOString(),
        metriques: {
          roundsJoues: rounds.length,
          renforcees: stats.renforcees,
          distillees: stats.distillees,
          rewardMoyen: Number(stats.rewardMoyen.toFixed(4)),
        },
        modele: entrainement.etatEleve,
        meta: { arene: true, mode },
      },
      null,
      2,
    );
    const blob = new Blob([corps], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const lien = document.createElement("a");
    lien.href = url;
    lien.download = `gen3-modele-arene-${Date.now()}.json`;
    lien.click();
    URL.revokeObjectURL(url);
    setMessage("Modèle élève amélioré exporté — réimportable dans le Studio ou dans l'arène.");
  }, [rounds.length, stats, mode]);

  /* --------------------------- Rendu --------------------------------- */

  const dernieresMesures = rounds.length > 0 ? rounds[rounds.length - 1].mesures : null;

  return (
    <div className="arene-shell">
      <header className="arene-header">
        <div className="arene-marque">
          <span className="arene-logo" aria-hidden="true">⚛</span>
          <div>
            <h1 className="arene-titre">Gen3ia · Arène d&apos;interférence</h1>
            <p className="arene-sous-titre">Les IA s&apos;entraînent mutuellement par collision d&apos;ondes — la physique juge chaque idée</p>
          </div>
        </div>
        <div className="arene-badges" aria-label="État de l'arène">
          <span className="arene-badge" data-actif={enCours}>{enCours ? `Round ${roundCourant}/${roundsMax}` : "prête"}</span>
          <span className="arene-badge">{DIM_ARENE}×{DIM_ARENE}</span>
          <span className="arene-badge" data-actif={mode === "duel"}>{mode === "duel" ? "duel de modèles" : "élève contre Gen3"}</span>
          <span className="arene-badge" title="Garantie timebox : un entraînement ne dépasse jamais trente minutes, par modèle, par session.">
            timebox ≤ {Math.round(DUREE_MAX_ENTRAINEMENT_MS / 60000)} min
          </span>
        </div>
      </header>

      <main className="arene-corps">
        <section className="arene-scene" aria-label="Champs d'ondes du duel">
          <div className="arene-champs">
            <figure className="arene-champ">
              <figcaption>Professeur — onde émise</figcaption>
              <canvas ref={canvasProfRef} width={TAILLE_CANVAS} height={TAILLE_CANVAS} />
            </figure>
            <figure className="arene-champ arene-champ-central">
              <figcaption>Superposition — le terme d&apos;interférence</figcaption>
              <canvas ref={canvasSuperpositionRef} width={TAILLE_CANVAS} height={TAILLE_CANVAS} />
            </figure>
            <figure className="arene-champ">
              <figcaption>Élève — onde réponse</figcaption>
              <canvas ref={canvasEleveRef} width={TAILLE_CANVAS} height={TAILLE_CANVAS} />
            </figure>
          </div>

          {dernieresMesures ? (
            <div className="arene-mesures" role="status">
              <div className="arene-mesure" data-sens="plus">
                <span className="arene-mesure-valeur">{(dernieresMesures.resonance * 100).toFixed(0)}%</span>
                <span className="arene-mesure-label">Résonance constructive</span>
              </div>
              <div className="arene-mesure" data-sens={dernieresMesures.reward >= 0 ? "plus" : "moins"}>
                <span className="arene-mesure-valeur">{dernieresMesures.reward >= 0 ? "+" : ""}{(dernieresMesures.reward * 100).toFixed(0)}%</span>
                <span className="arene-mesure-label">Récompense physique</span>
              </div>
              <div className="arene-mesure" data-sens="moins">
                <span className="arene-mesure-valeur">{(dernieresMesures.annihilation * 100).toFixed(0)}%</span>
                <span className="arene-mesure-label">Annihilation destructive</span>
              </div>
              <div className="arene-mesure">
                <span className="arene-mesure-valeur">{dernieresMesures.correlation.toFixed(2)}</span>
                <span className="arene-mesure-label">Corrélation des idées</span>
              </div>
            </div>
          ) : (
            <p className="arene-attente">
              Lancez une session : chaque réponse des deux IA devient une onde, la superposition révèle l&apos;accord (lumière blanche) ou l&apos;opposition (extinction rouge).
            </p>
          )}
        </section>

        <aside className="arene-controles" aria-label="Contrôles de l'arène">
          <div className="arene-groupe">
            <h2>Participants</h2>
            <label className="arene-champ-form">
              <span>Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as ModeAreneUi)} disabled={enCours}>
                <option value="gen3">Élève contre Gen3 (professeur embarqué)</option>
                <option value="duel">Duel de modèles (2 fichiers)</option>
              </select>
            </label>
            <label className="arene-champ-form">
              <span>Niveau initial de l&apos;élève</span>
              <select value={profilEleve} onChange={(e) => setProfilEleve(e.target.value as ProfilEleve)} disabled={enCours || etatEleveImporte !== null}>
                <option value="vierge">Vierge (ne sait rien)</option>
                <option value="amnesique">Amnésique (1 réponse sur 4 perdue)</option>
                <option value="complet">Complet (savoir Gen3 entier)</option>
              </select>
            </label>
            {mode === "duel" ? (
              <label className="arene-champ-form">
                <span>Modèle professeur (gen3-language-model.json)</span>
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={enCours}
                  onChange={(e) => {
                    const fichier = e.target.files?.[0];
                    if (fichier) void importerModele(fichier, "professeur");
                  }}
                />
              </label>
            ) : null}
            <label className="arene-champ-form">
              <span>Modèle élève importé (optionnel)</span>
              <input
                type="file"
                accept="application/json,.json"
                disabled={enCours}
                onChange={(e) => {
                  const fichier = e.target.files?.[0];
                  if (fichier) void importerModele(fichier, "eleve");
                }}
              />
            </label>
            {nomModeleEleve ? <p className="arene-note">Élève : {nomModeleEleve}</p> : null}
            {nomModeleProf ? <p className="arene-note">Professeur : {nomModeleProf}</p> : null}
          </div>

          <div className="arene-groupe">
            <h2>Session</h2>
            <label className="arene-champ-form">
              <span>Rounds (questions posées aux deux IA) : {roundsMax}</span>
              <input type="range" min={5} max={60} value={roundsMax} onChange={(e) => setRoundsMax(Number(e.target.value))} disabled={enCours} />
            </label>
            <div className="arene-boutons">
              <button type="button" className="arene-bouton arene-bouton-lancer" onClick={lancerSession} disabled={enCours}>
                {enCours ? `Round ${roundCourant}…` : "Lancer l'arène"}
              </button>
              {enCours ? (
                <button type="button" className="arene-bouton arene-bouton-arreter" onClick={arreterSession}>
                  Arrêter
                </button>
              ) : null}
              <button type="button" className={cx("arene-bouton")} onClick={exporterEleve} disabled={enCours || !exportDisponible}>
                Exporter l&apos;élève amélioré
              </button>
            </div>
            {message ? <p className="arene-message">{message}</p> : null}
          </div>

          <div className="arene-groupe">
            <h2>Scores physiques</h2>
            <dl className="arene-scores">
              <div><dt>Rounds jugés</dt><dd>{stats.juges}</dd></div>
              <div><dt>Résonances (élève validé)</dt><dd>{stats.renforcees}</dd></div>
              <div><dt>Distillations (élève corrigé)</dt><dd>{stats.distillees}</dd></div>
              <div><dt>Récompense moyenne</dt><dd>{stats.rewardMoyen >= 0 ? "+" : ""}{(stats.rewardMoyen * 100).toFixed(0)}%</dd></div>
            </dl>
          </div>

          <div className="arene-groupe arene-groupe-historique">
            <h2>Historique des rounds</h2>
            <ol className="arene-historique">
              {rounds.slice().reverse().map((r, i) => (
                <li key={`${r.motif}-${i}`} data-action={r.action}>
                  <span className="arene-historique-verdict">
                    {r.action === "renforcee" ? "⟡ résonance" : r.action === "distillee" ? "✕ distillation" : "· ignoré"}
                  </span>
                  <span className="arene-historique-motif">{r.motif}</span>
                  <span className="arene-historique-reward">
                    {r.action === "ignoree" ? "—" : `${r.mesures.reward >= 0 ? "+" : ""}${(r.mesures.reward * 100).toFixed(0)}%`}
                  </span>
                </li>
              ))}
              {rounds.length === 0 ? <li className="arene-historique-vide">Aucun round joué.</li> : null}
            </ol>
          </div>
        </aside>
      </main>

      <section className="arene-pedagogie" aria-label="Comment fonctionne l'arène">
        <h2>La physique fait le professeur</h2>
        <p>
          Chaque réponse est traduite en ondes par le <strong>codec onde-vecteur</strong> : les mots d&apos;un texte
          deviennent des impulsions de fréquence, de phase et d&apos;amplitude sur une grille de {DIM_ARENE}×{DIM_ARENE} oscillateurs.
          Le professeur et l&apos;élève parlent dans deux champs physiquement identiques — l&apos;accord des idées devient
          une grandeur mesurable : <em>E(ψₐ+ψᵦ) = E(ψₐ) + E(ψᵦ) + 2·⟨ψₐ, ψᵦ⟩</em>. Le dernier terme EST l&apos;interférence :
          accords et oppositions d&apos;idées se lisent sur l&apos;énergie du champ, sans aucune récompense symbolique.
        </p>
        <p>
          Quand l&apos;élève dit ce que dit le professeur, les ondes s&apos;additionnent — le champ s&apos;illumine
          (résonance constructive) et sa logique est validée. Quand il se trompe, les ondes se détruisent (extinction)
          et la réponse du professeur est <strong>injectée comme onde d&apos;enseignement</strong> : les régions du champ
          élève voient leur fréquence propre dériver vers celle de l&apos;onde — le modèle « ressent » la correction,
          et son état exporté ressort réellement modifié (paires rééduquées, poids d&apos;usage, mémoire hebbienne).
        </p>
        <p>
          N&apos;importe quelle IA peut entrer dans l&apos;arène : il lui suffit de produire un vecteur (embedding, sac
          de mots, poids) — le codec onde-vecteur le traduit, l&apos;essaim P2P en propage les micro-paquets, et le
          monde d&apos;ondes rend son verdict en quelques millisecondes, sans jamais fusionner les codes sources.
        </p>
      </section>
    </div>
  );
}

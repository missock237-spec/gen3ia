"use client";

/**
 * CORTEX TÉLÉPHONE EMBARQUÉ (it.73 — demande propriétaire : « que gen3
 * puisse fonctionner même sur un téléphone tout en gardant sa qualité de
 * compétences »).
 *
 * Ce composant charge UNE FOIS le snapshot binaire du cortex compact
 * (public/neural/cortex-telephone-it73.bin — 2^17 colonnes, poids u8,
 * lecture seule, ~1,5 Mo cacheable) puis exécute TOUT localement :
 *  - la RÉPONSE vient du pont vocation (composerDepuisVocation) — LA MÊME
 *    fonction pure que la production exécute côté serveur : la qualité de
 *    réponse est conservée PAR CONSTRUCTION (même charte, même détection,
 *    même composition) ;
 *  - la COUCHE NEURONALE est le vrai SNN embarqué (CortexTelephone) :
 *    projection hash des tokens, 4 pas columnnaires, lecture graduée des
 *    bandes, métabolisme réel affiché (évaluées / spikes / transmissions /
 *    ms) — zéro requête serveur par question après le chargement.
 *
 * HONNÊTETÉ : le moteur est en LECTURE SEULE (le téléphone répond, il ne
 * s'entraîne pas) ; hors cadre, la réponse dit honnêtement qu'elle ne
 * connaît pas (le pont ne fabrique jamais de domaine ni de capacité).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { composerDepuisVocation } from "@/lib/neural/vocation-pont";
import { tokenize } from "@/lib/neural/encoding/text-encoder";
import { cortexDepuisSnapshot } from "@/lib/neural/core/v2/cortex-telephone";
import type { CortexTelephone } from "@/lib/neural/core/v2/cortex-telephone";
import { CompteurEnergie, importerSnapshotTelephone } from "@/lib/neural/core/v2/energie";

const CYCLES_FENETRE = 4; // même fenêtre que le serveur (NEURAL_CYCLES_PAR_GENERATION)

interface ResultatLocal {
  question: string;
  connu: boolean;
  reponse: string;
  theme: string | null;
  score: number | null;
  bandeDominante: number | null;
  activationsBandes: number[] | null;
  metabolisme: {
    evaluees: number;
    reposes: number;
    spikes: number;
    transmissions: number;
    ms: number;
  } | null;
  msTotal: number;
}

function formaterOctets(octets: number): string {
  if (octets >= 1048576) return `${(octets / 1048576).toFixed(2).replace(".", ",")} Mo`;
  if (octets >= 1024) return `${(octets / 1024).toFixed(1).replace(".", ",")} Ko`;
  return `${octets} o`;
}

export default function CortexTelephoneEmbarque() {
  const [statut, setStatut] = useState<"chargement" | "pret" | "erreur">("chargement");
  const [erreur, setErreur] = useState<string | null>(null);
  const [telechargementOctets, setTelechargementOctets] = useState(0);
  const [memoireOctets, setMemoireOctets] = useState(0);
  const [detailMemoire, setDetailMemoire] = useState<{ energies: number; horloges: number; drapeaux: number; structure: number; poidsU8: number } | null>(null);
  const [question, setQuestion] = useState("");
  const [resultat, setResultat] = useState<ResultatLocal | null>(null);
  const [session, setSession] = useState({ questions: 0, transmissions: 0, ms: 0 });
  const compteurRef = useRef(new CompteurEnergie());
  const moteurRef = useRef<CortexTelephone | null>(null);

  useEffect(() => {
    let annule = false;
    (async () => {
      try {
        const reponse = await fetch("/neural/cortex-telephone-it73.bin", { cache: "force-cache" });
        if (!reponse.ok) throw new Error(`Snapshot HTTP ${reponse.status}`);
        const tampon = new Uint8Array(await reponse.arrayBuffer());
        if (annule) return;
        setTelechargementOctets(tampon.byteLength);
        const { entete, poidsU8 } = importerSnapshotTelephone(tampon);
        const moteur = cortexDepuisSnapshot(entete, poidsU8);
        moteurRef.current = moteur;
        const stats = moteur.stats();
        setMemoireOctets(stats.octetsResidentiels);
        setDetailMemoire(stats.detail);
        setStatut("pret");
      } catch (e) {
        if (annule) return;
        setErreur(e instanceof Error ? e.message : String(e));
        setStatut("erreur");
      }
    })();
    return () => {
      annule = true;
    };
  }, []);

  const interroger = useCallback(() => {
    const moteur = moteurRef.current;
    const propre = question.trim();
    if (!moteur || !propre) return;

    // 1. La réponse — MÊME pont lexical que la production (fonction pure).
    const composition = composerDepuisVocation(propre);

    // 2. La couche neuronale — SNN embarqué réel (projection hash + 4 pas).
    const debut = performance.now();
    moteur.reinitialiserEnergies();
    const injections = moteur.projetterTokens(tokenize(propre));
    let evaluees = 0;
    let spikes = 0;
    let transmissions = 0;
    for (let c = 0; c < CYCLES_FENETRE; c++) {
      const sortants = moteur.pas(c === 0 ? injections : null, c + 1);
      spikes += sortants.length;
      evaluees += moteur.metabolismeDernierPas.evaluees;
      transmissions += moteur.metabolismeDernierPas.transmissions;
    }
    const activations = moteur.activationBandes();
    // Bande-porteuse dominante : argmax sur le vocabulaire des 8 porteurs
    // (19 domaines répartis par hash — des domaines partagent une bande ;
    // c'est une lecture d'ondes, pas une détection de domaine).
    let bandeDominante = 0;
    for (let b = 1; b < 8; b++) {
      if ((activations[b] ?? 0) > (activations[bandeDominante] ?? 0)) bandeDominante = b;
    }
    const msTotal = performance.now() - debut;

    const meta = moteur.metabolismeDernierPas;
    compteurRef.current.enregistrerPas(
      { evaluees, reposes: meta.reposes, transmissions, ms: msTotal },
      spikes,
    );
    const rapport = compteurRef.current.rapport();
    setSession({ questions: rapport.fenetresExecutees, transmissions: rapport.transmissions, ms: rapport.ms });

    setResultat({
      question: propre,
      connu: composition !== null,
      reponse: composition?.texte ?? "",
      theme: composition?.theme ?? null,
      score: composition?.scoreAppariement ?? null,
      bandeDominante,
      activationsBandes: activations.slice(0, 8),
      metabolisme: { evaluees, reposes: meta.reposes, spikes, transmissions, ms: Math.round(msTotal * 1000) / 1000 },
      msTotal: Math.round(msTotal * 1000) / 1000,
    });
  }, [question]);

  return (
    <div className="space-y-4">
      {/* État du moteur embarqué */}
      <section className="rounded-xl border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-card, #14141b)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Moteur embarqué — SNN compact sur votre appareil</h2>
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              statut === "pret"
                ? "bg-emerald-500/15 text-emerald-400"
                : statut === "erreur"
                  ? "bg-red-500/15 text-red-400"
                  : "bg-amber-500/15 text-amber-400"
            }`}
          >
            {statut === "pret" ? "chargé — 100 % local" : statut === "erreur" ? "erreur de chargement" : "chargement du snapshot…"}
          </span>
        </div>
        {statut === "pret" && (
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-[var(--g3-muted, #8b8b9e)]">Snapshot téléchargé (une fois)</dt>
              <dd className="font-mono">{formaterOctets(telechargementOctets)}</dd>
            </div>
            <div>
              <dt className="text-[var(--g3-muted, #8b8b9e)]">Mémoire résidente du SNN</dt>
              <dd className="font-mono">{formaterOctets(memoireOctets)}</dd>
            </div>
            <div>
              <dt className="text-[var(--g3-muted, #8b8b9e)]">Configuration</dt>
              <dd className="font-mono">2^17 colonnes · poids u8</dd>
            </div>
            <div>
              <dt className="text-[var(--g3-muted, #8b8b9e)]">Requêtes par question</dt>
              <dd className="font-mono">0 — tout est local</dd>
            </div>
          </dl>
        )}
        {statut === "pret" && detailMemoire && (
          <p className="mt-3 text-xs text-[var(--g3-muted, #8b8b9e)]">
            Détail mesuré (typed arrays réels) : énergies {formaterOctets(detailMemoire.energies)} · horloges u32{" "}
            {formaterOctets(detailMemoire.horloges)} · drapeaux {formaterOctets(detailMemoire.drapeaux)} · structure CSR{" "}
            {formaterOctets(detailMemoire.structure)} · poids u8 {formaterOctets(detailMemoire.poidsU8)} — lecture seule
            (le téléphone répond, il ne s&apos;entraîne pas : l&apos;apprentissage reste un rôle du serveur).
          </p>
        )}
        {statut === "erreur" && <p className="mt-3 text-sm text-red-400">Chargement impossible : {erreur}</p>}
      </section>

      {/* Testeur local */}
      <section className="rounded-xl border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-card, #14141b)] p-5">
        <h2 className="text-base font-semibold">Testeur local — posez une question du cadre d&apos;apprentissage</h2>
        <p className="mt-1 text-sm text-[var(--g3-muted, #8b8b9e)]">
          La réponse est composée par le même pont que la production (charte des 19 domaines — zéro invention) ; la
          couche neuronale ci-dessous est le vrai SNN quantifié exécuté dans votre navigateur.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") interroger();
            }}
            maxLength={600}
            placeholder="Ex. : Comment planifier la culture du maïs cette saison ?"
            className="flex-1 rounded-lg border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-bg, #0b0b10)] px-3 py-2 text-sm outline-none focus:border-[var(--g3-accent, #6c7bff)]"
            disabled={statut !== "pret"}
          />
          <button
            type="button"
            onClick={interroger}
            disabled={statut !== "pret" || question.trim().length === 0}
            className="rounded-lg bg-[var(--g3-accent, #6c7bff)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Interroger localement
          </button>
        </div>

        {resultat && (
          <div className="mt-5 space-y-3">
            <div className="rounded-lg border border-[var(--g3-border, #2a2a35)] p-4">
              <p className="text-xs uppercase tracking-wide text-[var(--g3-muted, #8b8b9e)]">
                Réponse (pont vocation — identique à la production)
              </p>
              {resultat.connu ? (
                <>
                  <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{resultat.reponse}</p>
                  <p className="mt-2 text-xs text-[var(--g3-muted, #8b8b9e)]">
                    theme: {resultat.theme} · score d&apos;appariement: {resultat.score?.toFixed(3).replace(".", ",")}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm text-amber-400">
                  Question hors du cadre reconnu pour l&apos;instant — gen3 embarqué ne fabrique pas de réponse
                  (honnêteté : reformulez avec les mots d&apos;un des 19 domaines de vocation).
                </p>
              )}
            </div>
            {resultat.metabolisme && (
              <div className="rounded-lg border border-[var(--g3-border, #2a2a35)] p-4">
                <p className="text-xs uppercase tracking-wide text-[var(--g3-muted, #8b8b9e)]">
                  Couche neuronale embarquée (métabolisme réel, jamais estimé)
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                  <div>
                    <dt className="text-[var(--g3-muted, #8b8b9e)]">Colonnes évaluées</dt>
                    <dd className="font-mono">{resultat.metabolisme.evaluees.toLocaleString("fr-FR")}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-muted, #8b8b9e)]">Au repos (coût zéro)</dt>
                    <dd className="font-mono">{resultat.metabolisme.reposes.toLocaleString("fr-FR")}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-muted, #8b8b9e)]">Spikes</dt>
                    <dd className="font-mono">{resultat.metabolisme.spikes.toLocaleString("fr-FR")}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-muted, #8b8b9e)]">Transmissions</dt>
                    <dd className="font-mono">{resultat.metabolisme.transmissions.toLocaleString("fr-FR")}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-muted, #8b8b9e)]">Durée (4 pas)</dt>
                    <dd className="font-mono">{resultat.metabolisme.ms} ms</dd>
                  </div>
                </dl>
                {resultat.activationsBandes && (
                  <p className="mt-2 text-xs text-[var(--g3-muted, #8b8b9e)]">
                    Lecture graduée des 8 bandes-porteuses (ondes) : [{resultat.activationsBandes.map((a) => a.toFixed(4).replace(".", ",")).join(" · ")}] —
                    bande dominante #{resultat.bandeDominante} (19 domaines répartis par hash sur 8 bandes : des
                    domaines partagent une bande — lecture d&apos;ondes, pas une détection de domaine).
                  </p>
                )}
              </div>
            )}
            <p className="text-xs text-[var(--g3-muted, #8b8b9e)]">
              Session locale : {session.questions} question{session.questions > 1 ? "s" : ""} · {session.transmissions.toLocaleString("fr-FR")}{" "}
              transmissions cumulées · {session.ms.toFixed(1).replace(".", ",")} ms — zéro requête serveur après le
              chargement du snapshot.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

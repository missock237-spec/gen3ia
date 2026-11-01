"use client";

/**
 * CORTEX DÉVELOPPEMENT WEB EMBARQUÉ (it.79 — demande propriétaire : « entraîne
 * gen3 dans le développement web : écrire du code, comprendre puis simuler
 * du code… et mets-le à la disposition des utilisateurs sur le domaine en
 * ligne »).
 *
 * Ce composant charge UNE FOIS le snapshot binaire du cortex compact
 * spécialisé (public/neural/cortex-developpement-web-it79.bin — 2^17
 * colonnes, poids u8, lecture seule, ~1,5 Mo cacheable) ET la matière
 * d'entraînement committée (public/neural/webdev-it79-matiere.json — 6 items
 * × 3 capacités, traces EXÉCUTÉES à la génération), puis exécute TOUT
 * localement :
 *  - ÉCRIRE    : la réponse est le code complet de la matière committée
 *    (instruction réelle → code TypeScript réel) ;
 *  - COMPRENDRE : question + code + réponse exacte dérivée des métadonnées
 *    du gabarit d'entraînement ;
 *  - SIMULER   : le RÉSULTAT et la TRACE PAR PAS sont les mesures d'une
 *    EXÉCUTION RÉELLE du code (faite à la génération — la page n'évalue
 *    aucun code dans le navigateur, CSP sans unsafe-eval) ;
 *  - la COUCHE NEURONALE est le vrai SNN embarqué (CortexTelephone) :
 *    projection hash, 4 pas, lecture graduée des bandes, métabolisme réel
 *    affiché — zéro requête serveur par question après chargement.
 *
 * HONNÊTETÉ : la page répond DANS LE CADRE APPRIS (les 18 items committés
 * de la campagne it.79 + la charte generation-code) ; le SNN mesure la
 * résonance de la bande, il ne « génère » pas de code tout seul.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { tokenize } from "@/lib/neural/encoding/text-encoder";
import { cortexDepuisSnapshot } from "@/lib/neural/core/v2/cortex-telephone";
import type { CortexTelephone } from "@/lib/neural/core/v2/cortex-telephone";
import { CompteurEnergie, importerSnapshotTelephone } from "@/lib/neural/core/v2/energie";

const CYCLES_FENETRE = 4; // même fenêtre que le serveur

type Capacite = "ecrire" | "comprendre" | "simuler";

interface ItemEcrire {
  id: string; capacite: "ecrire"; instruction: string; code: string;
}
interface ItemComprendre {
  id: string; capacite: "comprendre"; question: string; code: string; reponse: string;
}
interface ItemSimuler {
  id: string; capacite: "simuler"; question: string; code: string;
  entreeDesc: string; sortie: string; trace: string[];
}
type ItemWebdev = ItemEcrire | ItemComprendre | ItemSimuler;

interface Matiere {
  iteration: number;
  horodatage: string;
  items: ItemWebdev[];
}

interface ResultatSnn {
  bandeDominante: number;
  activationsBandes: number[];
  metabolisme: { evaluees: number; reposes: number; spikes: number; transmissions: number; ms: number };
  msTotal: number;
}

const LABELS_CAPACITE: Record<Capacite, string> = {
  ecrire: "Écrire du code",
  comprendre: "Comprendre du code",
  simuler: "Simuler du code",
};

function formaterOctets(octets: number): string {
  if (octets >= 1048576) return `${(octets / 1048576).toFixed(2).replace(".", ",")} Mo`;
  if (octets >= 1024) return `${(octets / 1024).toFixed(1).replace(".", ",")} Ko`;
  return `${octets} o`;
}

export default function CortexWebdevEmbarque() {
  const [statut, setStatut] = useState<"chargement" | "pret" | "erreur">("chargement");
  const [erreur, setErreur] = useState<string | null>(null);
  const [snapshotOctets, setSnapshotOctets] = useState(0);
  const [memoireOctets, setMemoireOctets] = useState(0);
  const [matiere, setMatiere] = useState<Matiere | null>(null);
  const [capaciteActive, setCapaciteActive] = useState<Capacite>("ecrire");
  const [itemActif, setItemActif] = useState<Record<Capacite, string>>({ ecrire: "", comprendre: "", simuler: "" });
  const [snn, setSnn] = useState<ResultatSnn | null>(null);
  const [session, setSession] = useState({ questions: 0, transmissions: 0, ms: 0 });
  const compteurRef = useRef(new CompteurEnergie());
  const moteurRef = useRef<CortexTelephone | null>(null);

  useEffect(() => {
    let annule = false;
    (async () => {
      try {
        const [repSnapshot, repMatiere] = await Promise.all([
          fetch("/neural/cortex-developpement-web-it79.bin", { cache: "force-cache" }),
          fetch("/neural/webdev-it79-matiere.json", { cache: "force-cache" }),
        ]);
        if (!repSnapshot.ok) throw new Error(`Snapshot HTTP ${repSnapshot.status}`);
        if (!repMatiere.ok) throw new Error(`Matière HTTP ${repMatiere.status}`);
        const tampon = new Uint8Array(await repSnapshot.arrayBuffer());
        const matiereChargee = JSON.parse(await repMatiere.text()) as Matiere;
        if (annule) return;
        setSnapshotOctets(tampon.byteLength);
        const { entete, poidsU8 } = importerSnapshotTelephone(tampon);
        const moteur = cortexDepuisSnapshot(entete, poidsU8);
        moteurRef.current = moteur;
        setMemoireOctets(moteur.stats().octetsResidentiels);
        setMatiere(matiereChargee);
        const premier = (cap: Capacite): string =>
          matiereChargee.items.find((it) => it.capacite === cap)?.id ?? "";
        setItemActif({ ecrire: premier("ecrire"), comprendre: premier("comprendre"), simuler: premier("simuler") });
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

  const interroger = useCallback(
    (item: ItemWebdev, texteProbe: string) => {
      const moteur = moteurRef.current;
      if (!moteur) return;
      const debut = performance.now();
      moteur.reinitialiserEnergies();
      const injections = moteur.projetterTokens(tokenize(texteProbe));
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
      setSnn({
        bandeDominante,
        activationsBandes: activations.slice(0, 8),
        metabolisme: { evaluees, reposes: meta.reposes, spikes, transmissions, ms: Math.round(msTotal * 1000) / 1000 },
        msTotal: Math.round(msTotal * 1000) / 1000,
      });
      void item;
    },
    [],
  );

  const itemsCapacite = (matiere?.items ?? []).filter((it) => it.capacite === capaciteActive);
  const itemCourant = itemsCapacite.find((it) => it.id === itemActif[capaciteActive]) ?? itemsCapacite[0];
  const probe = itemCourant
    ? itemCourant.capacite === "ecrire"
      ? itemCourant.instruction
      : itemCourant.question
    : "";

  return (
    <div className="space-y-4">
      {/* État du moteur embarqué */}
      <section className="rounded-xl border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-card, #14141b)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Moteur embarqué — SNN spécialisé développement web</h2>
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              statut === "pret"
                ? "bg-emerald-500/15 text-emerald-400"
                : statut === "erreur"
                  ? "bg-red-500/15 text-red-400"
                  : "bg-amber-500/15 text-amber-400"
            }`}
          >
            {statut === "pret" ? "chargé — 100 % local" : statut === "erreur" ? "erreur de chargement" : "chargement…"}
          </span>
        </div>
        {statut === "pret" && (
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-[var(--g3-muted, #8b8b9e)]">Snapshot spécialisé it.79</dt>
              <dd className="font-mono">{formaterOctets(snapshotOctets)}</dd>
            </div>
            <div>
              <dt className="text-[var(--g3-muted, #8b8b9e)]">Mémoire résidente du SNN</dt>
              <dd className="font-mono">{formaterOctets(memoireOctets)}</dd>
            </div>
            <div>
              <dt className="text-[var(--g3-muted, #8b8b9e)]">Matière committée</dt>
              <dd className="font-mono">{matiere?.items.length ?? 0} items · 3 capacités</dd>
            </div>
            <div>
              <dt className="text-[var(--g3-muted, #8b8b9e)]">Requêtes par exemple</dt>
              <dd className="font-mono">0 — tout est local</dd>
            </div>
          </dl>
        )}
        {statut === "erreur" && <p className="mt-3 text-sm text-red-400">Chargement impossible : {erreur}</p>}
      </section>

      {/* Les 3 capacités */}
      <section className="rounded-xl border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-card, #14141b)] p-5">
        <h2 className="text-base font-semibold">Les 3 capacités entraînées — écrire, comprendre, simuler</h2>
        <p className="mt-1 text-sm text-[var(--g3-muted, #8b8b9e)]">
          Les réponses viennent de la matière d&apos;entraînement committée (campagne it.79 — 100 % locale, graine 42) ;
          la simulation rejoue une <strong>exécution réelle</strong> mesurée à la génération ; la couche neuronale
          ci-dessous est le vrai SNN quantifié exécuté dans votre navigateur.
        </p>

        <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Capacités développement web">
          {(Object.keys(LABELS_CAPACITE) as Capacite[]).map((cap) => (
            <button
              key={cap}
              type="button"
              role="tab"
              aria-selected={capaciteActive === cap}
              onClick={() => setCapaciteActive(cap)}
              className={`rounded-lg px-3 py-2 text-sm font-medium ${
                capaciteActive === cap
                  ? "bg-[var(--g3-accent, #6c7bff)] text-white"
                  : "border border-[var(--g3-border, #2a2a35)] text-[var(--g3-muted, #8b8b9e)]"
              }`}
            >
              {LABELS_CAPACITE[cap]}
            </button>
          ))}
        </div>

        {itemCourant && (
          <div className="mt-4 space-y-3">
            <select
              value={itemCourant.id}
              onChange={(e) => {
                setItemActif((etat) => ({ ...etat, [capaciteActive]: e.target.value }));
                setSnn(null);
              }}
              className="w-full rounded-lg border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-bg, #0b0b10)] px-3 py-2 text-sm outline-none focus:border-[var(--g3-accent, #6c7bff)]"
              aria-label="Exemple de la matière d'entraînement"
            >
              {itemsCapacite.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.id} — {(it.capacite === "ecrire" ? it.instruction : it.question).slice(0, 86)}…
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => itemCourant && interroger(itemCourant, probe)}
              className="rounded-lg bg-[var(--g3-accent, #6c7bff)] px-4 py-2 text-sm font-medium text-white"
            >
              Exécuter localement (réponse + couche SNN)
            </button>

            {/* Réponse selon la capacité */}
            {itemCourant.capacite === "ecrire" && (
              <div className="rounded-lg border border-[var(--g3-border, #2a2a35)] p-4">
                <p className="text-xs uppercase tracking-wide text-[var(--g3-muted, #8b8b9e)]">
                  Instruction → code complet (matière committée it.79)
                </p>
                <p className="mt-2 text-sm leading-relaxed">{itemCourant.instruction}</p>
                <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--g3-bg, #0b0b10)] p-3 text-xs leading-relaxed">
                  <code>{itemCourant.code}</code>
                </pre>
              </div>
            )}
            {itemCourant.capacite === "comprendre" && (
              <div className="rounded-lg border border-[var(--g3-border, #2a2a35)] p-4">
                <p className="text-xs uppercase tracking-wide text-[var(--g3-muted, #8b8b9e)]">
                  Question → compréhension exacte (métadonnées du gabarit)
                </p>
                <p className="mt-2 text-sm leading-relaxed">{itemCourant.question}</p>
                <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--g3-bg, #0b0b10)] p-3 text-xs leading-relaxed">
                  <code>{itemCourant.code}</code>
                </pre>
                <p className="mt-3 text-sm leading-relaxed text-emerald-400">→ {itemCourant.reponse}</p>
              </div>
            )}
            {itemCourant.capacite === "simuler" && (
              <div className="rounded-lg border border-[var(--g3-border, #2a2a35)] p-4">
                <p className="text-xs uppercase tracking-wide text-[var(--g3-muted, #8b8b9e)]">
                  Simulation — résultat et trace MESURÉS par exécution réelle (à la génération)
                </p>
                <p className="mt-2 text-sm leading-relaxed">{itemCourant.question}</p>
                <pre className="mt-3 overflow-x-auto rounded-lg bg-[var(--g3-bg, #0b0b10)] p-3 text-xs leading-relaxed">
                  <code>{itemCourant.code}</code>
                </pre>
                <p className="mt-3 text-sm">
                  Entrée : <span className="font-mono text-[var(--g3-muted, #8b8b9e)]">{itemCourant.entreeDesc}</span>
                </p>
                <p className="mt-1 text-sm text-emerald-400">
                  → Sortie mesurée : <span className="font-mono">{itemCourant.sortie}</span>
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-[var(--g3-accent, #6c7bff)]">
                    Trace pas à pas ({itemCourant.trace.length} pas mesurés)
                  </summary>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 font-mono text-xs text-[var(--g3-muted, #8b8b9e)]">
                    {itemCourant.trace.map((pas, i) => (
                      <li key={`${itemCourant.id}-${i}`}>{pas}</li>
                    ))}
                  </ol>
                </details>
              </div>
            )}

            {/* Couche SNN */}
            {snn && (
              <div className="rounded-lg border border-[var(--g3-border, #2a2a35)] p-4">
                <p className="text-xs uppercase tracking-wide text-[var(--g3-muted, #8b8b9e)]">
                  Couche neuronale embarquée — résonance de la bande « génération de code » (métabolisme réel)
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                  <div>
                    <dt className="text-[var(--g3-muted, #8b8b9e)]">Colonnes évaluées</dt>
                    <dd className="font-mono">{snn.metabolisme.evaluees.toLocaleString("fr-FR")}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-muted, #8b8b9e)]">Au repos (coût zéro)</dt>
                    <dd className="font-mono">{snn.metabolisme.reposes.toLocaleString("fr-FR")}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-muted, #8b8b9e)]">Spikes</dt>
                    <dd className="font-mono">{snn.metabolisme.spikes.toLocaleString("fr-FR")}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-muted, #8b8b9e)]">Transmissions</dt>
                    <dd className="font-mono">{snn.metabolisme.transmissions.toLocaleString("fr-FR")}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--g3-muted, #8b8b9e)]">Durée (4 pas)</dt>
                    <dd className="font-mono">{snn.metabolisme.ms} ms</dd>
                  </div>
                </dl>
                <p className="mt-2 text-xs text-[var(--g3-muted, #8b8b9e)]">
                  Lecture graduée des 8 bandes-porteuses : [{snn.activationsBandes.map((a) => a.toFixed(4).replace(".", ",")).join(" · ")}] —
                  bande dominante #{snn.bandeDominante} (la bande attendue pour « génération de code » est celle du
                  hash du domaine — lecture d&apos;ondes, pas une détection de domaine).
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Session + honnêteté */}
      <section className="rounded-xl border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-card, #14141b)] p-5 text-sm leading-relaxed">
        <h2 className="text-base font-semibold">Honnêteté de mesure</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--g3-muted, #8b8b9e)]">
          <li>
            Le snapshot <strong>cortex-developpement-web-it79.bin</strong> est un cortex compact spécialisé
            (campagne it.79 : 120 000 exemples code vus sur un corpus de 160 000 uniques — objectif déclaré du
            propriétaire : 1 milliard d&apos;exemples / 1 million de datasets, poursuivi par checkpoints avec
            <code> --reprendre</code>). Sondes JAMAIS supervisées : ratio moyen 3,61 · accord u8 9/9 · anti-retour des
            19 domaines tenu (plancher 1,242631 ≥ socle it.73 1,242484) — tout est mesuré dans l&apos;artefact
            committé <code>cortex-developpement-web-it79.json</code>.
          </li>
          <li>
            La simulation <strong>ne évalue pas de code dans votre navigateur</strong> (CSP sans unsafe-eval) :
            les sorties et traces sont les mesures d&apos;exécutions réelles faites à la génération et vérifiées par
            la garde 47ᵉ (ré-exécution).
          </li>
          <li>
            La page répond <strong>dans le cadre appris</strong> (les 18 items committés + la charte
            « Génération de code ») ; le SNN mesure la résonance de bande — il ne fabrique pas de code hors matière.
          </li>
          <li>
            Session locale : {session.questions} exécution{session.questions > 1 ? "s" : ""} ·{" "}
            {session.transmissions.toLocaleString("fr-FR")} transmissions cumulées ·{" "}
            {session.ms.toFixed(1).replace(".", ",")} ms — zéro requête serveur après le chargement.
          </li>
        </ul>
      </section>
    </div>
  );
}

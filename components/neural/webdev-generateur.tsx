"use client";

/**
 * GÉNÉRATEUR SUR DEMANDE — « créer un site / une app » (it.80 — demande
 * propriétaire, trace 1a198553ec1dce61 : « via le navigateur, si un
 * utilisateur lui demande de créer un site où une app il peut lui générer
 * du code »).
 *
 * L'utilisateur décrit sa demande (famille de projet, nom métier, contexte,
 * options) et gen3 compose le code correspondant DANS LE NAVIGATEUR :
 *  - la composition vient du module appris (lib/gen3/generateur-sites.ts —
 *    6 familles paramétrées, déterministe, la suite de la matière it.79) ;
 *  - la couche NEURONALE est le vrai SNN embarqué (snapshot spécialisé
 *    it.79 chargé une fois, mis en cache) : il mesure la RÉSONANCE de la
 *    bande generation-code pour la demande — affichée telle quelle ;
 *  - zéro requête serveur par génération après le premier chargement ;
 *  - aucun code évalué dans le navigateur (CSP sans unsafe-eval).
 *
 * HONNÊTETÉ : gen3 refuse d'improviser hors matière — les 6 familles
 * paramétrées sont le cadre appris ; ce qui n'y entre pas est affiché
 * comme non couvert.
 */

import { useCallback, useRef, useState } from "react";

import {
  TYPES_PROJET,
  genererCodeSite,
  type ResultatGeneration,
  type TypeProjet,
} from "@/lib/gen3/generateur-sites";
import { tokenize } from "@/lib/neural/encoding/text-encoder";
import { cortexDepuisSnapshot } from "@/lib/neural/core/v2/cortex-telephone";
import type { CortexTelephone } from "@/lib/neural/core/v2/cortex-telephone";
import { importerSnapshotTelephone } from "@/lib/neural/core/v2/energie";

const CYCLES_FENETRE = 4; // même fenêtre que le serveur et la page /code
const BANDE_CODE = 3; // bande generation-code (hash FNV-1a % 8 — bandeDuDomaine, mesuré)

interface ResonanceSnn {
  bandeDominante: number;
  activationBandeCode: number;
  activations: number[];
  metabolisme: { evaluees: number; spikes: number; transmissions: number; ms: number };
}

const OPTIONS_TYPE = Object.entries(TYPES_PROJET) as [
  TypeProjet,
  (typeof TYPES_PROJET)[TypeProjet],
][];

export default function WebdevGenerateur() {
  const [type, setType] = useState<TypeProjet>("site-vitrine");
  const [nom, setNom] = useState("");
  const [contexte, setContexte] = useState<"next" | "react">("next");
  const [accessibilite, setAccessibilite] = useState(true);
  const [stockageLocal, setStockageLocal] = useState(true);
  const [resultat, setResultat] = useState<ResultatGeneration | null>(null);
  const [resonance, setResonance] = useState<ResonanceSnn | null>(null);
  const [statutSnn, setStatutSnn] = useState<"repos" | "chargement" | "pret" | "erreur">("repos");
  const [copie, setCopie] = useState(false);
  const moteurRef = useRef<CortexTelephone | null>(null);

  const chargerMoteur = useCallback(async (): Promise<CortexTelephone> => {
    const deja = moteurRef.current;
    if (deja) return deja;
    const reponse = await fetch("/neural/cortex-developpement-web-it79.bin", { cache: "force-cache" });
    if (!reponse.ok) throw new Error(`Snapshot HTTP ${reponse.status}`);
    const tampon = new Uint8Array(await reponse.arrayBuffer());
    const { entete, poidsU8 } = importerSnapshotTelephone(tampon);
    const moteur = cortexDepuisSnapshot(entete, poidsU8);
    moteurRef.current = moteur;
    return moteur;
  }, []);

  const mesurerResonance = useCallback(
    async (texte: string): Promise<void> => {
      setStatutSnn("chargement");
      try {
        const moteur = await chargerMoteur();
        moteur.reinitialiserEnergies();
        const injections = moteur.projetterTokens(tokenize(texte));
        let spikes = 0;
        let evaluees = 0;
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
        setResonance({
          bandeDominante,
          activationBandeCode: activations[BANDE_CODE] ?? 0,
          activations: activations.slice(0, 8),
          metabolisme: {
            evaluees,
            spikes,
            transmissions,
            ms: Math.round(moteur.metabolismeDernierPas.ms * 1000) / 1000,
          },
        });
        setStatutSnn("pret");
      } catch {
        setStatutSnn("erreur");
      }
    },
    [chargerMoteur],
  );

  const generer = useCallback(() => {
    const produit = genererCodeSite({ type, nom, contexte, accessibilite, stockageLocal });
    setResultat(produit);
    setCopie(false);
    void mesurerResonance(produit.instruction);
  }, [type, nom, contexte, accessibilite, stockageLocal, mesurerResonance]);

  const copier = useCallback(() => {
    if (!resultat) return;
    void navigator.clipboard.writeText(resultat.code).then(() => setCopie(true));
  }, [resultat]);

  const ficheType = TYPES_PROJET[type];

  return (
    <section className="rounded-xl border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-card, #14141b)] p-5">
      <h2 className="text-base font-semibold">Créer un site / une app — sur demande</h2>
      <p className="mt-1 text-sm text-[var(--g3-muted, #8b8b9e)]">
        Décrivez votre demande : gen3 compose le code complet dans le navigateur, dans le cadre appris
        (6 familles paramétrées — la suite de la matière it.79). Le SNN embarqué mesure la résonance de
        la bande « génération de code » pour votre demande — mesure affichée telle quelle.
      </p>

      {/* Formulaire de demande */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Ce que vous voulez créer
          <select
            value={type}
            onChange={(e) => setType(e.target.value as TypeProjet)}
            className="mt-1 w-full rounded border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-bg)] px-3 py-2"
          >
            {OPTIONS_TYPE.map(([valeur, fiche]) => (
              <option key={valeur} value={valeur}>
                {fiche.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Nom du projet / du métier
          <input
            value={nom}
            onChange={(e) => setNom(e.target.value)}
            placeholder="ex. Café Goma, Clinique Nkolo…"
            maxLength={60}
            className="mt-1 w-full rounded border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-bg)] px-3 py-2"
          />
        </label>
        <label className="text-sm">
          Contexte technique
          <select
            value={contexte}
            onChange={(e) => setContexte(e.target.value === "react" ? "react" : "next")}
            className="mt-1 w-full rounded border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-bg)] px-3 py-2"
          >
            <option value="next">Next.js 16 (page app/)</option>
            <option value="react">React 19 (composant isolé)</option>
          </select>
        </label>
        <fieldset className="text-sm">
          <legend className="sr-only">Options</legend>
          <div className="flex flex-col gap-2 pt-6">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={accessibilite} onChange={(e) => setAccessibilite(e.target.checked)} />
              Accessibilité (aria, labels)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={stockageLocal && ficheType.avecEtatPersistable}
                disabled={!ficheType.avecEtatPersistable}
                onChange={(e) => setStockageLocal(e.target.checked)}
              />
              Sauvegarde locale (localStorage){!ficheType.avecEtatPersistable && " — non applicable à cette famille"}
            </label>
          </div>
        </fieldset>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={generer}
          className="rounded-lg bg-[var(--g3-accent, #6c7bff)] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Générer le code
        </button>
        {resultat && (
          <button
            type="button"
            onClick={copier}
            className="rounded-lg border border-[var(--g3-border, #2a2a35)] px-4 py-2 text-sm hover:underline"
          >
            {copie ? "Copié ✓" : "Copier le code"}
          </button>
        )}
        <span className="text-xs text-[var(--g3-muted, #8b8b9e)]">
          {ficheType.description}
        </span>
      </div>

      {/* Résultat */}
      {resultat && (
        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">{resultat.titre}</h3>
            <code className="text-xs text-[var(--g3-muted, #8b8b9e)]">{resultat.fichier}</code>
          </div>
          <p className="text-sm text-[var(--g3-muted, #8b8b9e)]">
            Demande comprise : {resultat.instruction}
          </p>

          {/* Mesure SNN (réelle, affichée telle quelle) */}
          {statutSnn === "chargement" && (
            <p className="text-xs text-[var(--g3-muted, #8b8b9e)]">SNN : chargement du snapshot spécialisé…</p>
          )}
          {statutSnn === "erreur" && (
            <p className="text-xs text-amber-400">
              SNN : snapshot indisponible — le code généré reste servi (la composition est locale).
            </p>
          )}
          {statutSnn === "pret" && resonance && (
            <p className="text-xs text-[var(--g3-muted, #8b8b9e)]">
              SNN embarqué (mesure réelle) — bande dominante : {resonance.bandeDominante}/7 ·
              bande génération de code ({BANDE_CODE}) : activation {resonance.activationBandeCode.toFixed(4)} ·
              colonnes évaluées {resonance.metabolisme.evaluees.toLocaleString("fr-FR")} ·
              spikes {resonance.metabolisme.spikes} · transmissions {resonance.metabolisme.transmissions} ·
              métabolisme {resonance.metabolisme.ms} ms. La mesure neuronale traduit la résonance de la
              demande, elle ne garantit pas le code — la composition, elle, est déterministe et vérifiée.
            </p>
          )}

          <pre className="max-h-96 overflow-auto rounded-lg border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-bg)] p-4 text-xs leading-relaxed">
            <code>{resultat.code}</code>
          </pre>

          <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--g3-muted, #8b8b9e)]">
            {resultat.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

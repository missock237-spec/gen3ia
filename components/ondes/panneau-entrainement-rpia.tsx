"use client";

/**
 * Panneau d'entraînement RPIA du laboratoire d'ondes — la facette
 * APPRENTISSAGE du W-DNN rendue tangible : une requête texte devient
 * onde cible (conditionneur), la couche d'ondes neuronales apprend à
 * résonner vers elle (règle RPIA, GPU utilisateur si WebGPU, miroir
 * CPU sinon), et le résultat est :
 *
 *   · montré honnêtement — courbe d'erreur réelle, convergence ou non ;
 *   · injecté dans le cerveau — la grille 10×10 = les 100 neurones,
 *     leur énergie de résonance après apprentissage ;
 *   · ÉCOUTABLE — la synthèse acoustique par résonance produit un WAV
 *     réel (oscillateurs 20–20 000 Hz guidés vers la même cible) ;
 *   · vérifiable — la suite de validation gen3 (3 familles de tests)
 *     s'exécute dans le navigateur.
 */

import { useCallback, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CoucheOndesNeuronales } from "@/lib/neural/core/couche-rpia";
import { webgpuDisponible } from "@/lib/ondes/moteur";
import { executerSuiteValidationGen3 } from "@/lib/ondes/suite-validation";
import type { ResultatSuiteValidation } from "@/lib/ondes/suite-validation";
import { SynthetiseurAcoustique, versWav } from "@/lib/ondes/synthese-acoustique";
import type { RapportEntrainement } from "@/lib/ondes/types-entrainement";

const CHOIX_NOEUDS = [100, 256, 512, 1024] as const;

function CourbeErreur({ historique }: { historique: number[] }) {
  const chemin = useMemo(() => {
    if (historique.length < 2) return "";
    const min = Math.min(...historique);
    const max = Math.max(...historique);
    const etendue = Math.max(1e-9, max - min);
    return historique
      .map((v, i) => {
        const x = (i / (historique.length - 1)) * 100;
        const y = 30 - ((v - min) / etendue) * 28;
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [historique]);

  return (
    <svg viewBox="0 0 100 30" className="h-12 w-full" preserveAspectRatio="none" aria-hidden="true">
      <path d={chemin} fill="none" stroke="#7C5CFF" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function GrilleResonance({ noeuds }: { noeuds: { amplitude: number }[] }) {
  // Les 100 premiers nœuds = les 100 neurones du cerveau (même index).
  const cent = noeuds.slice(0, 100);
  return (
    <div className="grid grid-cols-10 gap-0.5" role="img" aria-label="Énergie de résonance des 100 neurones">
      {cent.map((n, i) => {
        const intensite = Math.min(1, n.amplitude / 2);
        return (
          <div
            key={i}
            title={`Neurone ${i} — amplitude ${n.amplitude.toFixed(3)}`}
            className="aspect-square rounded-[2px]"
            style={{
              backgroundColor: `rgba(139, 92, 246, ${0.12 + intensite * 0.88})`,
            }}
          />
        );
      })}
    </div>
  );
}

export default function PanneauEntrainementRPIA() {
  const [texte, setTexte] = useState("gen3 apprend par résonance d'ondes");
  const [nbNoeuds, setNbNoeuds] = useState<(typeof CHOIX_NOEUDS)[number]>(100);
  const [epoques, setEpoques] = useState(120);
  const [enCours, setEnCours] = useState(false);
  const [rapport, setRapport] = useState<RapportEntrainement | null>(null);
  const [noeudsAppris, setNoeudsAppris] = useState<{ amplitude: number }[]>([]);
  const [suite, setSuite] = useState<ResultatSuiteValidation | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const urlAudio = useRef<string | null>(null);
  const webgpu = useMemo(() => webgpuDisponible(), []);

  const entrainer = useCallback(() => {
    setEnCours(true);
    setErreur(null);
    try {
      // Entraînement LOCAL : la physique tourne dans ce navigateur
      // (WebGPU si disponible, miroir CPU déterministe sinon) — aucune
      // requête réseau, aucune donnée envoyée.
      const couche = new CoucheOndesNeuronales(nbNoeuds);
      const r = couche.entrainerVersTexte(texte, epoques);
      setRapport(r);
      setNoeudsAppris(couche.noeuds());
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Échec de l'entraînement.");
    } finally {
      setEnCours(false);
    }
  }, [texte, nbNoeuds, epoques]);

  const ecouterSynthese = useCallback(() => {
    try {
      // La même requête, mise en résonance ACOUSTIQUE : oscillateurs
      // audibles guidés vers l'onde cible, puis rendu PCM → WAV réel.
      const synth = new SynthetiseurAcoustique(Math.min(nbNoeuds, 512));
      const coucheCible = new CoucheOndesNeuronales(synth.nbNoeuds);
      synth.entrainerVers(coucheCible.cibleDepuisTexte(texte), 8);
      const pcm = synth.genererBuffer(1.2);
      const wav = versWav(pcm, synth.frequenceEchantillonnage);
      if (urlAudio.current) URL.revokeObjectURL(urlAudio.current);
      urlAudio.current = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      const audio = new Audio(urlAudio.current);
      void audio.play();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Échec de la synthèse acoustique.");
    }
  }, [texte, nbNoeuds]);

  const validerArchitecture = useCallback(() => {
    setSuite(executerSuiteValidationGen3({ nbNoeuds: 1024 }));
  }, []);

  return (
    <Card className="border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Entraînement RPIA — apprendre par résonance</CardTitle>
          <Badge tone={webgpu ? "info" : "neutral"}>
            {webgpu ? "WebGPU disponible" : "Miroir CPU"}
          </Badge>
        </div>
        <CardDescription>
          La requête devient une onde cible ; les nœuds d&apos;onde (un par neurone) apprennent à
          résonner vers elle par interférence constructive/destructive. Tout se calcule localement.
        </CardDescription>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="rpia-texte" className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Requête à mettre en résonance
          </label>
          <textarea
            id="rpia-texte"
            value={texte}
            onChange={(e) => setTexte(e.target.value)}
            rows={2}
            maxLength={500}
            className="w-full resize-none rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-violet-500 dark:border-zinc-700"
            placeholder="Ex : rédiger un rapport d'analyse de données"
          />
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Nœuds</span>
            <div className="flex gap-1">
              {CHOIX_NOEUDS.map((n) => (
                <Button
                  key={n}
                  size="sm"
                  variant={nbNoeuds === n ? "primary" : "secondary"}
                  onClick={() => setNbNoeuds(n)}
                  className="min-w-[3rem] px-2"
                >
                  {n}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="rpia-epoques" className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Époques : {epoques}
            </label>
            <input
              id="rpia-epoques"
              type="range"
              min={10}
              max={300}
              step={10}
              value={epoques}
              onChange={(e) => setEpoques(Number(e.target.value))}
              className="w-40 accent-violet-600"
            />
          </div>
          <Button onClick={entrainer} disabled={enCours || texte.trim().length === 0}>
            {enCours ? "Résonance en cours…" : "Entraîner par résonance"}
          </Button>
          <Button variant="secondary" onClick={ecouterSynthese}>
            Écouter la synthèse acoustique
          </Button>
          <Button variant="ghost" onClick={validerArchitecture}>
            Suite de validation gen3
          </Button>
        </div>

        {erreur && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {erreur}
          </p>
        )}

        {rapport && (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Courbe d&apos;interférence ({rapport.epoques} époques)
                </span>
                <Badge
                  tone={rapport.convergence ? "success" : "warning"}
                >
                  {rapport.convergence ? "convergence réelle" : "non convergé"}
                </Badge>
              </div>
              <CourbeErreur historique={rapport.historiqueErreur} />
              <p className="font-mono text-xs text-zinc-500 dark:text-zinc-500">
                erreur {rapport.erreurInitiale.toFixed(4)} → {rapport.erreurFinale.toFixed(4)}
              </p>
            </div>
            <div className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Énergie de résonance injectée au cerveau (100 neurones)
              </span>
              {noeudsAppris.length > 0 ? (
                <GrilleResonance noeuds={noeudsAppris} />
              ) : (
                <p className="text-xs text-zinc-500">Lancez un entraînement pour voir la résonance.</p>
              )}
            </div>
          </div>
        )}

        {suite && (
          <div className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Suite de validation gen3 — {suite.dureeMs} ms
              </span>
              <Badge tone={suite.succes ? "success" : "danger"}>
                {suite.succes ? "3/3 réussis" : "échec"}
              </Badge>
            </div>
            <ul className="flex flex-col gap-1">
              {suite.tests.map((t) => (
                <li key={t.nom} className="flex items-start gap-2 text-xs">
                  <span aria-hidden="true">{t.succes ? "✅" : "❌"}</span>
                  <span>
                    <span className="font-medium">{t.nom}</span> — {t.details}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-500">
          Honnêteté : l&apos;entraînement RPIA façonne la résonance du champ et l&apos;énergie
          injectée au cerveau neuronal — il ne remplace pas les poids d&apos;un grand modèle. La
          synthèse acoustique produit un vrai signal WAV ; le rendu vidéo spatiotemporel produit
          des trames RGBA prêtes pour un encodeur.
        </p>
      </CardBody>
    </Card>
  );
}

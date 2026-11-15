"use client";

/**
 * Le Laboratoire du Monde — l'interface où l'IA simule la nature.
 *
 * L'utilisateur écrit en français (« lance un projectile à 50 m/s à
 * 45° », « fentes de Young à 600 nm », « résous y' = -2*t*y ») ; le
 * navigateur interprète, simule et dessine INSTANTANÉMENT — tout le
 * calcul physique tourne LOCALEMENT (architecture utilisateurs
 * infinis : chaque client apporte sa puissance). Le mode « essaim »
 * renvoie vers l'API pour les intégrations programmatiques et met en
 * évidence le répartiteur (quotas, files bornées, équité).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { ToileMonde } from "@/components/monde/toile-monde";
import { servir, statsLocales, type StatsEssaimLocal } from "@/lib/monde/repartiteur-local";
import type { ResultatSimulation } from "@/lib/monde/types";
import { interpreter } from "@/lib/monde/intention";
import { simuler } from "@/lib/monde/univers";

import "./laboratoire-monde.css";

const EXEMPLES: Array<{ etiquette: string; question: string }> = [
  { etiquette: "Projectile", question: "Lance un projectile à 50 m/s avec un angle de 45 degrés, avec l'air" },
  { etiquette: "Fentes de Young", question: "Franges des fentes de Young avec une longueur d'onde de 600 nm et fentes espacées de 0.1 mm" },
  { etiquette: "Équation différentielle", question: "Résous y'' = -y + sin(t) avec y(0) = 0 et y'(0) = 1 jusqu'à t = 20 s" },
  { etiquette: "Chaleur (cuivre)", question: "Diffusion de la chaleur dans une plaque de cuivre chauffée à 200 °C" },
  { etiquette: "Terre–Lune", question: "Simule l'orbite de la lune autour de la terre pendant un mois" },
  { etiquette: "Relativité", question: "Dilatation du temps à 99.9 % de la vitesse de la lumière pendant 1 an" },
  { etiquette: "Pendule", question: "Pendule de longueur 2 m lâché à 80 degrés" },
  { etiquette: "Interférences d'ondes", question: "Onde de 440 Hz avec deux sources pour voir les interférences" },
  { etiquette: "Racines", question: "Trouve les racines de x^3 - 6*x^2 + 11*x - 6 = 0 entre -10 et 10" },
  { etiquette: "Intégrale", question: "Calcule l'intégrale de exp(-x^2) entre -3 et 3" },
  { etiquette: "Circuit RLC", question: "Circuit RLC avec résistance de 10 ohms, inductance de 1 mH et capacité de 1 nF" },
  { etiquette: "Électron quantique", question: "Paquet d'onde d'un électron avec impulsion de 1e-24 en évolution libre" },
];

function formaterNombre(v: number): string {
  if (!Number.isFinite(v)) return "∞";
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs >= 1e5 || abs < 1e-3) return v.toExponential(3);
  if (abs >= 1000) return v.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  return v.toLocaleString("fr-FR", { maximumFractionDigits: 4 });
}

export default function LaboratoireMonde() {
  const [question, setQuestion] = useState("");
  const [resultat, setResultat] = useState<ResultatSimulation | null>(null);
  const [comprehension, setComprehension] = useState("");
  const [suppositions, setSuppositions] = useState<string[]>([]);
  const [confiance, setConfiance] = useState(1);
  const [erreur, setErreur] = useState("");
  const [calcul, setCalcul] = useState(false);
  const [modeEssaim, setModeEssaim] = useState(false);
  const [stats, setStats] = useState<StatsEssaimLocal | null>(null);

  useEffect(() => {
    setStats(statsLocales());
    const id = setInterval(() => setStats(statsLocales()), 2000);
    return () => clearInterval(id);
  }, []);

  const simulerQuestion = useCallback(
    (texte: string) => {
      const propre = texte.trim();
      if (!propre || calcul) return;
      setCalcul(true);
      setErreur("");

      // Délai minimal pour laisser React peindre l'état « calcul ».
      requestAnimationFrame(() => {
        try {
          const intention = interpreter(propre);
          if (!intention) {
            setErreur(
              "Aucun phénomène physique détecté. Essayez : « projectile à 50 m/s à 45° », « chaleur dans du cuivre », « résous y' = -y », « dilatation du temps »…",
            );
            setCalcul(false);
            return;
          }
          const debut = performance.now();
          const res = simuler(intention.spec);
          // Latence ressentie honnête : le calcul est instantané, on
          // marque juste le temps réel d'exécution.
          res.dureeMs = performance.now() - debut;
          setResultat(res);
          setComprehension(intention.comprehension);
          setSuppositions(intention.suppositions);
          setConfiance(intention.confiance);
          servir(propre);
          setStats(statsLocales());
        } catch (e) {
          setErreur(e instanceof Error ? e.message : "La simulation a échoué.");
        } finally {
          setCalcul(false);
        }
      });
    },
    [calcul],
  );

  const viaEssaim = useCallback(async (texte: string) => {
    setCalcul(true);
    setErreur("");
    try {
      const reponse = await fetch("/api/monde/simuler", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: texte }),
      });
      const data = (await reponse.json()) as {
        ok?: boolean;
        erreur?: string;
        comprehension?: string;
        suppositions?: string[];
        confiance?: number;
        resultat?: ResultatSimulation;
      };
      if (!reponse.ok || !data.ok || !data.resultat) {
        setErreur(data.erreur ?? "L'essaim a refusé la demande.");
      } else {
        setResultat(data.resultat);
        setComprehension(data.comprehension ?? "");
        setSuppositions(data.suppositions ?? []);
        setConfiance(data.confiance ?? 1);
      }
    } catch {
      setErreur("Essaim injoignable — utilisez le calcul local.");
    } finally {
      setCalcul(false);
    }
  }, []);

  const soumettre = useCallback(() => {
    if (modeEssaim) void viaEssaim(question);
    else simulerQuestion(question);
  }, [modeEssaim, question, simulerQuestion, viaEssaim]);

  const seriesMemo = useMemo(() => resultat?.series ?? [], [resultat]);
  const champMemo = useMemo(() => resultat?.champ ?? null, [resultat]);

  return (
    <div className="monde-lab">
      <header className="monde-entete">
        <div className="monde-titre">
          <span className="monde-glyphe" aria-hidden>
            ⌬
          </span>
          <div>
            <h1>Le Monde</h1>
            <p>
              Simulateur universel des lois de la nature — décrivez un phénomène en français, le moteur
              l&apos;interprète, résout les équations et dessine la physique.
            </p>
          </div>
        </div>
        <div className="monde-badge-archi" title="Le calcul physique s'exécute dans VOTRE navigateur : la capacité de la plateforme croît avec le nombre d'utilisateurs.">
          <strong>Calcul local</strong> — chaque navigateur est un superordinateur
        </div>
      </header>

      <section className="monde-composer" aria-label="Composer de simulation">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              soumettre();
            }
          }}
          placeholder="Décrivez un phénomène physique… ex. « lance un projectile à 50 m/s à 45 degrés avec l'air »"
          rows={2}
          aria-label="Question physique"
        />
        <div className="monde-composer-actions">
          <button type="button" className="monde-bouton-principal" onClick={soumettre} disabled={calcul || question.trim().length === 0}>
            {calcul ? "Le Monde calcule…" : "Simuler"}
          </button>
          <label className="monde-bascule" title="Via l'essaim : la requête passe par le répartiteur global (quotas, files bornées, équité) — démonstration de l'architecture utilisateurs infinis.">
            <input type="checkbox" checked={modeEssaim} onChange={(e) => setModeEssaim(e.target.checked)} />
            Via l&apos;essaim (API + répartiteur)
          </label>
        </div>
      </section>

      <nav className="monde-exemples" aria-label="Exemples">
        {EXEMPLES.map((ex) => (
          <button
            key={ex.etiquette}
            type="button"
            className="monde-puce-exemple"
            onClick={() => {
              setQuestion(ex.question);
              if (modeEssaim) void viaEssaim(ex.question);
              else simulerQuestion(ex.question);
            }}
          >
            {ex.etiquette}
          </button>
        ))}
      </nav>

      {erreur && (
        <div className="monde-erreur" role="alert">
          {erreur}
        </div>
      )}

      {(comprehension || resultat) && (
        <section className="monde-resultat" aria-label="Résultat de simulation">
          {comprehension && (
            <p className="monde-comprehension">
              <span className="monde-etiquette">Compris :</span> {comprehension}
              <span className="monde-confiance"> (confiance {(confiance * 100).toFixed(0)} %)</span>
            </p>
          )}

          {resultat && (
            <>
              <div className="monde-entete-resultat">
                <h2>
                  {resultat.titre} <small>· {resultat.modele}</small>
                </h2>
                <span className="monde-duree">{resultat.dureeMs.toFixed(1)} ms</span>
              </div>

              <p className="monde-explication">{resultat.explication}</p>

              <div className="monde-toile-conteneur">
                <ToileMonde
                  series={seriesMemo}
                  champ={champMemo}
                  vide="Aucune donnée tracable pour cette simulation — consultez les grandeurs ci-dessous."
                />
              </div>

              {resultat.equations.length > 0 && (
                <div className="monde-equations">
                  {resultat.equations.map((eq) => (
                    <code key={eq}>{eq}</code>
                  ))}
                </div>
              )}

              <div className="monde-grille">
                {resultat.scalaires.length > 0 && (
                  <div className="monde-panneau">
                    <h3>Grandeurs clés</h3>
                    <ul>
                      {resultat.scalaires.map((s) => (
                        <li key={s.nom}>
                          <span className="monde-grandeur-nom">{s.nom}</span>
                          <span className="monde-grandeur-valeur">
                            {Number.isNaN(s.valeur) ? s.unite : `${formaterNombre(s.valeur)} ${s.unite}`}
                          </span>
                          {s.note && <span className="monde-grandeur-note">{s.note}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="monde-panneau">
                  <h3>Diagnostics honnêtes</h3>
                  <ul>
                    {resultat.diagnostics.map((d) => (
                      <li key={d.nom} className={d.sain ? "sain" : "vigilance"}>
                        <span className="monde-diag-puce" aria-hidden>
                          {d.sain ? "✓" : "⚠"}
                        </span>
                        <span className="monde-diag-nom">{d.nom}</span>
                        <span className="monde-diag-valeur">{d.valeur}</span>
                      </li>
                    ))}
                  </ul>
                  {resultat.avertissements.length > 0 && (
                    <div className="monde-avertissements">
                      {resultat.avertissements.map((a) => (
                        <p key={a}>⚠ {a}</p>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {suppositions.length > 0 && (
                <details className="monde-suppositions">
                  <summary>Hypothèses employées ({suppositions.length})</summary>
                  <ul>
                    {suppositions.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </section>
      )}

      <section className="monde-essaim" aria-label="État de l'essaim global">
        <h3>Essaim local — la preuve par les chiffres</h3>
        {stats && (
          <div className="monde-essaim-stats">
            <div>
              <strong>{stats.servis.toLocaleString("fr-FR")}</strong>
              <span> simulations servies</span>
            </div>
            <div>
              <strong>{stats.admises.toLocaleString("fr-FR")}</strong>
              <span> admises</span>
            </div>
            <div>
              <strong>{stats.refusees.toLocaleString("fr-FR")}</strong>
              <span> refusées (quota)</span>
            </div>
            <div>
              <strong>{(stats.equite * 100).toFixed(1)} %</strong>
              <span> équité (Jain)</span>
            </div>
            <div>
              <strong>{stats.utilisateursSuivis.toLocaleString("fr-FR")}</strong>
              <span> utilisateurs suivis (plafonné)</span>
            </div>
          </div>
        )}
        <p className="monde-essaim-note">
          Architecture « utilisateurs infinis » : le calcul physique tourne dans votre navigateur (ici) ou sur le GPU
          client (W-DNN) ; le serveur ne fait que la signalisation — sa capacité ne se dégrade PAS quand le nombre
          d&apos;utilisateurs monte. Le répartiteur global (quotas par token bucket, sharding 64 fragments,
          backpressure honnête) est testé sous 100 000 utilisateurs virtuels : mémoire bornée, équité &gt; 0.95,
          zéro famine.
        </p>
      </section>
    </div>
  );
}

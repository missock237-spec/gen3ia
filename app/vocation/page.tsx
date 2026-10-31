import type { Metadata } from "next";
import Link from "next/link";

import {
  DOMAINES_VOCATION,
  MISSION_GEN3,
  NB_DOMAINES_VOCATION,
} from "@/lib/gen3/vocation";
import { lireResumeMasse } from "@/lib/gen3/pretrain-masse";
import { lireResumeMillion } from "@/lib/gen3/pretrain-million";

/**
 * /vocation — LA CHARTE LISIBLE DE LA VOCATION DE GEN3 (it.62).
 *
 * La demande propriétaire (it.59) : gen3 « doit savoir qu'il a été créé
 * pour exécuter des tâches dans chaque domaine ». La charte est déjà
 * injectée dans son prompt système (engine-chat.ts, response-quality.ts)
 * et exposée par GET /api/neural/domaines — cette page la rend LISIBLE
 * PAR LES UTILISATEURS : chacun voit les 19 domaines pour lesquels gen3
 * a été créé, les tâches qu'il y exécute et les outils réels qu'il y
 * mobilise.
 *
 * Composant serveur : la charte est un module statique zéro IO
 * (lib/gen3/vocation.ts) ; les résumés des campagnes de pré-entraînement
 * lisent les rapports committés par les campagnes réelles
 * (lib/gen3/pretrain-masse.ts campagne B, lib/gen3/pretrain-million.ts
 * campagne A — null si absent, honnêteté : aucune métrique inventée).
 * Aucune donnée utilisateur, aucun secret. Page publique (la vocation est
 * une promesse publique). Le pré-entraînement par ondes correspondant
 * (méthode EOD it.57) est pilotable depuis la console /neural (onglet
 * Entraînement — it.62).
 */

export const metadata: Metadata = {
  title: "La vocation de gen3 — les 19 domaines | Gen3ia",
  description:
    "Gen3, moteur neuronal local de Gen3ia, a été créé pour exécuter des tâches dans 19 domaines : recherche web, analyse de données, génération de code, médecine, droit, cybersécurité et plus. Charte complète, tâches et outils réels.",
};

export default function PageVocation() {
  // it.63 — résumé du pré-entraînement massif committé (null si absent).
  const masse = lireResumeMasse();
  const masseParId = new Map(masse?.parDomaine.map((d) => [d.id, d]) ?? []);
  // it.64 — résumé de la session million à données uniques (campagne A).
  const million = lireResumeMillion();
  const millionParId = new Map(million?.parDomaine.map((d) => [d.id, d]) ?? []);
  const formatM = (n: number) => `${(n / 1_000_000).toFixed(3).replace(".", ",")}`;
  const fmtFr = (n: number) => n.toLocaleString("fr-FR");

  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-10 sm:px-6">
        {/* En-tête — la mission */}
        <header className="g3v6-card g3v6-sweep relative overflow-hidden px-6 py-6">
          <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3v6-spike-text)]">
            Gen3ia · charte d&apos;identité du moteur neuronal
          </p>
          <h1 className="mt-2 text-3xl font-bold">La vocation de gen3</h1>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[var(--g3-muted)]">
            {MISSION_GEN3}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-[var(--g3-muted)]">
            <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">
              <strong className="text-[var(--g3v6-spike-text)]">{NB_DOMAINES_VOCATION} domaines</strong> — ordre déclaré par le propriétaire
            </span>
            <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">Raisonnement 100 % local (SNN) — zéro service IA externe</span>
            <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">Outils réels du registre de la plateforme</span>
          </div>
        </header>

        {/* Les 19 domaines */}
        <section aria-label="Les 19 domaines de la vocation" className="grid gap-3 sm:grid-cols-2">
          {DOMAINES_VOCATION.map((domaine, index) => (
            <article key={domaine.id} className="g3v6-card p-5">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold text-[var(--g3-faint)]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h2 className="text-base font-bold">{domaine.label}</h2>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--g3-muted)]">
                {domaine.mission}
              </p>
              <p className="mt-3 text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                Tâches exécutées
              </p>
              <ul className="mt-1 space-y-0.5 text-[12px] text-[var(--g3-text-secondary)]">
                {domaine.taches.map((tache) => (
                  <li key={tache}>· {tache}</li>
                ))}
              </ul>
              <p className="mt-3 text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                Outils réels mobilisés
              </p>
              <p className="mt-1 text-[11px] text-[var(--g3-muted)]">
                {domaine.outils.map((outil) => (
                  <span key={outil} className="mr-1.5 inline-block rounded-full border border-[var(--g3-border)] px-2 py-0.5">
                    {outil}
                  </span>
                ))}
              </p>
            </article>
          ))}
        </section>

        {/* it.64 — session million à données uniques (campagne A) : le
            critère propriétaire « plus d'un million de données par domaine » */}
        <section aria-label="Session million à données uniques" className="g3v6-card p-5">
          <h2 className="text-sm font-bold">
            Session million — 1 005 000 textes uniques par domaine (campagne A)
          </h2>
          {million ? (
            <>
              <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-[var(--g3-muted)]">
                Campagne réelle du {million.date.slice(0, 10)} — {fmtFr(million.totalEchantillons)} échantillons
                réellement traités par la pipeline EOD complète ({fmtFr(million.sources.depot)} du dépôt +{" "}
                {fmtFr(million.sources.huggingface)} Hugging Face + {fmtFr(million.sources.proceduraux)} procéduraux
                uniques), soit <strong className="text-[var(--g3v6-spike-text)]">plus d&apos;un million de données par
                domaine</strong> — 1 005 000 textes uniques chacun (bijection mixte-radix, unicité contrôlée).
                Plan d&apos;ordonnancement : {million.plan || "non documenté"} —{" "}
                {fmtFr(million.cyclesParEchantillon)} cycles par échantillon, mécanique EOD it.57 inchangée.
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">
                  Données : <strong className="text-[var(--g3v6-spike-text)]">{million.bilan.donneesParDomaine.ok}/{million.bilan.donneesParDomaine.total}</strong>
                </span>
                <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">
                  Porteurs renforcés : <strong className="text-[var(--g3v6-spike-text)]">{million.bilan.porteursRenforces.ok}/{million.bilan.porteursRenforces.total}</strong>{" "}
                  ({fmtFr(million.bilan.porteursRenforces.renfortsTotaux)} renforts mesurés)
                </span>
                <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">
                  Bandes stables : <strong className="text-[var(--g3v6-spike-text)]">{million.bilan.stabiliteBandes.ok}/{million.bilan.stabiliteBandes.total}</strong>
                </span>
                <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">
                  Trace : {million.bilan.traceParDomaine.ok}/{million.bilan.traceParDomaine.total} — limite sparse-colonne documentée, rapportée telle quelle
                </span>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="text-[10px] uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                    <tr>
                      <th className="py-1.5 pr-3">Domaine</th>
                      <th className="py-1.5 pr-3">Échantillons</th>
                      <th className="py-1.5 pr-3">Renforts mesurés</th>
                      <th className="py-1.5 pr-3">Gain trace</th>
                      <th className="py-1.5">Gain vocabulaire</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DOMAINES_VOCATION.map((domaine) => {
                      const d = millionParId.get(domaine.id);
                      return (
                        <tr key={domaine.id} className="border-t border-[var(--g3-border)]">
                          <td className="py-1.5 pr-3 font-medium">{domaine.label}</td>
                          <td className="py-1.5 pr-3 text-[var(--g3-muted)]">{d ? `${formatM(d.echantillons)} M` : "—"}</td>
                          <td className="py-1.5 pr-3 text-[var(--g3-muted)]">{d ? `${formatM(d.renforts)} M` : "—"}</td>
                          <td className="py-1.5 pr-3 text-[var(--g3-muted)]">{d ? `×${d.gainTrace.toFixed(2).replace(".", ",")}` : "—"}</td>
                          <td className="py-1.5 text-[var(--g3-muted)]">{d ? `×${d.gainVocabulaire.toFixed(2).replace(".", ",")}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--g3-faint)]">
                Métabolisme mesuré : {fmtFr(million.metabolisme.evaluees)} colonnes évaluées, {fmtFr(million.metabolisme.transmissions)} transmissions —
                {" "}mécanisme événementiel (repos gratuit). Sonde de vocabulaire : ×{million.sondeVocabulaire.avant.toFixed(2).replace(".", ",")} →
                ×{million.sondeVocabulaire.apres.toFixed(2).replace(".", ",")}. {million.limitesHonnetes.length} limites honnêtes documentées dans l&apos;artefact
                (corpus procédural synthétique étiqueté comme tel ; la généralisation sémantique reste hors de portée de la méthode — it.61).
              </p>
            </>
          ) : (
            <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-[var(--g3-muted)]">
              Aucune session million committée à ce jour — cette section affichera le bilan à quatre signaux
              (données, porteurs, bandes, trace) dès qu&apos;un rapport de campagne à données uniques sera livré avec le dépôt.
            </p>
          )}
        </section>

        {/* it.63 — pré-entraînement massif (preuve d'assimilation honnête) */}
        <section aria-label="Pré-entraînement massif par domaine" className="g3v6-card p-5">
          <h2 className="text-sm font-bold">Pré-entraînement massif — plus d&apos;un million de données par domaine</h2>
          {masse ? (
            <>
              <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-[var(--g3-muted)]">
                Campagne réelle du {masse.date.slice(0, 10)} — {masse.totalEchantillons.toLocaleString("fr-FR")} échantillons traités
                par la méthode des ondes de domaine ({masse.epoques.toLocaleString("fr-FR")} époques entrelacées de {masse.lot.toLocaleString("fr-FR")}),
                chaque domaine recevant plus d&apos;un million de données. Sonde d&apos;assimilation : rejeu des échantillons entraînés
                (TRACE à l&apos;horloge exacte) et textes jamais vus (GÉNÉRALISATION), comparés à un cortex témoin vierge —
                gains mesurés, aucun chiffre inventé. Assimilation (gain ≥ {masse.seuilAssimile.toLocaleString("fr-FR")}) :{" "}
                <strong className="text-[var(--g3v6-spike-text)]">{masse.assimiles}/{masse.totalDomaines} domaines</strong>.
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="text-[10px] uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                    <tr>
                      <th className="py-1.5 pr-3">Domaine</th>
                      <th className="py-1.5 pr-3">Échantillons</th>
                      <th className="py-1.5 pr-3">Gain trace</th>
                      <th className="py-1.5 pr-3">Gain généralisation</th>
                      <th className="py-1.5">Assimilation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DOMAINES_VOCATION.map((domaine) => {
                      const d = masseParId.get(domaine.id);
                      return (
                        <tr key={domaine.id} className="border-t border-[var(--g3-border)]">
                          <td className="py-1.5 pr-3 font-medium">{domaine.label}</td>
                          <td className="py-1.5 pr-3 text-[var(--g3-muted)]">
                            {d ? `${formatM(d.echantillons)} M` : "—"}
                          </td>
                          <td className="py-1.5 pr-3 text-[var(--g3-muted)]">{d ? `×${d.gainTrace.toFixed(2).replace(".", ",")}` : "—"}</td>
                          <td className="py-1.5 pr-3 text-[var(--g3-muted)]">{d ? `×${d.gainGeneralisation.toFixed(2).replace(".", ",")}` : "—"}</td>
                          <td className="py-1.5">
                            {d ? (
                              d.assimile ? (
                                <span className="rounded-full border border-[var(--g3-border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--g3v6-spike-text)]">assimilé</span>
                              ) : (
                                <span className="rounded-full border border-[var(--g3-border)] px-2 py-0.5 text-[11px] text-[var(--g3-muted)]">gain faible — rapporté tel quel</span>
                              )
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-[var(--g3-faint)]">
                Artefact cortical committé (amorçage production) :{" "}
                {masse.artefactCortical.present && masse.artefactCortical.tailleOctets !== null
                  ? `${(masse.artefactCortical.tailleOctets / 1e6).toFixed(1).replace(".", ",")} Mo — chargé au démarrage si aucun état local plus récent`
                  : "absent — le cortex de production démarre à neuf"}
                . 19 domaines répartis sur 8 bandes-porteuses du vocabulaire fréquentiel (bandes partagées : la
                discrimination mesurée est celle de la bande).
              </p>
            </>
          ) : (
            <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-[var(--g3-muted)]">
              Aucune campagne massive committée à ce jour — cette section affichera les résultats mesurés
              (échantillons réellement traités, gains de sonde, artefact cortical) dès qu&apos;un rapport de campagne
              sera livré avec le dépôt.
            </p>
          )}
        </section>

        {/* Piste d'action — entraînement + vérification */}
        <section className="g3v6-card p-5">
          <h2 className="text-sm font-bold">Comment gen3 apprend ces domaines</h2>
          <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-[var(--g3-muted)]">
            Le pré-entraînement par ondes (méthode EOD) stimule le cortex columnnaire de 1 048 576 colonnes :
            chaque texte d&apos;un domaine devient une onde (fréquence, phase, amplitude), la colonne est dérivée
            de cette onde, puis la plasticité consolide la bande-porteuse du domaine sur le bus inter-régions.
            La session est mesurée honnêtement : échantillons traités, résonance par domaine, paquets émis,
            renforts/annulations et métabolisme réel du substrat.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/neural"
              className="rounded-xl bg-[var(--g3-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--g3-primary-strong)]"
            >
              Ouvrir la console neuronale (pré-entraînement par ondes)
            </Link>
            <Link
              href="/faq"
              className="rounded-xl border border-[var(--g3-border)] px-4 py-2.5 text-sm text-[var(--g3-muted)] transition hover:bg-[var(--g3-hover)]"
            >
              Questions fréquentes sur la plateforme
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

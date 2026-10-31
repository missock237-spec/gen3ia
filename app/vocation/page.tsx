import type { Metadata } from "next";
import Link from "next/link";

import {
  DOMAINES_VOCATION,
  MISSION_GEN3,
  NB_DOMAINES_VOCATION,
} from "@/lib/gen3/vocation";

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
 * Composant serveur PUR : la charte est un module statique zéro IO
 * (lib/gen3/vocation.ts) — aucun fetch, aucune donnée utilisateur,
 * aucun secret. Page publique (la vocation est une promesse publique).
 * Le pré-entraînement par ondes correspondant (méthode EOD it.57) est
 * pilotable depuis la console /neural (onglet Entraînement — it.62).
 */

export const metadata: Metadata = {
  title: "La vocation de gen3 — les 19 domaines | Gen3ia",
  description:
    "Gen3, moteur neuronal local de Gen3ia, a été créé pour exécuter des tâches dans 19 domaines : recherche web, analyse de données, génération de code, médecine, droit, cybersécurité et plus. Charte complète, tâches et outils réels.",
};

export default function PageVocation() {
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

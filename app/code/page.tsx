import type { Metadata } from "next";
import Link from "next/link";

import CortexWebdevEmbarque from "@/components/neural/cortex-webdev-embarque";
import WebdevGenerateur from "@/components/neural/webdev-generateur";

/**
 * /code — GEN3 DÉVELOPPEMENT WEB (it.79 — demande propriétaire : « entraîne
 * gen3 dans le développement web : il doit pouvoir écrire du code, comprendre
 * puis simuler du code ; une fois terminé assure-toi qu'il est mis à la
 * disposition des utilisateurs sur le domaine en ligne »).
 *
 * Page PUBLIQUE (aucune donnée utilisateur, aucun secret) : le snapshot
 * binaire du cortex compact spécialisé (2^17 colonnes, poids quantifiés u8,
 * lecture seule) et la matière d'entraînement committée (traces exécutées)
 * sont chargés UNE FOIS (cacheables) puis tout tourne DANS le navigateur :
 * zéro requête serveur par exemple.
 *
 * Les 3 capacités entraînées : ÉCRIRE (instruction → code TypeScript
 * complet), COMPRENDRE (question + code → réponse exacte), SIMULER
 * (exécution pas à pas — sorties et traces MESURÉES à la génération, la
 * page n'évalue aucun code, CSP sans unsafe-eval).
 *
 * Composant serveur : coquille statique ; toute l'exécution est client.
 */

export const metadata: Metadata = {
  title: "gen3 développement web — écrire, comprendre, simuler du code | Gen3ia",
  description:
    "Le cortex columnnaire compact spécialisé de gen3 (campagne it.79 : écrire, comprendre et simuler du code) tourne directement dans votre navigateur : code réel, réponses exactes, traces d'exécution mesurées — zéro requête serveur par exemple.",
};

export default function PageCode() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6">
        {/* En-tête */}
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-widest text-[var(--g3-accent, #6c7bff)]">
            Développement web — it.79
          </p>
          <h1 className="text-2xl font-semibold sm:text-3xl">
            gen3 développement web — écrire, comprendre, simuler du code
          </h1>
          <p className="text-sm leading-relaxed text-[var(--g3-muted, #8b8b9e)]">
            Campagne d&apos;entraînement 100 % locale (graine 42, zéro service IA externe) : 120 000 exemples code
            vus sur un corpus de 160 000 uniques en cette session (objectif déclaré : 1 milliard d&apos;exemples /
            1 million de datasets — poursuivi par checkpoints), matière réelle du dépôt
            (<code>datasets/code</code>, 12 000 exemples) + corpus procédural de fonctions web réelles. Le snapshot
            spécialisé (~1,5 Mo, poids u8) se charge une fois puis <strong>chaque exemple est traité localement</strong>.
          </p>
        </header>

        {/* Moteur embarqué + les 3 capacités */}
        <CortexWebdevEmbarque />

        {/* Générateur sur demande — créer un site / une app (it.80) */}
        <WebdevGenerateur />

        {/* Honnêteté */}
        <section className="rounded-xl border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-card, #14141b)] p-5 text-sm leading-relaxed">
          <h2 className="text-base font-semibold">Ce que gen3 sait faire ici — et ce qu&apos;il ne fait pas</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--g3-muted, #8b8b9e)]">
            <li>
              <strong>Écrire</strong> : des fonctions TypeScript complètes, typées, avec garde de cas limite — issues
              de la matière committée (12 gabarits × paramètres métier, bijection index→exemple).
            </li>
            <li>
              <strong>Comprendre</strong> : but, signature, paramètres, cas limite et contexte technique d&apos;un
              code — réponses exactes dérivées des métadonnées des gabarits d&apos;entraînement.
            </li>
            <li>
              <strong>Simuler</strong> : exécution pas à pas de fonctions pures (somme, max, fibonacci, dichotomie,
              exponentiation rapide…) — sorties et traces <strong>mesurées par exécution réelle</strong> à la
              génération, vérifiées par la garde 47ᵉ (ré-exécution).
            </li>
            <li>
              <strong>Créer un site / une app</strong> (it.80) : décrivez votre demande (vitrine, liste,
              formulaire, panier, rendez-vous, blog + nom, contexte, options) — gen3 compose un module
              TypeScript/TSX complet, déterministe, copiable — <strong>dans le cadre appri</strong> (6 familles
              paramétrées, suite de la matière it.79) ; le SNN embarqué mesure la résonance de votre demande.
            </li>
            <li>
              <strong>Ce que gen3 ne fait pas ici</strong> : inventer du code hors matière (le cadre appris est
              celui de la campagne it.79 et des familles paramétrées it.80), ni évaluer du code dans votre
              navigateur (CSP sans unsafe-eval) ;
              la qualité de conversation générale reste le rôle du service complet (/chat).
            </li>
          </ul>
        </section>

        {/* Liens */}
        <nav className="flex flex-wrap gap-4 text-sm">
          <Link className="text-[var(--g3-accent, #6c7bff)] underline-offset-4 hover:underline" href="/vocation">
            ← La charte de vocation de gen3 (dont « Génération de code »)
          </Link>
          <Link className="text-[var(--g3-accent, #6c7bff)] underline-offset-4 hover:underline" href="/mobile">
            gen3 embarqué — les 19 domaines sur votre téléphone
          </Link>
          <Link className="text-[var(--g3-accent, #6c7bff)] underline-offset-4 hover:underline" href="/">
            Retour à l&apos;accueil
          </Link>
        </nav>
      </div>
    </div>
  );
}

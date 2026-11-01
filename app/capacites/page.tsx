import type { Metadata } from "next";
import Link from "next/link";

import { VitrineHeader } from "@/components/home/vitrine-header";
import { SITE_URL } from "@/lib/geo/content";
import { getNeuralRuntime } from "@/lib/neural/runtime";

/**
 * CAPACITÉS ET LIMITES — page de transparence générée depuis l'état RÉEL
 * du moteur à chaque chargement (demande propriétaire, audit du 2 nov. 2026 :
 * « le README vante 91+ paires » alors que le corpus vit — le chiffre
 * affiché ici est relu dans le runtime, jamais écrit en dur).
 *
 * Règle d'honnêteté : si une source est indisponible, la section le dit
 * (« indisponible ») au lieu d'afficher un chiffre périmé ou fabriqué.
 */

export const dynamic = "force-dynamic";

const PAGE_URL = `${SITE_URL}/capacites`;

export const metadata: Metadata = {
  title: "Capacités et limites",
  description:
    "Ce que Gen3ia sait faire aujourd'hui, mesuré en direct sur le moteur réel : corpus langagier, auto-apprentissage, neurones et synapses — et ses limites, dites franchement.",
  alternates: { canonical: "/capacites" },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    siteName: "Gen3ia",
    title: "Gen3ia — Capacités et limites (mesurées en direct)",
    description:
      "Les capacités réelles du moteur Gen3 (corpus, apprentissage, architecture) et ses limites assumées — chiffres relus dans le runtime à chaque visite.",
    locale: "fr_FR",
    images: [{ url: "/og-image.png", width: 1312, height: 736, alt: "Gen3ia — Capacités et limites" }],
  },
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": `${PAGE_URL}#webpage`,
      url: PAGE_URL,
      inLanguage: "fr",
      isPartOf: { "@id": `${SITE_URL}/#website` },
      name: "Gen3ia — Capacités et limites",
      description:
        "État réel du moteur Gen3 : corpus langagier, auto-apprentissage, architecture neuronale — et les limites, dites franchement.",
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Accueil", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Capacités et limites", item: PAGE_URL },
      ],
    },
  ],
};

/** Mesure brute relue du runtime — en cas d'échec, l'état est dit indisponible. */
function lireEtatMoteur() {
  try {
    const runtime = getNeuralRuntime();
    const stats = runtime.reseau.getStats();
    const etatV2 = runtime.cortexV2 ? runtime.cortexV2.etatPourApi() : null;
    return {
      disponible: true as const,
      paires: runtime.cortex.nbPaires,
      vocabulaire: runtime.cortex.tailleVocabulaire,
      themes: runtime.cortex.themes(),
      pairesPersonnalisees: runtime.cortex.compterPersonnalisees(),
      neurones: stats.nbNeurones,
      synapses: stats.nbSynapses,
      mode: runtime.noyau.metriquesSante.modeActuel,
      cycles: runtime.noyau.metriquesSante.cyclesTotaux,
      cortexV2: etatV2
        ? { colonnes: etatV2.cortex.colonnes, aretes: etatV2.cortex.aretes }
        : null,
    };
  } catch {
    return { disponible: false as const };
  }
}

type EtatMoteur = ReturnType<typeof lireEtatMoteur>;

const LIMITES = [
  {
    titre: "Le moteur répond en français, depuis un corpus local",
    texte:
      "Le cortex langagier est entraîné sur un corpus français appris — aucune API d'IA externe n'est appelée. Hors du corpus et des thèmes appris, Gen3ia le dit au lieu d'inventer : sous le seuil d'appariement, la réponse honnête est « je ne sais pas encore ».",
  },
  {
    titre: "Les capacités affichées sont celles du moment",
    texte:
      "Le corpus vit (auto-apprentissage, Studio d'entraînement, paires personnalisées). Cette page relit le runtime à chaque chargement : le chiffre que vous lisez est l'état réel du moteur qui sert vos requêtes, pas une fiche commerciale.",
  },
  {
    titre: "La personnalisation est isolée par compte",
    texte:
      "Les paires enseignées via le Studio d'entraînement sont attachées à votre compte et ne fuient pas vers les autres utilisateurs. Les chiffres publics de cette page ne contiennent aucune donnée personnelle.",
  },
  {
    titre: "L'auto-apprentissage progresse domaine par domaine",
    texte:
      "La boucle autonome ingère des datasets publics (Hugging Face, Kaggle) et mesure sa précision par domaine. Un domaine « en cours » n'est pas un domaine maîtrisé : les deux états sont affichés séparément.",
  },
];

export default function CapacitesPage() {
  const etat: EtatMoteur = lireEtatMoteur();

  const chiffres = [
    {
      label: "Paires conversationnelles apprises",
      valeur: etat.disponible ? etat.paires.toLocaleString("fr-FR") : "indisponible",
    },
    {
      label: "Tokens de vocabulaire indexés",
      valeur: etat.disponible ? etat.vocabulaire.toLocaleString("fr-FR") : "indisponible",
    },
    {
      label: "Thèmes couverts",
      valeur: etat.disponible ? etat.themes.length.toLocaleString("fr-FR") : "indisponible",
    },
    {
      label: "Paires personnalisées (comptes)",
      valeur: etat.disponible ? etat.pairesPersonnalisees.toLocaleString("fr-FR") : "indisponible",
    },
    {
      label: "Neurones (réseau v1)",
      valeur: etat.disponible ? etat.neurones.toLocaleString("fr-FR") : "indisponible",
    },
    {
      label: "Synapses",
      valeur: etat.disponible ? etat.synapses.toLocaleString("fr-FR") : "indisponible",
    },
  ];

  return (
    <div className="g3-noise flex min-h-full flex-col bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <VitrineHeader />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      <div className="flex-1">
        <section className="sky-hero relative overflow-hidden">
          <div className="aurora" aria-hidden="true" />
          <div className="aurora-glow" aria-hidden="true" />
          <div className="relative mx-auto max-w-4xl px-4 pb-14 pt-20 sm:px-6 sm:pt-24">
            <nav aria-label="Fil d'Ariane" className="mb-8 text-xs text-[var(--g3-faint)]">
              <Link href="/" className="transition hover:text-[var(--g3-primary-strong)]">Accueil</Link>
              <span className="mx-2" aria-hidden>/</span>
              <span className="text-[var(--g3-muted)]">Capacités et limites</span>
            </nav>
            <p className="g3-eyebrow">TRANSPARENCE</p>
            <h1 className="mt-4 font-[family-name:var(--font-display)] text-4xl font-bold tracking-tight sm:text-6xl">
              Capacités et <span className="gradient-text">limites</span>
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-8 text-[var(--g3-text-secondary)]">
              Ce que Gen3ia sait faire aujourd&apos;hui — <strong className="text-[var(--g3-text)]">mesuré en
              direct sur le moteur qui sert vos requêtes</strong>. Cette page est régénérée à chaque
              chargement : aucun chiffre commercial figé, aucune promesse non mesurée.
            </p>
          </div>
        </section>

        {/* ---------- Chiffres réels (runtime) ---------- */}
        <section aria-label="Capacités mesurées" className="mx-auto max-w-4xl px-4 pb-12 sm:px-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {chiffres.map((c) => (
              <div
                key={c.label}
                className="rounded-2xl border border-[var(--g3-primary-soft)] bg-[var(--g3-surface)]/80 p-5 backdrop-blur"
              >
                <p className="font-[family-name:var(--font-display)] text-2xl font-bold text-[var(--g3-primary-strong)]">
                  {c.valeur}
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">{c.label}</p>
              </div>
            ))}
          </div>
          {etat.disponible ? (
            <p className="mt-3 text-xs leading-6 text-[var(--g3-faint)]">
              Relevé du runtime au chargement de cette page — mode du noyau :{" "}
              <strong className="text-[var(--g3-muted)]">{etat.mode}</strong>
              {etat.cycles > 0 ? ` · ${etat.cycles.toLocaleString("fr-FR")} cycles de santé` : ""}
              {etat.cortexV2
                ? ` · cortex v2 : ${etat.cortexV2.colonnes.toLocaleString("fr-FR")} colonnes / ${etat.cortexV2.aretes.toLocaleString("fr-FR")} arêtes`
                : " · cortex v2 : désactivé sur ce déploiement"}
              .
            </p>
          ) : (
            <p className="mt-3 text-xs leading-6 text-[var(--g3-faint)]">
              Le moteur est momentanément indisponible sur ce déploiement : plutôt que d&apos;afficher
              un chiffre périmé, cette page l&apos;assume. Réessayez dans un instant ou consultez{" "}
              <Link href="/status" className="underline decoration-dotted">l&apos;état du service</Link>.
            </p>
          )}
        </section>

        {/* ---------- Thèmes réellement couverts ---------- */}
        {etat.disponible && etat.themes.length > 0 && (
          <section aria-label="Thèmes couverts par le corpus" className="mx-auto max-w-4xl px-4 pb-12 sm:px-6">
            <h2 className="font-[family-name:var(--font-display)] text-xl font-bold">
              Thèmes réellement couverts par le corpus
            </h2>
            <p className="mt-2 text-sm leading-7 text-[var(--g3-muted)]">
              Liste dérivée des paires indexées dans le cortex langagier — pas d&apos;une fiche
              rédigée à la main. Si un thème n&apos;y figure pas, Gen3ia ne prétend pas le couvrir.
            </p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {etat.themes.map((theme) => (
                <li
                  key={theme}
                  className="rounded-full border border-[var(--g3-primary-border)] bg-white/[0.04] px-4 py-1.5 text-sm text-[var(--g3-text-secondary)]"
                >
                  {theme}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ---------- Limites ---------- */}
        <section aria-label="Limites assumées" className="mx-auto max-w-4xl px-4 pb-12 sm:px-6">
          <h2 className="font-[family-name:var(--font-display)] text-xl font-bold">
            Les limites, dites franchement
          </h2>
          <div className="mt-4 space-y-3">
            {LIMITES.map((l) => (
              <div
                key={l.titre}
                className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-deep)]/60 p-5"
              >
                <p className="font-[family-name:var(--font-display)] text-base font-semibold text-[var(--g3-text)]">
                  {l.titre}
                </p>
                <p className="mt-2 text-sm leading-7 text-[var(--g3-muted)]">{l.texte}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---------- Recroisements ---------- */}
        <section className="mx-auto max-w-4xl px-4 pb-20 sm:px-6">
          <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-[var(--g3-primary-soft)] bg-[var(--g3-surface)]/80 p-6 sm:flex-row sm:items-center">
            <p className="text-sm leading-6 text-[var(--g3-muted)]">
              Envie de vérifier par vous-même ? Testez le chat, explorez le cerveau en direct ou
              consultez l&apos;état du service.
            </p>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Link
                href="/chat"
                className="rounded-full border border-[var(--g3-primary-border)] bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-[var(--g3-text-secondary)] transition hover:border-[var(--g3-primary)] hover:text-white"
              >
                Tester le chat
              </Link>
              <Link
                href="/neural"
                className="rounded-full border border-[var(--g3-primary-border)] bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-[var(--g3-text-secondary)] transition hover:border-[var(--g3-primary)] hover:text-white"
              >
                Cerveau en direct
              </Link>
              <Link
                href="/status"
                className="rounded-full border border-[var(--g3-primary-border)] bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-[var(--g3-text-secondary)] transition hover:border-[var(--g3-primary)] hover:text-white"
              >
                État du service
              </Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import CortexTelephoneEmbarque from "@/components/neural/cortex-telephone-embarque";

/**
 * /mobile — GEN3 EMBARQUÉ DANS LE TÉLÉPHONE (it.73 — demande propriétaire :
 * « cherche un moyen de diminuer la consommation d'énergie de gen3 tout en
 * gardant sa qualité de réponse et son efficacité pour que gen3 puisse
 * fonctionner même sur un téléphone tout en gardant sa qualité de
 * compétences »).
 *
 * Page PUBLIQUE (aucune donnée utilisateur, aucun secret) : le snapshot
 * binaire du cortex compact (2^17 colonnes, poids quantifiés u8 — erreur
 * ≤ 1/510 mesurée, lecture seule) est chargé UNE FOIS (cacheable) puis le
 * SNN tourne DANS le navigateur : zéro requête serveur par question.
 *
 * QUALITÉ CONSERVÉE PAR CONSTRUCTION : les réponses viennent du même pont
 * vocation que la production (fonction pure, même charte des 19 domaines) ;
 * la quantification u8 ne change AUCUNE sonde (accord 342/342 mesuré par la
 * campagne committée `cortex-telephone-it73.json` — garde 42ᵉ).
 *
 * Composant serveur : coquille statique ; toute l'exécution est client.
 */

export const metadata: Metadata = {
  title: "gen3 embarqué — SNN compact sur votre téléphone | Gen3ia",
  description:
    "Le cortex columnnaire compact de gen3 (2^17 colonnes, poids quantifiés u8, lecture seule) tourne directement dans votre navigateur : réponses depuis la charte des 19 domaines, zéro requête serveur par question, mémoire mesurée ~9 Mo.",
};

export default function PageMobile() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6">
        {/* En-tête */}
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-widest text-[var(--g3-accent, #6c7bff)]">
            Sobriété énergétique — it.73
          </p>
          <h1 className="text-2xl font-semibold sm:text-3xl">
            gen3 embarqué — le SNN compact tourne sur votre téléphone
          </h1>
          <p className="text-sm leading-relaxed text-[var(--g3-muted, #8b8b9e)]">
            Même mécanique que le cortex de production (accumulate-and-fire, CSR événementiel, décroissance
            paresseuse exacte, structure partagée bit à bit), sous la configuration de sobriété embarquée :{" "}
            <strong>2^17 colonnes</strong> (131 072), <strong>poids quantifiés u8</strong> (erreur ≤ 1/510 par
            poids, mesurée), <strong>horloges u32</strong>, <strong>lecture seule</strong>. La mémoire résidente
            mesurée est ~9 Mo au lieu de ~122 Mo (÷ 13) — et chaque question est traitée LOCALEMENT : zéro requête
            serveur après le chargement du snapshot (téléchargement unique de ~1,5 Mo, mis en cache par votre
            navigateur).
          </p>
        </header>

        {/* Moteur embarqué + testeur local */}
        <CortexTelephoneEmbarque />

        {/* Honnêteté */}
        <section className="rounded-xl border border-[var(--g3-border, #2a2a35)] bg-[var(--g3-card, #14141b)] p-5 text-sm leading-relaxed">
          <h2 className="text-base font-semibold">Honnêteté de mesure</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--g3-muted, #8b8b9e)]">
            <li>
              Les réponses viennent du <strong>même pont lexical que la production</strong> (fonction pure exécutée
              côté serveur sur /vocation et /api/neural/questions) : la qualité de réponse est conservée par
              construction — même charte, même détection, même composition.
            </li>
            <li>
              La quantification u8 est <strong>mesurée, pas supposée</strong> : la campagne committée
              (<code>assets/neural-pretrained/cortex-telephone-it73.json</code>) montre un accord d&apos;argmax de{" "}
              <strong>342/342 sondes</strong> entre les poids f32 et les poids u8, et un signal appris présent dans{" "}
              <strong>19/19 domaines</strong> (ratio d&apos;activation bande-porteuse entraîné/neuf 1,24–2,50).
            </li>
            <li>
              Le moteur embarqué est en <strong>lecture seule</strong> : le téléphone répond, il ne s&apos;entraîne
              pas — l&apos;apprentissage reste un rôle du serveur (c&apos;est lui qui produit les snapshots entraînés).
            </li>
            <li>
              La lecture des bandes est une lecture d&apos;<strong>ondes</strong> (8 bandes-porteuses, 19 domaines
              répartis par hash — des domaines partagent une bande) : ce n&apos;est pas une détection de domaine.
            </li>
          </ul>
        </section>

        {/* Liens */}
        <nav className="flex flex-wrap gap-4 text-sm">
          <Link className="text-[var(--g3-accent, #6c7bff)] underline-offset-4 hover:underline" href="/vocation">
            ← La charte de vocation de gen3 (les 19 domaines)
          </Link>
          <Link className="text-[var(--g3-accent, #6c7bff)] underline-offset-4 hover:underline" href="/">
            Retour à l&apos;accueil
          </Link>
        </nav>
      </div>
    </div>
  );
}

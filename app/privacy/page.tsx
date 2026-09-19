import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Politique de confidentialité — Gen3ia",
  description:
    "Comment Gen3ia collecte, utilise, conserve et supprime vos données personnelles (RGPD).",
};

const SECTIONS: Array<{ title: string; body: string[] }> = [
  {
    title: "1. Responsable du traitement",
    body: [
      "Gen3ia (« la plateforme ») est exploitée par l'éditeur du service, joignable via l'adresse de contact indiquée sur la page de connexion. Le responsable du traitement détermine les finalités et les moyens des traitements décrits dans la présente politique.",
      "Pour toute question relative à vos données personnelles, ou pour exercer vos droits, écrivez à l'adresse de contact depuis l'email avec lequel vous vous êtes inscrit : votre demande sera traitée dans un délai maximum de trente (30) jours.",
    ],
  },
  {
    title: "2. Données collectées",
    body: [
      "Compte : lors de l'inscription (email/mot de passe, Google ou GitHub), nous collectons votre identifiant, votre adresse email, votre nom d'affichage et, le cas échéant, votre photo de profil. Ces données servent à vous authentifier et à personnaliser l'interface.",
      "Contenus d'usage : les objectifs de missions que vous saisissez, les conversations avec vos agents, les fichiers que vous déposez, les plans d'exécution produits et les artefacts générés (documents, images, interfaces) sont stockés pour vous permettre de retrouver votre travail.",
      "Facturation : votre portefeuille (solde, réservations, consommations) et, en cas de rechargement via notre partenaire Chariow, les références de transaction nécessaires à la traçabilité comptable. Gen3ia ne stocke jamais vos coordonnées bancaires.",
      "Sécurité : les actions sensibles des agents (exécutions d'outils, contrôles de l'Agent Live, arrêts d'urgence) sont journalisées dans un registre d'audit dont les champs sensibles sont anonymisés automatiquement.",
    ],
  },
  {
    title: "3. Finalités et bases légales",
    body: [
      "Fournir le service (exécution du contrat) : authentification, exécution de vos missions, conservation de vos artefacts et de votre historique.",
      "Sécurité et prévention des abus (intérêt légitime) : limitation de débit, journalisation des actions critiques, détection d'anomalies de facturation.",
      "Obligations légales et comptables : conservation des enregistrements de transaction, réponse aux requêtes des autorités compétentes.",
    ],
  },
  {
    title: "4. Sous-traitants et transferts",
    body: [
      "Firebase (Google) : authentification et bases de données. Les identifiants de connexion et le contenu applicatif transitent par l'infrastructure Google Cloud.",
      "Chariow : traitement des paiements de rechargement de portefeuille. Les informations de paiement sont traitées directement par le prestataire.",
      "Fournisseurs d'IA : vos demandes sont transmises aux fournisseurs de modèles (OpenAI, Anthropic, Groq, OpenRouter, Google, Hugging Face) strictement nécessaires à l'exécution de vos missions. Nous ne leur transmettons ni votre mot de passe ni vos moyens de paiement.",
      "Twilio / Plivo : lorsqu'un agent téléphonique est activé, le numéro attribué et les échanges vocaux transitent par le prestataire de téléphonie choisi.",
    ],
  },
  {
    title: "5. Durées de conservation",
    body: [
      "Données de compte et contenus d'usage : conservées tant que votre compte est actif, puis supprimées à la suppression du compte (voir section 7).",
      "Journaux d'audit de sécurité : conservés pour une durée limitée au besoin probatoire, sans données d'authentification associées après effacement du profil.",
      "Enregistrements de facturation : conservés conformément aux obligations comptables applicables.",
    ],
  },
  {
    title: "6. Vos droits",
    body: [
      "Conformément au RGPD, vous disposez des droits d'accès, de rectification, d'effacement, de limitation, d'opposition et de portabilité de vos données.",
      "L'exercice du droit à l'effacement est immédiat et automatisé : la suppression de votre compte (section 7) entraîne l'effacement de vos contenus et de votre profil sans intervention humaine.",
    ],
  },
  {
    title: "7. Suppression du compte",
    body: [
      "Vous pouvez supprimer votre compte à tout moment depuis le menu de compte de la plateforme (« Supprimer le compte »). La suppression est définitive et couvre : profil, portefeuille, agents, exécutions, documents, conversations et équipe.",
      "Cette action est irréversible. Exportez vos artefacts importants avant de procéder. Une trace d'audit anonyme de l'opération est conservée à des fins de sécurité.",
    ],
  },
  {
    title: "8. Cookies",
    body: [
      "Gen3ia dépose un unique cookie strictement nécessaire : `gen3ia_session`, un cookie signé (HMAC, httpOnly) qui maintient votre session ouverte pendant 30 jours. Aucun cookie publicitaire ni de mesure d'audience tierce n'est déposé.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-10 md:py-14">
      <p className="g3-eyebrow">Conformité RGPD</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">
        Politique de confidentialité
      </h1>
      <p className="mt-3 text-sm leading-6 text-neutral-500">
        Dernière mise à jour : septembre 2026. La présente politique décrit
        comment vos données personnelles sont collectées, utilisées et
        protégées lorsque vous utilisez Gen3ia.
      </p>

      <div className="mt-8 space-y-8">
        {SECTIONS.map((section) => (
          <section key={section.title} aria-labelledby={section.title.replace(/[^a-zA-Z0-9]/g, "-")}>
            <h2 id={section.title.replace(/[^a-zA-Z0-9]/g, "-")} className="text-lg font-bold">
              {section.title}
            </h2>
            <div className="mt-2 space-y-3">
              {section.body.map((paragraph, index) => (
                <p key={index} className="text-sm leading-7 text-neutral-700">
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-10 text-sm text-neutral-500">
        Une question sur vos données ?{" "}
        <Link href="/dashboard" className="font-semibold text-[var(--gen3ia-sky)] underline underline-offset-2">
          Revenir à votre espace
        </Link>
        .
      </p>
    </div>
  );
}

import { NextResponse } from "next/server";

/**
 * GET /api/v1/capabilities — inventaire HONNÊTE des capacités de gen3ia.
 *
 * Règle d'or commerciale (déjà validée) : ne présenter que ce qui tourne
 * réellement. Endpoint public (aucune clé requise — métadonnées, aucune
 * donnée utilisateur), consommable par le SDK et les intégrations pour
 * adapter leurs appels sans supposition.
 *
 * MODÈLE ÉCONOMIQUE : portefeuille (wallet) au réel — PAS d'abonnement.
 */
export const runtime = "nodejs";

export function GET() {
  const billingEnabled = process.env.GEN3IA_BILLING_ENABLED === "true";

  return NextResponse.json(
    {
      plateforme: "gen3ia",
      version_api: "v1",
      modele_economique: {
        type: "wallet",
        abonnement: false,
        note: billingEnabled
          ? "Facturation au portefeuille, au réel (tokens mesurés : 1,00 €/1M entrant, 1,50 €/1M sortant)."
          : "Mode libre actif : consommation non débitée tant que la facturation n'est pas armée.",
      },
      capacites: [
        {
          id: "chat",
          nom: "Chat gen3 (moteur neuronal + modulation RPIA)",
          etat: "actif",
          endpoint: "POST /api/v1/chat",
          auth: "Bearer g3a_… + X-Gen3ia-Project-Id",
          facturation: "wallet (tokens mesurés)",
        },
        {
          id: "documents",
          nom: "Rédaction et analyse de documents",
          etat: "actif",
          endpoint: "interface web /chat (génération de livrables internes)",
          auth: "session utilisateur",
          facturation: "wallet (exécutions réelles)",
        },
        {
          id: "agents",
          nom: "Système multi-agents (essaim)",
          etat: "reserve_ia",
          note: "Actionnable uniquement par l'IA de gen3ia à la demande d'un utilisateur (sécurité n°5) — non appelable directement par clé.",
          endpoint: null,
          auth: null,
          facturation: "wallet (exécutions réelles via chat)",
        },
        {
          id: "live",
          nom: "Agent live (voix + vision temps réel)",
          etat: "actif",
          endpoint: "interface web /live (sessions temps réel)",
          auth: "session utilisateur",
          facturation: "wallet (sessions réelles)",
        },
        {
          id: "entrainement",
          nom: "Entraînement d'IA (studio + worker GPU)",
          etat: "actif",
          endpoint: "interface web /neural (studio) + /api/training/*",
          auth: "session utilisateur",
          facturation: "wallet (jobs réels, worker GPU requis)",
        },
        {
          id: "media",
          nom: "Génération images / audio / vidéo",
          etat: "actif",
          endpoint: "interface web (atelier média du cerveau + studio)",
          auth: "session utilisateur",
          facturation: "wallet (médias réels)",
        },
        {
          id: "wallet",
          nom: "Portefeuille (solde, réserves, disponible)",
          etat: "actif",
          endpoint: "GET /api/v1/wallet",
          auth: "Bearer g3a_… + X-Gen3ia-Project-Id",
          facturation: "gratuit (consultation)",
        },
      ],
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}

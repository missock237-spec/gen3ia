# Grille tarifaire Gen3ia — paiements Chariow

Intégration « prête à l'emploi » des quatre offres officielles via la boutique
Chariow [Gen3ia](https://xdaagetk.mychariow.shop). Chaque visite de paiement
créée par la plateforme est rattachée à Gen3ia (métadonnées + redirection +
origine déclarée), et le webhook Pulse active l'offre automatiquement après
paiement.

## 1. Les quatre offres

| Offre | Tarif | Produit Chariow | Fonctionnalités ouvertes |
|---|---|---|---|
| **Plan Gratuit** | 0 FCFA (0 €) | — (inclus par défaut) | Micro-agents standards, inférence de base via l'essaim P2P public, contribution passive |
| **Plan Pro** | 9 750 FCFA (≈ 15 €) / mois | `prd_svqonju7` (« Plan pro », boutique) | Agent Master + modules d'apprentissage, priorité de calcul P2P, RAG local chiffré, API datasets |
| **Plan Entreprise** | 328 000 FCFA (≈ 500 €) / mois | à créer (dashboard) | IA 100 % locale et décentralisée (Private Mesh), confidentialité totale, support prioritaire, clé multi-postes, tout le Pro |
| **Modèle Sur-Mesure** | 3 280 000 FCFA (≈ 5 000 €) / modèle | à créer (dashboard) | Entraînement d'un modèle/agent dédié dans l'Arène Virtuelle d'Ondes, traduction & correction symbolique, livraison clé en main en paquet d'ondes |

La devise de facturation est le **XAF**, identique au portefeuille
(`GEN3IA_WALLET_CURRENCY=XAF`). La parité EUR→XAF est fixe
(1 EUR = 655,957 XAF, surchargeable via `CHARIOW_EUR_XAF_RATE`).

## 2. Architecture des flux

```
A. Checkout depuis la plateforme (/billing)
   Utilisateur → POST /api/billing/plans/checkout
     → POST api.chariow.com/v1/checkout (custom_metadata:
        gen3ia_product=plan_subscription, plan_id, user_id ;
        redirect_url=/billing?plan=success ; embed_origins=domaine)
     → page de paiement Chariow (Mobile Money, carte…)
     → webhook Pulse successful.sale → /api/webhooks/chariow
     → activation du plan (userPlans/{uid}, journal planActivations/plan_{saleId})

B. Licence achetée sur la boutique publique
   Achat → clé de licence reçue → /billing « Activer une licence »
     → POST /api/billing/plans/licence
     → GET api.chariow.com/v1/licenses/{key} (statut, produit)
     → POST api.chariow.com/v1/licenses/{key}/activate (instance gen3ia:{uid})
     → activation du plan (journal planActivations/licence_{key})
```

Deux barrières d'idempotence protègent la facturation : le journal
`planActivations` (une vente ou une licence ne prolonge jamais deux fois
l'accès) et l'empilement des fenêtres (un renouvellement anticipé ajoute
30 jours à la fin de la fenêtre courante, pas au jour du paiement). Les plans
mensuels expirent après 30 jours avec 3 jours de grâce ; le Modèle Sur-Mesure
est un achat unitaire sans expiration.

## 3. Gating des fonctionnalités

`lib/billing/plans.ts` définit les entitlements, `lib/billing/abonnements.ts`
les fait respecter :

```ts
import { requirePlanEntitlement, hasPlanEntitlement } from "@/lib/billing/abonnements";

// Dans une route API :
await requirePlanEntitlement(userId, "private_mesh");   // lève si plan < Entreprise

// Dans une capacité (affichage, essaim) :
const meshPrive = await hasPlanEntitlement(userId, "private_mesh");
```

Entitlements : `micro_agents` (tous), `agent_master`, `apprentissage_modules`,
`p2p_priority`, `rag_chiffre`, `datasets_api` (Pro+), `private_mesh`,
`multi_postes`, `support_prioritaire` (Entreprise+), `arene_ondes`,
`paquet_ondes` (Sur-Mesure).

## 4. Mise en service (dashboard Chariow)

L'API publique Chariow est en lecture seule sur `/products` : la création et
la publication des produits se font dans le dashboard
[chariow.com](https://chariow.com) (boutique « Gen3ia », `store_o8bpv4c57c8j`).
Le script `scripts/chariow_plans_status.mjs` vérifie l'état à chaque étape :

```bash
CHARIOW_API_KEY=sk_… node scripts/chariow_plans_status.mjs
```

1. **Publier le produit « Plan pro »** (`prd_svqonju7`, actuellement en
   brouillon) : Produits → Plan pro → Publier. Prix 9 750 FCFA.
2. **Créer le produit « Plan Entreprise »** : type *Licence*, prix
   **328 000 FCFA**, description suggérée :
   > IA 100 % locale et décentralisée (Private Mesh) pour votre structure.
   > Confiance et confidentialité totale : aucune donnée ne sort de votre parc
   > informatique. Support prioritaire et clé de licence multi-postes.
   Puis reporter son ID public dans `CHARIOW_PLAN_ENTREPRISE_PRODUCT_ID`.
3. **Créer le produit « Modèle Sur-Mesure »** : type *Licence*, prix
   **3 280 000 FCFA**, description suggérée :
   > Entraînement complet d'un modèle/agent dédié dans l'Arène Virtuelle
   > d'Ondes de Gen3ia. Traduction et correction symbolique sur-mesure pour
   > vos besoins métiers. Livré clé en main sous forme de paquet d'ondes
   > autonome optimisé.
   Puis reporter son ID public dans `CHARIOW_PLAN_SUR_MESURE_PRODUCT_ID`.
4. **Configurer le webhook Pulse** : Développeur → Pulse → créer un webhook
   vers `https://<domaine-gen3ia>/api/webhooks/chariow`, événement
   **successful.sale**. Copier le secret de signature dans
   `CHARIOW_PULSE_SECRET` (le webhook vérifie la signature HMAC
   `x-chariow-signature` et rejette le reste).

## 5. Variables d'environnement (VPS)

```bash
CHARIOW_API_KEY=sk_…                        # clé API (Developpeur → API Keys)
CHARIOW_PULSE_SECRET=…                      # secret de signature du webhook Pulse
CHARIOW_PLAN_PRO_PRODUCT_ID=                # vide → produit boutique prd_svqonju7
CHARIOW_PLAN_ENTREPRISE_PRODUCT_ID=prd_…    # après création dashboard
CHARIOW_PLAN_SUR_MESURE_PRODUCT_ID=prd_…    # après création dashboard
CHARIOW_EUR_XAF_RATE=655.957                # parité fixe franc CFA
```

Tant qu'un produit n'est pas configuré, l'offre reste consultable sur
`/billing` mais le bouton de paiement affiche « Bientôt disponible » (HTTP 409
si appelée directement) — aucune vente ne peut aboutir sur un produit absent.

## 6. Rattachement de la plateforme aux visites de paiement

Chaque session créée par `createChariowPlanCheckout` porte trois preuves que
la visite provient de Gen3ia :

1. **`custom_metadata`** : `gen3ia_product=plan_subscription`, `plan_id`,
   `user_id` — repris tels quels dans le payload Pulse, le webhook sait quoi
   activer et pour qui ;
2. **`redirect_url`** : le client revient sur `/billing?plan=success&planId=…`
   après le paiement (sondage automatique de l'activation à 3 s / 9 s / 20 s) ;
3. **`embed_origins`** : l'origine HTTPS de la plateforme est déclarée à
   Chariow pour l'intégration de la page de paiement.

La même mécanique existe pour les recharges de portefeuille
(`wallet_topup`) et les achats d'extensions (`extension_purchase`) — les trois
types de ventes sont traités par le même webhook signé, avec dédoublonnement
par vente et reprise des livraisons échouées.

# Grille tarifaire Gen3ia — paiements Chariow

Intégration « prête à l'emploi » des quatre offres officielles via la boutique
Chariow [Gen3ia](https://xdaagetk.mychariow.shop). Chaque visite de paiement
créée par la plateforme est rattachée à Gen3ia (métadonnées + redirection +
origine déclarée), et le webhook Pulse active l'offre automatiquement après
paiement. Les **trois produits payants sont publiés dans la boutique** et
payables directement via les widgets officiels Chariow rendus sur `/billing`
(components/billing/chariow-widget.tsx).

## 1. Les quatre offres

| Offre | Tarif boutique (source de vérité) | Produit Chariow | Fonctionnalités ouvertes |
|---|---|---|---|
| **Plan Gratuit** | 0 FCFA (0 €) | — (inclus par défaut) | Micro-agents standards, inférence de base via l'essaim P2P public, contribution passive |
| **Plan Pro** | 9 750 FCFA (≈ 15 €) | `prd_svqonju7` (« Plan pro ») | Agent Master + modules d'apprentissage, priorité de calcul P2P, RAG local chiffré, API datasets |
| **Plan Entreprise** | 325 000 FCFA (≈ 495 €) | `prd_v76f5kjl` (« Plan entreprise ») | IA 100 % locale et décentralisée (Private Mesh), confidentialité totale, support prioritaire, clé multi-postes, tout le Pro |
| **Modèle Sur-Mesure** | 995 000 FCFA (≈ 1 517 €) | `prd_646qpmge` (« Entraînez vos modèles d'IA ») | Entraînement d'un modèle/agent dédié dans l'Arène Virtuelle d'Ondes, traduction & correction symbolique, livraison clé en main en paquet d'ondes |

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
30 jours à la fin de la fenêtre courante, pas au jour du paiement). Les trois
produits boutique sont des licences one_time : Pro et Entreprise ouvrent une
fenêtre de 30 jours par licence achetée (renouvelable), le Modèle Sur-Mesure
est sans expiration.

## 3. Widgets de paiement direct (boutique)

Sur `/billing`, la section « Paiement direct sur la boutique Chariow » rend les
trois widgets officiels (script `js.chariowcdn.com/v1/widget.min.js`, style
« tap », boutique `xdaagetk.mychariow.shop`) :

- `prd_svqonju7` → Plan Pro ;
- `prd_v76f5kjl` → Plan Entreprise ;
- `prd_646qpmge` → Modèle Sur-Mesure.

La carte « GEN3IA WALLET » rend en plus le widget de **recharge rapide du
portefeuille** (`prd_llfosdp1`, produit « Recharge Wallet API ») — voir
§8.

Le script Chariow scanne une seule fois tous les `#chariow-widget` du document :
le composant injecte le loader après le rendu (dédoublonné par micro-tâche) et
le réinjecte au remontage React pour rescanner. La CSP autorise
`js.chariowcdn.com` (script + style + frame) et `*.mychariow.shop`
(frame + connect) — rien d'autre n'est ouvert.

Après un paiement effectué via widget, la licence s'active soit
automatiquement (webhook Pulse, si l'acheteur est reconnu), soit en collant la
clé reçue dans le formulaire « Activer une licence » de `/billing`
(flux B ci-dessus).

## 4. Gating des fonctionnalités

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

## 5. Mise en service (dashboard Chariow)

L'API publique Chariow est en lecture seule sur `/products` : la création et
la publication des produits se font dans le dashboard
[chariow.com](https://chariow.com) (boutique « Gen3ia », `store_o8bpv4c57c8j`).
Le script `scripts/chariow_plans_status.mjs` vérifie l'état à chaque étape :

```bash
CHARIOW_API_KEY=sk_… node scripts/chariow_plans_status.mjs
```

État actuel (vérifié via GET /products) : les trois produits sont **publiés**
(`prd_svqonju7` 9 750 FCFA · `prd_v76f5kjl` 325 000 FCFA · `prd_646qpmge`
995 000 FCFA) et branchés par défaut dans `lib/billing/plans.ts` — aucune
variable d'environnement n'est requise pour vendre. Reste à configurer dans le
dashboard :

1. **Webhook Pulse** : Développeur → Pulse → créer un webhook
   vers `https://<domaine-gen3ia>/api/webhooks/chariow`, événement
   **successful.sale**. Copier le secret de signature dans
   `CHARIOW_PULSE_SECRET` (le webhook vérifie la signature HMAC
   `x-chariow-signature` et rejette le reste).
2. **Évolution des prix** : toute modification de prix se fait dans le
   dashboard Chariow (source de vérité du paiement) puis est répercutée dans
   `lib/billing/plans.ts` (affichage) — jamais l'inverse.

## 6. Variables d'environnement (VPS)

```bash
CHARIOW_API_KEY=sk_…                        # clé API (Developpeur → API Keys)
CHARIOW_PULSE_SECRET=…                      # secret de signature du webhook Pulse
CHARIOW_TOPUP_PRODUCT_ID=prd_llfosdp1       # défaut boutique → « Recharge Wallet API »
CHARIOW_TOPUP_STORE_URL=                    # optionnel : repli boutique affiché sur /billing
CHARIOW_PLAN_PRO_PRODUCT_ID=                # vide → produit boutique prd_svqonju7
CHARIOW_PLAN_ENTREPRISE_PRODUCT_ID=         # vide → produit boutique prd_v76f5kjl
CHARIOW_PLAN_SUR_MESURE_PRODUCT_ID=         # vide → produit boutique prd_646qpmge
CHARIOW_EUR_XAF_RATE=655.957                # parité fixe franc CFA
```

Les trois produits de grille et le produit de recharge étant branchés par
défaut, les variables `CHARIOW_PLAN_*` et `CHARIOW_TOPUP_PRODUCT_ID` sont
optionnelles : elles servent uniquement à pointer un produit de
remplacement (nouveau produit, test) sans redéploiement du code.

## 7. Rattachement de la plateforme aux visites de paiement

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

## 8. Recharge du wallet API — produit `prd_llfosdp1`

Le produit **« Recharge Wallet API »** (`prd_llfosdp1`, boutique
`xdaagetk.mychariow.shop`) alimente directement le solde du portefeuille
(`GEN3IA_WALLET_CURRENCY`, XAF par défaut). Il est rendu sur `/billing` dans
la carte « GEN3IA WALLET » (bloc « Recharge rapide du wallet ») via le même
composant `components/billing/chariow-widget.tsx` que la grille tarifaire —
aucun second mécanisme de widget.

**Montant libre (choix utilisateur)** : le produit est configuré en prix
libre côté Chariow — c'est l'utilisateur qui choisit le montant de sa
recharge sur la page de paiement (Mobile Money ou carte). Le webhook crédite
le **montant réel de la vente** (`payload.sale.amount.value` →
`amountMinor = Math.round(amount * 100)` → `applyTopup`), jamais un palier
prédéfini : aucun montant n'est imposé ni plafonné par le code. Seules
contraintes : devise de vente = devise wallet (XAF), statut créditable
(`CREDITABLE_STATUSES`), idempotence par `chariow_<saleId>`.

### Cycle d'un achat via le widget

```
Achat (widget « tap » prd_llfosdp1 sur la boutique)
  → page de paiement Chariow (Mobile Money, carte…)
  → webhook Pulse successful.sale → /api/webhooks/chariow (signature HMAC vérifiée)
  → isTopupSale (lib/billing/chariow-delivery.ts) :
      vente reconnue par product.id === getChariowTopupProductId()
      (env CHARIOW_TOPUP_PRODUCT_ID → défaut boutique prd_llfosdp1)
  → applyTopup (lib/billing/wallet.ts) : journal idempotent chariow_<saleId>
    — une même vente ne peut jamais être créditée deux fois
  → solde mis à jour, visible sur /billing
```

L'achat via widget ne porte pas de `custom_metadata` (le checkout n'est pas
créé par la plateforme) : la reconnaissance repose sur l'identifiant produit.
Les ventes créées par le checkout API de la plateforme (bouton « Recharger
avec Chariow ») restent reconnues par `gen3ia_product = wallet_topup`, et le
retour de paiement passe par `/api/billing/topup/verify` (filet de sécurité,
même journal `chariow_<saleId>` partagé avec le webhook). En cas d'échec de
crédit, la livraison Pulse est reprise automatiquement (re-délivrance ou
rapprochement admin) ; le webhook reste la SEULE voie de crédit automatique.

### Notes opérationnelles

- **Le produit doit être facturé en XAF côté Chariow** : le webhook refuse
  toute recharge dans une devise différente du wallet (`WALLET_CURRENCY`) —
  la vente passe alors en `failed` et n'est jamais créditée.
- **Surcharge env** : `CHARIOW_TOPUP_PRODUCT_ID` REMPLACE le défaut boutique
  (même sémantique que `resolvePlanProductId`) — pointer un produit de
  remplacement retire la reconnaissance du produit précédent.
- **Repli boutique** : `CHARIOW_TOPUP_STORE_URL` (optionnel) est exposé par
  `GET /api/billing/wallet` et affiché sur `/billing` comme lien secondaire.
- **Variables requises (VPS)** : `CHARIOW_PULSE_SECRET` (webhook = seule voie
  de crédit automatique) et `CHARIOW_API_KEY` (checkouts API + vérification
  des ventes). Le produit `prd_llfosdp1` étant branché par défaut,
  `CHARIOW_TOPUP_PRODUCT_ID` est optionnel.

# Zero Trust — Gen3ia (Pilier 3)

> Statut : implémenté (couche application) — Task I, 2026-10.
> Principe directeur : **aucune confiance par position réseau**. Être « dans
> le VPS », « sur le même hôte » ou « derrière nginx » ne prouve RIEN : toute
> requête prouve son identité par la cryptographie (JWT Firebase, HMAC,
> signature de service) puis est autorisée selon le CONTEXTE (qui, quoi,
> quel quota, quel périmètre de données).

---

## 1. Principes appliqués

| Principe | Transposition Gen3ia |
|---|---|
| Aucune confiance par position réseau | Le middleware et les gardes de route ne font AUCUNE hypothèse d'IP/réseau ; les routes « internes » (cron, workers) exigent un secret OU une signature, pas une adresse source. |
| Identité cryptographique partout | Utilisateurs : JWT Firebase vérifié RS256 ou cookie de session HMAC. Services : HMAC-SHA256 par service (`GEN3IA_SERVICE_TOKENS`). Webhooks entrants : HMAC du corps brut (`X-Gen3ia-Signature`). |
| Accès contextuel (moindre privilège) | Matrice deny-by-default (`lib/security/user-access.ts`) + scoping par ressource (`lib/tenants/resource-access.ts` : personnel vs organisation) + quotas par utilisateur (rate limit local). |
| Défense en profondeur | Deux barrières (middleware + gardes de route) ; deny par défaut Firestore en troisième filet ; signature ANTI-REPLAY sur les appels de service. |
| Fail-closed | Panne d'annuaire → traité comme utilisateur standard ; secret absent → 401/503 honnête (jamais de faux succès) ; registre de service vide → repli documenté + warning. |
| Journalisation corrélée | `x-gen3ia-trace-id` propagé sur toutes les API ; événements d'audit (`lib/security/audit-events.ts`, journal chaîné `journal-chaine.ts`). |

---

## 2. Inventaire « FAIT » (couche application)

### 2.1 Périmètre navigateur / utilisateur

- **Middleware deny-by-default** (`middleware.ts`) : classification centralisée
  de TOUT chemin (pages + API) dans `lib/security/user-access.ts` — public /
  utilisateur (liste blanche des familles) / restreint (admin seul).
  Runtime Node : vérification réelle de l'identité (JWT RS256 Firebase ou
  cookie de session HMAC) avant décision 403.
- **Garde canonique de route** `protectRoute` (`lib/security/route-guard.ts`) :
  seconde barrière, ré-applique la matrice (défense en profondeur), limite de
  débit par utilisateur, trace-id. `requireUser`, `enforceRateLimit`,
  `timingSafeStringEqual` complètent la panoplie.
- **Webhooks entrants signés** :
  - `/api/webhooks/agent-triggers/[token]` — token d'URL **+** HMAC-SHA256 du
    corps brut (`X-Gen3ia-Signature: sha256=<hex>`, clé
    `AGENT_TRIGGER_WEBHOOK_SECRET`), obligatoire dès que le secret est
    configuré (rétrocompatible sinon).
  - `/api/webhooks/chariow` — HMAC `x-chariow-signature` (crédit wallet
    idempotent, seule voie de crédit automatique).
- **Routes système déjà signées** : `/api/queue/*` et `/api/video/worker/*`
  (signature interne de tick, fraîcheur ±300 s), crons `/api/cron/*`
  (bearer `CRON_SECRET`), `/api/agents/system/activate` (bearer
  `AGENTS_SYSTEM_SECRET`).

### 2.2 Identité de service interne (BeyondProd local) — Task I

- **Registre** : `GEN3IA_SERVICE_TOKENS="nom:secret,nom2:secret2"`
  (un secret DÉDIÉ par service — `openssl rand -hex 32`). Parse robuste :
  entrées malformées ignorées, warning unique si la variable est vide.
- **Protocole** (`lib/security/service-identity.ts`) : en-têtes
  `X-Gen3ia-Service` / `X-Gen3ia-Timestamp` (epoch secondes) /
  `X-Gen3ia-Signature: sha256=` + hex(HMAC-SHA256(secret,
  `service:méthode:chemin:horodatage:hachéSHA256(corps)`)).
- **Vérification** : `verifyServiceRequest` — fenêtre glissante ±300 s
  (anti-replay), lookup du secret à temps constant, allowlist par route,
  comparaison de signature timing-safe.
- **Garde** : `requireService(request, …noms)` → 401 prête à renvoyer.
  **Rétrocompatibilité stricte** : registre absent → `allowIfUnconfigured()`
  laisse la route retomber sur son authentification historique (bearer)
  avec warning — JAMAIS de rupture de service.
- **Routes habillées (rétrocompatible)** : `/api/cron/agent-schedules`,
  `/api/cron/training-sweep`, `/api/cron/knowledge-ingest`,
  `/api/cron/cleanup-invitations` (service « cron ») et
  `/api/agents/system/activate` (service « agent-system », corps brut signé).
  La signature est acceptée EN PLUS du bearer historique.
- **Tests** : `lib/security/service-identity.test.ts` (22 cas : parse,
  aller-retour, refus documentés, anti-replay, garde 401).

### 2.3 Règles Firestore + isolation multi-tenant — Task I

- **`firestore.rules`** (racine) : deny-by-default total, puis ouvertures
  minimales sur le noyau multi-tenant RÉEL (cartographié dans le code) :
  `users/{uid}`, `organizations/{orgId}` (+ `members/`, `invitations/`),
  index `orgMemberships/`, ressources métier `ownerId`/`orgId` (agents,
  workflows, videoProjects, knowledgeDocuments, chatConversations),
  portefeuille `userWallets` en lecture titulaire seule. Tout le reste :
  refus. Champ-clés `role`/`plan`/`credits`/`uid` non modifiables par le
  client (aucune auto-promotion).
- **RÉALITÉ PRODUCUTION À CONNAÎTRE** : Firebase sert de fournisseur
  d'identité ; les données vivent dans R2 via le moteur r2fs consommé par le
  SDK **Admin** — qui ne passe JAMAIS par ces règles. Les règles sont donc un
  troisième filet (encadrent un éventuel retour de Firestore en base et
  interdisent tout accès client direct résiduel). Elles ne peuvent pas casser
  le service actuel.
- **Tests d'isolation** : `tests/firestore/rules.test.ts`
  (`@firebase/rules-unit-testing@5.0.2`) — non authentifié → refus ;
  org A ne lit PAS org B ; propriétaire/membre/admin conformes à la matrice
  `resource-access` ; anti-élévation ; refus par défaut des collections
  système. Le test **s'auto-désactive sans émulateur** (`npm test` reste
  vert) et s'exécute ainsi :
  ```bash
  npx firebase-tools emulators:exec --only firestore \
    "vitest run tests/firestore/rules.test.ts"
  ```
- **DÉPLOIEMENT DES RÈGLES = MANUEL, PAR LE CLIENT** (jamais automatisé dans
  la CI actuelle) :
  ```bash
  firebase deploy --only firestore:rules
  ```
  (prérequis : `FIREBASE_PROJECT_ID` + CLI Firebase authentifiée. Sans base
  Firestore active, le déploiement n'a aucun effet sur le service.)

### 2.4 Accès contextuel actuel (résumé)

1. Identité : Bearer Firebase (claims vérifiés) OU cookie `gen3ia_session`
   (HMAC `SESSION_SECRET`) — le cookie ne porte AUCUN privilège, le rôle est
   résolu via l'annuaire plateforme (cache 60 s, erreurs jamais cachées).
2. Autorisation : matrice `user-access` (familles autorisées par requête) ;
   exceptions restreintes (orchestration agent, inventaire admin Ads…) ;
   scoping par ressource côté routes (propriétaire / org owner / org admin /
   org member — `lib/tenants/resource-access.ts`).
3. Limitation : rate limit local par clé d'identité (routes, webhooks,
   terminal…) ; plafonds de corps (413) avant parsing sur les routes coûteuses.
4. Services : identité de service signée (2.2) — complément des secrets
   partagés historiques en cours d'abandon progressif.

---

## 3. Feuille de route — Phase 3 (infrastructure)

Conditions de déclenchement : migration hors du VPS unique (multi-instances
GKE / cloud), exposition d'API sensibles entre clusters, ou exigence client
entreprise (silo). **Pas avant** que la Phase 2 (identité de service) soit
déployée partout : la cryptographie applicative d'abord, la mécanique
réseau ensuite (l'inverse crée une dépendance à l'infrastructure).

| Étape | Contenu | Conditions d'entrée |
|---|---|---|
| 3.1 mTLS entre services | Certificats clients par service (rotation automatique), SPIFFE/SPIRE ou équivalent géré ; la signature applicative (2.2) reste la source de vérité applicative, le mTLS chiffre/authentifie le transport. | Multi-hôte (GKE), automatisation de la rotation (cert-manager), inventaire des couples appelant/route (audit Task I comme base). |
| 3.2 Service mesh (GKE) | Sidecar/ambient mesh (Istio ambient ou Linkerd) : policies L7 par identité de service, retrait progressif des secrets partagés (CRON_SECRET…), traçabilité réseau dans les logs. | Étape 3.1 faite, workloads conteneurisés, budget mémoire (VPS 2 Go actuel insuffisant — condition matérielle explicite). |
| 3.3 Identity-Aware Proxy (IAP) / Zero Trust accès | Front d'authentification périmétrique pour les surfaces admin/diagnostic (aujourd'hui : écran admin + gardes applicatives), WAF géré, journalisation centralisée des décisions. | Domaine géré (Cloud Identity), cohérence avec la matrice `user-access` (IAP ne remplace PAS les gardes applicatives — superposition uniquement). |

Gardes-fous transverses (déjà posés, à conserver pendant la migration) :
deny-by-default aux deux étages, timing-safe partout, anti-replay,
fail-closed, rétrocompatibilité prouvée par tests.

---

## 4. Références code

| Élément | Fichier |
|---|---|
| Middleware | `middleware.ts` |
| Matrice d'accès | `lib/security/user-access.ts` (+ tests) |
| Garde utilisateur | `lib/security/route-guard.ts`, `lib/security/authenticated-request.ts` |
| Identité de service | `lib/security/service-identity.ts` (+ tests) |
| Webhook HMAC entrant | `app/api/webhooks/agent-triggers/[token]/route.ts` |
| Isolation multi-tenant serveur | `lib/tenants/resource-access.ts`, `lib/tenants/organizations.ts` |
| Règles Firestore | `firestore.rules`, `firebase.json`, `firestore.indexes.json` |
| Tests règles | `tests/firestore/rules.test.ts` |
| Secrets documentés | `.env.example` (sections AGENT SCHEDULER, ZERO TRUST) |

# Feuille de route SaaS — Gen3ia

État d'implémentation du plan « SaaS de niveau enterprise » au moment de la
passe multi-tenant + connecteurs @ (septembre 2026). Chaque axe indique ce qui
est **implémenté** (dans le code, vérifiable) et ce qui reste (infra externe ou
phase suivante).

## 1. Multi-tenancy et isolation — ✅ Socle implémenté

- **Implémenté** :
  - `organizations/{orgId}` avec `name`, `plan` (free/pro/enterprise), `ownerId`,
    `isolation` (pool/silo), `settings` — `lib/tenants/organizations.ts`.
  - Sous-collection `members/{uid}` (rôles owner/admin/member) + index
    `orgMemberships` pour la résolution utilisateur → organisations.
  - Invitations par email avec expiration 7 jours, révocation, acceptation
    vérifiée (email invité = email du compte).
  - API : `GET/POST /api/organizations`, `GET /api/organizations/{orgId}`,
    `POST /api/organizations/{orgId}/members` (invite/role/remove/revoke).
  - Règles Firestore : lecture/écriture conditionnée à l'appartenance
    (`exists(organizations/{orgId}/members/{uid})`), mutations sensibles
    réservées à l'Admin SDK.
  - UI : panneau Organisations sur `/team` (création, membres, rôles, quotas).
- **Reste** : rattacher progressivement les collections métier existantes
  (agents, projets, exécutions) à un `orgId` avec double appartenance
  (userId + orgId) pour la compatibilité ; migration douce recommandée par
  copies lazy lors des prochaines écritures.

## 2. Scalabilité et performance — ⚠️ Partiel (dépendances infra)

- **Implémenté** : exécutions asynchrones avec checkpoints (`lib/agents/runtime`),
  files d'attente logiques (plan/étapes idempotentes, reprises), cache du
  catalogue Composio, ISR Next.js, CDN Vercel par défaut.
- **Reste (infra)** : Redis distribué (cache profils/réponses), file
  éphémère managée (Pub/Sub ou SQS) pour les tâches très longues, base
  analytique (Spanner/Aurora) si requêtes croisées à l'échelle. Ces briques
  nécessitent un compte cloud dédié ; le code est structuré pour les accepter
  sans refonte (interfaces de repository déjà isolées).

## 3. Observabilité — ✅ Socle implémenté

- **Implémenté** :
  - Logs JSON pino (`lib/observability/logger.ts`) avec redaction des secrets.
  - Corrélation `traceId` par requête API : généré ou repris des en-têtes
    `x-gen3ia-trace-id`/`x-request-id`, propagé dans les logs
    (`traceLogger`) et renvoyé au client (header de réponse 401).
  - Traces d'exécution agent (étapes, coûts, tokens) : `execution-tracer`,
    `execution-store`, page `/observability`, alertes budget ads.
  - Sentry branché si `SENTRY_DSN` présent.
- **Reste** : exporteur OpenTelemetry vers un backend dédié (Datadog/Grafana),
  métriques agrégées par organisation (le `orgId` est désormais disponible
  dans le contexte de requête pour l'instrumentation).

## 4. Sécurité — ✅ Renforcée

- **Implémenté** :
  - CSP complète + `X-Frame-Options: DENY` (`next.config.ts`) : default-src
    self, script-src restreint aux domaines Google nécessaires à Firebase,
    frame-ancestors none, upgrade-insecure-requests.
  - Garde-fous existants : rate limiting par utilisateur, guardrails agent,
    politiques d'exécution, approbations d'actions sensibles, audit sécurité
    (`lib/security/*`).
  - Isolation Firestore des organisations (voir §1).
- **Reste** : MFA/OIDC enterprise (Identity Platform), CMEK/KMS pour les
  tenants silo, WAF (Cloud Armor) — dépendances de compte cloud.

## 5. Facturation — ⚠️ Socle interne implémenté

- **Implémenté** : wallet + crédits + compteurs d'outils/médias + moteur de
  coûts par exécution (`lib/billing/*`), page `/billing`, quotas par plan
  définis dans `lib/tenants/organizations.ts` (membres, agents, crédits/mois,
  stockage) appliqués aux invitations et à la création d'organisations.
  Paiement : intégration Chariow existante.
- **Reste** : Stripe Billing (plans, portail client, webhooks) — le module
  `lib/billing/` expose les événements d'usage ; brancher Stripe nécessite
  les clés du compte Stripe du propriétaire. Les quotas code-side sont déjà
  indépendants du PSP.

## 6. Expérience développeur — ✅ Amélioré

- **Implémenté** :
  - README complet (architecture, fonctionnalités, démarrage, déploiement).
  - Cette feuille de route (`docs/saas-roadmap.md`).
  - Page `/features` ouvrant les fonctionnalités cachées (portail client,
    approbations à distance, API publique, webhooks, voix, orchestrateur,
    MCP, PWA/desktop).
  - Tests Vitest (unitaires) + E2E, CI GitHub Actions.
- **Reste** : SDK npm publié, site de documentation (Nextra/Docusaurus),
  Terraform/Pulumi pour l'IaC multi-environnements.

## Décisions d'architecture notables

- **Isolation hybride** : le champ `isolation` (pool/silo) matérialise le
  modèle par organisation dès maintenant ; le silo enterprise activera un
  namespace de données dédié au provisionnement sans changer le schéma.
- **Pas de custom claims pour l'appartenance org** : les règles Firestore
  vérifient directement `members/{uid}` (source de vérité), ce qui évite la
  gestion fragile des claims multi-organisations et leurs problèmes de
  propagation (les claims restent utilisés pour le rôle admin plateforme).
- **connect-src CSP ouvert https:/wss:** : choix pragmatique (Firebase,
  Composio, Sentry, webhooks utilisateurs). Un audit des domaines réellement
  appelés permettra un resserrement par allowlist.

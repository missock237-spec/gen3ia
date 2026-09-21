# Ré-analyse du projet Gen3ia-ia-studio (post-implémentation)

Analyse refaite après la passe « SaaS enterprise » (commits `743fb7e` et
`ba52e7f`, déployés en production sur gen3ia.online). Cette analyse suit la
structure de l'analyse initiale : architecture, forces, faiblesses restantes,
prochaines étapes.

## 1. État de l'architecture après implémentation

Les couches demandées sont désormais présentes et déployées :

| Couche | Implémentation | Fichiers clés |
|---|---|---|
| Multi-tenant | Organisations, membres (owner/admin/member), invitations expirables, index user→org, quotas par plan (free/pro/enterprise) | `lib/tenants/organizations.ts`, `app/api/organizations/**` |
| Isolation données | Règles Firestore : accès conditionné à `members/{uid}`, mutations sensibles via Admin SDK uniquement | `firestore.rules` |
| Connecteurs conversationnels | Sélecteur `@` dans le chat agent : connexions actives + catalogue, contexte d'actions Composio injecté au planificateur, `composio.execute` ouvert dans la politique (approbations conservées) | `lib/integrations/mention.ts`, `app/api/integrations/mention`, `components/agent/agent-chat-panel.tsx`, `app/api/agent/chat/route.ts` |
| Sécurité | CSP centralisée middleware + `upgrade-insecure-requests`, `X-Frame-Options: DENY`, 401 corrélés, rate limiting, guardrails | `proxy.ts`, `next.config.ts`, `lib/security/*` |
| Observabilité | `traceId` par requête (réutilisé de `x-gen3ia-trace-id`/`x-request-id`), logs pino enfants avec userId/route, événements `request.authorized`/`request.rate_limited` | `lib/observability/logger.ts`, `lib/security/route-guard.ts` |
| Découvrabilité | Page `/features` (portail client, approbations à distance, API publique, webhooks, voix, orchestrateur, MCP, PWA/desktop) + entrée de navigation | `app/features/page.tsx`, `components/nav/nav-items.ts` |
| Documentation | README complet + feuille de route SaaS avec état d'implémentation honnête | `README.md`, `docs/saas-roadmap.md` |

Vérifications production (compte de test créé puis parcours complet) :
- `/features`, `/studio`, `/team`, `/integrations` → HTTP 200.
- `/api/organizations` et `/api/integrations/mention` sans auth → 401 +
  `x-gen3ia-trace-id` (corrigé : le premier déploiement renvoyait 500).
- Création d'organisation (plan FREE, rôle OWNER, isolation pool), affichage
  quotas, invitation d'un membre (statut « en attente ») → fonctionnels.
- Sélecteur `@` : ouverture par bouton et par frappe de `@` en cours de
  saisie, liste filtrée, chip d'activation avec état « connecté / à connecter ».
- Chat agent : classification requête (badge « Réponse directe » vs « Mission
  exécutée »), réponse professionnelle dans le périmètre, et refus correct
  d'une demande hors périmètre même avec un connecteur activé.
- Tests unitaires : 203/203 passés ; build production OK.

## 2. Forces (nouvelles)

- **Socle multi-tenant réel** : le cloisonnement n'est plus seulement par
  `userId` — les organisations apportent rôles, invitations et quotas par
  plan, avec isolation appliquée aux règles Firestore et vérifiée côté serveur.
- **Connecteurs conversationnels** : l'activation `@` transforme le chat en
  surface d'intégration sans quitter la conversation, tout en conservant la
  double barrière (whitelist agent + approbation humaine des actions
  sensibles).
- **Observabilité corrélable** : chaque requête API porte un traceId
  (réutilisable par une passerelle), ce qui prépare l'agrégation de métriques
  par tenant sans refonte.
- **Transparence fonctionnelle** : la page `/features` supprime le risque
  « fonctionnalité livrée mais invisible » en documentant les chemins d'accès.

## 3. Faiblesses restantes et priorisées

1. **Migration métier vers `orgId`** : les collections existantes (agents,
   projets, exécutions) restent indexées par `userId`. La convention
   recommandée : ajouter `orgId` optionnel aux schémas, l'écrire lors des
   prochaines créations, et filtrer par org dans les vues « entreprise ».
2. **Stripe Billing** : le moteur de quotas est indépendant du PSP mais les
   plans payants nécessitent les clés Stripe du propriétaire (webhooks +
   portail client à brancher sur `lib/billing/`).
3. **Observabilité avancée** : export OpenTelemetry vers un backend dédié et
   métriques agrégées par org (le contexte est prêt) restent à câbler.
4. **Scalabilité infra** : Redis distribué et file éphémère managée (Pub/Sub
   ou SQS) pour les exécutions très longues — dépendances de compte cloud.
5. **Sécurité enterprise** : MFA/OIDC (Identity Platform), CMEK pour les
   tenants silo, WAF/Cloud Armor ; la CSP peut être resserrée (allowlist
   `connect-src`) après audit des domaines réellement appelés.
6. **Dette documentaire ciblée** : SDK npm publié et site de documentation
   (Nextra) pour les intégrations tierces.

## 4. Prochaines étapes recommandées (ordre proposé)

1. Écrire `orgId` sur les nouvelles ressources (agents/projets) et filtrer
   les vues par organisation côté API (migration lazy, sans coupure).
2. Brancher Stripe Billing sur les événements d'usage existants (clés à
   fournir), avec webhooks idempotents et portail client.
3. Ajouter l'export OTel (collector) derrière une variable d'environnement,
   en réutilisant `traceId` comme corrélation primaire.
4. Resserrer la CSP par audit du trafic réel (en-têtes déjà loggés).
5. Publier le SDK npm (`@gen3ia/sdk`) à partir de `app/api/public` et
   documenter le parcours webhook → mission agent.

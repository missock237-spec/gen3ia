# Roadmap Enterprise — Gen3ia (Task 39)

Ce document couvre les recommandations du plan d'action qui nécessitent une
**décision produit ou un compte externe** (contrairement aux travaux
implémentés directement dans le code : CI e2e émulateurs, tests de règles
Firestore, budgets de bundle CI, gitleaks, Makefile/seed/README, sonde de
configuration). Chaque section donne les étapes exactes, prêtes à exécuter.

---

## 1. Observabilité Sentry (Rec 4.1 → 4.3) — bloqué : compte Sentry requis

Gen3ia dispose déjà de logs structurés Pino + `traceId` corrélés + sonde
`/api/health` (publique) + `/api/health/infra` (couches + groupes de config).
Sentry ajoute l'agrégation d'erreurs et le tracing distribué.

**Étapes (après création du projet sur sentry.io) :**

```bash
npx @sentry/wizard@latest -i nextjs
```

Le wizard génère `sentry.client.config.ts`, `sentry.server.config.ts`,
`sentry.edge.config.ts` et ajoute `SENTRY_DSN` + `SENTRY_AUTH_TOKEN` aux
variables Vercel. Vérifications Gen3ia spécifiques :

1. `SENTRY_DSN` est déjà dans la liste des optionnels reconnus de
   `lib/env/config-report.ts` → sa présence apparaîtra automatiquement dans
   `/api/health/infra`.
2. Pino reste le transport principal ; ajouter le transport Sentry aux
   fichiers sensibles uniquement (routes API critiques), jamais côté client.
3. Tracing : activer `tracesSampleRate: 0.1` (production) sur
   `/api/agents/execute`, `/api/agent/chat`, `/api/billing/webhook`.

**Métriques métier (Rec 4.2) :** durée moyenne d'exécution des plans
Planner-Executor-Evaluator (déjà mesurée par run dans `agentRuns` — exporter
vers Sentry metrics ou Prometheus/Grafana via un petit exporter) ; taux
d'échec LLM par fournisseur (agréger `lib/ai/router` fallback events) ;
latence p95 des API critiques.

**Alertes (Rec 4.3) :** Sentry Alerts → e-mail/Slack sur
- erreurs 5xx > 1 % des requêtes sur 5 min ;
- échec de webhook Chariow (facturation) ;
- dépassement du budget d'un agent autonome (événement `budget_exceeded`
  déjà journalisé par le moteur d'exécution).

---

## 2. Migration Firestore → PostgreSQL (Rec 7) — bloqué : provisionnement base requis

**Décision préalable :** Neon, Supabase ou RDS PostgreSQL. Recommandation :
**Neon + Drizzle ORM** (TypeScript-first, branchement edge-friendly, froid
automatique adapté à une charge SaaS à pics).

**Cartographie initiale (à affiner avant exécution) :**

| Vers PostgreSQL (relationnel) | Reste Firestore (temps réel) |
|---|---|
| `users`, `organizations`, `organizations/members`, `orgMemberships` | `chatConversations`, `chatMessages` |
| `teams`, `teams/members`, `userTeams`, `invitations` | `liveAgentSessions` (websocket-like) |
| `userWallets`, `walletLedger`, billing Chariow | `agentRuns` timeline live |
| `agents` (métadonnées), `executions`, `researchJobs` | caches éphémères |

**Transition progressive :**

1. **Phase 1 — double écriture** : nouvelles écritures des collections
   ci-dessus vers Postgres (source de vérité) + Firestore (compat), via un
   module `lib/db/dual-write.ts` derrière un flag.
2. **Phase 2 — bascule des lectures** critiques vers Postgres.
3. **Phase 3 — retrait des écritures Firestore** pour les collections
   migrées ; Firestore conserve son rôle temps réel.

**Auth :** conserver Firebase Auth (UID = clé étrangère Postgres). Une
migration NextAuth est possible plus tard mais n'apporte rien tant que
l'émulateur + les règles Firestore restent utilisés pour le temps réel.

**Données :** export JSON Firestore (`gcloud firestore export`) → script
`scripts/migrate.ts` (transformation documents → lignes) ; synchronisation
des écritures pendant la transition par double écriture plutôt qu'outil tiers.

---

## 3. Accessibilité & i18n — suite (Rec 8)

**Déjà conforme (vérifié Task 39) :** `<html lang="fr">`, `alt` sur toutes
les images, `focus-visible` stylé, `aria-label` sur les contrôles clés,
contrastes de la palette actuelle.

**Automatisation axe-core (à brancher sur la sonde Playwright existante) :**

```bash
npm i -D @axe-core/playwright
```

Ajouter aux sondes de production (`scripts/verify_*_prod.mjs`) un scan axe
des pages principales (`/`, `/login`, `/workspace/conversations`,
`/settings`) et faire échouer la CI sur les violations `critical`/`serious`.

**i18n FR/EN (next-intl) :** l'application est nativement francophone (UI,
e-mails, chartes d'agents). L'ajout d'EN nécessite : extraction des chaînes
vers `messages/fr.json` + `messages/en.json`, middleware de détection de
locale, sélecteur de langue, formats `Intl`. Chantier estimé : 2-3 itérations
complètes (tous les fichiers UI sont concernés). Priorité recommandée après
la migration Postgres, car la traduction modifiera les mêmes fichiers.

# Roadmap Enterprise — Gen3ia (Task 39)

Ce document couvre les recommandations du plan d'action qui nécessitent une
**décision produit ou un compte externe** (contrairement aux travaux
implémentés directement dans le code : CI e2e émulateurs, tests de règles
Firestore, budgets de bundle CI, gitleaks, Makefile/seed/README, sonde de
configuration). Chaque section donne les étapes exactes, prêtes à exécuter.

---

## 1. Observabilité Sentry (Rec 4.1 → 4.3) — ✅ INTÉGRÉE (Task 40, ADR-005)

Gen3ia dispose déjà de logs structurés Pino + `traceId` corrélés + sonde
`/api/health` (publique) + `/api/health/infra` (couches + groupes de config).

**Livré Task 40** (SDK @sentry/nextjs 10, org gen3ia / projet
javascript-nextjs, DSN provisionné) :
- `instrumentation.ts` (runtimes nodejs + edge) + hook `onRequestError` ;
- navigateur : pont asynchrone `lib/telemetry/sentry-bridge-client.ts`
  (file synchrone ~1 kB + SDK au repos — A/B : −52 kB gzip vs init
  synchrone, budget bundle préservé) ;
- tunnel anti-bloqueurs `/monitoring` (liste blanche d'hôtes, testé) ;
- source maps au build via `SENTRY_AUTH_TOKEN` (secret Vercel) ;
- scrubbing PII + boundaries `error.tsx`/`global-error.tsx` branchées.

**Reste (action utilisateur)** : renseigner `SENTRY_AUTH_TOKEN` + DSN dans
Vercel ; activer les Sentry Alerts (Rec 4.3) → e-mail/Slack sur erreurs 5xx
> 1 % / 5 min, échec webhook Chariow, dépassement de budget agent
(`budget_exceeded` déjà journalisé).

---

## 2. Migration Firestore → PostgreSQL (Rec 7) — ✅ INFRASTRUCTURE LIVRÉE (Task 40, ADR-006) : cible Supabase

**Décision (demande utilisateur) : cible = Supabase** (PostgreSQL 15 + RLS
+ Storage + Realtime + pgvector), pas Neon. Schéma complet + politiques RLS
livrés (`supabase/migrations/0001` + `0002`), couche `lib/supabase/`
(admin/service-role, anon, navigateur), pont d'identité Firebase ⇄
`profiles`, driver `DATA_BACKEND` avec garde anti-oubli, pilote
notifications migré et testé. Guide complet : `docs/migration-supabase.md`.

**Phases restantes** (cf. guide) : P2 double-écriture + backfill par
domaine (notifications → artefacts → conversations → agents → équipes →
wallet), P3 cutover lectures + temps réel. Provisionnement du projet
Supabase = action utilisateur (URL + clés dans Vercel).

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

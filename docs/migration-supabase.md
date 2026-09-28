# Migration Firestore → Supabase (PostgreSQL) — Task 40

## Objectif et décision

La roadmap enterprise (Rec 7) avait recommandé PostgreSQL comme cible de
données. **Décision Task 40 : la cible est Supabase** (PostgreSQL managé +
storage + temps réel), sous le n° **ADR-006** (voir
`docs/architecture-decisions.md`). La migration est **progressive, pilotée
par domaine**, avec Firebase conservé comme fournisseur d'identité en
phases 1-2 — zéro big-bang, zéro régression production possible.

## Pourquoi Supabase (et pourquoi pas un Postgres brut)

| Besoin Gen3ia | Réponse Supabase |
|---|---|
| Requêtes relationnelles (équipes, wallets, runs) | PostgreSQL complet, jointures, contraintes |
| Recherche vectorielle (mémoires, connaissances) | pgvector natif (remplace le repli cosine Firestore) |
| Stockage fichiers | Supabase Storage (complète R2, buckets par projet) |
| Temps réel (runs, notifications) | Realtime sur WAL Postgres (phase 3) |
| Gouvernance des accès | RLS déclarative ≙ firestore.rules (migration 0002) |
| Coûts prévisibles | Quotas transparents, pas de lecture/unité facturée à l'appel |

## Ce qui est livré (phase 1 — infrastructure + pilote)

```
lib/supabase/config.ts       lecture env + garde de configuration
lib/supabase/admin.ts        client service-role singleton (≙ firebase-admin)
lib/supabase/server.ts       client anon serveur (RLS respectée)
lib/supabase/client.ts       client navigateur (phase 3, temps réel)
lib/supabase/auth-bridge.ts  pont d'identité Firebase ⇄ profiles
lib/db/driver.ts             bascule DATA_BACKEND + cache uid→profil
lib/notifications/supabase-repository.ts   pilote du domaine notifications
supabase/migrations/0001_core_schema.sql   28 tables, index, triggers
supabase/migrations/0002_rls_policies.sql RLS ≙ firestore.rules
supabase/config.toml         développement local (CLI supabase)
```

Le pilote **notifications** démontre le pattern complet : sémantique zod
identique, micro-cache Redis conservée, invalidation inchangée, tests
(15/15 verts) sur les mappages et la bascule.

## Schéma de données (0001)

Transposition relationnelle du modèle Firestore : 28 tables couvrant
profils, organisations/membres, projets, agents, conversations/messages,
runs, approbations, artefacts, skills, mémoires (pgvector-ready),
connaissances/chunks, wallets/ledger, notifications, usage, audit,
marketplace d'extensions, arrêts d'urgence, schedules. Points clés :

- **JSONB** pour les structures souples (manifests, plans, metadata) ;
- **timestamptz** partout, `updated_at` par trigger `set_updated_at()` ;
- **CHECK** sur les énumérations (statuts) — les `z.enum` deviennent des
  contraintes de base ;
- **table `migration_mapping`** : correspondance Firestore ID ⇄ Postgres
  UUID pour un cutover vérifiable ligne à ligne ;
- **index partiels** sur les chemins chauds (`status='awaiting'`,
  notifications non lues, schedules dus).

## Sécurité (0002) — RLS ≙ firestore.rules

La matrice des règles Firestore (9 familles vérifiées par les tests
e2e Task 39) est transposée :

- helper `request_firebase_uid()` lit le claim JWT (dormant en phase 1) ;
- **deny-all par défaut** : la clé anon ne voit rien tant que Supabase
  Auth n'est pas activé ;
- propriété directe (`owns_row`) pour agents/projects/runs/conversations… ;
- wallet/ledger/usage/audit/api-keys : **aucune politique client** →
  écritures service-role seul (≙ `allow write: if false`) ;
- organisations : rôles owner/admin/member/viewer via `org_role()`.

Le service-role (serveur) contourne la RLS : **le scoping utilisateur
reste appliqué explicitement dans les repositories**, exactement comme
avec firebase-admin aujourd'hui — pas de changement de modèle de
confiance, la RLS protège la clé anon (présent/futur).

## Pont d'identité (phases 1-2)

```
Firebase ID token (RS256 vérifié, verifyFirebaseAuth)
        │ uid
        ▼
resolveProfileId(uid)  [cache TTL 5 min, process-local]
        │ upsert idempotent profiles (firebase_uid unique)
        ▼
owner_profile_id → toutes les requêtes Supabase
```

Provisionnement **à la volée, utilisateur par utilisateur** : aucune
migration de masse obligatoire ; le backfill par lots (scripts) couvre
les comptes dormants avant cutover.

## Phases

### P1 — Infrastructure + pilote (livré, flag OFF)
Les variables Supabase sont optionnelles ; `DATA_BACKEND=firebase` est
le comportement par défaut et supporté indéfiniment. Supabase absent ⇒
repli silencieux Firestore (garde du driver, testée).

### P2 — Double-écriture + backfill (par domaine)
Pour chaque domaine piloté (ordre recommandé : notifications → artifacts →
conversations/messages → agents → teams/organizations → wallet) :
1. écrire en double (Firestore vérité, Supabase miroir) via le driver ;
2. backfill par lots avec `migration_mapping` (idempotent, reprise) ;
3. réconcilier par checksums (compteurs par utilisateur/période).

### P3 — Cutover lectures + temps réel
1. basculer les lectures du domaine (`DATA_BACKEND=supabase`, garde verte) ;
2. surveiller 1-2 semaines (Sentry + /api/health/infra) ;
3. retirer l'écriture Firestore du domaine, archiver la collection ;
4. (option) basculer l'IdP vers Supabase Auth : les OAuth Google/GitHub
   sont recréés côté Supabase, les uid Firebase deviennent des claims
   `firebase_uid` portés par les JWT Supabase — les politiques RLS
   s'activent telles quelles.

## Rollback

À chaque étape, le retour arrière = repasser `DATA_BACKEND=firebase` :
les écritures Firestore n'ont jamais cessé pendant P2, aucune donnée n'est
perdue. Le pilote garde un chemin de code Firestore complet.

## Opération

- Développement local : `npx supabase start` puis
  `npx supabase db reset` (applique les migrations) ;
- Vérification configuration : `GET /api/health/infra` → section
  `config.groups[data-supabase]` (booléens, jamais de valeurs) ;
- Couverture des tables : `npx supabase gen types typescript` à chaque
  migration (phase 2) pour remplacer les types déclaratifs.

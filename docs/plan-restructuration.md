# Plan de restructuration du dépôt — Gen3ia

> Plan d'amélioration en 4 phases, adopté le 2026-10-24. Ce document fait
> foi : il corrige les hypothèses initiales là où la réalité du dépôt était
> différente et consigne chaque décision. Statut mis à jour à chaque phase
> livrée.

## État d'avancement

| Phase | Périmètre | Statut |
|---|---|---|
| Phase 1 — Nettoyage immédiat | tests, journal, doublons docs, roadmaps | ✅ **LIVRÉE 2026-10-24** |
| Phase 2 — Restructuration de la racine | infra/, services/, tests/e2e | ✅ **LIVRÉE 2026-10-24** |
| Phase 3 — Logique métier | modules lib/, intégrations, app/, i18n | ⏳ Planifiée (1-2 sem.) |
| Phase 4 — Gouvernance & hygiène | CONTRIBUTING, ESLint, CI structure | ⏳ En continu |

---

## Phase 1 — Nettoyage immédiat ✅ (livrée)

### 1.1 Tests déplacés vers `tests/unit/`

- **14 fichiers déplacés** : les 13 tests situés à la racine de `app/`
  (`agent-interaction-ux`, `ai-response-quality`, `deploy-auto-update`,
  `geo-routes`, `ios-splash`, `markdown-render`, `nova-dashboard`,
  `offline-page`, `perf-cache-policy`, `pwa-consistency`,
  `theme-consistency`, `ux-accessibility`, `version-manifest`) +
  `docs/openapi.test.ts` → `tests/unit/openapi.test.ts`.
- **Décision : les ~44 `route.test.ts` co-localisés dans `app/api/**`
  restent en place.** Le plan offrait deux options (« tests/unit/ » **ou**
  « co-localiser dans les modules ») ; la co-localisation à côté du
  `route.ts` testé est la meilleure organisation pour les tests de routes
  et évite un churn de 44 fichiers avec imports relatifs `./route`.
  `app/` ne contient donc plus aucun test « flottant ».
- **Corrections de chemins** : `tests/unit/openapi.test.ts` utilisait des
  URLs relatives à `import.meta.url` — remontées d'un niveau
  (`../../docs/api/openapi.json`, `../../app/**/route.ts`). Les 12 autres
  tests lisent via `process.cwd()` (insensible au déplacement) ou
  l'alias `@/`.
- **`vitest.config.mts`** : le motif `docs/**/*.test.ts` est supprimé ;
  `tests/**/*.test.ts` couvre le nouveau dossier ; `app/**/*.test.ts` est
  conservé (tests co-localisés). Commentaires mis à jour.

### 1.2 Journal déplacé dans `docs/journal/`

- `worklog.md` → `docs/journal/worklog.md` et `CHANGELOG.md` →
  `docs/journal/CHANGELOG.md`.
- **Décision : `worklog.md` reste versionné** (non ajouté à `.gitignore`) :
  ce n'est pas un log généré mais le journal d'ingénierie tenu à la main,
  cité par des commentaires de code (mis à jour :
  `lib/storage/user-data-store.ts`, `lib/r2fs/db.ts`,
  `docs/journal/CHANGELOG.md` ×2).

### 1.3 Fusion `docs/security/` + `docs/securite/` → `docs/securite/`

- Standard retenu : **français**, cohérent avec `SECURITE.md` à la racine.
- `bug-bounty.md` et `pentest-checklist.md` déplacés ; références mises à
  jour dans `docs/load-testing.md`, `.github/workflows/security.yml`,
  `docs/archive/feuille-de-route-google-grade.md` et en interne.
  (`tests/firestore/rules.test.ts` citait déjà `docs/securite/`.)

### 1.4 Roadmaps fusionnées → `docs/roadmap.md`

- Les trois feuilles (`saas-roadmap.md`, `roadmap-enterprise.md`,
  `feuille-de-route-google-grade.md`) sont **archivées telles quelles dans
  `docs/archive/`** (bannière « archivé » + liens corrigés) et remplacées
  par un document unique vivant `docs/roadmap.md` : synthèse par axe,
  chantiers ouverts, phases structurelles (conteneurisation, GCP et leurs
  déclencheurs), décisions structurantes, index des archives.
- 12 références mises à jour (README, `docs/processus-ingenierie.md` ×3,
  `docs/analyse-projet.md`, `docs/deploiement-k8s.md`,
  `docs/exploitation/ssh-bloque-runbook.md`, `k8s/README.md`,
  `k8s/base/deployment-app.yaml`, `lib/observability/org-queries.ts`,
  `app/api/observability/org/route.ts`, `scripts/a11y_prod.mjs`).

### 1.5 « Dossiers vides » — hypothèse initiale corrigée

Le plan initial proposait de supprimer `agent-ctx/`, `live-agent/`,
`orchestrator-24h/`, `pipeline/` comme dossiers vides. **Vérification
réelle : aucun n'est vide, aucun dossier vide n'existe dans le dépôt** (0
trouvé sur disque, `.git`/`node_modules`/`.next` exclus) :

- `agent-ctx/` : 7 notes de sessions d'agents (historique de travail) ;
- `live-agent/` : package TS réel (+ tests, inclus dans vitest) ;
- `orchestrator-24h/` : orchestrateur Redis Streams dockerisé (+ 26 tests) ;
- `pipeline/` : pipeline d'entraînement (package npm + tests).

**Décision : rien n'est supprimé.** Leur sort est traité en Phase 2
(déménagement vers `services/`) et une recommandation d'archivage des
notes `agent-ctx/` est inscrite en Phase 3.

---

## Phase 2 — Restructuration de la racine ✅ (livrée 2026-10-24)

### Réalisations (état réel vs cible)

1. **`infra/` créé** : `Dockerfile`, `docker-compose.yml`, `k8s/`, `deploy/`
   (`cd-finisher.sh`, `nginx/`, `render.yaml`), `firebase.json`, `.firebaserc`,
   `firestore.rules`, `firestore.indexes.json` — tous en `git mv` (renames R,
   historique préservé). Adaptations :
   - `deploy-vps.yml` : le SCP livre désormais `infra/deploy/cd-finisher.sh` ;
   - `ci.yml` : `npm ci --prefix services/sandbox` ;
   - `Makefile` + `package.json` (`test:e2e`, `test:e2e:firebase`) :
     `--config infra/firebase.json` (décision S1 appliquée) ;
   - `infra/docker-compose.yml` : `build: context: ..` + `dockerfile:
     infra/Dockerfile` (les chemins relatifs d'un compose se résolvent depuis
     son propre dossier) et `env_file ../.env` ;
   - `tests/firestore/rules.test.ts` : chemin des règles `../../infra/firestore.rules` ;
   - `infra/Dockerfile` : note de build ajoutée — `docker build -f
     infra/Dockerfile .` depuis la racine (contexte inchangé, COPY inchangés) ;
   - `scripts/k8s/valider-manifestes.sh` : cibles `infra/k8s/…` ;
   - `scripts/vps-auto-deploy/deploy.sh` : détection pipeline bivoie
     (`services/pipeline/` d'abord, ancien chemin toléré pour un worktree
     VPS pas encore resynchronisé).
2. **`services/` créé** : les 6 packages (`sandbox`, `sdk`, `training-worker`,
   `live-agent`, `orchestrator-24h`, `pipeline`) en `git mv`. Adaptations :
   - `services/sdk/build.mjs` : `repoRoot` remonte d'un niveau de plus
     (`../..`) et `sdkDir = join(repoRoot, "services", "sdk")` — `npm run
     sdk:build` re-vérifié vert après coup ;
   - `package.json` : `sdk:build` / `sdk:pack` / `sdk:test` → `services/sdk` ;
   - `vitest.config.mts` : motifs `services/{live-agent,sandbox,sdk}/…` ;
   - `tsconfig.json` : exclude `services` (remplace les 4 entrées) ;
   - `eslint.config.mjs` : ignore `services/**` ;
   - `app/api/public/sdk/route.test.ts` : lecture `services/sdk/package.json`
     (garde anti-dérive re-vérifiée) ; `tests/unit/nova-dashboard.test.ts` :
     lecture `services/live-agent/package.json`.
3. **`e2e/` → `tests/e2e/`** (3 tests + helpers) :
   - `vitest.e2e.config.mts` : include `tests/e2e/**/*.test.ts` ;
   - **`vitest.config.mts` : `exclude: [...configDefaults.exclude,
     "tests/e2e/**"]` AJOUTÉ — sans lui, le run principal aurait attrapé les
     tests e2e exigeant les émulateurs** (vérifié : 4 890 tests verts,
     aucun test e2e attrapé) ;
   - `.gitleaks.toml` : allowlist `tests/e2e/`.
4. **Vérifications** : typecheck, lint, `sdk:build`, suite vitest complète
   (433 fichiers / 4 890 tests verts / 12 auto-skip firestore), `npm run
   build` (BUILD_ID régénéré), YAML compose + 18 manifestes k8s, syntaxe
   bash des 3 scripts shell, JSON (firebase, package, tsconfig).

### Décisions Phase 2 (corrections du plan initial)

- **S2 — `.dockerignore` RESTE à la racine** (le plan le mettait dans
  `infra/`) : Docker lit le fichier d'ignore depuis la RACINE DU CONTEXTE
  de build, pas depuis le dossier du Dockerfile. Comme le contexte reste la
  racine (`docker build -f infra/Dockerfile .`), déplacer `.dockerignore`
  aurait silencieusement invalidé toutes les exclusions (secrets `.env*`,
  `var`, binaires neuronaux) — inacceptable. Contenu mis à jour : entrée
  `services` unique (remplace les 5 packages) et `tests/e2e`.
- **S3 — `firebase.json` déplacé avec `--config`** (S1 tranchée à
  l'exécution) : `Makefile`, `package.json` ×2 et `zero-trust.md` passent
  par `--config infra/firebase.json` ; les chemins internes
  (`firestore.rules`, `firestore.indexes.json`) restent relatifs au
  `firebase.json` et ont donc migré avec lui sans modification.
- **Impact VPS assumé** : `infra/deploy/cd-finisher.sh` fait
  `git reset --hard <SHA>` sur `/opt/gen3ia` — après le prochain déploiement,
  le worktree VPS reflétera la nouvelle arborescence (`.env.production`
  non suivi, intact ; `deploy.sh` no-op déjà en bivoie pour
  `services/pipeline/`).
- Docs datées non mises à jour (volontaire, valeur historique) :
  `docs/archive/`, `docs/journal/`, `agent-ctx/`, `docs/plan-plateforme-
  enterprise.md`, `docs/analyse-suppression-conversation.md`,
  `docs/codeql-triage.md`.

### Cible (adaptée à la réalité du dépôt)

```
gen3ia/
├── app/              # Routes Next.js uniquement (plus aucun test flottant — fait en Phase 1)
├── components/
├── lib/              # Logique métier (CONSERVÉ sous ce nom — voir décision L1)
├── tests/            # unit/ (fait) + e2e/ (ex-racine e2e/) + firestore/ (existant)
├── infra/            # Dockerfile, .dockerignore, docker-compose.yml, k8s/, deploy/,
│                     # firebase.json, .firebaserc, firestore.rules, firestore.indexes.json
├── scripts/          # (existant — outils version-manifest, a11y, charge…)
├── services/         # sandbox/, sdk/, training-worker/, live-agent/, orchestrator-24h/, pipeline/
├── training/         # packs d'entraînement gen3 (INCHANGÉ — voir contrainte C1)
├── docs/             # adr/, guides/, runbooks/, sre/, securite/, archive/, journal/, roadmap.md, plan-restructuration.md
├── public/
└── config files      # tsconfig, eslint, vitest, next.config, package.json, vercel.json, middleware.ts…
```

### Contraintes et décisions préalables

- **C1 — `training/` ne bouge pas.** Les notebooks Colab livrés et les
  README des packs clonent le dépôt et référencent `training/gen3-*` par
  chemin exact ; déplacer casserait la chaîne d'entraînement reproductible
  (et l'historique Git LFS des médias ~50 Mo).
- **L1 — `lib/` reste `lib/`** (pas de renommage `src/`) : ~300 fichiers,
  alias `@/*` → racine, churn maximal pour un bénéfice cosmétique nul.
  Le regroupement par domaine est traité en Phase 3.
- **S1 — `vercel.json` reste à la racine** (fichier reconnu uniquement là) ;
  `firebase.json` doit rester à la racine OU être déplacé avec
  `--config infra/firebase.json` dans tous les appels (CI + Makefile) — à
  trancher à l'exécution, préférence pour `--config`.

### Travaux Phase 2 (ordre recommandé)

1. `infra/` : `git mv` Dockerfile, `.dockerignore`, `docker-compose.yml`,
   `k8s/`, `deploy/`, `firebase.json`, `.firebaserc`, `firestore.rules`,
   `firestore.indexes.json` → adapter : `.github/workflows/*` (chemins
   `deploy/cd-finisher.sh`, émulateurs firebase, kustomize), `Makefile`,
   `Dockerfile` (COPY), `.dockerignore`, scripts de déploiement.
2. `services/` : `git mv` des 6 packages → adapter `vitest.config.mts`
   (`live-agent/src/**` → `services/live-agent/src/**`, idem `sandbox`,
   `sdk`), `tsconfig.json` (exclusions), workflows CI qui y lancent des
   tests, Dockerfiles internes (chemins de contexte de build).
3. `e2e/` → `tests/e2e/` : adapter `vitest.e2e.config.mts` + workflow CI e2e.
4. Vérification : suite vitest complète, `npm run build`, CI verte,
   déploiement prod contrôlé (`/version.json`), rollback prêt.

## Phase 3 — Logique métier ⏳

1. Grouper `lib/` par domaine avec `index.ts` public par module
   (interdire les imports profonds) — périmètre proposé : `lib/ai/`,
   `lib/agents/`, `lib/billing/`, `lib/training/`, `lib/observability/`,
   `lib/security/`, `lib/tenants/`, `lib/r2fs/`, `lib/storage/`.
2. Séparer intégrations et domaine : `lib/integrations/` ne contient que
   des adaptateurs (Firebase, R2, Qdrant, Sentry, Composio) ; la logique
   reste dans les modules métier.
3. Clarifier `app/` : fusionner `app/monitoring` (route) et la page
   `app/observability` si redondants ; statut des pages expérimentales
   (`ondes`, `arene`, `essaim`, `monde`, `nova-dashboard`) : **garder**
   (fonctionnalités réelles avec routes API et tests) mais documenter leur
   statut bêta dans le README.
4. i18n : unifier la stratégie entre `app/en/` et les routes FR (décision
   liée au chantier next-intl de `docs/roadmap.md` §2.6).
5. Archiver `agent-ctx/*.md` vers `docs/journal/agent-ctx/` (notes de
   sessions d'agents, valeur historique seulement).

## Phase 4 — Gouvernance & hygiène ⏳ (en continu)

1. `CONTRIBUTING.md` : convention de structure (cible Phase 2), nommage,
   règles de test (co-localisation route vs `tests/unit/`).
2. ESLint `import/no-restricted-paths` : interdire `components/` → `app/`
   et `lib/` → `components/` (hors types).
3. `scripts/check-structure.mjs` en CI : échouer si un `*.test.ts` apparaît
   hors des zones autorisées (co-localisation module ou `tests/`) ou si un
   fichier dépasse un seuil de taille.
4. Un `README.md` court (5 lignes) par dossier de premier niveau.
5. Revue `.gitignore` : `var/`, artefacts de build, `brain-v1.json` et
   résidus locaux ; garder `worklog.md` versionné (décision 1.2).

---

## Registre des vérifications Phase 2

- Résidus : 0 référence vivante aux anciens chemins (balayage des fichiers
  suivis, hors archives/journaux listés ci-dessus et faux positifs
  `lib/deploy/` — module métier homonyme).
- Suite vitest complète verte AVANT push : 433 fichiers / 4 890 tests.
- Historique Git préservé : tous les déplacements en `git mv` (renames R).

## Registre des vérifications Phase 1

- Références obsolètes : 0 occurrence résiduelle de `docs/security/`,
  `docs/saas-roadmap.md`, `docs/roadmap-enterprise.md`,
  `docs/feuille-de-route-google-grade.md` hors `docs/archive/` et
  `docs/journal/` (vérifié par balayage des fichiers suivis).
- Suite vitest complète : à valider avant merge (voir commit).
- Historique Git préservé : tous les déplacements en `git mv` (renames R).

# Feuille de route « Google-grade » — Gen3ia

> Livrable central de la vision 4 piliers : où la plateforme se situe
> aujourd'hui par rapport au standard d'ingénierie Google, élément par
> élément, avec un statut **honnête** et des chemins réels du dépôt comme
> preuves. Document vivant : réévalué à chaque revue trimestrielle
> (cf. [`docs/processus-ingenierie.md`](processus-ingenierie.md) §8).

## Légende des statuts

| Statut | Signification |
|---|---|
| **[FAIT — sur VPS]** | Implémenté et actif dans la production actuelle (VPS 2 Go, PM2 + nginx, déploiement continu). |
| **[PHASE 2 — conteneurisation]** | Préparé/décidé pour la phase conteneurs (Dockerfile + compose) ; le runtime actuel reste PM2 tant que la phase n'est pas déclenchée. |
| **[PHASE 3 — migration GCP]** | Visé pour la migration Google Cloud (GKE, Vertex AI, IAP/mTLS) — conditions de déclenchement explicites au §6. |

**Note sur les références croisées.** Ce document s'appuie sur la session
d'orchestration en cours (worklog, tasks A–F fusionnées et déployées) et sur
les livrables des agents sœurs, référencés **par chemin canonique** :
`docs/sre/sli-slo.md`, `docs/sre/postmortem-modele.md`, la route
`/api/metrics`, rapports `/home/z/my-project/reports/task-G.md` / `task-H.md`
/ `task-I.md`. Si un de ces chemins n'existe pas encore sur `main` au moment
de la lecture, le livrable correspondant est simplement en file
d'intégration : le statut vaut « convenu et implémenté au niveau session »,
la vérification finale reste le run CI/CD sur `main`.

## Vue d'ensemble

| Pilier | État résumé |
|---|---|
| 1. Infrastructure & exploitation | CD continu solide sur VPS unique (swap atomique, rollback, vérification build) ; conteneurisation et orchestration en PHASE 2/3. |
| 2. MLOps & moteur IA | Registre + pipeline à porte + arène locaux testés ; Vertex AI managé en PHASE 3. |
| 3. Sécurité & identité | Deny-by-default, HMAC webhooks, identité de service, scans automatisés — déjà au niveau visé ; IAP/mTLS relève de la PHASE 3. |
| 4. Excellence opérationnelle | Processus trunk-based, revue obligatoire, budgets d'erreur, postmortems, tests de charge — posés et documentés. |

---

## Pilier 1 — Infrastructure & exploitation

| Élément | Statut | Preuve (chemin réel) | Prochaine étape |
|---|---|---|---|
| CI complète : typecheck · lint · tests (couverture) · audit npm · build · budget bundle | **[FAIT — sur VPS]** | `.github/workflows/ci.yml` (job `ci`) | Maintenir les seuils ; budget bundle ajusté par route |
| E2E auth sur émulateur (jamais la prod) | **[FAIT — sur VPS]** | `.github/workflows/ci.yml` (job `e2e`, `firebase.json` émulateurs) | Étendre la couverture e2e aux nouveaux parcours |
| Accessibilité bloquante (axe-core · WCAG 2.1 AA) | **[FAIT — sur VPS]** | `.github/workflows/ci.yml` (job `a11y`) + `scripts/a11y_prod.mjs` | — |
| CD continu avec build sur runner, swap atomique, rollback auto, blacklist SHA, vérification du build servi | **[FAIT — sur VPS]** | `.github/workflows/deploy-vps.yml` + `deploy/cd-finisher.sh` (`.next.old`, `failed_commits.txt`, comparaison `BUILD_ID` ↔ `/api/deploy-info` + `/version.json`) | — |
| Sondes de santé publiques/protégées | **[FAIT — sur VPS]** | `app/api/health/route.ts`, `app/api/status/route.ts`, `app/api/deploy-info/route.ts`, `app/api/health/infra/route.ts` | — |
| Observabilité applicative (logs structurés, OpenTelemetry, alertes, Sentry) | **[FAIT — sur VPS]** | `lib/observability/` (`metrics.ts`, `otel.ts`, `alerts.ts`, `sentry.ts`) | Brancher les alertes sur les budgets d'erreur |
| SLI/SLO + budget d'erreur exposés | **[FAIT — sur VPS]** | `/api/metrics` + `docs/sre/sli-slo.md` (livrable tâche G — cf. note références croisées) | Tableau de bord hebdo (rituel §8 du processus) |
| Tests de charge avant déploiement majeur | **[FAIT — sur VPS]** | `scripts/charge/k6-chat-smoke.js` (10 VU · 60 s, p95 < 3 s, échecs < 1 %) + workflow **manuel** `.github/workflows/load-test.yml` + profils historiques `scripts/load/` + `docs/load-testing.md` | Exécuter le smoke avant chaque migration majeure |
| Runbooks exploitation & incident | **[FAIT — sur VPS]** | `docs/runbooks/deployment.md`, `docs/runbooks/incident-response.md` | Postmortem modèle en `docs/sre/postmortem-modele.md` |
| Conteneurisation (Dockerfile + compose) | **[PHASE 2 — conteneurisation]** | — (préparé §5) | Dockerfile multi-stage + `docker-compose.yaml`, §5 |
| Orchestration GKE + HPA, rollouts canary | **[PHASE 3 — migration GCP]** | — | Conditions de déclenchement §6 |
| CDN multi-régions / édge mondial | **[PHASE 3 — migration GCP]** | — | Cloud CDN derrière GCLB (la cache `deploy/nginx/gen3ia-cache.conf` reste le niveau actuel) |

## Pilier 2 — MLOps & moteur IA

| Élément | Statut | Preuve (chemin réel) | Prochaine étape |
|---|---|---|---|
| Registre de modèles local | **[FAIT — sur VPS]** | `lib/training/repository.ts` (projets/modèles), `lib/training/engines/registry.ts` (moteurs d'entraînement), `lib/training/catalog.ts` (catalogue honnête — n'affiche que ce qui est réellement supporté) ; artefacts lourds déversionnés avec repli documenté (`assets/neural-pretrained/README.md`, `scripts/download-model.sh`) | — |
| Pipeline d'entraînement **à porte** (machine à états, quotas, audit) | **[FAIT — sur VPS]** | `lib/training/orchestrator.ts` (transitions `canTransition` testées dans `lib/training/rules.test.ts`), `lib/training/quotas.ts` (`TRAINING_MAX_UPLOAD_MB`), `lib/training/audit.ts`, `lib/training/timebox.ts` | — |
| Accès système réservé (identité de service des workers d'entraînement) | **[FAIT — sur VPS]** | `app/api/training/_internal/system-only.ts` + `app/api/training/_internal/system-only.test.ts` | — |
| Évaluation continue (arène) | **[FAIT — sur VPS]** | `lib/training/arene-orchestrator.ts`, `app/api/training/projects/[id]/arene/route.ts` | — |
| Suivi de dérive (drift PSI) + métriques qualité | **[FAIT — sur VPS]** | Exposition `/api/metrics` (livrable tâche G) sur la base `lib/observability/metrics.ts` ; suivi des échanges/consolidation du moteur (`lib/neural/evolution.ts`, stats publiques `app/api/neural/public-stats/route.ts`) | Confirmer les fenêtres de comparaison PSI dans `docs/sre/sli-slo.md` |
| Registry / Pipelines / Metadata / Monitoring **managés** (Vertex AI) | **[PHASE 3 — migration GCP]** | — | Correspondances locales ↔ GCP §6 |
| Autoscaling du runtime neuronal | **[PHASE 3 — migration GCP]** | — | HPA sur CPU/RAM GKE ; le moteur reste 100 % local (routeur neuronal exclusif, cf. `lib/ai/router.ts`) d'ici là |

## Pilier 3 — Sécurité & identité de service

| Élément | Statut | Preuve (chemin réel) | Prochaine étape |
|---|---|---|---|
| Deny-by-default (liste blanche + double barrière) | **[FAIT — sur VPS]** | `middleware.ts` + `lib/security/user-access.ts` (contrat testé : `lib/security/user-access.test.ts`, `middleware.test.ts`) + garde canonique `protectRoute` (`lib/security/route-guard.ts`) | — |
| Règles d'accès testées | **[FAIT — sur VPS]** | Suites vitest des barrières (`user-access.test.ts`, `middleware.test.ts`, gardes par route) ; harnais `@firebase/rules-unit-testing` présent dans `package.json` — sa migration v6 est traitée par l'orchestrateur (PR dependabot #30, hors périmètre de ce document) | Rapatrier les règles Firestore natives dans le dépôt si la console reste leur source de vérité |
| Webhooks signés HMAC (timing-safe) | **[FAIT — sur VPS]** | `app/api/webhooks/chariow/route.ts` (`x-chariow-signature`) + `app/api/webhooks/agent-triggers/[token]/route.ts` (`X-Gen3ia-Signature`, `timingSafeStringEqual`) | — |
| Garde des routes coûteuses + quotas | **[FAIT — sur VPS]** | `app/api/monde/simuler/route.ts` (protectRoute avant tout calcul, corps plafonné), rate limits distribué/local (`lib/cache/redis`, `lib/security/rate-limit`) | — |
| Identité de service (endpoints système uniquement) | **[FAIT — sur VPS]** | `app/api/training/_internal/system-only.ts` (403 clair sans détail d'infra), workers système `app/api/video/worker/*`, crons `app/api/cron/*` | — |
| Scans automatisés (SAST, DAST, secrets, dépendances) | **[FAIT — sur VPS]** | `codeql.yml` (CodeQL), `security.yml` (OWASP ZAP baseline), `ci.yml` (gitleaks + `npm audit --omit=dev`), triage documenté `docs/codeql-triage.md` + `docs/security/bug-bounty.md` | — |
| CSP stricte sans `unsafe-eval`, frame-ancestors none | **[FAIT — sur VPS]** | `middleware.ts` (CSP + CSP artefact dédiée) | — |
| IAP (Zero Trust) + mTLS service mesh | **[PHASE 3 — migration GCP]** | — | IAP sur les surfaces admin, mesh Anthos/Istio : Workload Identity remplace les clés de compte de service |

## Pilier 4 — Excellence opérationnelle

| Élément | Statut | Preuve (chemin réel) | Prochaine étape |
|---|---|---|---|
| Trunk-Based Development (branches < 48 h, intégration ≥ 1×/jour, feature flags) | **[FAIT — sur VPS]** | `docs/processus-ingenierie.md` §2 ; pattern flags réel : `lib/billing/payment-provider.ts` (`PAYMENT_PROVIDER` fail-safe), `lib/billing/billing-mode.ts` (`GEN3IA_BILLING_ENABLED`), `AGENT_TRIGGER_WEBHOOK_SECRET` ; flux réel des sessions (branches courtes → merge rafale → 1 déploiement) | Retirer les flags consommés |
| CI/CD standardisé (main toujours vert, jamais de push sur CI rouge) | **[FAIT — sur VPS]** | `docs/processus-ingenierie.md` §3 (pipeline réel job par job) | — |
| Revue de code rigoureuse (1 relecteur distinct, CI verte avant soumission, PR structurée) | **[FAIT — sur VPS]** | `.github/CODEOWNERS` (`* @missock237-spec` — revue obligatoire même en solo), `.github/pull_request_template.md` (contexte / changements / tests / risques & rollback / checklist), règles §4 du processus | — |
| Tests de charge avant déploiement majeur | **[FAIT — sur VPS]** | `scripts/charge/` + `.github/workflows/load-test.yml` (manuel uniquement) + cadre `docs/load-testing.md` | Garder le scénario à jour après chaque montée de capacité |
| Budgets d'erreur (budget épuisé = gel features) | **[FAIT — sur VPS]** | `docs/sre/sli-slo.md` (SLI/SLO + calcul) + règle §5 du processus | Appliquer le gel formellement à la prochaine échéance |
| Postmortems sans blâme (incident prod = postmortem < 72 h) | **[FAIT — sur VPS]** | `docs/sre/postmortem-modele.md` + `docs/runbooks/incident-response.md` | Renseigner les premiers postmortems réels |
| Définition du « fait » (definition of done) | **[FAIT — sur VPS]** | `docs/processus-ingenierie.md` §7 | — |
| Parité dev/prod (environnements conteneurisés) | **[PHASE 2 — conteneurisation]** | — | §5 |
| Staging permanent séparé de la prod | **[PHASE 3 — migration GCP]** | — | Projet/environnement GCP dédié + IAP |

---

## 5. PHASE 2 — Conteneurisation (préparée, runtime actuel PM2)

**Objectif :** parité dev/staging/prod du conteneur, sans dégrader le CD
actuel. **Le runtime de production reste PM2** tant que la phase n'est pas
validée : le conteneur s'ajoute (tests, reproductibilité, migration
future), il ne remplace rien d'emblée.

**Travaux :**

1. `Dockerfile` multi-stage : stage `deps` (`npm ci`), stage `build` (le
   `next build` réclame > 3,5 Go RSS — le build conteneurisé doit tourner
   côté runner CI/CI locale, jamais sur le VPS 2 Go), stage `runner` (image
   slim, `npm start`, user non-root, HEALTHCHECK sur `/api/health`) ;
2. `.dockerignore` (`.next`, `node_modules`, `assets/neural-pretrained/*.bin`
   — artefacts téléchargés au démarrage, cf. `scripts/download-model.sh`) ;
3. `docker-compose.yaml` pour l'environnement de développement/staging :
   app + Qdrant + services annexes, secrets hors image (variables
   d'environnement, même `.env.example` que la prod) ;
4. Le CD actuel ne change pas : `deploy-vps.yml` continue de livrer
   `.next` + `cd-finisher.sh` à PM2. La conteneurisation n'est basculée en
   runtime qu'après : smoke k6 vert dans le conteneur, parité des sondes
   (`/api/health`, `/api/status`, `/api/deploy-info`), rollback documenté
   (retour PM2 en un merge).

**Critères d'acceptation :** image démarre sans `.env` (échec propre),
healthcheck conteneur = sonde applicative, budget bundle inchangé, smoke k6
sous les seuils du §Pilier 1.

## 6. PHASE 3 — Migration GCP (conditions de déclenchement explicites)

**La migration n'est PAS un objectif : c'est une réponse.** Trois
déclencheurs, dont un seul suffit :

| Déclencheur | Seuil concret (mesuré, pas ressenti) |
|---|---|
| **Charge / capacité** | Saturation chronique du VPS : RAM > 80 % sur 7 jours glissants (métriques PM2/hôte), p95 du smoke > 3 000 ms répété, files PM2 qui s'allongent — c'est-à-dire le plafond des **2 Go** atteint sans marge. |
| **Coût** | Le coût de la solution actuelle (temps d'ingénierie perdu en incidents de capacité, surdimensionnement ponctuel du VPS) dépasse durablement l'écart de facturation GCP. À ce jour, un VPS 2 Go reste un ordre de grandeur moins cher qu'un cluster GKE minimum : le coût NE déclenche PAS la migration, il la retarde tant que la charge suit. |
| **Équipe** | Effectif > 1 humain : besoin d'environnements séparés (staging permanent), de revues multi-humains à horaires distincts, d'un accès admin Zero Trust (IAP) plutôt que partagé. |

**Correspondances locales ↔ GCP :**

| Actuel (FAIT — sur VPS) | Équivalent GCP (PHASE 3) |
|---|---|
| VPS + PM2 (`deploy-vps.yml`, `cd-finisher.sh`) | GKE Deployment + **HPA** (ou Cloud Run si la charge reste modeste) ; image de la PHASE 2 |
| nginx (`deploy/nginx/gen3ia-cache.conf`) | Global Load Balancer + Cloud CDN + Cloud Armor |
| Rollback `.next.old` + blacklist SHA | Rollouts progressifs GKE (canary) + analyse d'erreurs |
| `.env.production` + secrets GitHub | Secret Manager (Workload Identity pour l'accès sans clés) |
| Firestore + Firebase Auth | Identiques (natifs GCP) — aucune migration |
| R2 / S3 | Cloud Storage (API S3 compatible) ou R2 conservé |
| Qdrant | StatefulSet GKE ou service managé |
| Redis (`lib/cache/redis`) | Memorystore |
| Registre de modèles local (`lib/training/*`) | **Vertex AI Model Registry** |
| Pipeline d'entraînement à porte (`lib/training/orchestrator.ts`) | **Vertex AI Pipelines** (les portes = étapes conditionnelles + approbations) |
| Métadonnées d'entraînement (Firestore + audit `lib/training/audit.ts`) | **Vertex AI ML Metadata** |
| Drift PSI via `/api/metrics` | **Vertex AI Model Monitoring** (détection de skew/drift managée) + Cloud Monitoring |
| `/api/metrics` + `lib/observability/` (OTel) | Managed Service for Prometheus + Cloud Trace/Logging |
| Identité de service système (`system-only.ts`, workers) | Service accounts GKE + **Workload Identity** + mTLS service mesh (Anthos/Istio) |
| Accès admin (matrice + MFA) | **IAP** en front des surfaces internes |
| Sentry (`lib/observability/sentry.ts`) | Error Reporting (ou Sentry conservé — décision au moment de la migration) |
| CI GitHub Actions (`ci.yml`) | Inchangée + Artifact Registry pour les images |

**Prochaines étapes concrètes PHASE 3 (à ne lancer qu'après un
déclencheur) :** 1) cadrage de coûts sur 30 jours de métriques réelles
(`/api/metrics` + moniteur d'uptime) ; 2) conteneurs PHASE 2 validés en
staging ; 3) projet GCP unique (terraformé, pas à la main) avec Firestore/
Firebase inchangés ; 4) double-write ou bascule DNS douce, smoke k6 +
`docs/load-testing.md` à chaque étape ; 5) postmortem/retour d'expérience
dans les 72 h suivant la bascule.

---

## Prochaines étapes concrètes (par phase)

**Maintenant (FAIT à entretenir) :**
1. Fusionner cette branche (`feat/excellence-operationnelle`) — template PR,
   CODEOWNERS, k6 smoke + workflow manuel, processus, présente feuille de
   route — puis vérifier la prod après déploiement (run `deploy-vps.yml`
   SUCCESS + `/api/health`) ;
2. Réviser hebdomadairement `docs/sre/sli-slo.md` : budget d'erreur comme
   critère de gel/relâchement des features ;
3. Exécuter le smoke k6 (workflow manuel) avant le prochain déploiement
   majeur — le premier run sert de référence JSON.

**PHASE 2 (conteneurisation) :** Dockerfile multi-stage + `.dockerignore` +
`docker-compose.yaml` + validation smoke en conteneur — runtime PM2
conservé jusqu'aux critères d'acceptation du §5.

**PHASE 3 (GCP) :** surveiller les trois déclencheurs du §6 ; aucun travail
de migration ne démarre sans eux. Les investissements FAIT (sondes,
SLI/SLO, tests de charge, processus) sont exactement ce qui rendra la
migration mesurable au lieu d'être une aventure.

# Feuille de route — Gen3ia

> Document unique et vivant de la feuille de route (restructuration Phase 1,
> 2026-10-24). Il fusionne les trois feuilles antérieures — `saas-roadmap.md`,
> `roadmap-enterprise.md` et `feuille-de-route-google-grade.md` — conservées
> telles quelles dans [`docs/archive/`](archive/) pour l'historique et les
> détails (tables de preuves complètes, correspondances GCP, phases de
> migration de données). Réévalué à chaque revue trimestrielle
> (cf. [`docs/processus-ingenierie.md`](processus-ingenierie.md) §8).
>
> Règle d'honnêteté inchangée : un statut ✅ signifie « implémenté et
> vérifiable dans le code ou en production », jamais « prévu ».

## Légende

| Statut | Signification |
|---|---|
| ✅ FAIT | Actif en production (VPS 2 Go, PM2 + nginx, CD continu) ou vérifiable dans le dépôt |
| 🟡 PARTIEL | Socle implémenté ; le reste dépend d'une infra externe ou d'une phase ultérieure |
| ⏳ PLANIFIÉ | Décidé et préparé ; non déclenché (conditions explicites requises) |

## 1. État actuel (synthèse par axe)

| Axe | État | Points clés (preuves dans les archives citées) |
|---|---|---|
| CI/CD & exploitation | ✅ | CI complète (typecheck, lint, tests + couverture, audit, build, budget bundle, a11y axe-core, e2e émulateurs, gitleaks) ; CD VPS avec swap atomique, rollback, blacklist SHA ; sondes `/api/health`, `/status`, `/deploy-info`, `/health/infra` ; runbooks + postmortem modèle ; smoke k6 manuel |
| Observabilité | ✅ | Logs pino structurés, corrélation `traceId` + propagation W3C `traceparent`, spans HTTP OpenTelemetry, `/api/metrics` (Prometheus, SLI/SLO + budget d'erreur), Sentry pont asynchrone + tunnel `/monitoring` |
| Sécurité | ✅ | Deny-by-default (middleware + `route-guard`), webhooks HMAC timing-safe, CSP stricte, scans CodeQL/ZAP/gitleaks, identité de service system-only, zéro-trust documenté (`docs/securite/`) |
| MLOps & moteur IA gen3 | ✅ (local) / ⏳ (managé) | Registre de modèles, pipeline d'entraînement à porte (quotas, audit, timebox), arène d'évaluation, packs d'entraînement réels (`training/` : code, image, visuel, médias, RPIA) ; worker GPU `training-worker/` ; Vertex AI managé = PHASE 3 |
| Multi-tenant SaaS | 🟡 | Organisations + membres + invitations + règles Firestore d'isolation + quotas par plan ; reste : rattacher les collections métier à `orgId` (migration douce par copies lazy) |
| Facturation | 🟡 | Wallet + crédits + compteurs + moteur de coûts + Chariow (SEULE passerelle, décision 2026-10-23) ; conformité à compléter : CGU + politique de confidentialité (RGPD) publiées sur gen3ia.online |
| Scalabilité | 🟡 | Exécutions asynchrones à checkpoints, files logiques idempotentes, ISR ; reste (infra externe) : Redis distribué, file éphémère managée, base analytique |
| Expérience développeur | 🟡 | README, guide technique, SDK TypeScript (`sdk/`), tests vitest + e2e, Makefile ; reste : publication npm du SDK, site de documentation, IaC Terraform/Pulumi |

## 2. Chantiers ouverts (court terme)

1. **Restructuration du dépôt** — Phase 1 livrée (2026-10-24, cf.
   [`docs/plan-restructuration.md`](plan-restructuration.md)) ; Phases 2 à 4
   (infra/, services/, modules métier, gouvernance) planifiées dans ce
   document.
2. **Conformité de commercialisation** — publier CGU + politique de
   confidentialité (RGPD) et étiqueter clairement la bêta sur gen3ia.online.
3. **Sentry Alerts** (action utilisateur) — renseigner `SENTRY_AUTH_TOKEN` +
   DSN, activer les alertes 5xx > 1 % / 5 min, échec webhook Chariow,
   `budget_exceeded`.
4. **Migration Supabase (PostgreSQL)** — infra livrée (ADR-006, schéma + RLS
   + `lib/supabase/`) ; restent P2 double-écriture + backfill par domaine puis
   P3 bascule des lectures (guide : `docs/migration-supabase.md`).
5. **Multi-tenant suite** — rattacher agents/projets/exécutions à `orgId`.
6. **i18n EN** (next-intl) — après la migration Postgres (mêmes fichiers UI).
7. **Retraits techniques** — flags consommés à retirer, migration
   `@firebase/rules-unit-testing` v6, dépendances signalées par dependabot.

## 3. Phases structurelles (conditions explicites, pas d'objectif par défaut)

### PHASE 2 — Conteneurisation ⏳

Préparée (Dockerfile + compose présents), runtime de production **toujours
PM2** tant que les critères ne sont pas validés : image sans `.env` qui
échue proprement, healthcheck conteneur = sondes applicatives, smoke k6 sous
les seuils, rollback documenté (retour PM2 en un merge). Détails :
archive `feuille-de-route-google-grade.md` §5.

### PHASE 3 — Migration GCP ⏳

**La migration n'est pas un objectif : c'est une réponse.** Trois
déclencheurs mesurés, dont un seul suffit (détails + correspondances
locales ↔ GCP : archive `feuille-de-route-google-grade.md` §6) :

| Déclencheur | Seuil concret |
|---|---|
| Charge / capacité | RAM > 80 % sur 7 jours glissants, p95 smoke > 3 000 ms répété, files PM2 qui s'allongent (plafond 2 Go atteint) |
| Coût | Le coût réel (ingénierie perdue en incidents de capacité) dépasse durablement l'écart de facturation GCP |
| Équipe | Effectif > 1 humain : staging permanent, revues multi-humains, accès admin IAP |

## 4. Décisions structurantes en vigueur

- **Isolation hybride** `isolation: pool|silo` sans custom claims org (les
  règles Firestore lisent `members/{uid}`, source de vérité).
- **Chariow est la seule passerelle de paiement** (2026-10-23) : toute autre
  passerelle d'encaissement répond 501 (`PAYMENT_PROVIDER` fail-safe).
- **Cible données relationnelles : Supabase** (PostgreSQL 15 + RLS), Firebase
  Auth conservé, Firestore garde le temps réel.
- **CSP `connect-src` pragmatique** (Firebase, Composio, Sentry, webhooks) ;
  resserrement par allowlist après audit des domaines réellement appelés.
- **VPS 2 Go reste le runtime** tant que la charge suit ; le coût NE
  déclenche PAS la migration GCP, il la retarde.

## 5. Historique / archives

| Document archivé | Périmètre d'origine |
|---|---|
| [`archive/saas-roadmap.md`](archive/saas-roadmap.md) | Plan « SaaS de niveau enterprise » : multi-tenancy, scalabilité, observabilité, sécurité, facturation, DX (passe multi-tenant + connecteurs @, septembre 2026) |
| [`archive/roadmap-enterprise.md`](archive/roadmap-enterprise.md) | Recommandations nécessitant décision produit ou compte externe : Sentry (Task 40/ADR-005), migration Supabase (ADR-006), accessibilité & i18n (Task 39) |
| [`archive/feuille-de-route-google-grade.md`](archive/feuille-de-route-google-grade.md) | Vision 4 piliers « Google-grade » avec preuves par chemin, PHASE 2 conteneurisation (§5), PHASE 3 GCP et déclencheurs (§6) |

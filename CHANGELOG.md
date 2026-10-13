# Changelog

Tous les changements notables de ce projet seront documentés dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/)
et ce projet adhère au [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Le projet n'a pas encore de release taguée : la section active est `[Non publié]`
> (intégration continue sur `main`, chaque tâche validée par tsc/eslint/vitest puis
> déployée sur <https://gen3ia.online>). L'historique antérieur est condensé par
> grandes vagues de travaux ; le détail complet vit dans `worklog.md`.

## [Non publié]

### Ajouté

- **Appels vocaux IA pilotés par Bland AI (Task 139)** : refonte complète du
  système d'appel vocal — suppression de l'infrastructure Twilio/Plivo
  (webhooks, numéros virtuels, renouvellements) et migration vers Bland AI.
  Synchronisation automatique agent Gen3ia ⇄ agent Bland (création v2,
  snapshot prompt/personnalité/langue/voix, publish + promote, resynchro
  dès que la config change), Call App reconstruite (suivi live Bland,
  transcript, enregistrement, résumé IA, arrêt d'appel), webhook
  post-appel signé (X-Webhook-Signature HMAC-SHA256), tool `phone.call`
  rebranché sur Bland, facturation miroir à la minute (wallet) et quota
  journalier. Variables : `BLAND_API_KEY`, `BLAND_WEBHOOK_SECRET`,
  `BLAND_WEBHOOK_BASE_URL`, `GEN3IA_MAX_DAILY_VOICE_CALLS`,
  `GEN3IA_VOICE_CALL_MIN_BALANCE_MINOR`.

- **Studio vidéo « CapCut » (Task 119)** : synchro voix-visuel audio-réactive
  (beat/énergie — la vidéo suit la voix), sous-titres **karaoké ASS** (surlignage
  mot à mot calé sur la voix), 6 nouvelles transitions/effets (`punch_zoom`,
  `glitch`, `light_leak`, `parallax_depth`, `teal_orange`, `bleach_bypass`),
  et QC du **contrat utilisateur** (durée demandée ±10 %, ratio, captions,
  narration).
- **Vitesse du pipeline vidéo (Task 120)** : pool de concurrence des assets,
  chevauchement assets∥voix, rendu des segments en parallèle, preset `veryfast`,
  assemblage sans ré-encodage quand il n'y a que des coupes franches.
- **Routage automatique des demandes de code vers Jules (Task 121)** : détection
  FR/EN déterministe dans le chat IA, clarification `owner/repo`, session
  asynchrone (jules.google, API v1alpha) suivie par ticks, livraison idempotente
  du résultat dans le fil d'origine ; sans clé : réponse honnête « intégration
  en préparation », puis traitement par les outils internes.
- **Terminal intégré réel pour l'agent IA (Task 122)** : outil `terminal.run` —
  exécution réelle en-processus (mode serverless : env nettoyé, `/tmp`,
  ulimit, deny-list durcie, timeout, sortie plafonnée), chaîne honnête
  Docker > serverless > simulation (le mode réel est toujours renvoyé).
- **Audio livré directement dans le fil (Task 123)** : lecteur `<audio>` intégré
  au fil de discussion (source résolue à la demande depuis la clé R2 permanente)
  + téléchargement direct — fin des liens markdown expirés au bout d'une heure.
- **Vitesse de traitement globale (Task 124)** : pump multi-tickets de la file
  (rattrapage par lots parallèles, backoff 10 s), exécution parallèle des étapes
  indépendantes du DAG de mission (~3 en concurrence), lectures agrégées `GET`
  (somme → max), `maxDuration` 300 s sur les routes lourdes.
- **Clés API entreprise `g3a_` (Task 126)** : identifiants de compte à scopes
  nominaux (`media`/`agents`/`terminal`/`read`) et quota par clé (req/min,
  défaut 60, plafond 600), créées/révoquées en self-service dans
  **Paramètres → Clés API** ; seul le hash SHA-256 est persisté, la clé complète
  n'est affichée qu'une fois ; auth `/api/v1` par `Authorization: Bearer g3a_…`
  ou `X-API-Key: g3a_…` (prioritaire sur la chaîne développeur `g3x_`).
- **Statut public `GET /api/status` (Task 126)** : `{ status, version, services:
  { auth, r2, ticks }, checkedAt }` — `200`/`503` pour les moniteurs d'uptime,
  cache CDN 30 s ; complète `/api/health` (heartbeat sans dépendance) et
  `/api/health/infra` (détails, protégé).
- **Export RGPD self-service (Task 126)** : agrégation profil + conversations +
  messages + artefacts + jobs + mémoire en JSON versionné, livré par URL R2
  signée courte (5 min) — le document ne transite jamais dans la réponse ;
  sections fail-soft, rate-limit 3/h, audit.
- **Journal d'audit `auditEvents` (Task 126)** : trace des actions admin
  destructrices (migration Firestore→R2, décisions de payout, rapprochement
  facturation) — acteur, issue, cible, métadonnées redactées ; best-effort.
- **Finitions Task 127** : `ErrorBoundary` global (SVG inline, tokens g3),
  `ProductionAlerts` (logger + Sentry avec cooldown), métriques OTel réelles,
  `IntelligentModelRouter` (sélecteur tâche/urgence/budget + cache borné),
  `TokenBudgetManager` (suivi de budget par utilisateur + notifications).
- **Documentation (Task 129)** : spécification **OpenAPI 3.1** de l'API publique
  (`docs/api/openapi.json`), référence humaine (`docs/api-reference.md`),
  runbooks opérationnels (`docs/runbooks/`), ce CHANGELOG — la spec est validée
  en CI par `docs/openapi.test.ts` (aucun chemin documenté sans route réelle).

### Changé

- **Identité visuelle 2 couleurs (Task 125)** : EXACTEMENT deux teintes
  chromatiques — violet `#7C5CFF` (strong `#9E85FF`) + cyan `#2AD4E8` (strong
  `#7FE9F5`) — sur toute la plateforme, thèmes sombre et clair (108 fichiers :
  tokens, composants, SVG inline, sous-titres ASS, charts ECharts) ; dégradés
  signature réduits à 2 stops ; tests verrouillant la nouvelle palette et
  bannissant les 16 anciennes teintes.
- **Persistance R2 des artefacts de rendu vidéo (Task 127)** : chaque
  segment/montage/master est téléversé dans R2 dès sa production — une instance
  relais re-télécharge au lieu de re-rendre (fin des boucles de re-rendu :
  vidéo 10 s livrée en ~6 min au lieu de ~28 min).
- **Dépendances (Task 128)** : `next` 15.5.27, `react`/`react-dom` 19.3.0,
  `@aws-sdk` 3.1147.0, `@composio/core` 0.22.0, `docx` 9.9, `pptxgenjs` 4.0.1,
  workflows GitHub Actions montés (`checkout@v7`, `setup-node@v6`, `cache@v6`,
  `gitleaks-action@v3`).
- **Migration vitest 5 (Task 128)** : `vitest` + `@vitest/coverage-v8` ^5.0.3
  montés ensemble (fix ERESOLVE) — 3 245 tests verts, compteur identique,
  couverture 88,1 %.

### Corrigé

- **CI `main` réparée (Task 128)** : suppression d'`app/manifest.ts` (script
  Service Worker collé par un commit externe dans un module de route Next.js —
  typecheck et build cassés) ; le PWA reste couvert par
  `public/manifest.webmanifest` + `public/sw.js`, verrouillés par tests.
- **Résolution des 15 pull requests ouvertes (Task 128)** : 2 fermées avec
  justification (déjà intégrée dans main / contredisait l'architecture — service
  Redis externe supprimé volontairement en Task 108), 13 intégrées en une passe
  QA unique (`373c0f3`) avec traçabilité complète ; 0 PR ouverte restante.

### Sécurité

- **Durcissement Task 127** : `encryption.ts` type-safe AES-256-GCM
  (`adminDb`, store/load des clés utilisateur), rate-limiter sur le mécanisme
  existant (budgets user 100/min + IA 20/h, double couche locale + distribuée),
  validation App Router (`parseValidatedBody` + `createAgentSchema`),
  `next.config` débarrassé d'un bloc dupliqué (double export/identifiants).
- **Clés API (Task 126)** : quota par clé vérifié **avant** toute exécution
  métier, révocation soft immédiate et auditable, garde d'hygiène 10 clés
  actives/compte, secrets jamais en clair (convention « secret-envelope »).

---

## Historique condensé

> Condensé par grandes vagues — le détail par tâche vit dans `worklog.md`.

### Vague « Fondations production » (Tasks 41–57)

Déploiement et variables d'environnement Vercel ; 8 axes d'évolution IA ;
recommandations de l'audit de production livrées de bout en bout : file
d'attente asynchrone + `runId` + SSE (missions longues), dual-write, alerte de
solde, perf/cache CDN, scoping `orgId` multi-tenant systématique sur toutes les
collections, tri complet du backlog SAST CodeQL (P1 → P3, services annexes et
outils dev inclus), activation production de la file d'attente.

### Vague « Concepts post-SaaS » (Tasks 64–68)

Les 10 concepts post-SaaS installés : contrats de résultat + porte d'objectif +
avoir automatique (Goal-as-a-Service / Outcome-as-a-Service), réseaux d'agents
persistants + messagerie d'équipe, Intent-to-Infrastructure, moteur
Réel→Numérique, auto-évolution (clusters d'échec + replanification dynamique),
pulse business autonome.

### Vague « Améliorations produit » (Tasks 69–80)

E2E multi-tenant (7 scénarios émulateurs, correctif d'assertion `orgId`),
marketplace avancé (paiement wallet, part développeur 80/20 réellement
enregistrée, catalogue paginé keyset, modération d'avis), terminal utilisateur,
tâches planifiées avancées, skills, prompts système, chat plein écran, pièces
jointes 10×50 Mo utilisables par l'agent, missions qui survivent au refresh ;
**GEN3IA VIDEO AGENT** (moteur de production vidéo autonome piloté par l'agent,
spécification 30 sections / 18 modules) ; payouts développeurs et
renouvellement auto des abonnements extensions.

### Vague « Durcissement & quota Firestore » (Tasks 98–104)

Amélioration globale multi-lots + durcissement sécurité ; PWA complet (push
serveur Web Push/VAPID, splash iOS, `clients.claim()`, offline) ; réduction
drastique du quota Firestore (agrégats `usageDaily` 1 doc/jour/utilisateur,
sweep des plannings indexé `wakeAtMs`, suppression de code mort, scans `orderBy`
serveur + index composites) ; lot voix (clonage vocal ElevenLabs réellement
branché, persistance R2) ; correctifs CodeQL hautes (épinglage release +
checksums SHA256 des binaires FFmpeg runtime) ; webhook Chariow résilient
(reprise, dédoublonnage par `saleId`, rapprochement périodique) ;
`request-forgery` QStash corrigée (origine canonique serveur + allowlist).

### Vague « Migration R2 & fiabilité » (Tasks 110–118)

Diagnostic de l'exécution bloquée en conversation ; **migration R2 totale**
(file de missions, wallet/billing, approbations HITL, audit, notifications,
workflows, domaines admin) ; repli images Hugging Face (Z-Image-Turbo) +
analyses image/vidéo/audio connectées à l'agent ; génération vidéo et voix-off
garanties (jamais un échec brut) ; **V2** : escrow de mission (frais réservés /
capturés / libérés), Jumeau Créatif, marketplace d'agents (publication à la
location, location avec escrow et avis), interface universelle ; correctifs de
production en conditions réelles (génération média sans approbation abusive,
quota 100 req/min/utilisateur, charge multi-comptes 902 req/min sans erreur) ;
suppression de QStash au profit d'une **file de ticks R2 durable** (tickets +
self-délivrance + pump opportuniste + sentinelle cron) ; garde cross-instance
de l'étape exports des rendus vidéo (fin des échecs définitifs après
interruption).

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

- **Génération multimodale scénique v2 — texte/son/vidéo/image SANS GPU,
  entraînement HORS PRODUCTION** : les trois moteurs média locaux passent de
  l'abstrait neuronal (constellation v1) à la génération SCÉNIQUE — l'analyseur
  sémantique (`lib/neural/generation/scene-spec.ts`, FR/EN : sujets, cadres,
  moments, météos, styles, ambiances, couleurs, sons ; correspondance
  longest-prefix « château » ≠ « chat », locutions, cadres implicites
  phare→mer/vache→campagne) pilote trois moteurs en calques :
  `visual-scene.ts` (illustration vectorielle → PNG via sharp : ciel du moment,
  astre, météo, 8 cadres, 25 sujets dessinés, 6 styles), `audio-composition.ts`
  (WAV PCM 16 bits : 11 couches SFX synthétisées + musique structurée — tempo
  et mode majeur/mineur dérivés de l'ambiance, motif tiré des synapses
  APPRISES), `video-storyboard.ts` (SVG animé SMIL : 1–4 scènes découpées du
  prompt, caméra pan/zoom alternée, sujet flottant, météo vivante — pluie qui
  tombe, éclairs, neige, brouillard —, oiseaux en vol, fondus enchaînés).
  Déterminisme bit-à-bit conservé (même prompt + même état cérébral = même
  œuvre) ; repli v1 ASSUMÉ et nommé (`gen3-snn-*-v1-constellation`) quand
  rien n'est reconnu ; clés de cache de contenu bumpées v2 ; méta honnêtes
  (`moteur`, scène reconnue, couverture, mots reconnus, calques/couches).
  ENTRAÎNEMENT HORS PRODUCTION (directive : la production charge, elle ne
  s'entraîne pas) : `scripts/pretrain-multimodal.ts` — corpus bilingue annoté
  (48 phrases, jeu de test tenu à l'écart), 140 enseignements validés (aucun
  conflit avec l'intégré, aucune valeur hors liste, aucun nouveau sujet non
  rendable), précision attendus mesurée 0.913 → 1.000 (train) / 1.000 (test),
  artefact committé `assets/neural-pretrained/multimodal-lexique-v1.json`
  chargé au runtime (`lexique-serveur.ts`, échec doux) + rapport honnête.
  Cortex langagier enrichi (6 paires « multimodal » : le moteur explique ses
  capacités et ses écarts) ; console Cerveau IA : libellés atelier média
  alignés (scènes décrites, repli v1 documenté) ; doc
  `docs/multimodal/gen3-multimodal.md` (modalités, entraînement, niveaux de
  référence ChatGPT/Leonardo/ElevenLabs/Veo avec écarts assumés). 63 tests
  dédiés (analyseur, 3 moteurs, entraîneur + round-trip artefact, câblage
  media-service v2/v1).

- **Recharge rapide du wallet API via le widget Chariow (`prd_llfosdp1`)** :
  widget boutique officiel rendu dans la carte « GEN3IA WALLET » de `/billing`
  (raccourci de paiement direct à côté du flux Mobile Money existant, via le
  même composant `ChariowWidget`) ; le webhook Pulse reconnaît les ventes du
  produit par identifiant (`CHARIOW_TOPUP_PRODUCT_ID` → défaut boutique
  `prd_llfosdp1`, sinon métadonnée `gen3ia_product = wallet_topup`) et crédite
  le solde de façon idempotente (`chariow_<saleId>`, journal partagé avec le
  retour de paiement vérifié) ; devise wallet alignée sur la boutique
  (`GEN3IA_WALLET_CURRENCY=XAF` — le webhook refuse toute recharge dans une
  autre devise) ; repli boutique `CHARIOW_TOPUP_STORE_URL` exposé par
  `GET /api/billing/wallet` et affiché en lien secondaire ; doc
  `docs/billing/chariow-plans.md` §8 (cycle paiement → webhook → solde).
- **Paiements Chariow — les 3 produits payants branchés de bout en bout** :
  mappage des produits réellement publiés (`prd_svqonju7` → Pro 9 750 FCFA,
  `prd_v76f5kjl` → Entreprise 325 000 FCFA, `prd_646qpmge` → Sur-Mesure
  995 000 FCFA) comme replis par défaut de `lib/billing/plans.ts` (env prime
  toujours) ; les trois offres deviennent achetables, l'activation de licence
  reconnaît les trois produits ; composant `ChariowWidget` (injection
  idempotente du loader officiel + re-scan au remontage React) et section
  « Paiement direct sur la boutique Chariow » sur `/billing` ; CSP ouverte au
  strict minimum (`js.chariowcdn.com` script/style/frame, `*.mychariow.shop`
  frame/connect) ; script `chariow_plans_status.mjs` et doc billing alignés
  sur les prix boutique (source de vérité du paiement).
- **Timebox d'entraînement réduite à 30 min par modèle** : la garantie produit
  « un entraînement ne dépasse jamais trente minutes, par modèle, par session »
  (lib/training/timebox.ts : plafond physique entre chaque round, verrou TTL
  timebox + 5 min, bornage défensif des durées demandées) ; message 409 et
  badge de l'Arène d'Ondes mis à jour. La fenêtre d'absorption des datasets
  (2 h) reste inchangée.

- **Suite « outils pilotés par les agents IA » — 16 nouveaux outils (Task 140)** :
  `handover.compose` (brief de relais IA → humain : intention, état émotionnel,
  blocages, données collectées — livrable persisté), `terminal.shield` (terminal
  protégé : pré-analyse des chemins, interception des erreurs de build,
  auto-réparation bornée), `registry.find` (vérification EN DIRECT des packages
  npm/PyPI : existence, version, fraîcheur, dépréciation, MCP), `build.autofix`
  (log de build → localisation de la ligne fautive → correctif → pull request
  GitHub automatique, gated `GITHUB_TOKEN`), `simulation.run` (studio de
  simulation multi-personas — novice, hacker, acheteur pressé… — rapport de bugs
  comportementaux), `browser.navigate` (navigation adaptative anti-robots : UA
  rotatifs, backoff, détection honnête des challenges), `schema.extract` (pages
  non structurées → tableaux JSON typés selon schéma cible ou auto-détection),
  `voicemail.respond` (répondeur vocal : extraction du besoin + réponses
  rédigées + expédition email/SMS via canaux configurés), `transcript.redact`
  (masquage déterministe temps réel : cartes Luhn, IBAN, CVV, mots de passe,
  téléphones, NIR), `ivr.navigate` (analyse d'arbre SVI + plan DTMF optimal),
  `webhook.heal` (passerelle auto-réparatrice : diagnostic, payload adapté,
  re-soumission signée HMAC), `watchdog.track` (veille de pages : référence
  hashée, diff, classification stratégique vs cosmétique), `terminal.guide`
  (session terminal → guide interactif pas-à-pas persisté), `content.package`
  (idée → pack complet : angles, script scène par scène, SEO, miniature),
  `knowledge.graph` (documents → graphe de concepts pondérés + SVG déterministe),
  `decision.analyze` (moteur probabiliste déterministe : espérance, Monte-Carlo
  seedé, VaR/CVaR, sensibilité, recommandation par tolérance au risque).
  Chaque outil est enregistré au registre exécutable, annoncé au catalogue du
  planificateur (`GEN3IA_TOOLS`), couvert par `TOOL_SECURITY`, labellisé FR et
  pilotable depuis les missions agents, le chat et la console — les 7 outils
  internes ne déclenchent aucune carte de validation (directive 10-10), les 3
  externes (`build.autofix`, `voicemail.respond`, `webhook.heal`) passent par la
  validation humaine. Indices d'intention déterministes FR (tool-intent) pour
  l'auto-sélection par le planner. Socle partagé : `generateStructuredForUser`
  (LLM facturé wallet + zod + relance corrective) et `persistMarkdownDeliverable`
  (livrables persistés dans le stockage privé).

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

# Décisions d'architecture — Gen3ia

> Journal des décisions techniques structurantes. Chaque entrée expose le
> contexte, les options envisagées, la décision et les déclencheurs de
> réévaluation. Statuts : `Proposée` / `Acceptée` / `Supplantée`.

---

## ADR-001 — Séparation back/front : conserver les routes API Next.js

**Statut :** Acceptée (réévaluation planifiée) · **Date :** 2026-09-19

### Contexte

Le backend actuel vit dans les route handlers `app/api/**` (Next.js 15,
runtime Node). La plateforme appelle aujourd'hui ~45 routes : agents,
billing, live, voice (Twilio/Plivo), extensions, storage R2, équipes,
code-agents (21st.dev), webhooks Chariow. Plusieurs traitements longs
(exécutions d'agents, gateway Live WebSocket sur `lib/live/gateway-server.ts`)
dépassent le périmètre naturel d'une route HTTP.

### Options envisagées

1. **Statu quo — routes API Next.js** : déploiement unique, auth par cookie
   partagé simple, cold starts maîtrisés, latence minimale pour le front.
2. **API dédiée (Fastify)** : process séparé, testabilité unitaire supérieure,
   scaling horizontal indépendant ; coût = deuxième déploiement, auth à
   re-câbler (JWT cross-service), duplication des types ou monorepo pnpm.
3. **API dédiée (NestJS)** : les bénéfices du 2 + DI/modularité forte ;
   coût additionnel = courbe d'apprentissage et boilerplate, poids
   disproportionné à la taille actuelle de l'équipe.

### Décision

**Conserver les routes API Next.js** tant que les trois déclencheurs
ci-dessous ne sont pas réunis. En cas de déclenchement, **Fastify** est
préféré à NestJS : le runtime Node + zod + pino existants s'y retrouvent
à l'identique, sans framework imposé.

### Déclencheurs de réévaluation

- Exécutions d'agents > 60 s systématiques (besoin de files durables :
  BullMQ/Redis plutôt que des fonctions serverless).
- Besoin de connexions WebSocket persistantes multi-régions (le gateway
  Live actuel est un process Node séparé — premier candidat à l'extraction).
- Équipe backend dédiée ≠ équipe frontend (conway).

### Mesures d'atténuation actuelles

- Logique métier déjà massivement extraite dans `lib/**` (modules purs,
  testés hors HTTP) — une extraction future de l'API serait un transport
  swap, pas une réécriture.
- Contrats d'entrée validés par zod sur toutes les routes sensibles.

---

## ADR-002 — State management global : ne pas introduire Zustand/Redux

**Statut :** Acceptée (conditionnelle) · **Date :** 2026-09-19

### Contexte

L'état client est aujourd'hui : état d'authentification Firebase
(`lib/firebase/auth-client.tsx`), état serveur (fetch + `useState` locaux),
navigation (URL). Aucun partage d'état mutable complexe entre pages.

### Décision

**Ne pas introduire** de store global tant que les déclencheurs suivants ne
sont pas réunis. Raison : un store global ajouterait une couche de
synchronisation à maintenir sans consommateur réel ; le risque d'état
divergent avec le serveur (wallet, exécutions) augmenterait.

### Déclencheurs

- Présence de state partagé entre ≥ 3 pages non liées par navigation
  (ex. : panier d'outils multi-pages, sessions Live observées en direct).
- Nécessité d'optimistic updates généralisés sur le wallet.
- Tables temps réel (exécutions en cours) consommées par plusieurs
  composants simultanément → préférer alors un store par domaine
  (Zustand slices) plutôt qu'un Redux Toolkit global.

---

## ADR-003 — Fichiers volumineux : découpage incrémental par responsabilité

**Statut :** Acceptée · **Date :** 2026-09-19

### Décision

Les composants dépassant ~400 lignes sont décomposés quand une frontière
naturelle existe, sans changement de comportement :

- `components/nav/app-nav.tsx` (304 → 182 lignes) : palette ⌘K extraite
  vers `components/nav/command-palette.tsx`, inventaire de navigation
  vers `components/nav/nav-items.ts` (source unique partagée).
- `components/agent/universal-agent-chat.tsx` (537 lignes) : candidat au
  découpage (bulles de message, barre d'approbation, état de conversation)
  lors de la refonte professionnelle du chat.

Règle : un fichier porte **une** responsabilité visible ; les hooks
d'état complexes migrent vers `components/**/use-*.ts` dès qu'ils sont
réutilisés ou testables isolément.

---

## ADR-004 — Chats agents IA : professionnalisation du rendu et du flux

**Statut :** Proposée · **Date :** 2026-09-19

### Contexte

Les conversations (`chatConversations`/`chatMessages`, Admin SDK) et le
chat universel agent rendent aujourd'hui du texte brut/approbations sans
distinction visuelle des étapes, coûts ou artefacts.

### Décision proposée

1. Rendu structuré : bulles par rôle, étapes du plan RuntimePlan
   (llm/tool/code/document) avec statut, coût par étape, artefacts liés.
2. Flux d'approbation : actions sensibles affichées en bloc dédié avec
   `approvalId`, boutons autoriser/refuser, traçabilité visible.
3. Accessibilité : `role="log"` sur le fil, annonce des nouveaux messages,
   navigation clavier complète.

La mise en œuvre est réalisée avec la refonte du chat universel
(`components/agent/universal-agent-chat.tsx`).

---

## ADR-005 — Observabilité Sentry native (erreurs, traces, replay)

**Statut :** Acceptée · **Date :** 2026-09-29

### Contexte

La supervision reposait sur les logs structurés pino + les trace-id
middleware. Les erreurs côté NAVIGATEUR n'arrivaient jamais aux équipes
(la console de l'utilisateur n'est pas observable), et aucune carte de
latence serveur n'était disponible. Rec 4 du plan enterprise exigeait le
niveau « observabilité configurée ».

### Décision

1. SDK **@sentry/nextjs** complet : `instrumentation.ts` (runtimes nodejs
   + edge), `instrumentation-client.ts` (navigateur), hook
   `onRequestError` (routes API/RSC), capture dans les boundaries
   `error.tsx` et `global-error.tsx`.
2. **Tunnel `/monitoring`** (route dédiée, liste blanche stricte des
   hôtes d'ingestion) : les événements traversent les bloqueurs de
   publicités ; le tunnel ne peut pas devenir un proxy ouvert.
3. **Confidentialité** : `sendDefaultPii: false`, scrubbing `beforeSend`
   (Authorization/cookies/query retirés), replay masqué par défaut,
   erreurs tiers (AdSense, OAuth) ignorées. Le DSN est public par
   conception ; le SENTRY_AUTH_TOKEN est un secret de build (source maps).
4. `lib/observability/sentry.ts` reste le point d'entrée canonique du
   code serveur (API inchangée, repli pino systématique).

### Conséquences

- Traces 15 % côté serveur / 10 % côté client ; replay 2 % (100 % si erreur).
- Build sans `SENTRY_AUTH_TOKEN` = vert, stacks minifiés (dégradation assumée).
- `config-report` expose le groupe `observability-sentry` (présence, jamais de valeurs).

---

## ADR-006 — Migration des données vers un second backend (PostgreSQL) — RETIRÉE

**Statut :** Retirée (Task 108) · **Date initiale :** 2026-09-29

Décision initiale : second moteur de données PostgreSQL piloté par
`DATA_BACKEND` avec double-écriture et repli sous quota (Task 40-101).

Retrait (Task 108) : le second backend et son miroir ont été SUPPRIMÉS du
projet — Firestore est de nouveau l'unique moteur transactionnel (wallet,
files vidéo, temps réel) et R2 le stockage d'objets/identité. Le cache et
les compteurs sont process-local (`lib/cache/redis.ts` réimplémenté en
mémoire). Le guide de migration et les migrations SQL correspondantes ont
été retirés.

---

## ADR-007 — Monétisation publicitaire : AdSense confiné aux surfaces publiques

**Statut :** Acceptée · **Date :** 2026-09-29

### Contexte

La vitrine publique (SEO/GEO) génère du trafic non monétisé. Le modèle
SaaS existant (abonnements, crédits, marketplace) est complété par la
demande explicite d'intégrer Google AdSense (client `ca-pub-716856…`).

### Décision

1. **Périmètre strict** : le composant `AdSenseAd` n'est monté que sur
   les pages de contenu public (vitrine). Jamais dans le workspace ni
   les routes applicatives — zéro poids bundle sur les surfaces
   d'exécution, conformité produit (expérience agent non dégradée).
2. **CSP augmentée au minimum** : script-src + frame-src ciblent les
   domaines AdSense/DoubleClick ; `unsafe-eval` reste interdit.
3. `public/ads.txt` servi à la racine (autorisations DIRECT officielles).
4. **Performance** : preconnect TLS pagead2 dans le layout, loader
   `lazyOnload` (dès que le navigateur est inactif), file
   `window.adsbygoogle` officielle (push avant chargement = sûr).

### Conséquences

- Revenus publicitaires actifs sans toucher au cœur SaaS.
- Sans `NEXT_PUBLIC_ADSENSE_CLIENT`, le composant ne rend rien (aucune
  régression locale/test).

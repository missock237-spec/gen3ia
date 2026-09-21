# Gen3ia — Plateforme SaaS d'Agents IA Autonomes

**Gen3ia** est une plateforme SaaS enterprise de création, orchestration et exécution d'agents IA autonomes. Conçue avec **Next.js 16 (App Router)**, **React 19** et **Firebase**, elle combine un moteur de chat intelligent, une boucle d'exécution autonome (Planner-Executor-Evaluator), la vision live en navigateur, la téléphonie interactive, la publication multi-canal de publicités via Composio, et un écosystème d'extensions marketplace multi-tenant.

**Production : <https://gen3ia.online>**

---

## 🌟 Fonctionnalités Clés

### 🤖 Studio & Chat Agent Intelligent
- **Création guidée** : Définition de l'identité (nom, description, chartes générées, compétences, mémoire dédiée, type personnalisé).
- **Classification automatique des requêtes** : Traitement instantané des réponses directes LLM vs déclenchement de missions d'exécution autonomes.
- **Invocations d'outils `@`** : Activation à la volée de connecteurs (Gmail, Notion, Slack, GitHub, Jira...) directement dans le fil de discussion.
- **Approbations de sécurité** : Validation humaine obligatoire pour l'exécution d'actions sensibles.

### 🔄 Boucle d'Exécution Autonome & Planification
- **Moteur Planner-Executor-Evaluator** : Décomposition dynamique de tâches complexes en plans d'action ordonnés.
- **Règles & Garde-fous** : Limites de profondeur d'exécution, arrêt d'urgence, vérification d'idempotence et contrôle du budget.

### 🌐 Agent Live Navigateur & Vision
- **Capture d'écran native** : Contrôle et analyse du navigateur via `getDisplayMedia` sans installation de logiciel PC externe.
- **Décideur Vision Multi-Fournisseurs** : Moteur de vision résilient avec repli automatique (OpenAI → Groq → Agnes).

### 📞 Téléphonie & Agent Vocal
- **Appels sortants et entrants** : Intégration complète Twilio et Plivo pour la gestion de conversations téléphoniques interactives.
- **Synthèse vocale avancée** : Voix naturelles propulsées par ElevenLabs.

### 📢 Publication Ads & Marketing
- **Connexions multi-plateformes** : Intégrations Meta Ads, Google Ads, TikTok Ads et LinkedIn Ads via Composio.
- **Génération & Garde-fous de budget** : Moteur de création de contenus publicitaires avec plafonds de dépense stricts.

### 🏢 Multi-Tenancy & Organisations Enterprise
- **Gestion des équipes** : Rôles granulaires (Owner, Admin, Member), système d'invitations sécurisées par lien expirable (7 jours).
- **Isolation des données** : Isolation Firestore au niveau organisation et quotas paramétrables par plan (Free, Pro, Enterprise).

### 🧠 Mémoire RAG Épisodique & Connaissances
- **Recherche sémantique & Vectorielle** : Indexation de documents, recherche d'embeddings, résumés épisodiques automatiques.
- **Calcul de charge cognitive** : Suivi de la charge cognitive d'équipe et agrégation de connaissances.

### 🛒 Marketplace d'Extensions & Code Agents
- **Écosystème de modules** : Publication, revue d'administration, installation et exécution d'extensions tierces.
- **Génération UI 21st.dev** : Intégration de composants UI réutilisables et générateur de thèmes et logos.

### 📊 Observabilité & Facturation
- **Traçabilité `traceId`** : Corrélation de chaque requête API avec logs structurés JSON Pino.
- **Moteur de coûts & Wallet** : Suivi précis des consommations de tokens, des appels d'outils et des crédits d'exécution.

---

## 🏛️ Architecture du Projet

| Dossier / Fichier | Rôle dans l'application |
|---|---|
| `app/` | Routes Next.js 16 (App Router) : `(auth)`, `admin`, `api`, `billing`, `dashboard`, `live`, `marketplace`, `memory`, `observability`, `studio`, `team` |
| `components/` | Composants UI React 19 modulaires (`agent`, `auth`, `home`, `integrations`, `marketplace`, `memory`, `nav`, `observability`, `studio`, `team`, `ui`) |
| `lib/` | Logique métier centralisée : `agents`, `ai`, `billing`, `documents`, `extensions`, `firebase`, `integrations`, `live`, `memory`, `observability`, `security`, `skills`, `tenants` |
| `functions/` | Firebase Cloud Functions backend |
| `docs/` | Documentation technique, bilans d'analyse, décisions d'architecture et roadmap SaaS |
| `e2e/` & `vitest/` | Tests d'intégration E2E et suites de tests unitaires |

---

## 🚀 Démarrage Rapide

### Prérequis
- Node.js 20+
- npm ou pnpm

### Installation et Lancement Local

```bash
# 1. Cloner le projet et installer les dépendances
npm install

# 2. Lancer le serveur de développement Next.js
npm run dev

# L'application est accessible sur http://localhost:3000
```

### Script de Génération & Tests

```bash
# Vérification des types TypeScript
npm run typecheck

# Exécution des lints ESLint
npm run lint

# Exécution de la suite de tests unitaires Vitest
npm test

# Compilation pour la production
npm run build
```

---

## 📜 Table des Scripts NPM

| Script | Commande | Description |
|---|---|---|
| `dev` | `next dev` | Lance le serveur de développement Next.js (hot reload) |
| `build` | `next build` | Compile l'application Next.js pour la production |
| `start` | `next start` | Démarre le serveur de production compilé |
| `lint` | `eslint .` | Analyse et vérifie la qualité du code avec ESLint |
| `typecheck` | `tsc --noEmit` | Valide les types TypeScript sur l'ensemble du projet |
| `test` | `vitest run` | Exécute la suite de tests unitaires avec Vitest |
| `test:watch` | `vitest` | Lance les tests en mode réactif (watch) |
| `test:coverage` | `vitest run --coverage` | Génère un rapport de couverture de code |
| `test:e2e:firebase` | `npx firebase-tools...` | Exécute les tests E2E avec l'émulateur Firebase |
| `format` | `prettier --write .` | Formate automatiquement l'ensemble du code source |
| `firebase:emulators` | `firebase emulators:start` | Démarre la suite d'émulateurs Firebase en local |
| `firebase:deploy` | `firebase deploy` | Déploie les règles, index et Cloud Functions sur Firebase |
| `live:gateway` | `tsx lib/live/gateway-server.ts` | Lance le serveur Gateway WebSocket pour les sessions Live |
| `analyze` | `ANALYZE=true next build` | Analyse la taille du bundle d'optimisation de build |

---

## 📚 Documentation Approfondie

Pour en savoir plus sur l'architecture, la roadmap et les spécifications techniques, consultez les documents dans le dossier `docs/` :

- 📖 **[Guide Technique & Référence API](docs/guide-technique.md)** : Cartographie complète des modules `lib/`, endpoints API, variables d'environnement et stack.
- 🎯 **[Analyse du Projet](docs/analyse-projet.md)** : Rapport d'analyse d'architecture, forces de la plateforme et leviers d'amélioration.
- 📐 **[Décisions d'Architecture (ADR)](docs/architecture-decisions.md)** : Journal des choix techniques structurants (Next.js API routes, state management, etc.).
- 🗺️ **[Feuille de Route SaaS (Roadmap)](docs/saas-roadmap.md)** : État d'implémentation de la couverture entreprise (Multi-tenant, Sécurité, Observabilité, Billing).

# Gen3ia — Plateforme d'IA à moteur neuronal propriétaire

**Gen3ia** est une plateforme d'intelligence artificielle qui pense avec son **propre cerveau neuronal** : le moteur **Gen3** (SNN — réseau de neurones à spikes), entraîné sur la plateforme, 100 % local, **aucune IA externe**. Conçue avec **Next.js 15.5 (App Router)**, **React 19** et **Firebase**, elle combine la conversation IA honnête, l'entraînement ouvert (corpus intégré, Hugging Face, Kaggle), la création média neuronale, la mémoire conversationnelle et des automatisations spécialisées sous validation humaine.

**Production : <https://gen3ia.online>**

---

## 🧠 L'IA Gen3 — comment elle fonctionne vraiment

L'intelligence de Gen3ia n'est ni un LLM externe ni un simulacre : c'est un **système neuronal complet** (`lib/neural/`), observable et traçable de bout en bout.

### Le réseau (SNN à spikes)
- **Neurones à seuils d'énergie** : chaque message est encodé en énergie sur la zone de tokens (hachage FNV-1a déterministe), les spikes se propagent par synapses pondérées.
- **Pools d'intention en sortie** : image, audio, vidéo, outils, compétences, appels… le pool qui résonne le plus fort détermine ce que l'IA a compris (pondération par **latence de spike** — le signal appris spike tôt, le bruit spike tard).
- **Plasticité hebbienne supervisée** : chaque entraînement renforce les synapses entrée → pool cible, avec punition compétitive des mauvais pools.

### Le cortex langagier (`lib/neural/generation/language.ts`)
- **Corpus appris** : 91+ paires conversationnelles françaises intégrées (`corpus.ts`), enrichies par des **paires personnalisées** enseignées via le Studio d'entraînement.
- **Appariement pondéré IDF** : score cosinus avec filtre de stopwords FR/EN, bonus de sous-ensemble (question exacte), bonus de personnalisation — **déterministe et traçable**.
- **Contexte anaphorique** : l'hippocampe (mémoire de travail) fournit le tour précédent — « et toi ? » est résolu.
- **Plasticité d'usage** : chaque rappel réussi renforce le poids de la paire (plafonné) — la connaissance utile remonte plus vite.
- **Honnêteté d'architecture** : sous le seuil d'appariement, l'IA **assume** qu'elle ne sait pas au lieu d'inventer.

### Persistance & entraînement
- **Cerveau persisté** (`var/neural/brain-v1.json`, format v2) : synapses, registre lexical, état du cortex langagier, historique d'entraînement — écriture atomique, rétrocompatible v1.
- **AI Training Studio** : datasets du dépôt, import **Hugging Face** et **Kaggle**, quotas, audit, worker GPU Python (`training-worker/`), cron de balayage.
- **Rapports réels** : époques, échantillons, précision train/test — rien de décoratif.

### Création média neuronale
- **Moteurs 100 % locaux** (`lib/neural/generation/`) : compositions visuelles SVG, signaux audio WAV, animations SMIL — calculés depuis l'état réel des poids synaptiques, archivés en R2.

---

## 🌟 Fonctionnalités de la plateforme

### 💬 Chat IA (cœur du produit)
- **Conversation honnête** : réponses composées depuis le corpus appris + télémétrie réseau (`raw.langage` : source, thème, score d'appariement).
- **Conversations persistées** en R2 (liste, recherche, renommage, suppression, export Markdown), streaming NDJSON, pièces jointes réelles (upload multipart).
- **Approbations de sécurité** : les actions sensibles des automatisations restent validées par un humain.

### 🏢 Multi-Tenancy & Organisations
- Rôles granulaires (Owner, Admin, Member), invitations sécurisées par lien expirable, isolation Firestore au niveau organisation, quotas par plan.

### 🧩 Mémoire RAG & Connaissances
- Indexation de documents, recherche sémantique/vectorielle (Qdrant), résumés épisodiques automatiques, bases de connaissances partagées.

### 🤖 Pilotage IA de la plateforme
- Toutes les fonctionnalités sont pilotées par Gen : automatisations (missions + agents), projets, fichiers importés, mémoire permanente, conversations et entraînements — « état de la plateforme » dans le chat retourne les chiffres réels du compte.
- Catalogue d'extensions tiers versionnées et sandboxées, avec revue d'administration et permissions explicites.

### 📊 Observabilité
- Traçabilité `traceId`, logs structurés JSON Pino, Sentry (erreurs + traces), page **Cerveau IA** (`/neural`) : santé du noyau, cycles, synapses et langage en direct.

---

## 🚀 Démarrage en 5 Minutes

```bash
make setup          # npm install + .env.local + hooks git anti-secrets
make emulators      # émulateurs Firebase (auth :9099, firestore :8080, UI :4000)
make seed           # 5 utilisateurs, 2 équipes, 3 agents, 10 conversations (émulateurs)
npm run dev         # http://localhost:3000
```

> Sans Make : `npm install && npm run setup:hooks && npm run firebase:emulators` puis `npm run seed` (autre terminal) et `npm run dev`.

**Variables OBLIGATOIRES** (développement comme production) : `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (identités factices acceptées en local — le seed en génère).

**Variables OPTIONNELLES** (chaque absence dégrade avec repli, jamais de panne) : `QDRANT_URL`/`QDRANT_API_KEY` (recherche vectorielle), `R2_*` (stockage fichiers), `RESEND_API_KEY` (e-mail), `COMPOSIO_API_KEY` (connecteurs), `CHARIOW_*` (facturation), `SANDBOX_URL`/`SANDBOX_SHARED_SECRET` (exécution de code). La sonde `/api/health/infra` (auth requise) liste les groupes présents/absents par nom — jamais de valeur.

> **Note IA** : aucune clé LLM n'est nécessaire — le moteur neural Gen3 est entièrement interne (les IA externes ont été retirées du projet, cf. Task 150).

**Qualité** : `make qa` = lint + typecheck + tests unitaires + build + budget bundle. Tests e2e contre émulateurs : `make test:e2e` (ne touche JAMAIS la production).

---

## 🏛️ Architecture du Projet

| Dossier / Fichier | Rôle dans l'application |
|---|---|
| `lib/neural/` | **L'IA Gen3** : réseau SNN (`core/`), encodage lexical (`encoding/`), décodage conversationnel (`decoding/`), cortex langagier + corpus (`generation/`), hippocampe & superviseur (`memory/`), effecteurs média/outils (`effectors/`), entraîneur supervisé + persistance (`training/`) |
| `app/` | Routes Next.js 15.5 (App Router) : `(auth)`, `admin`, `api`, `chat`, `neural`, `workspace`, `studio`, `memory`, `observability`, `billing`, `team` |
| `components/` | Composants UI React 19 modulaires (`neural`, `chat`, `training`, `shells`, `nav`, `knowledge`, `pilotage`, `ui`…) |
| `lib/` | Logique métier : `ai` (routeur → moteur neural), `chat`, `knowledge`, `memory`, `agents` (automatisations), `billing`, `integrations`, `security`, `tenants`, `training` |
| `training-worker/` | Worker GPU Python pour les entraînements lourds (contrat + tests) |
| `sandbox/` | Sandbox d'exécution de code (Fastify) |
| `e2e/` & `vitest/` | Tests d'intégration E2E et suites unitaires (4 000+ tests) |

### Flux d'une requête IA

```
Message utilisateur
  → /api/chat (validation, rate-limit, mémoire)
  → lib/ai/router.ts  (un seul moteur : gen3-snn)
  → lib/neural/engine.ts
      ├─ encodage lexical (zone de tokens)
      ├─ cycles SNN (noyau central, résonances par latence)
      ├─ cortex langagier (corpus appris + contexte hippocampe)
      └─ décodeur conversationnel (repli honnête par intention)
  → réponse streamée (NDJSON) + télémétrie raw.langage
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
| `test:e2e:firebase` | `npx firebase-tools…` | Exécute les tests E2E avec l'émulateur Firebase |
| `firebase:emulators` | `firebase emulators:start` | Démarre la suite d'émulateurs Firebase en local |
| `live:gateway` | `tsx lib/live/gateway-server.ts` | Lance le serveur Gateway WebSocket pour les sessions Live |
| `seed` / `db:reset` | `tsx scripts/seed.ts` | Peuple les émulateurs Firebase (dev local) |

---

## 🚢 Déploiement (VPS)

- **CD** : un push sur `main` déclenche `.github/workflows/deploy-vps.yml` — le runner GitHub (7 Go) installe et compile (`npm ci` + `next build`, le VPS de 2 Go ne peut pas builder), puis livre `.next` au VPS (`/opt/gen3ia`, PM2 + nginx).
- **Swap atomique** (`deploy/cd-finisher.sh`) : staging isolé pendant le transfert, bascule `.next` + `node_modules` avec conservation de la version précédente, health check `localhost:3000`, **rollback automatique** et blacklist des SHA en échec.
- **Vérification de bout en bout** : le workflow prouve que la production sert exactement le build livré (`/api/deploy-info` + `/version.json`).
- **Artefact neuronal pré-entraîné** : `assets/neural-pretrained/cortex-v2.bin` (≈ 12 Mo) n'est **plus versionné** — récupération/régénération documentées dans `assets/neural-pretrained/README.md` (l'app démarre sans lui, cortex amorcé à neuf).

---

## 📚 Documentation Approfondie

Consultez les documents dans le dossier `docs/` :

- 📖 **[Guide Technique & Référence API](docs/guide-technique.md)** : cartographie des modules `lib/`, endpoints API, variables d'environnement et stack.
- 📐 **[Décisions d'Architecture (ADR)](docs/architecture-decisions.md)** : journal des choix techniques structurants.
- 🗺️ **[Feuille de route](docs/roadmap.md)** : synthèse honnête par axe, chantiers ouverts et phases structurelles.

### Observabilité & données
- **Sentry** : erreurs + traces via le pont asynchrone (zéro coût First Load), tunnel `/monitoring`, source maps au build. Voir ADR-005.
- **Firestore (Firebase)** : unique moteur de données ; le stockage d'objets/identité est Cloudflare R2.
- **Google AdSense** : confiné aux pages publiques (`AdSenseAd`), `ads.txt` à la racine. Voir ADR-007.

## Système d'Auto-Amélioration

Le projet intègre un audit automatique de qualité (TypeScript, ESLint, dette TODO/FIXME, tests) :

```bash
node scripts/self-improve.mjs
```

Un workflow GitHub Actions s'exécute chaque semaine (lundi 08:00 UTC) ou à la demande via `workflow_dispatch`.

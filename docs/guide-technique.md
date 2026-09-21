# Guide Technique et Référence API — Gen3ia

Ce document fournit un aperçu complet des modules techniques, des routes API, des flux de données et des configurations de la plateforme **Gen3ia**.

---

## 1. Vue d'ensemble de la Stack Technique

- **Framework Web** : Next.js 16 (App Router, Server Actions, Route Handlers)
- **Frontend** : React 19, Tailwind CSS v4, Lucide Icons, UI Composants personnalisés
- **Backend & Base de Données** : Firebase Admin SDK, Firestore, Firebase Auth, Firebase Storage
- **Stockage Objets** : Cloudflare R2 / AWS S3 (via `@aws-sdk/client-s3`)
- **Moteur IA & LLM** : Routeur multi-fournisseurs (`lib/ai/router.ts`) supportant OpenAI, Groq, Anthropic, Hugging Face, OpenRouter
- **Connecteurs d'outils** : Composio (`@composio/core`, 800+ intégrations), MCP (Model Context Protocol)
- **Téléphonie & Voix** : Twilio, Plivo, ElevenLabs TTS
- **Exécution de code & composant UI** : Intégration 21st.dev (`lib/integrations/twentyfirst`)
- **Génération de documents** : DOCX (`docx`), XLSX (`exceljs`), PDF (`pdf-lib`), PPTX (`pptxgenjs`), Archives (`archiver`)
- **Observabilité & Métriques** : Logger Pino (`lib/observability/logger.ts`), Tracing d'exécutions (`execution-tracer.ts`), Moteur de coûts (`cost-engine.ts`)
- **Tests** : Vitest v4 (tests unitaires et d'intégration), suite E2E avec émulateur Firebase

---

## 2. Structure des Modules Principaux (`lib/`)

| Module | Emplacement | Rôle principal |
|---|---|---|
| **Agents** | `lib/agents/` | Moteur de chat (`chat-engine.ts`), boucle autonome (`loop.ts`), planification (`planner.ts`), exécution (`executor.ts`), évaluation (`evaluator.ts`), gestionnaire de schedules (`scheduler.ts`), chartes d'agents (`charter.ts`). |
| **IA Router** | `lib/ai/` | Routage dynamique de modèles LLM (`router.ts`), configuration des clés API, génération d'images (`image-generation.ts`), suivi de la consommation de tokens (`usage.ts`). |
| **Multi-tenancy** | `lib/tenants/` | Gestion des organisations (`organizations.ts`), membres, rôles (owner, admin, member), invitations expirables, quotas de plan (Free, Pro, Enterprise). |
| **Facturation** | `lib/billing/` | Gestion du portefeuille de crédits (`wallet.ts`), calcul du coût d'exécution AI (`cost-engine.ts`), suivi des outils (`tool-meter.ts`), suivi des médias (`media-meter.ts`), webhooks Chariow (`chariow.ts`). |
| **Extensions** | `lib/extensions/` | Registre des extensions (`repository.ts`), validation de manifeste (`manifest.ts`), permissions (`permissions.ts`), templates HTTP (`http-template.ts`), exécution runtime (`runtime.ts`). |
| **Sécurité** | `lib/security/` | Protection des routes (`route-guard.ts`), politique de débit/rate-limiting (`rate-limit.ts`), arrêt d'urgence (`emergency-stop.ts`), garde-fous d'autonomie (`autonomy-guard.ts`), budget ads (`ads-spend-budget.ts`). |
| **Live / Vision** | `lib/live/` | Moteur de vision avec repli multi-modèles (`vision-decider.ts`), gateway WebSocket (`gateway.ts`), gestionnaire de sessions live (`repository.ts`). |
| **Mémoire & RAG** | `lib/memory/` | Mémoire épisodique (`episodic.ts`), découpage de documents (`chunker.ts`), recherche sémantique (`search.ts`), mémoire utilisateur (`user-memory.ts`). |
| **Documents** | `lib/documents/` | Moteur de génération multi-format (PDF, DOCX, XLSX, PPTX, ZIP), gestion des artefacts et validation de schémas (`engine.ts`, `artifact-store.ts`). |
| **Intégrations** | `lib/integrations/` | Connecteurs Composio, Twilio, Plivo, ElevenLabs, GitHub, Notion, 21st.dev, Webhooks. |

---

## 3. Cartographie des Endpoints API (`app/api/`)

### Authentification & Utilisateurs
- `GET/POST /api/auth/session` : Gestion de la session utilisateur et cookies sécurisés.
- `GET /api/auth/account` : Profil et informations de compte.
- `GET /api/auth/access` : Vérification des droits d'accès plateforme.

### Agents & Chat
- `POST /api/agent/chat` : Endpoint principal du chat agent (classification directe vs mission autonome).
- `POST /api/agent/chat/approve` : Validation humaine des actions sensibles de l'agent.
- `GET/POST /api/agents` : Liste et création d'agents IA.
- `GET/PUT/DELETE /api/agents/[id]` : Gestion d'un agent spécifique.
- `POST /api/agents/[id]/run` : Lancement d'une exécution d'agent.
- `POST /api/agents/autonomous/run` : Lancement d'une boucle autonome d'agent.
- `POST /api/agents/plan` : Génération d'un plan d'action structuré.

### Planifications & Cron
- `GET/POST /api/agents/schedules` : Gestion des exécutions programmées d'agents.
- `GET/DELETE /api/agents/schedules/[id]` : Modification ou suppression d'un schedule.
- `POST /api/cron/agent-schedules` : Déclencheur automatique de cron (à appeler via Vercel Cron ou Cloud Scheduler).

### Téléphonie & Voix
- `POST /api/voice/twilio/answer` & `/turn` : Webhooks d'appel entrant et de dialogue interactif Twilio.
- `POST /api/voice/plivo/answer` & `/turn` : Webhooks d'appel entrant et de dialogue interactif Plivo.
- `POST /api/agents/[id]/voice/call` : Iniation d'un appel téléphonique sortant via un agent.

### Publicité & Marketing (Ads)
- `POST /api/ads/generate` : Génération de contenu publicitaire multi-canal.
- `POST /api/ads/publish` : Publication de campagnes sur Meta/Google/TikTok/LinkedIn via Composio.
- `GET/POST /api/ads/connections` : Gestion des connexions de comptes publicitaires.

### Extensions & Marketplace
- `GET/POST /api/extensions` : Recherche et soumission d'extensions.
- `POST /api/extensions/[id]/install` : Installation d'une extension par un utilisateur.
- `POST /api/extensions/[id]/run` : Exécution d'une action d'extension.
- `POST /api/admin/extensions/review` : Approbation ou rejet d'extensions par l'administrateur.

### Live Navigateur & Vision
- `POST /api/live/sessions` : Création d'une session de contrôle live.
- `POST /api/live/sessions/[id]/frames` : Analyse de capture d'écran par la boucle de vision IA.
- `PUT /api/live/sessions/[id]/actions/[actionId]/approve` : Validation d'action live.

### Facturation & Wallet
- `GET /api/billing/wallet` : Consultation du solde de crédits et de l'historique d'utilisation.
- `POST /api/billing/topup` : Rechargement de crédits.
- `POST /api/webhooks/chariow` : Webhook de réception des paiements Chariow.

### Organisations & Équipes
- `GET/POST /api/organizations` : Liste et création d'organisations multi-tenant.
- `GET/POST /api/organizations/[orgId]/members` : Gestion des membres, rôles et invitations.

---

## 4. Variables d'Environnement

```bash
# Configuration Firebase Web Client
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# Firebase Admin SDK (Serveur)
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

# Clés Fournisseurs IA
OPENAI_API_KEY=
GROQ_API_KEY=
ANTHROPIC_API_KEY=
HUGGINGFACE_API_KEY=
OPENROUTER_API_KEY=

# Intégrations Tierces
COMPOSIO_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
PLIVO_AUTH_ID=
PLIVO_AUTH_TOKEN=
ELEVENLABS_API_KEY=
TWENTYFIRST_API_KEY=

# Stockage Cloudflare R2 / AWS S3
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
AWS_BUCKET_NAME=
AWS_ENDPOINT=

# Observabilité & Sécurité
SENTRY_DSN=
INTERNAL_API_SECRET=

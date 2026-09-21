# Gen3ia — Studio d'agents IA

Plateforme SaaS de création, personnalisation et exécution d'agents IA :
chat agent personnalisable (nom, description, skills, mémoire, agent d'appel
ou standard, type + type personnalisé), classification automatique des
requêtes (réponse LLM directe ou exécution de tâche), périmètre strict par
agent, connecteurs externes activables dans la conversation avec `@`,
multi-tenancy par organisations, marketplace d'extensions et observabilité.

**Production : <https://gen3ia.online>**

## Architecture

| Dossier | Rôle |
|---|---|
| `app/` | Routes Next.js 16 (App Router) : `(auth)`, `admin`, `api`, `studio`, `team`, `features`, … |
| `components/` | UI React 19 (agent, studio, integrations, marketplace, memory, nav…) |
| `lib/` | Logique métier : `agents`, `ai`, `billing`, `chat`, `memory`, `observability`, `orchestrator`, `security`, `tenants`, `integrations/composio`… |
| `functions/` | Firebase Functions |
| `live-agent/` | Agent live WebSocket |
| `desktop/` | Clients desktop (Windows/Linux) |
| `e2e/`, `vitest/` | Tests E2E et unitaires |

**Stack** : Next.js 16 · React 19 · Tailwind 4 · Firebase (Auth, Firestore, Storage,
Admin SDK) · multi-fournisseurs IA (OpenAI, Anthropic, Groq, Hugging Face, OpenRouter…)
· Composio (800+ connecteurs) · Zod · Vitest · pino.

## Fonctionnalités clés

- **Studio d'agents** : création guidée (nom, description, skills, fichier mémoire
  optionnel, agent d'appel vs standard, type : code, marketing, recherches,
  création de contenu… ou type personnalisé), charte professionnelle générée.
- **Chat agent** : chaque requête est classifiée — réponse claire (LLM) ou
  exécution de tâche planifiée, toujours dans le périmètre de l'agent.
- **Connecteurs `@`** : tapez `@` dans le chat pour activer Gmail, Notion, Slack,
  GitHub, etc. dans la conversation ; l'agent reçoit les actions réelles
  disponibles (Composio) et exécute via `composio.execute` (approbation humaine
  pour les actions sensibles).
- **Multi-tenant** : organisations (`organizations`), membres avec rôles
  (owner/admin/member), invitations à expiration, quotas par plan
  (free/pro/enterprise) — voir `lib/tenants/organizations.ts`.
- **Mémoire** : permanente (fichiers) + épisodique (embeddings, résumés auto).
- **Observabilité** : traces d'exécution, coûts par agent, logs pino corrélés
  par `traceId` (`lib/observability`), page `/observability`.
- **Marketplace** : extensions, achats, licences, revenus développeurs.
- **Fonctionnalités cachées** : page `/features` — portail client, approbation
  à distance, API publique, webhooks, téléphonie, orchestrateur, MCP…

## Démarrage

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # build production
npm test             # Vitest
```

Variables d'environnement requises : `NEXT_PUBLIC_FIREBASE_*` (config web),
`FIREBASE_*` (Admin), `OPENAI_API_KEY` (+ fournisseurs optionnels),
`COMPOSIO_API_KEY`, `AWS_*` (stockage S3). Voir `docs/`.

## Déploiement

Vercel (production : `gen3ia.online`). Les règles Firestore sont dans
`firestore.rules`, les index dans `firestore.indexes.json`. CI : `.github/workflows`.

## Documentation

- `docs/saas-roadmap.md` — feuille de route SaaS (multi-tenant, scalabilité,
  observabilité, sécurité, facturation, DX) et état d'implémentation.

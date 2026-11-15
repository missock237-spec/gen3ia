# Plan Plateforme Enterprise Gen3ia — Cartographie & Matrice d'implémentation

Date : 2026-09-24 · Base : commit `b69121d` · 444 tests verts · tsc/eslint/build OK

## 1. Cartographie synthétique de l'existant (audit 4 agents parallèles)

### Réel et en production (à conserver, ne pas dupliquer)
- **Agent Runtime** (`lib/agents/runtime/runner.ts`) : exécution DAG réelle (étapes parallèles, concurrency, retry, checkpoints `executions`, pause/resume `agentPauseControls`, rollback/branches/snapshots), facturation wallet par étape, HITL via autonomy-guard, emergency-stop.
- **Moteur conversationnel** (`lib/domain/conversations/engine.ts`) : streaming NDJSON, plans, tools réels, artefacts versionnés, runs `conversationRuns`, approvals `conversationApprovals`.
- **Outils natifs** (~30, `lib/tools/`) : web.search (cascade providers + fallback), knowledge.search, artifact/file/zip, terminal+code (sandbox Docker réelle, repli simulation honnête), composio.execute, mcp.call, messaging, email, social, github, notion, jules, cloudflare, phone, voice. Exécution durcie (`/api/tools/execute` : emergency-stop → permissions → audit `toolAuditLogs`).
- **MCP** (`lib/integrations/mcp/`) : client JSON-RPC Streamable HTTP réel, découverte tools, CRUD `mcpServers`, panel UI.
- **Composio** : SDK officiel, OAuth géré, catalogue ~800 apps, exécution vérifiée.
- **Extensions** (`lib/extensions/`) : cycle complet (manifest SDK → review admin → install/consentement permissions → runtime 10 étapes HTTP déclaratif → entitlements/licences/purchases → revenue split). 14 collections. Marketplace UI réelle.
- **Organisations** (`lib/tenants/`) : multi-tenant réel owner/admin/member, plans free/pro/enterprise + quotas + invitations + isolation pool/silo.
- **Billing** : wallet transactionnel (reserve/settle/refund) + ledger + Chariow (checkout, webhook, deliveries) + cost engine EUR (marge 35 %) + metering outils.
- **Sécurité** : route-guard (auth+rate-limit Redis+traceId+headers), HITL 3 modes + plancher invariable, emergency-stop, secret-masking, guardrails, url-safety, audit `securityAuditEvents`, `toolAuditLogs`.
- **Observabilité** : pino + execution-tracer `executionTelemetry` + agrégations `executions` + dashboards user/admin réels + Sentry.
- **Voice** : Twilio/Plivo inbound réels + ElevenLabs + numéros virtuels reventés.
- **Browser/Computer agent** : gateway WebSocket standalone + device runtime `live-agent/` (nut-js) + frames + approvals + camera requests.
- **Deployments** : GitHub (PAT plateforme) + Vercel + Render réels via `/api/deployments/create`.
- **Admin** : users, platform, security, extensions review, ads, observability.
- **Business suite** : 12 modules CRUD réels (hr, finance, sales, marketing, documents, operations, compliance, automations).

### Partiel / cassé / mort (à améliorer, pas dupliquer)
1. **Critic + Evaluator + auto-healing écrits mais NON branchés** (zéro appelant) — `lib/agents/critic/`, `lib/agents/evaluation/`.
2. **Evals** : aucun test set, aucune persistance de scores d'exécutions.
3. **Workflows : 2 systèmes** — `lib/workflows/` (validator graphe visuel SANS exécuteur) + `lib/engines/workflow-engine.ts` (automatisation métier séquentielle réelle). Le format graphe (agent/tool/condition/parallel/approval) n'est jamais exécuté.
4. **Knowledge/RAG : ingestion inexistante** — retrieval réel (Qdrant + repli Firestore cosinus) mais `indexKnowledgeDocument` sans appelant : zéro route, zéro UI, zéro parsing.
5. **Skills backend réels, zéro UI** — pas de @Skills dans le composer, `/api/skills` jamais appelé côté client.
6. **Multi-agent** : supervisor à 5 rôles figés par mots-clés ; `autonomous/run` = agents LLM sans outils ; pas de sous-agents dans la config agent.
7. **Research v2** pipeline complet orphelin (pas de route).
8. **Agent Builder** : wizard mono-formulaire (pas d'onglets, pas de modèle/outils/permissions/knowledge/MCP par agent).
9. **API platform** : `/api/agents/[id]/run` en session ; `developerApiKeys` existent mais non branchées sur le run d'agents.
10. **Doublons legacy** : 3 stacks de chat (gen vitrine, app/api/chat, workspace/conversations) ; Teams vs Organizations ; crédits vs wallet ; 2 gardes admin divergentes.

### Design system (état actuel)
- Tokens clairs crème centralisés (`--gen3ia-*`, globals.css 935 l.) + **îlots sombres hardcodés** (chats `#0b0b0d/#161618`, Admin `#101418`, Developer `#11120f`) ; **aucun dark mode** (color-scheme light figé) ; **4 primitives ui/** seulement ; icônes emoji ; Wizard monolithique ; markdown seulement dans la conversation workspace.

## 2. Matrice FEATURE / STATUS / PLAN / RISQUE

| # | Feature (demande) | Statut | Fichiers existants | Composants manquants | Plan (lot) | Risque |
|---|---|---|---|---|---|---|
| 1 | Design system sombre Gen3ia + mode clair | PARTIEL | globals.css, components/ui (4) | tokens sombres/clairs variables, primitives, thème persistant | **LOT 1** | Moyen (régression visuelle) |
| 2 | Chat moderne (actions message, markdown/code, tool cards) | PARTIEL | conversation-workspace, command-composer, run-timeline | épinglés/dossiers, retry/edit/regenerate/copy/feedback, markdown+code dans chat agent & Gen | LOT 2 | Moyen |
| 3 | Agent Builder 12 onglets + config réelle | PARTIEL | app/api/agents CRUD+PATCH, agent-wizard | éditeur onglets (instructions/model/tools/knowledge/memory/mcp/sub-agents/permissions/evals/deployment), sorties structurées, triggers/budget | **LOT 3** | Moyen |
| 4 | Création d'agent par langage naturel | ABSENT | skills/factory (génération LLM existante) | route génération config + UI d'acceptation | LOT 3 | Bas |
| 5 | Brancher Critic + auto-healing au runtime | CODE MORT | lib/agents/critic complet | appel dans runner après exécution + correction + re-run borné | **LOT 4** | Moyen |
| 6 | Supervisor multi-agents dynamique | PARTIEL | orchestrator, autonomous/run | sélection agents réels (DB), sous-agents dans config agent | LOT 5 | Élevé |
| 7 | Knowledge ingestion (upload/URL → RAG) | ABSENT | chunker/indexer/search réels | route ingestion + parsing texte/HTML/URL + UI Knowledge Spaces | **LOT 6** | Moyen |
| 8 | Workflow Studio (graphe exécutable) | PARTIEL | lib/workflows validator, workflow-engine métier | exécuteur graphe (agent/tool/condition/parallel/approval) sur AgentRuntime, API CRUD+run, éditeur visuel, versions/test run | **LOT 7** | Élevé |
| 9 | Evals Studio (test sets, judge, régression) | ABSENT | critic engine LLM judge, evaluator | collections testSets/testRuns, runner, routes, UI | **LOT 8** | Moyen |
| 10 | Research v2 exposé | CODE MORT | lib/research/v2 pipeline | route + tool agent | LOT 9 | Bas |
| 11 | API platform (API keys sur run) | PARTIEL | developerApiKeys, /api/agents/[id]/run | auth par API key, docs réelles | LOT 11 | Moyen |
| 12 | Usage dashboard par agent/modèle/outil | PARTIEL | observability queries, billing | agrégations par dimension + page Usage | LOT 12 | Moyen |
| 13 | Recherche globale (chats/agents/knowledge/runs) | PARTIEL | palette ⌘K navigation | recherche contenu API + intégration palette | LOT 13 | Moyen |
| 14 | Notifications persistantes (approvals/deploy/agents) | PARTIEL | toasts, businessNotifications | centre de notifications + événements plateforme | LOT 14 | Bas |
| 15 | Versioning agents + rollback | PARTIEL | agents PATCH, extensionVersions (modèle) | collection agentVersions + diff + rollback UI | LOT 15 | Moyen |
| 16 | Run Inspector (agents, coût/latence/trace) | PARTIEL | RunTimeline conversations, executions | vue runs par agent + détail step | LOT 16 | Moyen |
| 17 | Organisation/RBAC/SSO-ready | OK | tenants, access, security | fusion Teams→Org (dette documentée) | garder | — |
| 18 | Browser agent, Voice, Sandbox, Deployments, Extensions/Marketplace, MCP, Composio, Admin, Business | OK | — | — | garder | — |

## 3. Ordre d'exécution (lots structurants d'abord)

**Session courante (impératif : build/test/commit après chaque lot)**
- LOT 1 : Design tokens Gen3ia (sombre #080A0F par défaut + clair), primitives ui/, thème persistant, re-pointage shells/chats majeurs.
- LOT 3 : Agent Builder à onglets branché sur PATCH /api/agents/[id] + génération par langage naturel (réelle via LLM).
- LOT 4 : Branchage Critic/auto-healing dans le runner (borné, budgeté).
- LOT 6 : Ingestion Knowledge (route + parsing + UI) branchée sur le pipeline Qdrant existant.
- LOT 8 : Evals (collections + runner + judge critic + routes + UI).
- LOT 2 (partiel) : rendu markdown + code + tool cards dans le chat agent.
- LOT 7 (noyau) : exécuteur de graphe workflows sur AgentRuntime + API + éditeur fonctionnel (nodes configurables, connexions, validation, test run).

**Lots suivants (session ultérieure)** : 5, 9, 11→16, durcissement, fusion doublons legacy.

## 4. Règles de non-régression appliquées
- Aucune suppression sans justification ; aucune duplication de module existant ; réutilisation stricte des services (runner, tools gateway, critic, knowledge, skills).
- Après chaque lot : `tsc` + `eslint` + `vitest run` + `next build` avant commit.

# UCE V1.1 — PHASE 1 : AUDIT DES CHEMINS D'EXÉCUTION (P0)

**Date** : 2026-11-25 · **Dépôt** : missock237-spec/gen3ia · **Base** : `main` = `cc1ec1d` (UCE V1 fusionnée, 0b8c205 + fix CI) · **Arbre de travail** : propre (aucune modification non fusionnée au démarrage).

**Méthode** : analyse du code réellement présent sur `main` (grep exhaustif des symboles d'exécution, lecture des fichiers concernés). Aucune suppression avant cette cartographie (mission Phase 1, règle finale).

---

## 1. Tous les registres existants

| # | Registre | Fichier | Nature | Instances créées |
|---|---|---|---|---|
| R1 | `ToolRegistry` (classe) | `lib/tools/registry.ts` | Registre d'EXÉCUTION (get/list/register) | classe partagée, aucune instance hors usine |
| R2 | `createDefaultToolRegistry()` | `lib/tools/default-registry.ts` | Usine du registre réel (outils natifs + composio + MCP + ads) | **2 instances** : module-level `toolRegistry` dans `lib/tools/executor.ts:27` (utilisée par `executeTool`) et export `toolRegistry` dans `lib/tools/index.ts` (inspection planner/agents) |
| R3 | `GEN3IA_TOOLS` | `lib/tools/registry.ts` | Catalogue DÉCLARATIF (78 outils annoncés : name/description/risk/permission/sideEffect) | données statiques, non instanciée |
| R4 | `GestionnaireCapacites` | `lib/capabilities/core/capability-manager.ts` | Registre de référence UCE V1 (natives×registre réel + capacités UCE persistées) | singleton `obtenirGestionnaireCapacites()` |
| R5 | catalogue par principal | `lib/capabilities/catalog.ts` | Vue agrégée LECTURE SEULE (outils + skills + extensions + APIs perso + serveurs MCP) | fonction pure `construireCatalogue()` |
| R6 | stores connecteurs | `lib/integrations/mcp/store.ts`, `lib/integrations/composio/tools.ts` | Catalogues de CONNECTEURS (serveurs MCP utilisateur, outils Composio) | par utilisateur, exposés au registre réel via `mcpCallTool` / `createComposioTool` (R2) |

**Verdict doublons** : R1+R2 = registre d'exécution UNIQUE (les deux instances R2 portent le même contenu déterministe — aucune divergence de contenu). R3 (déclaratif) ≠ R2 (exécution) : divergence assumée et **rendue honnête** par le drapeau `enregistre` du registre UCE (R4). R5 est une vue dérivée SANS pouvoir d'exécution. R6 sont des sources d'approvisionnement du registre réel, pas des catalogues concurrents.

**Point unique de vérité retenu (Phase 2)** : `GEN3IA_TOOLS` (annoncé) × `createDefaultToolRegistry()` (réel) → centralisé dans un NOUVEAU registre de référence `lib/capabilities/core/capability-registry.ts` qui complète le contrat mission (inputSchema/outputSchema/permissions/dependencies/environmentRequirements/availability/executionAdapter/healthStatus/activation) ; `catalog.ts` (R5) est resynchronisé sur ce registre pour sa partie native.

## 2. Toutes les instances de registres créées (graphe d'import)

- `lib/tools/executor.ts:27` — `const toolRegistry = createDefaultToolRegistry()` (LE chemin d'exécution natif).
- `lib/tools/index.ts:11` — `export const toolRegistry` (inspection, pas d'exécution directe : `executeRegisteredTool` redélègue à `executeTool` — **0 appelant externe trouvé**).
- `lib/agents/runtime/unified-agent.ts` (8 refs), `tool-resolver.ts` (4), `personalized-plan.ts` (3), `agents/orchestrator.ts` (3), `gen3/*`, `capabilities/catalog.ts` (2), `runtime/tool-intent.ts` (2), `runtime/error-recovery.ts` (2), `security/tool-permissions.ts`, `security/agent-policy.ts` : références à `GEN3IA_TOOLS`/registre pour PLANIFICATION et PERMISSIONS — aucune exécution directe (vérifié : aucun `executeTool(` dans ces fichiers).

## 3. Tous les points d'entrée et chemins d'exécution

```
                        APPELANTS EXTERNES (sources réelles sur main)
┌───────────────────────────┬──────────────────────────────────────────────┐
│ Chat (moteurs conversationnels)                                          │
│  engine-services.ts:41     ┐                                             │
│  engine-plan.ts:732        │                                             │
│  engine-research.ts:177,222┼──→ executeTool()  [chemin B — direct]        │
│  engine-approvals.ts:42    │                                             │
│  web-context.ts:88         │                                             │
│  recherche-systematique.ts:56┘                                            │
│ API publique                                                             │
│  app/api/tools/execute/route.ts:233 ──→ executeTool()  [chemin C — direct]│
│ Agents                                                                   │
│  runner.ts → executeToolSecurely() ┐                                     │
│ Workflows                          │  [chemin A — contrôles renforcés]    │
│  workflows/executor.ts:166 ────────┘                                     │
│            │                                                             │
│            ▼                                                             │
│  secure-tool-executor.ts:173 → executeTool()  [branche générique]        │
│            (branches spécialisées : ads/terminal/memory/camera/sandbox/   │
│             extensions — contrôles propres, idempotence, facturation)     │
│ UCE (V1)                                                                 │
│  executerCapacite() (universal-gateway.ts)                                │
│    → adaptateurOutilNatif → executeTool()  [chemin D — délégation]        │
│            ▼                                                             │
│  executeTool() (lib/tools/executor.ts) — arrêt d'urgence + politique      │
│    + consentements + audit ; registre réel R2 → outil.execute()           │
│    (code.execute → sandbox réseau NONE)                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

**Décompte précis des appels `executeTool(` réels hors internals** (frontière de mot, hors tests) : 9 sites dans 8 fichiers — 6 moteurs conversationnels (B), 1 route API (C), 1 exécuteur sécurisé (A), 1 adaptateur UCE (D, interne légitime). Les correspondances supplémentaires trouvées par grep brut sont des commentaires (`personalized-plan.ts`, `artifact-repository.ts`, `composio/errors.ts`, `security/*`) ou des méthodes PRIVÉES homonymes (`runner.ts:635 this.executeTool` → délègue à `executeToolSecurely`).

**Connecteurs MCP/Composio** : aucun chemin parallèle — MCP passe par `mcpCallTool` et Composio par `createComposioTool`/`composio.execute`, tous enregistrés dans le registre réel R2, donc atteints UNIQUEMENT via `executeTool`/`executeToolSecurely`. Le chemin Composio Ads a une branche dédiée dans `secure-tool-executor` (budget/consentement ads) — conservée.

## 4. Divergences de permissions et de contrôle

| Chemin | Arrêt d'urgence | Politique | Consentements | Audit | Idempotence | Facturation | Enregistrement UCE (cap_executions) | Vérification indépendante |
|---|---|---|---|---|---|---|---|---|
| A agents/workflows (executeToolSecurely) | ✓ (3 lectures) | ✓ + guardrails + HITL | via executeTool | ✓ sécurité | ✓ external/destructive | ✓ | ✗ | ✗ |
| B conversation (executeTool direct) | ✓ | ✓ (CONVERSATION_EXECUTION_POLICY) | ✓ | ✓ outils | ✗ | ✗ | ✗ | ✗ |
| C route API (executeTool direct) | ✓ | ✓ (policy de la requête) | ✓ | ✓ outils | ✓ (route) | ✗ | ✗ | ✗ |
| D gateway UCE (executerCapacite) | ✓ | ✓ | ✓ | via executeTool | via executeTool | via executeTool | ✓ complet | ✓ (avant confirmation) |

**Divergence constatée** : les chemins A/B/C contournent l'enregistrement UCE et la vérification indépendante (D). Les contrôles de SÉCURITÉ sont homogènes (les trois passent par `executeTool` ou le surcouche `executeToolSecurely` qui le rappelle) — la divergence est de TRAÇABILITÉ et de vérification, pas d'autorisation. **Action Phase 3** : router A/B/C vers la passerelle via un pont legacy à sémantique identique ; garder `executeTool` comme adaptateur interne ; garde automatique de non-contournement.

## 5. Outils accessibles sans le système central

- **Aucun** outil natif n'est exécutable hors `executeTool` (le registre réel n'est invoqué que là ; `ToolExecutor.execute` — la classe historique — n'a **aucun appelant** hors `lib/tools/index.ts` (re-export) : code mort conservé par compatibilité, à considérer « fusionné »).
- Les surfaces spécialisées du chemin A (ads, terminal, memory, camera, sandbox, extensions) sont des IMPLÉMENTATIONS directes appelées avant la branche `executeTool` : elles ne contournent pas les autorisations (policy/arrêt d'urgence/guardrails/HITL/idempotence s'appliquent AVANT le dispatch) — ce sont des adaptateurs internes du chemin agents, conservés.

## 6. Registres déclaratifs ≠ registre d'exécution

- `GEN3IA_TOOLS` (78 annoncés) vs `createDefaultToolRegistry()` (variable selon clés d'environnement — Composio/Notion/Cloudflare/GitHub) : écart rendu honnête par le drapeau `enregistre` (UCE V1). Le registre V1.1 (Phase 2) centralise cet écart et l'expose (`availability`).
- `catalog.ts` reconstruit sa liste native depuis `GEN3IA_TOOLS` indépendamment → resynchronisé sur le registre de référence (Phase 2).

## 7. Décisions d'unification

| Composant | Décision |
|---|---|
| `executeTool` (lib/tools/executor.ts) | **CONSERVER** — devient adaptateur interne de la passerelle (déjà délégué par `adaptateurOutilNatif`) ; interdit aux appelants externes (garde automatique) |
| `ToolExecutor.execute` (classe historique) | **FUSIONNER** (0 appelant réel ; re-export conservé pour compat, marqué interne) |
| `executeToolSecurely` | **CONSERVER** — surcouche de contrôles agents (HITL/idempotence/facturation) ; sa branche générique route vers la passerelle |
| 6 moteurs conversationnels + route API | **REDRESSER** vers le pont legacy de la passerelle (sémantique identique) |
| `executeRegisteredTool` (lib/tools/index.ts) | **REDRESSER** sur le pont legacy (0 appelant actuel — cohérence) |
| Registre R2 / GEN3IA_TOOLS | **CONSERVER** — source unique réelle/annoncée, centralisée dans le registre V1.1 |
| `GestionnaireCapacites` | **CONSERVER** — machine à états + persistance ; le registre V1.1 l'utilise (pas de doublon) |
| `catalog.ts` | **CONSERVER** — vue par principal, partie native resynchronisée sur le registre |
| Surfaces spécialisées agents (ads/terminal/sandbox/extensions) | **CONSERVER** — adaptateurs internes au-dessus des contrôles centraux |
| Stores MCP/Composio | **CONSERVER** — sources d'approvisionnement du registre réel |

## 8. Livraison de la Phase 1

Aucune suppression n'a été effectuée. Le graphe ci-dessus est le référentiel de la Phase 3 (interdiction de contournement vérifiée par test automatique : aucun `executeTool(`/`ToolExecutor` hors liste blanche `lib/tools/**` + `lib/capabilities/execution/**`).

# LIVRABLE 2 — GRAPHE DÉFINITIF DES APPELS (après unification V1.1)

**Date** : 2026-11-25 · **Base** : branche `evolution/uce-v11` (main = cc1ec1d + Phases 1-13 V1.1) · Complète le livrable 1 (`rapport-uce-v11-phase1-audit.md`).

## 1. État AVANT unification (audit V1.1 Phase 1 — 4 chemins, 9 sites directs)

```
Chat (6 moteurs) ──────────┐
API /api/tools/execute ────┼──→ executeTool()           [B, C — contournement]
Agents runner/workflows ───┼──→ executeToolSecurely() ──┐ [A]
                           │                            └→ executeTool()
UCE gateway V1 ────────────┘──→ adaptateur ──────────────→ executeTool()  [D]
```

## 2. État APRÈS unification (V1.1 Phases 2-3 — un seul point d'entrée public)

```
                APPELANTS (toutes surfaces)
  Chat (6 moteurs) ────┐
  API /api/tools/execute ──┐                       ORIGINES TRACÉES :
  Agents (runner) ────┐    │                       "conversation" · "api-tools" ·
  Workflows ──────────┼────┤                       "agent-runtime" · "tools-index" ·
  executeRegisteredTool ──┘    │                   "chat" (gateway direct) ·
  Cycle UCE / admin / scénarios ┘                  "cycle-uce" · "scenario-*"
                    │
                    │  SEULE ENTRÉE PUBLIQUE AUTORISÉE
                    v
  ┌──────────────────────────────────────────────────────────────────┐
  │ UNIVERSAL EXECUTION GATEWAY (lib/capabilities/execution/         │
  │ universal-gateway.ts) — executerCapacite(demande, options)        │
  │                                                                   │
  │  1. réception (zod fail-closed : contexte normalisé complet       │
  │     executionId/capabilityId/userId/agentId/sessionId/traceId/    │
  │     approvalContext/resourceLimits/deadline)                      │
  │  2. résolution cible : natif:gen3ia:* (catalogue PUIS registre     │
  │     réel — repli honnête journalisé) | capacité UCE intégrée      │
  │  3. ACTIVATION (registre central capability-registry.ts) :        │
  │     désactivée/indisponible → REFUS                               │
  │  4. AUTORISATION (permission-manager) : arrêt d'urgence →         │
  │     politique → consentements — chaque couche tracée              │
  │  5. ADAPTATEUR (execution-adapter.ts) : outil-natif |             │
  │     capacite-uce | refus-non-integree                             │
  │  6. EXÉCUTION bornée (deadline ≤ 600 s, signal d'annulation       │
  │     transmis, budget sortie)                                      │
  │  7. VÉRIFICATION INDÉPENDANTE (result-verifier) — un résultat     │
  │     non vérifié n'est jamais un succès confirmé                   │
  │  8. PERSISTANCE (cap_executions) + USAGE mesuré (durée, mémoire)  │
  │  9. RÉPONSE NORMALISÉE (10 champs mission : success,              │
  │     executionId, capabilityId, status, result, error, durationMs, │
  │     verification, usage, timestamp)                               │
  └──────────────────────────────────────────────────────────────────┘
                    │ délégation (adaptateur interne)
                    v
  executeTool() (lib/tools/executor.ts) — ADAPTATEUR INTERNE :
  arrêt d'urgence + politique + consentements + audit → registre réel
  R2 (createDefaultToolRegistry) → tool.execute() (sandbox réseau NONE
  pour code.execute ; connecteurs MCP/Composio/ads enregistrés dans R2)
                    │
  executeToolSecurely() — SURCOUCHE AGENTS (conservée) : HITL, idempotence,
  facturation, guardrails, budget ads — SA branche générique passe par le
  pont legacy → gateway (les branches spécialisées ads/terminal/memory/
  camera/sandbox/extensions restent des adaptateurs internes au-dessus des
  contrôles centraux, déjà appliqués AVANT le dispatch).
```

## 3. Registres (source unique)

```
GEN3IA_TOOLS (78 annoncés) ─┐
createDefaultToolRegistry ──┴→ ENTREES NATIVES (capability-registry.ts,
                               entreesNativesSynchrones — SOURCE UNIQUE)
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              v                         v                         v
  REGISTRE CENTRAL            GestionnaireCapacites      catalogue.ts (vue par
  (capability-registry.ts)    (machine à états +         principal — GÉNÉRÉE depuis
  15 champs mission +          persistance Firestore/     entreesNativesSynchrones)
  activation persistée         journal local)             + extensions + APIs perso
  (cap_registry)               (cap_capabilities)         + MCP (plus de copie
  + santé monitoring           + capacités UCE            parallèle de la partie
  (healthStatus)                                          native)
```

## 4. Garde automatique (démonstration du critère « 100 % au gateway »)

- Test `lib/capabilities/tests/gateway-monopole.test.ts` :
  - **scan du code source** (lib/app/components/services) : aucun `executeTool(`/`ToolExecutor` ni import hors liste blanche fermée (`lib/tools/executor.ts`, `lib/tools/index.ts`, `lib/capabilities/execution/execution-adapter.ts`) — VERTE ;
  - **adoption du pont** : les 9 surfaces appelantes importent `pont-legacy` — VERTE ;
  - **parité** : ancien exécuteur ↔ gateway (refus identiques, sortie identique sur chemin délégué) — VERTE.

## 5. Appels d'exécution restants hors gateway — NÉANT

Après redressement, les seules occurrences d'`executeTool(` du dépôt sont : sa définition, le re-export interne index.ts, le ré-export de compatibilité `executeRegisteredTool` (redirigé vers le pont), et l'adaptateur natif du gateway — toutes internes. La méthode privée homonyme de `runner.ts` délègue à `executeToolSecurely` (elle-même sur le pont).

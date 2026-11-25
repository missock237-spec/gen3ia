# LIVRABLE 4 — DOCUMENTATION DU UNIVERSAL EXECUTION GATEWAY (V1.1 Phase 3)

**Date** : 2026-11-25 · **Fichier** : `lib/capabilities/execution/universal-gateway.ts` + `pont-legacy.ts` · **Statut** : IMPLEMENTED + INTEGRATED (9 surfaces appelantes redressées) + TESTED (garde + parité + réponse normalisée).

## 1. Le seul point d'entrée public

`executerCapacite(demande, options)` — toute exécution d'outil/capacité passe par lui. Les fonctions historiques (`executeTool`, `ToolExecutor.execute`) sont des **adaptateurs internes** (délégation) — aucun appelant externe ne peut les atteindre : la garde automatique (`gateway-monopole.test.ts`) scanne le code source et fait échouer CI en cas de contournement.

## 2. Contexte d'exécution normalisé (contrat mission)

`CapabilityExecutionRequest` (validé zod à la frontière) : `executionId`, `capabilityId`, `userId`, `projectId?`, `input`, `origine`, `deadlineMs?` (≤ 600 s), **`agentId?`, `sessionId?`, `traceId?`, `approvalContext?` (niveau hitl/politique/auto + approvalId/autorisePar), `resourceLimits?` (maxDurationMs/maxMemoryMb/maxOutputBytes)**. Compatibilité V1 totale (champs optionnels).

## 3. Cycle d'exécution (15 étapes mission)

1. réception · 2. validation de l'appelant (zod fail-closed) · 3. identification de la capacité (catalogue → registre réel, écart journalisé) · 4. disponibilité/activation (registre central : désactivée/indisponible → refus) · 5. validation des entrées (schéma outil côté adaptateur) · 6. permissions · 7. autorisations (arrêt d'urgence → politique → consentements, chaque couche tracée) · 8. limites de ressources (deadline + budget sortie + signal d'annulation transmis) · 9. choix de l'adaptateur · 10. exécution · 11. capture des journaux · 12. normalisation du résultat · 13. vérification indépendante (jamais fiduciaire) · 14. enregistrement persisté (`cap_executions`) · 15. réponse structurée.

## 4. Résultat normalisé (contrat mission — 10 champs)

```ts
reponseNormalisee(resultat) => {
  success, executionId, capabilityId, status,
  result, error, durationMs, verification,   // verification = preuve indépendante
  usage: { dureeMs, memoireMo },             // usage mesuré (jamais inventé)
  timestamp
}
```

## 5. Pont legacy (`pont-legacy.ts`) — sémantique historique préservée

`executerOutilViaGateway({userId, executionId, projectId?, toolName, input, signal?, policy?, origine?, agentId?, sessionId?, traceId?})` → `{success, output?, error?}` (jamais lève — identique à `executeTool`). La politique de la surface appelante est transmise aux deux couches d'autorisation ; le signal d'annulation est transmis jusqu'à l'outil (abort réel préservé). Origines tracées : `conversation` (6 moteurs), `api-tools` (route publique), `agent-runtime` (agents/workflows), `tools-index`.

## 6. Critère d'acceptation — démontré

- **Analyse du code** : graphe définitif (livrable 2) — plus aucun appel direct hors internals.
- **Test automatique 1 (garde)** : scan de tous les `.ts/.tsx` du dépôt — tout import/appel `executeTool`/`ToolExecutor` hors liste blanche fermée fait échouer la suite.
- **Test automatique 2 (adoption)** : les 9 surfaces historiques importent le pont.
- **Test automatique 3 (parité)** : refus identiques (outil inconnu → `Unknown tool: X` ; politique → même message en environnement sain) ; chemin délégué → erreur ET sortie identiques des deux côtés.
- **Réponse normalisée** : les 10 champs mission présents et vérifiés sur chaque exécution (test).
- **Activation** : capacité désactivée → refusee (test).

## 7. Comportement d'environnement (honnêteté)

Dans le sandbox de développement, le stockage d'arrêt d'urgence (r2fs/R2) est fail-closed : les exécutions déléguées échouent à la lecture du kill switch — comportement de sécurité EXISTANT, identique des deux côtés (parité conservée en échec), documenté V1 §10 ; en production (R2 configuré) le chemin s'applique sans changement.

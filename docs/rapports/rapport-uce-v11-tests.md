# LIVRABLE 8 — RAPPORT DE TESTS UCE V1.1

**Date** : 2026-11-25 · **Branche** : `evolution/uce-v11` · Statuts : TESTED partout où un test a réellement tourné.

## 1. Suites UCE V1.1 (nouvelles)

| Suite | Tests | Résultat |
|---|---|---|
| `registre-central.test.ts` (Phase 2 : contrat 15 champs, unicité, disponibilité honnête, activation gated) | 7 | **verts** |
| `gateway-monopole.test.ts` (Phase 3 : garde anti-contournement par scan du code, adoption du pont par les 9 surfaces, parité ancien exécuteur ↔ gateway, réponse normalisée 10 champs) | 7 | **verts** |
| `autonomie.test.ts` (Phases 4-8 : politique 5 niveaux, anti-auto-élévation, opérations toujours gated, décisions du cerveau, secrets fail-closed, insuffisances, plans, cycle persistant : idempotence/verrou/reprise/gate/annulation/retries, contenu malveillant = donnée) | 22 | **verts** |
| `apprentissage-phase9.test.ts` (Phase 9 : bilan d'exécutions réelles, 3 catégories séparées, amélioration démontrée avant/après sur jeu indépendant, régression détectée et refusée) | 5 | **verts** |
| Suites V1 conservées (discovery, benchmark, compatibility, execution, security, learning, verification, integration) | 40 | **verts** |
| **Total UCE** | **81** | **81 verts** |

## 2. Suite complète du dépôt (régression)

- **Baseline V1** : 7 687 verts (700 fichiers).
- **Exécution finale V1.1 (2026-11-25)** : **7 755 verts, 0 échec, 14 sautés, 706 fichiers** — **+68 tests** vs baseline.
- **3 échecs réels détectés puis corrigés** pendant la mission : les mocks de tests de `web-context` et de la route `/api/tools/execute` visaient l'ancien module `executeTool` alors que les moteurs importent désormais le pont legacy — mocks re-pointés sur `@/lib/capabilities/execution/pont-legacy`, les 14 tests concernés repassent ; confirmé par l'exécution finale complète.

## 3. Tests de défaillance couverts

API/source indisponible (statut honnête), outil inconnu (message historique préservé), politique refusante (parité), capacité désactivée (refus gateway), besoin avec secret (fail-closed), contenu malveillant (aucune action d'autorité), cycle sans candidat (échec honnête + cause persistée), verrou détenu (double exécution refusée), limite de retries atteinte (refus), gate d'autorisation sans autorisant (awaiting_approval), promotion d'une version défaillante (refusée, stable conservée) — scénarios A-G : **20/20 preuves réelles** (`docs/rapports/mesures/uce-v11-scenarios.json`).

## 4. Vérifications hors tests

- TypeScript : **0 erreur** (dépôt entier). ESLint : **0 erreur** sur tous les périmètres modifiés.
- Garde d'hygiène secrets : aucun motif réel (motifs de test = faux 32 caractères, comme à la V1).
- Build de production : **BLOCKED dans CE sandbox** (OOM V8 pendant la compilation Next.js — 2 tentatives, signature `Killed` puis `Aborted (core dumped)`, même limitation mémoire que celle documentée à la V1 §8) — la validation du build est reportée au job CI `build+budget` (GitHub Actions, ressources suffisantes) déclenché au push.

## 5. Ne pas confondre (consigne mission)

Code présent ✓ · Tests exécutés ✓ (résultats ci-dessus) · Fonctionnement vérifié ✓ (scénarios A-G avec preuves persistées) · **Déploiement confirmé ✗** (production VPS non vérifiée — cf. livrables 12/14).

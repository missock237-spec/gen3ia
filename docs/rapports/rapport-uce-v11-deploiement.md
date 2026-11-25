# LIVRABLE 12 — RAPPORT DE DÉPLOIEMENT UCE V1.1

**Date** : 2026-11-25 · **Dépôt** : missock237-spec/gen3ia · **Branche de travail** : `evolution/uce-v11` (base main = cc1ec1d) · **Statut** : déploiement VÉRIFIÉ EN DÉVELOPPEMENT ; **production VPS NON VÉRIFIÉE (BLOCKED infrastructure)** — aucun statut PRODUCTION_VERIFIED revendiqué.

## 1. Contrôles de production exécutés (2026-11-25, environnement de développement)

| Contrôle mission | Résultat | Preuve |
|---|---|---|
| Build de production | À EXÉCUTER à la clôture (`npm run build`) — cf. rapport final (résultat consigné au §5) | — |
| TypeScript | **0 erreur** sur tout le dépôt (exécutions répétées pendant la mission) | `npx tsc --noEmit` |
| ESLint | **0 erreur** sur les périmètres modifiés (`lib/capabilities`, `app/admin/capabilities`, `app/api/admin/capabilities`, `lib/tools/index.ts`, `lib/agents/runtime`, `lib/domain/conversations`, route API) | `npx eslint` |
| Tests unitaires | suites UCE V1.1 : **81 verts** (11 fichiers) | vitest |
| Tests d'intégration | suite complète du dépôt : cf. livrable 8 | vitest |
| Tests de bout en bout | scénarios mission A-G : **20/20 preuves réelles** | `docs/rapports/mesures/uce-v11-scenarios.json` |
| Variables d'environnement | aucune variable OBLIGATOIRE nouvelle : `AUTO_CAPABILITIES_LEVEL` optionnel (défaut 1) ; `GITHUB_TOKEN` optionnel (découverte GitHub, dégradation honnête sans) ; R2/Firestore : existants du dépôt | code + livrable 14 |
| PostgreSQL | **ABSENT du dépôt** (écart stack documenté : Firestore + journal local versionné) — entités mission conservées | livrable 6 §3 |
| Redis | **RETIRÉ du dépôt** (cache process-local, Task 108) — verrous via `cap_locks` | livrable 6 |
| R2 | requis par le chemin natif `executeTool` (existant) ; ABSENT dans ce sandbox → fail-closed documenté | V1 §10 + parité |
| Sandbox | opérationnelle (exécutions réelles des scénarios B/C/E) | scénarios |
| Connecteurs | MCP/Composio : chemins inchangés, atteints via le registre réel sous gateway | graphe (livrable 2) |
| Secrets | aucun secret dans le code (hook gitleaks au commit) ; motifs de test = faux | sécurité (livrable 9) |
| Monitoring | dashboard `/admin/capabilities` étendu autonomie V1.1 (chiffres mesurés) | Phase 13 |
| Sauvegardes | persistance double (Firestore + journal local versionné) ; migrations réversibles (V1) | V1 §13 |
| Rollback | version + cycle + registre (activation) — testés | scénario D, tests autonomie |

## 2. Procédure de déploiement (recommandée, inchangée du dépôt)

1. Fusion de `evolution/uce-v11` dans `main` après CI verte (build, typecheck, lint, tests, CodeQL, gitleaks — pipelines existants).
2. CD du dépôt déploie sur le VPS (pipeline sérialisé existant, préautorisé — voir historique job 478451).
3. Vérifications post-déploiement : `/api/health` 200 ; `/admin/capabilities` affichant les compteurs réels ; première exécution gateway tracée dans `cap_executions` ; `AUTO_CAPABILITIES_LEVEL` posé délibérément (défaut 1 = observation).
4. Test d'endurance 72 h à lancer ensuite sur le VPS stable (cf. livrable 11 §4).

## 3. Déploiement progressif

Le niveau d'autonomie IMPOSE la progression : niveau 1 (observation, défaut) → 2 → 3 → 4 → 5, chaque palier étant posé par un identifiant humain tracé. De même, les capacités découvertes ne deviennent exécutables qu'après le cycle gated (proposee → autorisee → integree). Ce cadencement EST le déploiement progressif fonctionnel de l'autonomie.

## 4. CI

- Le garde anti-contournement et les 41 nouveaux tests UCE V1.1 s'exécutent dans la suite vitest standard (incluse CI).
- Statut CI de la branche : à vérifier au push (cf. rapport final §CI) ; correctif appliqué si un contrôle échoue (même procédure sanctionnée que la V1, garde it.29).

## 5. Résultats consignés à la clôture

Build de production, suite complète et CI : résultats réels consignés dans le **rapport final** (livrable 13) au moment de la clôture de la mission.
